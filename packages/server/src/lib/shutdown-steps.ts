import { logSuppressed } from "./best-effort.js";

/**
 * Shutdown stops background runtimes before closing the file store. A runtime
 * whose stop() never settles (a worker waiting on a hung model call, say) must
 * not hold the store close hostage: the process force-exits at the shutdown
 * deadline, and if closeDB() has not run by then the debounced writes are lost.
 * So the stop phase gets its own budget, well inside the force-exit deadline,
 * and the store close always runs after it.
 */
export const RUNTIME_STOP_BUDGET_MS = 2_000;

/**
 * Time kept free after the runtime stops for the rest of onClose: queued
 * transactions, the final store flush and the writer lease release. Every
 * shutdown deadline pair must leave at least this much after the connection
 * cut and the runtime stop budget.
 */
export const STORE_CLOSE_RESERVE_MS = 1_500;

let activeRuntimeStopBudgetMs = RUNTIME_STOP_BUDGET_MS;

/** The runtime stop budget for the shutdown in progress. */
export function getRuntimeStopBudgetMs(): number {
  return activeRuntimeStopBudgetMs;
}

/**
 * Tightens (or restores) the runtime stop budget before app.close() runs, so
 * a shutdown with a short force-exit deadline (a Windows console close) still
 * leaves the store close its reserve.
 */
export function setRuntimeStopBudgetMs(budgetMs: number = RUNTIME_STOP_BUDGET_MS): void {
  activeRuntimeStopBudgetMs = Math.max(0, budgetMs);
}

export interface NamedShutdownStep {
  name: string;
  run: () => unknown;
}

export interface ShutdownStepRecord {
  stage: string;
  elapsedMs: number;
  /** Logging vocabulary outcome: a step still pending at the budget is "failed" with reason "timeout". */
  outcome: "ok" | "failed";
  reason?: "timeout";
  /** Set with reason "timeout": the budget the step overran. */
  timeoutMs?: number;
}

export interface ShutdownStepsOptions {
  /**
   * Called when a step that already timed out rejects later. Defaults to a
   * suppressed-failure log line so the late error is recorded, not lost.
   */
  onLateFailure?: (name: string, reason: unknown, elapsedMs: number) => void;
}

function logLateShutdownFailure(name: string, reason: unknown, elapsedMs: number): void {
  logSuppressed(reason, { event: "shutdown.service", stage: name, reason: "late_failure_after_timeout", elapsedMs });
}

export interface ShutdownStepsResult {
  failed: Array<{ name: string; reason: unknown; elapsedMs: number }>;
  /** Steps still pending when the budget ran out; they keep running detached. */
  timedOut: string[];
  /** One record per step, in step order, for the shutdown summary line. */
  records: ShutdownStepRecord[];
}

export async function runShutdownStepsWithin(
  steps: NamedShutdownStep[],
  budgetMs: number = getRuntimeStopBudgetMs(),
  options: ShutdownStepsOptions = {},
): Promise<ShutdownStepsResult> {
  const onLateFailure = options.onLateFailure ?? logLateShutdownFailure;
  const started = performance.now();
  let budgetSpent = false;
  const failed: ShutdownStepsResult["failed"] = [];
  const outcomes = new Map<string, ShutdownStepRecord>();
  const settled = Promise.all(
    steps.map(async (step) => {
      const stepStarted = performance.now();
      try {
        await step.run();
        outcomes.set(step.name, {
          stage: step.name,
          elapsedMs: Math.round(performance.now() - stepStarted),
          outcome: "ok",
        });
      } catch (reason) {
        const elapsedMs = Math.round(performance.now() - stepStarted);
        if (budgetSpent) {
          // The caller already reported this step as timed out and moved on;
          // log the late error instead of dropping it.
          try {
            onLateFailure(step.name, reason, elapsedMs);
          } catch (reportError) {
            // The logger itself threw; fall back to a process warning (stderr) instead of an
            // unhandled rejection, so the late stop failure is still visible.
            process.emitWarning(
              `Shutdown step ${step.name} failed after its timeout and could not be logged: ${String(reportError)}`,
              "MarinaraShutdownWarning",
            );
          }
          return;
        }
        failed.push({ name: step.name, reason, elapsedMs });
        outcomes.set(step.name, { stage: step.name, elapsedMs, outcome: "failed" });
      }
    }),
  );
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<void>((resolve) => {
    // Referenced on purpose: a hung step holding no handles must not let the
    // loop drain before the store close below gets its turn.
    timer = setTimeout(resolve, budgetMs);
  });
  try {
    await Promise.race([settled, budget]);
  } finally {
    clearTimeout(timer);
    budgetSpent = true;
  }
  const waitedMs = Math.round(performance.now() - started);
  const timedOut: string[] = [];
  const records = steps.map((step) => {
    const record = outcomes.get(step.name);
    if (record) return record;
    timedOut.push(step.name);
    const timeoutRecord: ShutdownStepRecord = {
      stage: step.name,
      elapsedMs: waitedMs,
      outcome: "failed",
      reason: "timeout",
      timeoutMs: budgetMs,
    };
    return timeoutRecord;
  });
  return { failed: [...failed], timedOut, records };
}
