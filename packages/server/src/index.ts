// ──────────────────────────────────────────────
// Server Entry Point
// ──────────────────────────────────────────────
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "node:child_process";
import { APP_VERSION } from "@marinara-engine/shared";
import { buildApp } from "./app.js";
import { StorageWriterLeaseError } from "./db/file-backed-store.js";
import { flushDB } from "./db/connection.js";
import { getBootId, logger } from "./lib/logger.js";
import { startFreezeDetector, stopFreezeDetector } from "./lib/freeze-detector.js";
import { finalizeSessionExit, noteSessionExitKind, startSessionPostmortem } from "./lib/session-postmortem.js";
import { armShutdownDeadline } from "./lib/shutdown-deadline.js";
import {
  createShutdownSignalController,
  installShutdownSignalHandlers,
  runtimeStopBudgetFor,
  shutdownDeadlinesFor,
} from "./lib/shutdown-signals.js";
import { setRuntimeStopBudgetMs } from "./lib/shutdown-steps.js";
import {
  getDataDir,
  getFileStorageDir,
  getHost,
  getLogFileLevel,
  getLogLevel,
  getPort,
  getServerProtocol,
  loadTlsOptions,
  logStorageDiagnostics,
} from "./config/runtime-config.js";
import { logCsrfTrustSummary } from "./middleware/csrf-protection.js";
import { startEnvWatcher } from "./config/env-watcher.js";
import { migrateTaskbarShortcuts } from "./services/setup/taskbar-shortcut-migration.js";
import { sidecarProcessService } from "./services/sidecar/sidecar-process.service.js";
import { getRuntimeMemoryPeaks, getRuntimeMemorySnapshot, startRuntimeMemoryMonitor } from "./utils/runtime-memory.js";
import { reportDiagnosticError } from "./lib/diagnostic-operation.js";
import { createDiagnostic, wasDiagnosticReported } from "./lib/diagnostics.js";
import { startup } from "./lib/startup-timeline.js";
import { checkBuildIntegrity, type BuildIntegrity } from "./lib/build-integrity.js";
import { getBuildCommit, getBuildLabel } from "./config/build-info.js";

const RUNTIME = import.meta.url.includes("/dist/") ? "dist" : "tsx";

function isAddressInUseError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err && err.code === "EADDRINUSE";
}

function scheduleTaskbarShortcutMigration() {
  const timeout = setTimeout(() => {
    const installDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    void migrateTaskbarShortcuts(installDir).catch((err) => {
      logger.warn({ err }, "taskbar shortcut migration skipped");
    });
  }, 1_000);
  timeout.unref?.();
}

function logFatalProcessError(reason: unknown, message: string): void {
  reportDiagnosticError(reason, { operation: "process", stage: "fatal" }, undefined, {
    level: "fatal",
    event: "process.fatal",
    message,
    fields: { uptimeS: Math.round(process.uptime()), commit: getBuildCommit() },
  });
}

function stopDevelopmentWatcherAfterLeaseConflict(error: unknown): void {
  if (!(error instanceof StorageWriterLeaseError) || !process.argv.includes("--marinara-dev-watch")) return;
  if (process.ppid <= 1) return;
  if (process.platform === "win32") {
    // Windows does not deliver POSIX SIGTERM to the tsx watcher reliably.
    // Terminate the owning watcher tree explicitly after a lease conflict so
    // it cannot keep restarting a server against the live writer.
    try {
      execFileSync("taskkill.exe", ["/PID", String(process.ppid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      return;
    } catch {
      // Fall through to the portable signal path if taskkill is unavailable.
    }
  }
  try {
    process.kill(process.ppid, "SIGTERM");
  } catch (signalError) {
    if ((signalError as NodeJS.ErrnoException).code !== "ESRCH") {
      logger.warn(signalError, "[startup] Could not stop the development watcher after a writer lease conflict");
    }
  }
}

async function main() {
  logger.info(
    {
      event: "startup.build",
      version: APP_VERSION,
      commit: getBuildCommit(),
      build: getBuildLabel(),
      runtime: RUNTIME,
      node: process.version,
      pid: process.pid,
      bootId: getBootId(),
      heapLimitMiB: getRuntimeMemorySnapshot().heapLimitMiB,
    },
    "[startup] Marinara Engine %s starting",
    getBuildLabel(),
  );
  await startup.phase("build.integrity", () => startup.record("buildIntegrity", checkBuildIntegrity()), {
    optional: true,
  });
  const tls = loadTlsOptions();
  logStorageDiagnostics();
  // Started before buildApp so the startup memory peak is captured.
  let stopRuntimeMemoryMonitor: () => void = startRuntimeMemoryMonitor();
  const app = await buildApp(tls ?? undefined);
  const envWatcher = startEnvWatcher();
  const protocol = tls ? "https" : getServerProtocol();
  const port = getPort();
  const host = getHost();
  let isShuttingDown = false;

  const reapSidecar = () => {
    sidecarProcessService.killCurrentChildForProcessExit();
  };

  process.once("exit", reapSidecar);
  // #5506 diagnostics: stamp how this session ended. Every deliberate ending
  // reaches process "exit" (signal shutdown, in-app update, Advanced Settings
  // restart, a fatal crash); an external SIGKILL reaches nothing, which is
  // precisely the signal the postmortem reports at the next startup.
  process.once("exit", (code) => {
    finalizeSessionExit(code);
  });
  // A bare process.exit(1) here would skip Fastify onClose (closeDB, then
  // fileStore.close, then flush) and the store's beforeExit handler, silently
  // dropping writes still in the debounce window that the API already
  // acknowledged. Close gracefully instead, bounded by the shutdown deadline.
  const fatalExit = (reason: unknown, message: string) => {
    logFatalProcessError(reason, message);
    noteSessionExitKind("crash");
    reapSidecar();
    if (isShuttingDown) {
      // A second fatal error, or one during a signal shutdown: the close in
      // progress is already bounded by its own deadline, so let it finish the
      // flush rather than cutting it short or re-entering close.
      return;
    }
    isShuttingDown = true;
    // Sever connections at 4 s and force exit(1) at 8 s if close or flush hangs.
    armShutdownDeadline(app, "crash", { exitCode: 1 });
    try {
      envWatcher.stop();
      stopRuntimeMemoryMonitor();
      stopFreezeDetector();
    } catch {
      // Best effort: the flush below matters more than tidy watcher teardown.
    }
    void app
      .close()
      .catch((err) => {
        logger.error(err, "[process] Graceful close after a fatal error failed");
      })
      .finally(() => {
        process.exit(1);
      });
  };
  process.on("uncaughtException", (err) => {
    fatalExit(err, "[process] Uncaught exception; closing gracefully before exit");
  });
  process.on("unhandledRejection", (reason) => {
    fatalExit(reason, "[process] Unhandled rejection; closing gracefully before exit");
  });
  process.on("warning", (w) => {
    logger.warn(
      { event: "process.warning", errorCode: w.name, code: (w as NodeJS.ErrnoException).code, err: w },
      "Node process warning: %s",
      w.name,
    );
  });

  const shutdown = async (signal: NodeJS.Signals) => {
    // fatalExit sets isShuttingDown before its own close: a signal arriving
    // then must not start a second close that ends in exit(0) and reports a
    // crash as a clean stop.
    if (isShuttingDown) {
      logger.warn("Received %s while shutdown is already in progress", signal);
      return;
    }
    isShuttingDown = true;
    logger.info("Received %s; shutting down Marinara Engine", signal);
    // #5838: bound the whole close - sever connections at 4 s, force-exit at
    // 8 s - so a supervisor's stop window (earlyoom ~10 s, Docker 10 s) never
    // expires on a connection-wait and escalates to a write-dropping SIGKILL.
    // A Windows console close gets a tighter budget (see shutdownDeadlinesFor).
    armShutdownDeadline(app, signal, shutdownDeadlinesFor(signal));
    setRuntimeStopBudgetMs(runtimeStopBudgetFor(signal));

    // Start writing pending saves now, while app.close() may still be waiting
    // on open connections; the store close inside onClose writes the rest.
    void flushDB().catch((err) => logger.warn(err, "Early shutdown flush failed; the store close will retry"));

    const shutdownStarted = Date.now();
    try {
      envWatcher.stop();
      stopRuntimeMemoryMonitor();
      stopFreezeDetector();
      await app.close();
      logger.info({ event: "shutdown.complete", signal, elapsedMs: Date.now() - shutdownStarted }, "Shutdown complete");
      process.exit(0);
    } catch (err) {
      reportDiagnosticError(err, { operation: "shutdown", stage: "shutdown" }, undefined, {
        level: "error",
        event: "shutdown.complete",
        message: "Shutdown failed",
        fields: { signal, outcome: "failed", elapsedMs: Date.now() - shutdownStarted },
      });
      process.exit(1);
    }
  };

  // Duplicate delivery of one stop request is ignored; a deliberate repeat
  // after the grace window forces the exit.
  installShutdownSignalHandlers(
    createShutdownSignalController({
      alreadyStopping: () => isShuttingDown,
      onShutdown: (signal) => {
        void shutdown(signal);
      },
    }),
  );

  try {
    await app.listen({ port, host });
    logStartupReady(`${protocol}://${host}:${port}`);
    startFreezeDetector();
    startSessionPostmortem();
    logCsrfTrustSummary();
    scheduleTaskbarShortcutMigration();
  } catch (err) {
    if (isShuttingDown) {
      logger.info("Startup interrupted by shutdown");
      return;
    }

    if (isAddressInUseError(err)) {
      reportDiagnosticError(err, { operation: "startup", stage: "listen" }, undefined, {
        level: "fatal",
        event: "startup.failed",
        message: `Port ${port} is already in use. Marinara Engine could not start. Close the app using that port or set PORT to another value, for example PORT=7869 bash ./start.sh on macOS/Linux or set PORT=7869 && start.bat in Windows cmd.`,
        fields: { stage: "listen", errorCode: "EADDRINUSE", port },
      });
    } else {
      reportDiagnosticError(err, { operation: "startup", stage: "listen" }, undefined, {
        level: "fatal",
        event: "startup.failed",
        message: "[startup] Listen failed",
        fields: { stage: "listen" },
      });
    }
    process.exit(1);
  }
}

/** One startup.ready line: the startup summary plus where the server runs. Warn when a package failed or the build is stale. */
function logStartupReady(url: string): void {
  startup.record("memory", { ...getRuntimeMemorySnapshot(), ...getRuntimeMemoryPeaks() });
  const summary = startup.summary();
  const packages = summary.packages as { activated?: unknown[]; failed?: unknown[] } | undefined;
  const buildIntegrity = summary.buildIntegrity as BuildIntegrity | undefined;
  const failedCount = packages?.failed?.length ?? 0;
  const activeCount = packages?.activated?.length ?? 0;
  const buildStale = buildIntegrity?.stale === true;
  const level = failedCount > 0 || buildStale ? "warn" : "info";
  logger[level](
    {
      ...summary,
      event: "startup.ready",
      version: APP_VERSION,
      commit: getBuildCommit(),
      runtime: RUNTIME,
      node: process.version,
      url,
      buildStale,
      dataDir: getDataDir(),
      fileStorageDir: getFileStorageDir(),
      logLevel: { console: getLogLevel(), file: getLogFileLevel() },
    },
    "Marinara Engine ready on %s in %d ms (%d packages active, %d failed)",
    url,
    summary.elapsedMs,
    activeCount,
    failedCount,
  );
}

main().catch((err) => {
  const stage = startup.stageOf(err) ?? startup.currentStage ?? "bootstrap";
  if (wasDiagnosticReported(err)) {
    // The phase already wrote the full error; this line only says the boot stopped there.
    const ref = createDiagnostic(err);
    logger.fatal(
      {
        event: "startup.failed",
        stage,
        errorId: ref.errorId,
        errorCode: ref.code,
        elapsedMs: Math.round(process.uptime() * 1000),
        completedPhases: startup.phases.filter((phase) => phase.outcome === "ok").length,
      },
      "[startup] Bootstrap failed in phase %s",
      stage,
    );
  } else {
    reportDiagnosticError(
      err,
      { operation: "startup", operationId: getBootId(), stage },
      err instanceof StorageWriterLeaseError ? "ME_STORAGE_LEASE" : undefined,
      { level: "fatal", event: "startup.failed", message: `[startup] Bootstrap failed in phase ${stage}` },
    );
  }
  stopDevelopmentWatcherAfterLeaseConflict(err);
  process.exit(1);
});
