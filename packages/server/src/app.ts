// ──────────────────────────────────────────────
// Fastify App Factory
// ──────────────────────────────────────────────
import { forgetCampaignMemoryCache, warmCampaignMemoryCache } from "./services/game/campaign-memory-campaign-scope.js";
import { structurePublishedContinuity } from "./services/game/continuity-structure.js";
import { holdInjectUntilRegistered } from "./lib/fastify-inject-gate.js";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { getDB, closeDB, type DB } from "./db/connection.js";
import { registerRoutes } from "./routes/index.js";
import { errorHandler } from "./middleware/error-handler.js";
import { ipAllowlistHook } from "./middleware/ip-allowlist.js";
import { basicAuthHook } from "./middleware/basic-auth.js";
import { csrfProtectionHook } from "./middleware/csrf-protection.js";
import { rateLimitHook } from "./middleware/rate-limit.js";
import { securityHeadersHook } from "./middleware/security-headers.js";
import { seedDefaultPreset } from "./db/seed.js";
import { seedProfessorMari } from "./db/seed-mari.js";
import { seedDefaultConnection } from "./db/seed-connection.js";
import { seedDefaultBackgrounds } from "./db/seed-backgrounds.js";
import { seedDefaultGameAssets } from "./db/seed-game-assets.js";
import { seedDefaultRegexScripts } from "./db/seed-regex.js";
import { buildAssetManifest, ensureAssetDirs } from "./services/game/asset-manifest.service.js";
import { recoverGalleryImages } from "./services/storage/gallery-recovery.js";
import { migrateCharacterExtendedDescriptionsToLorebooks } from "./services/lorebook/extended-descriptions-migration.js";
import { migrateTtsSettingsToAudioConnection } from "./services/connections/tts-audio-connection-migration.js";
import { migrateLegacyDefaultAgentPrompts } from "./services/agents/default-prompt-migration.js";
import { APP_VERSION, resetTurnGameRegistry } from "@marinara-engine/shared";
import { existsSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { getBuildCommit, getBuildLabel } from "./config/build-info.js";
import { getNodeEnv, isAutoCreateDefaultConnectionDisabled, getFileStorageDir } from "./config/runtime-config.js";
import { corsDelegate } from "./config/cors-config.js";
import { sidecarProcessService } from "./services/sidecar/sidecar-process.service.js";
import { startServerAutonomousScheduler } from "./services/conversation/server-autonomous-scheduler.service.js";
import { preparePersonalExtensionTrust } from "./services/setup/personal-extension-trust.js";
import { personalServerExtensionRuntime } from "./services/extensions/personal-server-extension-runtime.js";
import { runWithGenerationFallbackNotifier } from "./services/generation/fallback-notification.js";
import { createReplyFallbackNotifier } from "./routes/generate/fallback-notification.js";
import { initializeCapabilityAgentRegistry } from "./services/capability-packages/capability-agent-registry.service.js";
import { capabilityPackageManager } from "./services/capability-packages/package-manager.service.js";
import { capabilityModuleRuntime } from "./services/capability-packages/capability-module-runtime.service.js";
import { migrateLegacyCapabilities } from "./services/capability-packages/legacy-capability-migration.js";
import { migrateLegacyGameMapsAtBoot } from "./services/capability-packages/automatic-legacy-game-map-migration.js";
import { createClientNotFoundHandler, createClientStaticOptions } from "./config/client-static-config.js";
import { hostValidationHook } from "./middleware/host-validation.js";
import { androidLocalAuthHook, androidLocalLoginRoute } from "./middleware/android-local-auth.js";
import { arch, platform, release } from "node:os";
import { execFileSync } from "node:child_process";
import { getRuntimeMemorySnapshot } from "./utils/runtime-memory.js";
import { getLastFreeze } from "./lib/freeze-detector.js";
import { getPreviousSessionStatus, getUncleanExitHistory } from "./lib/session-postmortem.js";
import { protectTerminalLogger } from "./lib/logger.js";
import { openCodeSessionHook } from "./utils/opencode-session.js";
import { logger } from "./lib/logger.js";
import { runWithRootDiagnosticContext, sanitizeDiagnosticText, type DiagnosticContext } from "./lib/diagnostics.js";
import { reportDiagnosticError } from "./lib/diagnostic-operation.js";
import { logSuppressed } from "./lib/best-effort.js";
import {
  kDiagnosticContext,
  MarinaraLogController,
  routeLabel,
  sanitizeIncomingRequestId,
} from "./lib/http-diagnostics.js";
import { startup } from "./lib/startup-timeline.js";
import { randomUUID } from "node:crypto";
import { flushLorebookActivationStats } from "./services/lorebook/activation-stats.js";
import { createGameContinuityRuntime, type ContinuityRuntime } from "./services/game/continuity-runtime.js";

type SessionSummaryRefreshRuntime = {
  start(): Promise<void>;
  onDependencyChanged(chatId: string): Promise<void>;
  stop(): Promise<void>;
};

const isLite = process.env.MARINARA_LITE === "true" || process.env.MARINARA_LITE === "1";
const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

function resolveServerOs(): string {
  const hostPlatform = platform();
  const hostRelease = release();
  const hostArch = arch();
  if (hostPlatform === "darwin") {
    try {
      const version = execFileSync("sw_vers", ["-productVersion"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2_000,
      }).trim();
      return `macOS ${version || hostRelease} (${hostArch})`;
    } catch {
      return `macOS ${hostRelease} (${hostArch})`;
    }
  }
  if (hostPlatform === "win32") return `Windows ${hostRelease} (${hostArch})`;
  if (hostPlatform === "android" || process.env.PREFIX?.includes("com.termux")) {
    return `Android / Termux ${hostRelease} (${hostArch})`;
  }
  if (hostPlatform === "linux") return `Linux ${hostRelease} (${hostArch})`;
  return `${hostPlatform} ${hostRelease} (${hostArch})`;
}

const SERVER_OS = resolveServerOs();

type RequestWithDiagnosticContext = { [kDiagnosticContext]?: DiagnosticContext };
type ShutdownServiceRecord = { stage: string; elapsedMs: number; outcome: "ok" | "failed" };

/** Shared request correlation and response normalization hooks for HTTP tests and the live app. */
export function registerDiagnosticHttpHooks(app: FastifyInstance): void {
  app.addHook("onRequest", (request, _reply, done) => {
    // A fresh root store: a request never inherits the socket's or a timer's stale context.
    const context: DiagnosticContext = { requestId: request.id, operation: `${request.method} ${routeLabel(request)}` };
    (request as unknown as RequestWithDiagnosticContext)[kDiagnosticContext] = context;
    runWithRootDiagnosticContext(context, () => done());
  });
  // Body parsing runs in the HTTP parser's async context. This first preValidation hook
  // rebinds the request's root context before validation, preHandler and the handler.
  app.addHook("preValidation", (request, _reply, done) => {
    runWithRootDiagnosticContext(
      (request as unknown as RequestWithDiagnosticContext)[kDiagnosticContext] ?? { requestId: request.id },
      () => done(),
    );
  });
  app.addHook("onRequestAbort", (request, done) => {
    logger.info(
      { event: "request.aborted", requestId: request.id, method: request.method, route: routeLabel(request) },
      "Client aborted request",
    );
    done();
  });
  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("x-request-id", req.id);
    if (req.url.startsWith("/api/") && !reply.hasHeader("Cache-Control")) {
      reply.header("Cache-Control", "no-store");
    }
    if (reply.statusCode >= 400 && reply.getHeader("content-type")?.toString().includes("application/json")) {
      try {
        const parsed = typeof payload === "string" ? JSON.parse(payload) : payload;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "error" in parsed) {
          const record = parsed as Record<string, unknown>;
          if (!record.code || !record.errorId) {
            const route = routeLabel(req);
            const status = reply.statusCode;
            const synthetic = Object.assign(
              new Error(typeof record.error === "string" ? record.error : `HTTP ${status}`),
              {
                statusCode: status,
              },
            );
            // No frames: the error was rebuilt from a response body, so a stack would only point here.
            synthetic.stack = `${synthetic.name}: ${synthetic.message}`;
            const reference = reportDiagnosticError(
              synthetic,
              { requestId: req.id, operation: `${req.method} ${route}`, stage: "http" },
              undefined,
              {
                level: status >= 500 ? "error" : "info",
                event: "request.error",
                message: `${req.method} ${route} -> ${status}`,
                fields: { method: req.method, route, statusCode: status },
              },
            );
            const normalized = {
              ...record,
              error: typeof record.error === "string" ? sanitizeDiagnosticText(record.error) : record.error,
              ...reference,
              ...(record.code ? { code: record.code, diagnosticCode: reference.code } : {}),
            };
            return typeof payload === "string" ? JSON.stringify(normalized) : normalized;
          }
        }
      } catch {
        // Preserve the original payload when a directly-sent error is not JSON.
      }
    }
    return payload;
  });
}

export async function buildApp(https?: { cert: Buffer; key: Buffer }) {
  const hadUserStateBeforeStartup = existsSync(join(getFileStorageDir(), "manifest.json"));
  const app = Fastify({
    // Restart has its own bounded fallback; normal shutdown must not interrupt active generations.
    forceCloseConnections: false,
    // Keep Fastify and application records on the same Pino instance so
    // request context, sinks, and runtime level changes stay correlated.
    loggerInstance: logger as FastifyBaseLogger,
    // One request.end line per request, labelled `requestId`; LOG_DISABLE_REQUEST_LOGGING moves it from info to debug.
    logController: new MarinaraLogController(),
    // UUIDs never collide across boots. A well-formed client x-request-id is honoured for end-to-end tracing.
    genReqId: (req) => sanitizeIncomingRequestId(req.headers["x-request-id"]) ?? randomUUID(),
    bodyLimit: MAX_UPLOAD_BYTES, // General-route default; transfer routes opt into streamed or unbounded imports.
    ...(https && { https }),
  });
  // Early-boot detector: anything that boots Fastify (inject, ready) before registration
  // finishes makes every later plugin fail with "Root plugin has already booted".
  let registrationDone = false;
  app.addHook("onReady", function (done) {
    if (!registrationDone) {
      logger.error(
        {
          event: "startup.early_boot",
          errorCode: "ME_EARLY_BOOT",
          stage: startup.currentStage,
          stack: new Error("Fastify booted before registration finished").stack,
        },
        "[startup] Fastify booted before route registration finished; later plugins will fail with 'Root plugin has already booted'",
      );
    } else {
      logger.debug({ event: "startup.phase", stage: "fastify.ready" }, "Fastify ready");
    }
    done();
  });
  protectTerminalLogger(app.log, getNodeEnv() !== "production");
  // Hold internal inject() calls until every route, hook and package is registered (see fastify-inject-gate.ts).
  const releaseInjectGate = holdInjectUntilRegistered(app);

  registerDiagnosticHttpHooks(app);

  // Reject attacker-controlled DNS names before CORS or loopback trust can
  // treat a rebound browser request as same-origin local traffic.
  app.addHook("onRequest", hostValidationHook);

  // ── Plugins ──
  // CORS uses a per-request delegator so the trusted set is re-read each
  // request (CORS_ORIGINS hot-reloads in ~2s without a restart) AND so
  // same-origin requests (Origin matches the request's Host header) are
  // auto-allowed regardless of configuration. @fastify/cors expects the
  // delegator to be returned from a factory function passed as the plugin
  // options. See cors-config.ts.
  await startup.phase("plugins.cors", async () => {
    await app.register(cors, () => corsDelegate);
  });

  await startup.phase("plugins.multipart", async () => {
    await app.register(multipart, {
      limits: {
        fileSize: MAX_UPLOAD_BYTES,
      },
    });
  });

  // ── Storage ──
  const db = (await startup.phase("storage.init", () => getDB())) as DB;
  app.decorate("db", db);
  // Accessor decoration: game routes assign the service from an encapsulated
  // child context, and a plain property would only shadow on that child. The
  // setter routes the assignment to shared state so the root (start/stop,
  // onPublished) and sibling route contexts (chat message mutations) see it.
  let sessionSummaryRefresh: SessionSummaryRefreshRuntime | null = null;
  app.decorate("sessionSummaryRefresh", {
    getter: () => sessionSummaryRefresh,
    setter: (value: SessionSummaryRefreshRuntime | null) => {
      sessionSummaryRefresh = value;
    },
  });
  const gameContinuity = createGameContinuityRuntime(db, {
    onPublished: async (receipt) => {
      forgetCampaignMemoryCache(receipt.chatId);
      // Movements and relationships are read from the newly published records in the background; a failure
      // leaves the receipt unmarked so the structure backfill picks it up later.
      void structurePublishedContinuity(db, receipt.chatId, { receiptIds: [receipt.id] }).catch((error) =>
        logger.warn({ err: error, receiptId: receipt.id }, "[game-continuity] structure pass failed"),
      );
      await app.sessionSummaryRefresh?.onDependencyChanged(receipt.chatId);
    },
  });
  app.decorate("gameContinuity", gameContinuity);
  app.addHook("onClose", async () => {
    const closeStarted = performance.now();
    const services: ShutdownServiceRecord[] = [];
    try {
      const named: Array<[string, () => Promise<unknown> | unknown]> = [
        ["sessionSummaryRefresh", () => app.sessionSummaryRefresh?.stop()],
        ["gameContinuity", () => gameContinuity.stop()],
        ["capabilityModuleRuntime", () => capabilityModuleRuntime.stop()],
        ["personalExtensions", () => personalServerExtensionRuntime.stop()],
        ["sidecar", () => sidecarProcessService.stop()],
        // Write the last batched lorebook activation counts while the database is still open.
        ["lorebookActivationStats", () => flushLorebookActivationStats()],
      ];
      await Promise.all(
        named.map(async ([name, stop]) => {
          const started = performance.now();
          try {
            await stop();
            const elapsedMs = Math.round(performance.now() - started);
            services.push({ stage: name, elapsedMs, outcome: "ok" });
            if (elapsedMs > 2_000) {
              logger.warn(
                { event: "shutdown.service", stage: name, outcome: "ok", elapsedMs },
                "[shutdown] %s took %d ms to stop",
                name,
                elapsedMs,
              );
            }
          } catch (err) {
            const elapsedMs = Math.round(performance.now() - started);
            services.push({ stage: name, elapsedMs, outcome: "failed" });
            logger.error(
              { err, event: "shutdown.service", stage: name, outcome: "failed", elapsedMs },
              "[shutdown] Failed to stop %s",
              name,
            );
          }
        }),
      );
    } finally {
      await closeDB();
      logger.info(
        { event: "shutdown.complete", elapsedMs: Math.round(performance.now() - closeStarted), services },
        "[shutdown] Runtime services stopped",
      );
    }
  });

  // Existing installations retain their selected capabilities. Downloadable
  // package updates are offered in the client and never applied at startup.
  if (getNodeEnv() !== "test") {
    await startup.phase(
      "package.prune",
      async () => {
        const removedCorePackages = await capabilityPackageManager.pruneNonDownloadableCorePackages();
        startup.record("removedCorePackages", removedCorePackages);
        if (removedCorePackages.length > 0) {
          app.log.info("Removed obsolete downloadable copies of core features: %s", removedCorePackages.join(", "));
        }
      },
      { optional: true },
    );
    await startup.phase("package.migrate-legacy", () => migrateLegacyCapabilities(db, hadUserStateBeforeStartup), {
      optional: true,
    });
    await startup.phase(
      "package.migrate-noodle",
      async () => {
        const noodleMigration =
          await capabilityPackageManager.migrateExtractedNoodleAvailability(hadUserStateBeforeStartup);
        startup.record("noodleMigration", noodleMigration);
        if ("pending" in noodleMigration && noodleMigration.pending) {
          app.log.debug("Optional Noodle package is not in the active catalog yet; migration remains pending");
        } else if (noodleMigration.migrated) {
          app.log.info("Installed the optional Noodle package for an upgraded profile");
        }
      },
      { optional: true },
    );
  }
  resetTurnGameRegistry();

  // ── Seed defaults ──
  await startup.phase("seed.preset", () => seedDefaultPreset(db));
  await startup.phase("seed.mari", () => seedProfessorMari(db));
  if (isAutoCreateDefaultConnectionDisabled()) {
    app.log.info("Skipping default OpenRouter Free connection seed because AUTO_CREATE_DEFAULT_CONNECTION is disabled");
  } else {
    await startup.phase("seed.connection", () => seedDefaultConnection(db));
  }
  await startup.phase("seed.regex", () => seedDefaultRegexScripts(db));
  await startup.phase("migration.agent-prompts", () => migrateLegacyDefaultAgentPrompts(db));
  await startup.phase("migration.extended-descriptions", () => migrateCharacterExtendedDescriptionsToLorebooks(db));
  // Optional: a failure retries next startup.
  await startup.phase("migration.tts-audio", () => migrateTtsSettingsToAudioConnection(db), { optional: true });
  await startup.phase("seed.backgrounds", () => seedDefaultBackgrounds());
  await startup.phase("seed.game-assets", () => seedDefaultGameAssets());

  // ── Ensure default asset directories exist, then build manifest ──
  await startup.phase("assets.manifest", () => {
    ensureAssetDirs();
    buildAssetManifest();
  });

  // ── Recover orphaned gallery images (files on disk without DB records) ──
  await startup.phase("gallery.recover", () => recoverGalleryImages(db));

  // Legacy extension payloads and any out-of-band code changes are retained as
  // disabled drafts. Execution always requires approval of the exact hash.
  await startup.phase("extensions.trust", async () => {
    const personalExtensionTrust = await preparePersonalExtensionTrust(db);
    if (personalExtensionTrust.legacyRecordsQuarantined > 0) {
      app.log.info(
        "Quarantined %d legacy extension record(s) as Personal Extension drafts",
        personalExtensionTrust.legacyRecordsQuarantined,
      );
    }
    if (personalExtensionTrust.changedRecordsDisabled > 0) {
      app.log.warn(
        "Disabled %d Personal Extension record(s) because stored code changed outside the approval flow",
        personalExtensionTrust.changedRecordsDisabled,
      );
    }
  });

  // Share the originating chat session with nested provider calls and retries.
  app.addHook("preHandler", openCodeSessionHook);

  // Keep fallback reporting attached to the originating request even when
  // generation passes through nested services. Streamed routes emit an SSE
  // event; ordinary requests expose a response header consumed by the client.
  app.addHook("preHandler", (_request, reply, done) => {
    runWithGenerationFallbackNotifier(createReplyFallbackNotifier(reply), done);
  });

  // ── Security headers ──
  app.addHook("onRequest", securityHeadersHook);

  // ── IP Allowlist ──
  app.addHook("onRequest", ipAllowlistHook);

  // ── Lightweight API abuse throttling ──
  app.addHook("onRequest", rateLimitHook);

  // ── HTTP Basic Auth ──
  app.addHook("onRequest", basicAuthHook);

  // ── CSRF / Origin protection for unsafe API requests ──
  app.addHook("onRequest", csrfProtectionHook);

  // APK-managed Termux installs use a per-install secret so unrelated Android
  // apps cannot inherit the server's ordinary loopback trust.
  app.addHook("onRequest", androidLocalAuthHook);

  // ── Prevent caching of API JSON responses ──
  // Without explicit Cache-Control, browsers apply heuristic caching which
  // can return stale data when React Query refetches after mutations.
  // This caused messages to vanish after generation because the refetch
  // returned a cached response without the newly saved message.
  // ── Error Handler ──
  app.setErrorHandler(errorHandler);

  // API file routes use reply.sendFile even when the client build is absent.
  // Decorate once without exposing a static route; production assets register below.
  // ── Routes ──
  await startup.phase("routes.register", async () => {
    await app.register(fastifyStatic, { serve: false });
    await registerRoutes(app);
  });
  await startup.phase("workers.start", async () => {
    await Promise.all([app.sessionSummaryRefresh?.start(), gameContinuity.start()]);
  });
  // Hash earlier session transcripts once in the background, so the first GM turn after a restart stays fast.
  const campaignWarmTimer = setTimeout(() => {
    void warmCampaignMemoryCache(db).catch((error) =>
      logSuppressed(error, { event: "continuity.stage", stage: "campaign-memory.warm" }),
    );
  }, 15_000);
  campaignWarmTimer.unref?.();
  await startup.phase("routes.android-login", () => androidLocalLoginRoute(app));

  // Trusted downloaded server capabilities register while Fastify is still mutable.
  await startup.phase("capability.runtime", () => capabilityModuleRuntime.start(app));
  // Optional: a single malformed legacy chat must never prevent the host from booting.
  await startup.phase("migration.legacy-game-maps", () => migrateLegacyGameMapsAtBoot(db), { optional: true });
  // A package can install its own art during activate(), which runs AFTER the boot-time scan above, so
  // without this its assets stay invisible to everything reading the manifest until the NEXT restart.
  // Idempotent: the same scan the upload routes already re-run. Optional because it walks files a package
  // just wrote: a stale manifest costs that package its art, failing to boot costs the user everything.
  await startup.phase("assets.rescan-after-packages", () => buildAssetManifest(), { optional: true });
  await startup.phase("extensions.runtime", () => personalServerExtensionRuntime.start(db));
  // Server-backed agent definitions are visible only after their runtime reaches
  // functional readiness. Packages without a server entrypoint remain available
  // as soon as their verified files are installed.
  await startup.phase("agents.registry", () => initializeCapabilityAgentRegistry());

  // ── Server-side autonomous conversation scheduler ──
  startServerAutonomousScheduler(app);

  // ── Sidecar bootstrap (background, skipped in lite mode) ──
  if (!isLite) {
    void sidecarProcessService
      .syncForCurrentConfig({ suppressKnownFailure: true, allowRuntimeInstall: false })
      .catch((error) => {
        app.log.warn({ err: error }, "sidecar bootstrap failed");
      });
  }

  // ── Serve client build in production ──
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const clientDist = resolve(__dirname, "..", "..", "client", "dist");
  const clientIndex = resolve(clientDist, "index.html");
  if (existsSync(clientIndex)) {
    await startup.phase("client.static", async () => {
      await app.register(fastifyStatic, createClientStaticOptions(clientDist));

      // Only navigation falls back to HTML; missing modules must remain a 404.
      app.setNotFoundHandler(createClientNotFoundHandler(clientIndex));
    });
  } else {
    app.log.warn(
      "Client build entry not found at %s; serving API only. Run `pnpm build` to build the frontend.",
      clientIndex,
    );
  }

  // ── Health Check ──
  app.get("/api/health", async () => {
    const commit = getBuildCommit();
    let capabilityPackages: Awaited<ReturnType<typeof capabilityPackageManager.diagnostics>> | null = null;
    try {
      capabilityPackages = await capabilityPackageManager.diagnostics();
    } catch (error) {
      app.log.warn(error, "Capability package diagnostics are unavailable");
    }
    return {
      status: "ok",
      version: APP_VERSION,
      commit,
      build: getBuildLabel(),
      serverOs: SERVER_OS,
      memory: getRuntimeMemorySnapshot(),
      // Termux background-reliability telemetry (#5655/#5656): the launcher
      // exports its wake-lock outcome, and the freeze detector records the
      // most recent host-suspension it observed. Null on non-Termux hosts.
      wakeLock: process.env.MARINARA_WAKE_LOCK_STATUS || null,
      lastFreeze: getLastFreeze(),
      // #5506 diagnostics: how the PREVIOUS session ended. An external kill
      // (phantom process killer, battery manager, reboot) leaves no in-process
      // trace, so the next startup's heartbeat postmortem is the witness.
      // Tri-state by design: "unknown" is reported honestly rather than being
      // collapsed into a clean shutdown nobody observed.
      previousSession: getPreviousSessionStatus(),
      uncleanExitCount: getUncleanExitHistory().length,
      timestamp: new Date().toISOString(),
      startup: startup.summary(),
      buildIntegrity: startup.facts.buildIntegrity ?? null,
      capabilityPackages: {
        status: capabilityPackages
          ? capabilityPackages.every((item) => item.ready || item.status === "restart-required")
            ? "ok"
            : "degraded"
          : "error",
        packages: capabilityPackages ?? [],
      },
    };
  });

  registrationDone = true;
  releaseInjectGate();
  return app;
}

// Type augmentation so routes can access `fastify.db`
declare module "fastify" {
  interface FastifyInstance {
    db: DB;
    gameContinuity: ContinuityRuntime;
    sessionSummaryRefresh: SessionSummaryRefreshRuntime | null;
  }
}
