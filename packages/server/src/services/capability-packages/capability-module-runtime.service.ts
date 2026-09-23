import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse as InjectResponse } from "fastify";
import {
  registerTurnGameEngine,
  type AnyTurnGameEngine,
  type CapabilityRuntimeHost,
  type CapabilityRuntimeLogArgument,
  type InstalledCapabilityPackage,
  parseAgentSettingsRecord,
} from "@marinara-engine/shared";
import { isDebugAgentsEnabled } from "../../config/runtime-config.js";
import { logger } from "../../lib/logger.js";
import { runWithRootDiagnosticContext, sanitizeDiagnosticText, withDiagnosticContext } from "../../lib/diagnostics.js";
import { reportDiagnosticError } from "../../lib/diagnostic-operation.js";
import { startup } from "../../lib/startup-timeline.js";
import { DATA_DIR } from "../../utils/data-dir.js";
import { parseGameJsonish } from "../game/jsonish.js";
import { createAgentsStorage } from "../storage/agents.storage.js";
import { capabilityPackageManager } from "./package-manager.service.js";
import {
  registerCapabilityConversationCommand,
  type CapabilityConversationCommandRegistration,
} from "./capability-command-registry.service.js";
import { registerCapabilityService } from "./capability-service-registry.service.js";
import { assertCapabilityAgentRuntimeServiceRegistration } from "./capability-agent-runtime.service.js";
import { createCapabilityIntegrationHost } from "./capability-integrations.service.js";
import { createCapabilityLanguageModelHost } from "./capability-language-model.service.js";
import { linkCapabilityNativeDependencies } from "./capability-native-dependencies.service.js";
import {
  createCapabilityEmbeddingHost,
  createConfiguredCapabilityEmbeddingHost,
} from "./capability-embedding.service.js";
import { createCapabilityPersistenceHost } from "./capability-persistence.service.js";
import { createCapabilityResourceHost } from "./capability-resources.service.js";
import {
  registerCapabilityPrivilegedRoutes,
  runCapabilityInternalRoute,
} from "./capability-route-registration.service.js";
import {
  registerCapabilityPromptContext,
  withDeadline,
  type CapabilityPromptContextContributor,
} from "./capability-prompt-context.service.js";
import { registerCapabilityTool, type CapabilityToolRegistration } from "./capability-tool-registry.service.js";

/**
 * Errors raised by the host's own Fastify lifecycle (the app was booted or started listening before registration
 * finished) say nothing about the package. Rolling the package back or persisting "error" for them would disable a
 * healthy package on every later boot, as happened when a startup race hit hierarchical-maps, conversation-calls
 * and long-term-memory.
 */
export function isHostLifecycleActivationError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "FST_ERR_INSTANCE_ALREADY_LISTENING" || code === "AVV_ERR_ROOT_PLG_BOOTED") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /Root plugin has already booted|Fastify instance is already listening/u.test(message);
}

type Cleanup = () => void | Promise<void>;

/** Steps of one activation, in order. The last one entered is where a failure happened. */
export type ActivationStage =
  | "mark-pending"
  | "verify-files"
  | "snapshot"
  | "import"
  | "activate"
  | "mark-registered"
  | "self-check"
  | "mark-active"
  | "failure-handling";

/** What one activation did, for the startup summary line and startup.facts.packages. */
export interface ActivationResult {
  packageId: string;
  version: string;
  outcome: "ok" | "failed" | "skipped" | "rolled-back" | "deferred";
  stage: ActivationStage;
  elapsedMs: number;
  reason?: string;
  errorId?: string;
  errorCode?: string;
  rolledBackTo?: string;
  persistedStatus?: "error";
  /** The activation of the restored version, when this one rolled back. */
  rollbackResult?: ActivationResult;
}
type CapabilityActivationContext = {
  app: FastifyInstance;
  dataDir: string;
  package: InstalledCapabilityPackage;
  api: {
    runtime: CapabilityRuntimeHost;
    registerTurnGameEngine(engine: AnyTurnGameEngine): Cleanup;
    registerConversationCommand(registration: CapabilityConversationCommandRegistration): Cleanup;
    registerService<T>(key: string, service: T): Cleanup;
    /** Contribute text to each turn's system prompt. Requires the `prompt-context` permission. */
    registerPromptContext(contributor: CapabilityPromptContextContributor): Cleanup;
    /** Offer the model a tool this package handles. Requires the `tools` permission. */
    registerTool(registration: CapabilityToolRegistration): Cleanup;
    registerPrivilegedRoutes(
      routes: import("fastify").FastifyPluginAsync,
      options: { prefix: string },
    ): Promise<Cleanup>;
    /** Run an active route owned by this package as trusted server work. */
    runInternalRoute?: (options: InjectOptions | string) => Promise<InjectResponse>;
  };
};

async function createCapabilityRuntimeHost(
  app: FastifyInstance,
  packageId: string,
  packageVersion: string,
  permissions: readonly string[],
): Promise<CapabilityRuntimeHost> {
  // Every line a package writes carries its id and version, so its output can be filtered in the log.
  const pkgLog = logger.child({ packageId, packageVersion });
  const agents = app.db ? createAgentsStorage(app.db) : null;
  const config = await agents?.getByType(packageId);
  const embeddings = app.db
    ? await createConfiguredCapabilityEmbeddingHost(app.db, config?.connectionId)
    : createCapabilityEmbeddingHost();
  return Object.freeze({
    embeddings,
    async resolveEmbeddings() {
      const config = await agents?.getByType(packageId);
      return app.db
        ? createConfiguredCapabilityEmbeddingHost(app.db, config?.connectionId)
        : createCapabilityEmbeddingHost();
    },
    async getAgentConfig() {
      const config = await agents?.getByType(packageId);
      return config ? { connectionId: config.connectionId, settings: parseAgentSettingsRecord(config.settings) } : null;
    },
    isDebugAgentsEnabled,
    json: Object.freeze({ parseJsonish: parseGameJsonish }),
    languageModels: createCapabilityLanguageModelHost(app.db),
    integrations: createCapabilityIntegrationHost(permissions),
    logger: Object.freeze({
      debug: (message: string, ...args: CapabilityRuntimeLogArgument[]) =>
        Reflect.apply(pkgLog.debug, pkgLog, [message, ...args]),
      info: (message: string, ...args: CapabilityRuntimeLogArgument[]) =>
        Reflect.apply(pkgLog.info, pkgLog, [message, ...args]),
      warn: (message: string, ...args: CapabilityRuntimeLogArgument[]) =>
        Reflect.apply(pkgLog.warn, pkgLog, [message, ...args]),
      error: (error: unknown, message: string, ...args: CapabilityRuntimeLogArgument[]) =>
        Reflect.apply(pkgLog.error, pkgLog, [error, message, ...args]),
      // Same routing as logDebugOverride: the debugPrompt tag sends the line to logs/prompt-debug/ only.
      debugOverride: (overrideEnabled: boolean, message: string, ...args: CapabilityRuntimeLogArgument[]) => {
        const method = overrideEnabled && !pkgLog.isLevelEnabled("debug") ? pkgLog.warn : pkgLog.debug;
        Reflect.apply(method, pkgLog, [{ debugPrompt: true }, message, ...args]);
      },
    }),
    persistence: createCapabilityPersistenceHost(app.db, permissions),
    resources: createCapabilityResourceHost(app.db),
  });
}
type CapabilityModule = {
  activate?: (context: CapabilityActivationContext) => void | Cleanup | Promise<void | Cleanup>;
  selfCheck?: (context: CapabilityActivationContext) => void | Promise<void>;
};

export function prepareCapabilityRuntimeEnvironment(dataDir = DATA_DIR): void {
  // Downloaded runtimes bundle Engine utilities and evaluate them before
  // activate(context). Give those bundles the host's absolute resolved path;
  // preserving a relative DATA_DIR would resolve beside the nested server.mjs.
  process.env.DATA_DIR = dataDir;
}

async function runCleanups(cleanups: Cleanup[]): Promise<void> {
  let firstError: unknown;
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await withDeadline(cleanup(), "Capability cleanup", 8000);
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;
}

/** The last activation failure of one package in this process (admin runtime diagnostics). */
export interface CapabilityActivationErrorRecord {
  message: string;
  at: string;
  errorId?: string;
  errorCode?: string;
}

class CapabilityModuleRuntime {
  private cleanups = new Map<string, Cleanup>();
  // Last activation failure per package in this process, including host-lifecycle failures that are
  // deliberately not persisted to the registry. Read by the admin runtime diagnostics endpoint.
  private activationErrors = new Map<string, CapabilityActivationErrorRecord>();

  /** Read-only view for diagnostics: which package runtimes are live now, and recent activation failures. */
  runtimeState(): { live: string[]; activationErrors: Record<string, CapabilityActivationErrorRecord> } {
    return { live: [...this.cleanups.keys()].sort(), activationErrors: Object.fromEntries(this.activationErrors) };
  }

  async start(app: FastifyInstance): Promise<void> {
    // Bundled package modules execute before activate(context), so give their
    // shared Engine utilities the host's already-resolved data root up front.
    // Without this, a package can derive DATA_DIR from its nested server.mjs
    // location and fail to see host-owned models and storage.
    prepareCapabilityRuntimeEnvironment();
    // Snapshots belong to a single process; any found at boot were left behind by an unclean exit.
    try {
      await rm(join(DATA_DIR, "capability-runtime-snapshots"), { recursive: true, force: true });
    } catch (error) {
      logger.warn(error, "Could not remove stale capability runtime snapshots");
    }
    await this.ensureModuleResolution();
    const started = Date.now();
    const skipped: Array<{ packageId: string; reason: string }> = [];
    for (const skip of await capabilityPackageManager.runtimePackageSkips()) {
      skipped.push({ packageId: skip.packageId, reason: skip.reason });
      if (skip.reason === "persisted-error") {
        logger.warn(
          {
            event: "package.activate",
            packageId: skip.packageId,
            version: skip.version,
            outcome: "skipped",
            reason: "persisted-error",
            errorCode: "ME_PACKAGE_PERSISTED_ERROR",
            storedError: sanitizeDiagnosticText(skip.storedError ?? "").slice(0, 300),
          },
          "[capability] Package not activated: it failed on a previous start; re-enable it in Settings to retry",
        );
      } else {
        logger.debug(
          {
            event: "package.activate",
            packageId: skip.packageId,
            version: skip.version,
            outcome: "skipped",
            reason: "no-server-entrypoint",
          },
          "[capability] Package has no server runtime",
        );
      }
    }
    const results: ActivationResult[] = [];
    for (const runtimePackage of await capabilityPackageManager.runtimePackages()) {
      const packageStarted = Date.now();
      try {
        const result = await this.activateOne(app, runtimePackage, true, false);
        results.push(result);
        if (result.rollbackResult) results.push(result.rollbackResult);
      } catch (error) {
        // Bookkeeping (a registry write) failed while handling a failure. Record it and keep going.
        const elapsedMs = Date.now() - packageStarted;
        const reference = reportDiagnosticError(
          error,
          { operation: "package.activate", stage: "failure-handling" },
          undefined,
          {
            event: "package.activate",
            message: "[capability] Package activation bookkeeping failed",
            fields: {
              packageId: runtimePackage.installed.id,
              version: runtimePackage.installed.version,
              outcome: "failed",
              elapsedMs,
            },
          },
        );
        results.push({
          packageId: runtimePackage.installed.id,
          version: runtimePackage.installed.version,
          outcome: "failed",
          stage: "failure-handling",
          elapsedMs,
          errorId: reference.errorId,
          errorCode: reference.code,
        });
      }
    }
    for (const result of results) {
      if (result.outcome === "skipped")
        skipped.push({ packageId: result.packageId, reason: result.reason ?? "skipped" });
    }
    const summary = {
      elapsedMs: Date.now() - started,
      activated: results.filter((result) => result.outcome === "ok").map((result) => result.packageId),
      failed: results
        .filter((result) => result.outcome === "failed")
        .map(({ packageId, stage, errorCode, errorId }) => ({ packageId, stage, errorCode, errorId })),
      skipped,
      rolledBack: results
        .filter((result) => result.outcome === "rolled-back")
        .map((result) => ({ packageId: result.packageId, from: result.version, to: result.rolledBackTo })),
    };
    const degraded = summary.failed.length > 0 || summary.rolledBack.length > 0;
    logger[degraded ? "warn" : "info"](
      { event: "package.activate.summary", ...summary },
      "[capability] Packages: %d activated, %d failed, %d skipped, %d rolled back",
      summary.activated.length,
      summary.failed.length,
      summary.skipped.length,
      summary.rolledBack.length,
    );
    startup.record("packages", summary);
  }

  private async ensureModuleResolution(): Promise<void> {
    try {
      await linkCapabilityNativeDependencies(join(DATA_DIR, "capability-runtime-snapshots"));
    } catch (error) {
      logger.warn(error, "Could not link native package runtime dependencies");
    }
    const packageRoot = join(DATA_DIR, "capability-packages");
    const link = join(packageRoot, "node_modules");
    if (existsSync(link)) return;
    const serverNodeModules = resolve(dirname(fileURLToPath(import.meta.url)), "../../../node_modules");
    if (!existsSync(serverNodeModules)) return;
    await mkdir(packageRoot, { recursive: true });
    try {
      await symlink(serverNodeModules, link, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (!existsSync(link)) logger.warn(error, "Could not link package runtime dependencies");
    }
  }

  private async createVerifiedRuntimeSnapshot(
    installed: InstalledCapabilityPackage,
    verified: Awaited<ReturnType<typeof capabilityPackageManager.verifiedRuntimeFiles>>,
  ) {
    const snapshotsRoot = join(DATA_DIR, "capability-runtime-snapshots");
    const root = join(snapshotsRoot, `${installed.id}-${installed.version}-${randomUUID()}`);
    await mkdir(snapshotsRoot, { recursive: true, mode: 0o700 });
    await mkdir(root, { mode: 0o700 });
    try {
      for (const [relativePath, data] of verified.files) {
        const output = join(root, relativePath);
        await mkdir(dirname(output), { recursive: true, mode: 0o700 });
        await writeFile(output, data, { flag: "wx", mode: 0o400 });
      }
      await writeFile(join(root, "manifest.json"), JSON.stringify(installed.manifest), { flag: "wx", mode: 0o400 });
      const nodeModules = join(DATA_DIR, "capability-packages", "node_modules");
      if (existsSync(nodeModules) && !existsSync(join(root, "node_modules"))) {
        await symlink(nodeModules, join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
      }
      return {
        entrypoint: join(root, verified.entrypoint),
        cleanup: () => rm(root, { recursive: true, force: true }),
      };
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  private async activateOne(
    app: FastifyInstance,
    runtimePackage: Awaited<ReturnType<typeof capabilityPackageManager.runtimePackages>>[number],
    allowRollback: boolean,
    throwOnFailure: boolean,
  ): Promise<ActivationResult> {
    return withDiagnosticContext(
      { operation: "package.activate", operationId: randomUUID(), stage: "mark-pending" },
      () => this.activateInContext(app, runtimePackage, allowRollback, throwOnFailure),
    );
  }

  private async activateInContext(
    app: FastifyInstance,
    runtimePackage: Awaited<ReturnType<typeof capabilityPackageManager.runtimePackages>>[number],
    allowRollback: boolean,
    throwOnFailure: boolean,
  ): Promise<ActivationResult> {
    const { installed } = runtimePackage;
    const packageId = installed.id;
    const version = installed.version;
    const started = Date.now();
    let stage: ActivationStage = "mark-pending";
    const registeredCleanups: Cleanup[] = [];
    const toolCleanups: Array<() => void> = [];
    let moduleCleanup: Cleanup | undefined;
    // A package can keep hold of the activation context and call back into it later. Once this
    // activation has been torn down, those calls must not reach the host: a tool registered after
    // cleanup belongs to a package that is no longer running, and a re-activated package would have
    // its live tool replaced by the dead runtime's.
    let activationLive = true;
    try {
      await capabilityPackageManager.markRuntimeReadiness(installed.id, "pending");
      stage = "verify-files";
      const blockReason = capabilityPackageManager.runtimeBlockReason(installed);
      if (blockReason) throw new Error(blockReason);
      const verified = await capabilityPackageManager.verifiedRuntimeFiles(installed);
      stage = "snapshot";
      const runtimeSnapshot = await this.createVerifiedRuntimeSnapshot(installed, verified);
      registeredCleanups.push(runtimeSnapshot.cleanup);
      stage = "import";
      const module = (await import(pathToFileURL(runtimeSnapshot.entrypoint).href)) as CapabilityModule;
      if (typeof module.activate !== "function") throw new Error("Server entrypoint must export activate(context)");
      stage = "activate";
      const trackCleanup = (cleanup: Cleanup) => {
        let called = false;
        const guardedCleanup = () => {
          if (called) return;
          called = true;
          return cleanup();
        };
        registeredCleanups.push(guardedCleanup);
        return guardedCleanup;
      };
      const context: CapabilityActivationContext = {
        app,
        dataDir: DATA_DIR,
        package: installed,
        api: {
          runtime: await createCapabilityRuntimeHost(
            app,
            installed.id,
            installed.version,
            installed.manifest.permissions ?? [],
          ),
          registerTurnGameEngine: (engine) => trackCleanup(registerTurnGameEngine(engine)),
          registerConversationCommand: (registration) => {
            if (registration.handler && !installed.manifest.permissions?.includes("conversation-actions")) {
              throw new Error(
                `Capability package ${installed.id} must declare the "conversation-actions" permission to handle model actions`,
              );
            }
            return trackCleanup(registerCapabilityConversationCommand(registration));
          },
          registerService: (key, service) => {
            assertCapabilityAgentRuntimeServiceRegistration(installed.id, installed.manifest.permissions ?? [], key);
            return trackCleanup(registerCapabilityService(key, service));
          },
          // Gated on the permission the manifest already declares, so a package can't reach the prompt
          // without asking for it up front. Contract in capability-prompt-context.service.ts.
          registerPromptContext: (contributor) => {
            if (!installed.manifest.permissions?.includes("prompt-context")) {
              throw new Error(
                `Capability package ${installed.id} must declare the "prompt-context" permission to contribute prompt context`,
              );
            }
            return trackCleanup(registerCapabilityPromptContext(installed.id, contributor));
          },
          registerTool: (registration) => {
            if (!installed.manifest.permissions?.includes("tools")) {
              throw new Error(
                `Capability package ${installed.id} must declare the "tools" permission to register a tool`,
              );
            }
            if (!activationLive) {
              throw new Error(`Capability package ${installed.id} cannot register a tool after its activation ended`);
            }
            const release = registerCapabilityTool(installed.id, registration);
            toolCleanups.push(release);
            return trackCleanup(release);
          },
          registerPrivilegedRoutes: async (routes, options) =>
            trackCleanup(await registerCapabilityPrivilegedRoutes(app, installed, routes, options)),
          // Each internal call is its own traceable request: a fresh root context and an x-request-id the
          // HTTP layer honours, so the route's lines can be tied back to the package that made the call.
          runInternalRoute: (options) => {
            const operationId = randomUUID();
            const request = typeof options === "string" ? { url: options } : options;
            return runWithRootDiagnosticContext({ operation: `package.${installed.id}`, operationId }, () =>
              runCapabilityInternalRoute(app, installed.id, {
                ...request,
                headers: { "x-request-id": `pkg-${operationId}`, ...request.headers },
              }),
            );
          },
        },
      };
      const cleanup = await module.activate(context);
      if (typeof cleanup === "function") moduleCleanup = cleanup;
      stage = "mark-registered";
      await capabilityPackageManager.markRuntimeReadiness(installed.id, "registered");
      stage = "self-check";
      await module.selfCheck?.(context);
      stage = "mark-active";
      await capabilityPackageManager.markRuntimeStatus(installed.id, "active");
      await capabilityPackageManager.markRuntimeReadiness(installed.id, "ready");
      this.cleanups.set(installed.id, async () => {
        // A module cleanup that throws must not strand the host-side registrations. A tool left in
        // the registry would be offered to a model whose package is no longer there to answer it,
        // so tracked cleanups and the tool release run either way and the first error is rethrown.
        activationLive = false;
        // Release only this activation's tools before awaiting package cleanup. An old
        // teardown cannot delete replacements registered by a concurrent activation.
        for (const release of toolCleanups.splice(0)) release();
        try {
          if (moduleCleanup) await withDeadline(moduleCleanup(), "Capability module cleanup", 8000);
        } finally {
          await runCleanups(registeredCleanups);
        }
      });
      const elapsedMs = Date.now() - started;
      logger.info(
        { event: "package.activate", packageId, version, outcome: "ok", elapsedMs },
        "[capability] Package activated",
      );
      this.activationErrors.delete(packageId);
      return { packageId, version, outcome: "ok", stage, elapsedMs };
    } catch (error) {
      const elapsedMs = Date.now() - started;
      // Classify first, then write exactly one line for the failure.
      let reference: ReturnType<typeof reportDiagnosticError> | undefined;
      if (isHostLifecycleActivationError(error)) {
        // Keep the installed version and status so the next boot activates it normally.
        logger.warn(
          {
            event: "package.activate",
            packageId,
            version,
            stage,
            outcome: "skipped",
            reason: "host-booted-early",
            errorCode: "ME_EARLY_BOOT",
            err: error,
            elapsedMs,
          },
          "[capability] Package not activated: the server finished starting too early; it will be retried on the next start",
        );
      } else {
        reference = reportDiagnosticError(error, { operation: "package.activate", stage }, undefined, {
          event: "package.activate",
          message: "[capability] Package activation failed",
          fields: { packageId, version, outcome: "failed", elapsedMs },
        });
      }
      this.activationErrors.set(packageId, {
        message: error instanceof Error ? error.message : String(error),
        at: new Date().toISOString(),
        ...(reference ? { errorId: reference.errorId, errorCode: reference.code } : { errorCode: "ME_EARLY_BOOT" }),
      });
      activationLive = false;
      for (const release of toolCleanups.splice(0)) release();
      try {
        try {
          if (moduleCleanup) await withDeadline(moduleCleanup(), "Capability module cleanup", 8000);
        } finally {
          await runCleanups(registeredCleanups);
        }
      } catch (cleanupError) {
        logger.warn(
          { event: "package.activate", packageId, action: "cleanup", errorId: reference?.errorId, err: cleanupError },
          "Capability package %s cleanup failed after activation error",
          installed.id,
        );
      }
      if (!reference) {
        if (throwOnFailure) throw error;
        return { packageId, version, outcome: "skipped", reason: "host-booted-early", stage, elapsedMs };
      }
      const failure = { errorId: reference.errorId, errorCode: reference.code };
      const rollback = allowRollback ? await capabilityPackageManager.rollbackRuntime(installed.id) : null;
      if (rollback?.restored) {
        const previous = rollback.restored;
        logger.warn(
          {
            event: "package.rollback",
            packageId,
            fromVersion: version,
            toVersion: previous.installed.version,
            ...failure,
            stage,
          },
          "[capability] Rolling package %s back to %s",
          packageId,
          previous.installed.version,
        );
        const rollbackResult = await this.activateOne(app, previous, false, false);
        if (throwOnFailure) {
          // The rollback activation swallows its own failure, so only a registered runtime proves it came back.
          const restored = this.cleanups.has(installed.id);
          throw new Error(
            restored
              ? `Could not activate ${installed.id}@${installed.version}; restored ${previous.installed.version}`
              : `Could not activate ${installed.id}@${installed.version}, and rolling back to ${previous.installed.version} also failed`,
            { cause: error },
          );
        }
        return {
          packageId,
          version,
          outcome: "rolled-back",
          stage,
          elapsedMs,
          ...failure,
          rolledBackTo: previous.installed.version,
          rollbackResult,
        };
      }
      if (rollback) {
        logger.warn(
          {
            event: "package.rollback",
            packageId,
            outcome: "skipped",
            reason: rollback.reason,
            previousVersion: installed.previousVersion ?? null,
            detail: rollback.detail,
            errorId: failure.errorId,
          },
          "[capability] Package %s was not rolled back",
          packageId,
        );
      }
      logger.error(
        { event: "package.state", packageId, version, state: "failed", persisted: true, ...failure, stage },
        "[capability] Package disabled until re-enabled",
      );
      // The trailing [errorId] lets /api/health and the Settings UI point at the matching log line.
      const message = `${sanitizeDiagnosticText(error instanceof Error ? error.message : String(error))} [${failure.errorId}]`;
      await capabilityPackageManager.markRuntimeStatus(installed.id, "error", message);
      await capabilityPackageManager.markRuntimeReadiness(installed.id, "error", message);
      if (throwOnFailure) throw error;
      return { packageId, version, outcome: "failed", stage, elapsedMs, ...failure, persistedStatus: "error" };
    }
  }

  async activatePackage(app: FastifyInstance, packageId: string): Promise<InstalledCapabilityPackage> {
    prepareCapabilityRuntimeEnvironment();
    await this.ensureModuleResolution();
    const runtimePackage = (await capabilityPackageManager.runtimePackages()).find(
      ({ installed }) => installed.id === packageId,
    );
    if (!runtimePackage) throw new Error(`Installed capability package ${packageId} has no server runtime`);
    await this.deactivatePackage(packageId);
    await this.activateOne(app, runtimePackage, true, true);
    const installed = (await capabilityPackageManager.installed()).find((item) => item.id === packageId);
    if (!installed) throw new Error(`Capability package ${packageId} disappeared during activation`);
    return installed;
  }

  async deactivatePackage(packageId: string): Promise<void> {
    const cleanup = this.cleanups.get(packageId);
    if (!cleanup) return;
    this.cleanups.delete(packageId);
    try {
      await cleanup();
    } catch (error) {
      logger.warn(error, "Capability package %s cleanup failed during deactivation", packageId);
    }
    logger.info("Deactivated capability package %s", packageId);
  }

  async stop(): Promise<void> {
    for (const [packageId, cleanup] of [...this.cleanups.entries()].reverse()) {
      this.cleanups.delete(packageId);
      try {
        await cleanup();
      } catch (error) {
        logger.warn(error, "Capability package cleanup failed");
      }
    }
  }
}

export const capabilityModuleRuntime = new CapabilityModuleRuntime();
