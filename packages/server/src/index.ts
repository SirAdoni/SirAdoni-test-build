// ──────────────────────────────────────────────
// Server Entry Point
// ──────────────────────────────────────────────
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "node:child_process";
import { buildApp } from "./app.js";
import { StorageWriterLeaseError } from "./db/file-backed-store.js";
import { logger } from "./lib/logger.js";
import { startFreezeDetector, stopFreezeDetector } from "./lib/freeze-detector.js";
import { finalizeSessionExit, noteSessionExitKind, startSessionPostmortem } from "./lib/session-postmortem.js";
import { armShutdownDeadline } from "./lib/shutdown-deadline.js";
import { getHost, getPort, getServerProtocol, loadTlsOptions, logStorageDiagnostics } from "./config/runtime-config.js";
import { logCsrfTrustSummary } from "./middleware/csrf-protection.js";
import { startEnvWatcher } from "./config/env-watcher.js";
import { migrateTaskbarShortcuts } from "./services/setup/taskbar-shortcut-migration.js";
import { sidecarProcessService } from "./services/sidecar/sidecar-process.service.js";
import { startRuntimeMemoryMonitor } from "./utils/runtime-memory.js";
import { reportDiagnosticError } from "./lib/diagnostic-operation.js";

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
  const reference = reportDiagnosticError(reason, { operation: "process", stage: "fatal" });
  if (reason instanceof Error) {
    logger.error(reason, "%s [%s %s]", message, reference.code, reference.errorId);
    return;
  }

  logger.error({ reason, ...reference }, message);
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
  const tls = loadTlsOptions();
  logStorageDiagnostics();
  const app = await buildApp(tls ?? undefined);
  const envWatcher = startEnvWatcher();
  const protocol = tls ? "https" : getServerProtocol();
  const port = getPort();
  const host = getHost();
  let isShuttingDown = false;
  let stopRuntimeMemoryMonitor: () => void = () => undefined;

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
  process.on("uncaughtException", (err) => {
    logFatalProcessError(err, "[process] Uncaught exception; reaping sidecar before exit");
    noteSessionExitKind("crash");
    reapSidecar();
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    logFatalProcessError(reason, "[process] Unhandled rejection; reaping sidecar before exit");
    noteSessionExitKind("crash");
    reapSidecar();
    process.exit(1);
  });

  const shutdown = async (signal: NodeJS.Signals) => {
    if (isShuttingDown) {
      logger.warn("Received %s while shutdown is already in progress", signal);
      return;
    }

    isShuttingDown = true;
    logger.info("Received %s; shutting down Marinara Engine", signal);
    // #5838: bound the whole close - sever connections at 4 s, force-exit at
    // 8 s - so a supervisor's stop window (earlyoom ~10 s, Docker 10 s) never
    // expires on a connection-wait and escalates to a write-dropping SIGKILL.
    armShutdownDeadline(app, signal);

    try {
      envWatcher.stop();
      stopRuntimeMemoryMonitor();
      stopFreezeDetector();
      await app.close();
      logger.info("Shutdown complete");
      process.exit(0);
    } catch (err) {
      const reference = reportDiagnosticError(err, { operation: "shutdown", stage: "shutdown" });
      logger.error(err, "Shutdown failed [%s %s]", reference.code, reference.errorId);
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  if (process.platform !== "win32") {
    process.on("SIGHUP", () => {
      void shutdown("SIGHUP");
    });
  }

  try {
    await app.listen({ port, host });
    logger.info(`Marinara Engine server listening on ${protocol}://${host}:${port}`);
    startFreezeDetector();
    startSessionPostmortem();
    stopRuntimeMemoryMonitor = startRuntimeMemoryMonitor();
    logCsrfTrustSummary();
    scheduleTaskbarShortcutMigration();
  } catch (err) {
    if (isShuttingDown) {
      logger.info("Startup interrupted by shutdown");
      return;
    }

    if (isAddressInUseError(err)) {
      logger.error(
        err,
        "Port %d is already in use. Marinara Engine could not start. Close the app using that port or set PORT to another value, for example PORT=7869 bash ./start.sh on macOS/Linux or set PORT=7869 && start.bat in Windows cmd.",
        port,
      );
    } else {
      const reference = reportDiagnosticError(err, { operation: "startup", stage: "listen" });
      logger.error(err, "Startup listen failed [%s %s]", reference.code, reference.errorId);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  const reference = reportDiagnosticError(err, { operation: "startup", stage: "bootstrap" });
  logger.error(err, "[startup] Unhandled error during server bootstrap [%s %s]", reference.code, reference.errorId);
  stopDevelopmentWatcherAfterLeaseConflict(err);
  process.exit(1);
});
