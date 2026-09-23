// ──────────────────────────────────────────────
// Startup timeline: one timed record per boot phase
// ──────────────────────────────────────────────
import { withDiagnosticContext } from "./diagnostics.js";
import { reportDiagnosticError } from "./diagnostic-operation.js";
import { getBootId, logger } from "./logger.js";

export interface StartupPhaseRecord {
  stage: string;
  elapsedMs: number;
  outcome: "ok" | "failed" | "skipped";
  optional?: boolean;
  errorId?: string;
  errorCode?: string;
}

export interface StartupSummary {
  bootId: string;
  elapsedMs: number;
  phases: { count: number; failed: StartupPhaseRecord[]; slowest: StartupPhaseRecord[] };
  [fact: string]: unknown;
}

const failedStages = new WeakMap<object, string>();

export const startup = {
  get bootId(): string {
    return getBootId();
  },
  currentStage: undefined as string | undefined,
  phases: [] as StartupPhaseRecord[],
  /** packages, storage, buildIntegrity, removedCorePackages, legacyMaps, memory... */
  facts: {} as Record<string, unknown>,

  /**
   * Runs one boot step inside `{ operation: "startup", operationId: bootId, stage }`
   * and records its time. A failure is reported once; a required phase rethrows,
   * an optional phase logs warn and returns undefined.
   */
  async phase<T>(stage: string, work: () => Promise<T> | T, opts: { optional?: boolean } = {}): Promise<T | undefined> {
    startup.currentStage = stage;
    const started = performance.now();
    try {
      const result = await withDiagnosticContext({ operation: "startup", operationId: getBootId(), stage }, () =>
        work(),
      );
      const elapsedMs = Math.round(performance.now() - started);
      startup.phases.push({ stage, elapsedMs, outcome: "ok", ...(opts.optional ? { optional: true } : {}) });
      const fields = { event: "startup.phase", stage, elapsedMs, outcome: "ok" };
      if (elapsedMs > 5_000) logger.warn(fields, "[startup] %s took %d ms", stage, elapsedMs);
      else if (elapsedMs > 1_000) logger.info(fields, "[startup] %s took %d ms", stage, elapsedMs);
      else logger.debug(fields, "[startup] %s done", stage);
      return result;
    } catch (err) {
      const elapsedMs = Math.round(performance.now() - started);
      const optional = !!opts.optional;
      const ref = reportDiagnosticError(err, { operation: "startup", stage }, undefined, {
        event: "startup.phase",
        level: optional ? "warn" : "error",
        message: `[startup] ${stage} failed`,
        fields: { outcome: "failed", elapsedMs, optional },
      });
      if (err && typeof err === "object" && !failedStages.has(err)) failedStages.set(err, stage);
      startup.phases.push({
        stage,
        elapsedMs,
        outcome: "failed",
        ...(optional ? { optional: true } : {}),
        errorId: ref.errorId,
        errorCode: ref.code,
      });
      if (!optional) throw err;
      return undefined;
    }
  },

  record(key: string, value: unknown): void {
    startup.facts[key] = value;
  },

  /** The phase an error failed in, when it came out of startup.phase. */
  stageOf(error: unknown): string | undefined {
    return error && typeof error === "object" ? failedStages.get(error) : undefined;
  },

  summary(): StartupSummary {
    const slowest = [...startup.phases].sort((a, b) => b.elapsedMs - a.elapsedMs).slice(0, 8);
    return {
      bootId: getBootId(),
      elapsedMs: Math.round(process.uptime() * 1000),
      phases: {
        count: startup.phases.length,
        failed: startup.phases.filter((phase) => phase.outcome === "failed"),
        slowest,
      },
      ...startup.facts,
    };
  },
};
