// ──────────────────────────────────────────────
// Best-effort work: failures that are logged, not thrown
// ──────────────────────────────────────────────
// Replaces bare `.catch(() => {})` and `catch { /* ignore */ }`. The failure
// reaches the log at most once a minute per event, chat and stage, and the
// caller keeps going. The error is not marked reported: if it also reaches a
// real failure path later, that path still logs it in full.
import type { DiagnosticContext } from "./diagnostics.js";
import { createDiagnostic } from "./diagnostics.js";
import { logRepeated } from "./log-events.js";

export type SuppressedFields = {
  /** What was being done, for example "storage.flush" or "agent.run". */
  event: string;
  stage?: string;
  chatId?: string;
  errorCode?: string;
  /** "debug" for expected cleanup failures; "warn" (the default) for real ones. */
  level?: "warn" | "debug";
} & DiagnosticContext &
  Record<string, unknown>;

/** The structured line for a swallowed failure; invariant fields always describe the failure. */
export function suppressedLogLine(error: unknown, fields: SuppressedFields): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...fields };
  delete rest.level;
  return { ...rest, err: error, outcome: "failed", suppressed: true };
}

/** Logs a failure the caller deliberately swallows (outcome "failed", suppressed true), rate-limited per key. */
export function logSuppressed(error: unknown, fields: SuppressedFields): void {
  const line = suppressedLogLine(error, fields);
  logRepeated(
    `${fields.event}:${fields.chatId ?? ""}:${fields.stage ?? ""}`,
    fields.level ?? "warn",
    { ...line, event: fields.event, errorCode: fields.errorCode ?? createDiagnostic(error).code },
    "Suppressed failure",
    { windowMs: 60_000 },
  );
}

/** Resolves to `fallback` instead of rejecting, and logs the failure through logSuppressed. */
export function orFallback<T, F>(promise: Promise<T>, fallback: F, fields: SuppressedFields): Promise<T | F> {
  return promise.catch((error: unknown) => {
    logSuppressed(error, fields);
    return fallback;
  });
}

/** Runs `work` and returns undefined instead of throwing; the failure is logged through logSuppressed. */
export async function bestEffort<T>(fields: SuppressedFields, work: () => Promise<T>): Promise<T | undefined> {
  try {
    return await work();
  } catch (error) {
    logSuppressed(error, fields);
    return undefined;
  }
}
