// ──────────────────────────────────────────────
// Best-effort work: failures that are logged, not thrown
// ──────────────────────────────────────────────
// Replaces bare `.catch(() => {})` and `catch { /* ignore */ }`. The failure
// still reaches the log once per minute per event, chat and stage, and the
// caller keeps going. The error is not marked reported: if it also reaches a
// real failure path later, that path still logs it in full.
import type { DiagnosticContext } from "./diagnostics.js";
import { createDiagnostic } from "./diagnostics.js";
import { logRepeated } from "./log-events.js";

export type SuppressedFields = {
  event: string;
  stage?: string;
  errorCode?: string;
  level?: "warn" | "debug";
} & DiagnosticContext &
  Record<string, unknown>;

/** Logs a failure the caller deliberately swallows (outcome "failed", suppressed true), rate-limited to one line a minute per key. */
export function logSuppressed(error: unknown, fields: SuppressedFields): void {
  const { level, ...rest } = fields;
  logRepeated(
    `${fields.event}:${fields.chatId ?? ""}:${fields.stage ?? ""}`,
    level ?? "warn",
    {
      err: error,
      outcome: "failed",
      suppressed: true,
      errorCode: fields.errorCode ?? createDiagnostic(error).code,
      ...rest,
    },
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
