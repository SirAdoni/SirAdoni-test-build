// ──────────────────────────────────────────────
// Runtime diagnostics snapshot (admin, read-only)
// ──────────────────────────────────────────────
// The privileged companion to the public /api/health reply. /api/health already
// serves the version and build, the memory snapshot, the startup summary, the
// build-integrity result and each package's registry status, so none of that
// is repeated here. This adds only what health does not carry: memory peaks
// (from utils/runtime-memory), storage residency detail, whether each capability
// package runtime is actually live (and its last activation failure), the worker
// gauges and the continuity queue and breaker detail the gauge leaves out.
// Counts and states only: no row content, no settings values, no connection
// details. Every section is collected on its own, so one failing source
// degrades to { error } instead of failing the whole snapshot.
import { getFileStoreStats } from "../db/connection.js";
import { capabilityModuleRuntime } from "../services/capability-packages/capability-module-runtime.service.js";
import { capabilityPackageManager } from "../services/capability-packages/package-manager.service.js";
import { getRuntimeMemoryPeaks } from "../utils/runtime-memory.js";
import { sanitizeDiagnosticText } from "./diagnostics.js";
import { sampleWorkerGauges } from "./worker-gauges.js";

const MAX_ERROR_TEXT = 500;

function errorText(error: unknown): string {
  return sanitizeDiagnosticText(error instanceof Error ? error.message : String(error), MAX_ERROR_TEXT);
}

async function section<T>(collect: () => T | Promise<T>): Promise<T | { error: string }> {
  try {
    return await collect();
  } catch (error) {
    return { error: errorText(error) };
  }
}

/** Process facts /api/health leaves out. The current memory snapshot is in /api/health; only the peaks are here. */
export function collectProcessDiagnostics() {
  return {
    pid: process.pid,
    node: process.version,
    platform: process.platform,
    uptimeSeconds: Math.round(process.uptime()),
    memoryPeaks: getRuntimeMemoryPeaks(),
  };
}

/**
 * What the storage worker gauge (resident units, dirty count, top tables) does
 * not carry: which tables are dirty or fully resident, the last flush failure
 * and the quarantine count.
 */
export function collectStorageDiagnostics() {
  const stats = getFileStoreStats();
  if (!stats) return { open: false as const };
  let residentRows = 0;
  let lazyTables = 0;
  for (const table of Object.values(stats.tables)) {
    residentRows += table.rows;
    if (table.lazy) lazyTables += 1;
  }
  return {
    open: true as const,
    // Lazy tables only count the rows loaded into memory, not every row on disk.
    residentRows,
    tableCount: Object.keys(stats.tables).length,
    lazyTables,
    residentChatUnits: stats.residentChatUnits,
    fullyResidentLazyTables: Object.entries(stats.tables)
      .filter(([, table]) => table.lazy && table.fullyResident)
      .map(([name]) => name)
      .sort(),
    dirtyTables: stats.dirtyTables,
    lastFlushError: stats.lastFlushError ? sanitizeDiagnosticText(stats.lastFlushError, MAX_ERROR_TEXT) : null,
    quarantinedTables: stats.quarantinedTables,
  };
}

export type CapabilityPackageRuntimeState = "active" | "failed" | "skipped" | "restart-required" | "pending";

/** The errorCode CapabilityModuleRuntime records when the host was booted too early; package.activate logs that case as outcome "skipped". */
export const EARLY_BOOT_ERROR_CODE = "ME_EARLY_BOOT";

type PackageStateInput = {
  status: string;
  readiness?: string;
  hasServer: boolean;
  live: boolean | null;
  activationFailed: boolean;
  /** errorCode of the recorded activation failure, if any. */
  activationErrorCode?: string | null;
};

/**
 * Registry status alone is not enough: a host-lifecycle activation failure at
 * boot deliberately keeps the registry "active" so the next start retries. A
 * server package that is not running is "skipped" when that early-boot case
 * was recorded (the same outcome the package.activate line logs), "failed" for
 * any other recorded activation failure, and "pending" with no failure yet
 * (for example part-way through its first activation).
 */
export function derivePackageRuntimeState(input: PackageStateInput): CapabilityPackageRuntimeState {
  if (input.status === "restart-required") return "restart-required";
  if (input.status === "error" || input.readiness === "error") return "failed";
  if (!input.hasServer || input.live) return "active";
  if (!input.activationFailed) return "pending";
  return input.activationErrorCode === EARLY_BOOT_ERROR_CODE ? "skipped" : "failed";
}

export async function collectCapabilityPackageDiagnostics() {
  const installed = await capabilityPackageManager.installed();
  const runtime = capabilityModuleRuntime.runtimeState();
  const live = new Set(runtime.live);
  const packages = installed.map((item) => {
    const hasServer = Boolean(item.manifest.entrypoints?.server);
    const activationError = runtime.activationErrors[item.id];
    const isLive = hasServer ? live.has(item.id) : null;
    const state = derivePackageRuntimeState({
      status: item.status,
      readiness: item.readiness,
      hasServer,
      live: isLive,
      activationFailed: Boolean(activationError),
      activationErrorCode: activationError?.errorCode ?? null,
    });
    const rawError =
      item.error ||
      item.readinessError ||
      (state === "failed" || state === "skipped" ? activationError?.message : null) ||
      null;
    return {
      id: item.id,
      version: item.version,
      status: item.status,
      readiness: item.readiness,
      hasServer,
      live: isLive,
      state,
      error: rawError ? sanitizeDiagnosticText(rawError, MAX_ERROR_TEXT) : null,
      lastActivationFailureAt: activationError?.at ?? null,
      lastActivationFailure: activationError
        ? {
            at: activationError.at,
            errorId: activationError.errorId ?? null,
            errorCode: activationError.errorCode ?? null,
          }
        : null,
    };
  });
  const counts: Record<CapabilityPackageRuntimeState, number> = {
    active: 0,
    failed: 0,
    skipped: 0,
    "restart-required": 0,
    pending: 0,
  };
  for (const item of packages) counts[item.state] += 1;
  return { counts, packages };
}

export type WorkerSources = {
  continuity?: {
    health(): { pausedUntil: number | null; pauseCode: string | null; transientFailures: number };
    /** Extra queue detail (parked, backfill) when the continuity runtime provides it. */
    queueStats?(): Record<string, unknown>;
  } | null;
};

/** Fields the continuity worker gauge already carries; gameContinuity leaves them to gauges.continuity. */
const CONTINUITY_GAUGE_FIELDS = new Set(["pending", "active", "pausedUntil"]);

/** The worker gauges (the same samples runtime.memory lines carry), plus the continuity detail the gauge leaves out. */
export function collectWorkerDiagnostics(sources: WorkerSources) {
  const gauges = sampleWorkerGauges();
  const continuity = sources.continuity;
  if (!continuity) return { gauges, gameContinuity: null };
  const health = continuity.health();
  const queue = Object.fromEntries(
    Object.entries(continuity.queueStats?.() ?? {}).filter(([key]) => !CONTINUITY_GAUGE_FIELDS.has(key)),
  );
  return {
    gauges,
    gameContinuity: {
      ...queue,
      pauseCode: health.pauseCode,
      transientFailures: health.transientFailures,
    },
  };
}

export async function collectRuntimeDiagnostics(sources: WorkerSources) {
  const [processInfo, storage, capabilityPackages, workers] = await Promise.all([
    section(collectProcessDiagnostics),
    section(collectStorageDiagnostics),
    section(collectCapabilityPackageDiagnostics),
    section(() => collectWorkerDiagnostics(sources)),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    process: processInfo,
    storage,
    capabilityPackages,
    workers,
  };
}
