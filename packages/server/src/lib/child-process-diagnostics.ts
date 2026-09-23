// ──────────────────────────────────────────────
// Child process failures: one classified error with the useful facts
// ──────────────────────────────────────────────
import { sanitizeDiagnosticText } from "./diagnostics.js";

export type ChildFailureCode = "ME_CHILD_TIMEOUT" | "ME_CHILD_EXIT" | "ME_CHILD_SPAWN";

export interface ChildFailureFields {
  errorCode: ChildFailureCode;
  exitCode?: number | null;
  signal?: string | null;
  timedOut: boolean;
  elapsedMs: number;
  /** Last 8 lines of stderr, sanitized, 800 characters max. */
  stderrTail?: string;
}

function stderrTailOf(stderr: string | undefined): string | undefined {
  if (!stderr) return undefined;
  const tail = stderr.split(/\r?\n/).filter(Boolean).slice(-8).join("\n");
  if (!tail) return undefined;
  const safe = sanitizeDiagnosticText(tail, 800);
  return safe.length > 800 ? safe.slice(-800) : safe;
}

/**
 * Classifies a failed child process (execFile, spawn) and wraps it as
 * `new Error("<command> failed", { cause })` with the fields assigned onto it,
 * ready for reportDiagnosticError or logger.error({ err, ...fields }).
 * `command` must be the executable name only, never its arguments.
 */
export function describeChildFailure(
  err: unknown,
  opts: { command: string; timeoutMs?: number; startedAt: number; stderr?: string },
): { error: Error; fields: ChildFailureFields } {
  const source = (err && typeof err === "object" ? err : {}) as Record<string, unknown>;
  const elapsedMs = Math.max(0, Date.now() - opts.startedAt);
  const signal = typeof source.signal === "string" ? source.signal : source.signal === null ? null : undefined;
  const rawCode = source.code;
  const exitCode =
    typeof source.exitCode === "number" ? source.exitCode : typeof rawCode === "number" ? rawCode : undefined;
  const timedOut = (source.killed === true || !!signal) && opts.timeoutMs !== undefined && elapsedMs >= opts.timeoutMs;
  const errorCode: ChildFailureCode = timedOut
    ? "ME_CHILD_TIMEOUT"
    : rawCode === "ENOENT" || rawCode === "EACCES"
      ? "ME_CHILD_SPAWN"
      : "ME_CHILD_EXIT";
  const stderrTail = stderrTailOf(opts.stderr ?? (typeof source.stderr === "string" ? source.stderr : undefined));
  const fields: ChildFailureFields = {
    errorCode,
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(signal !== undefined ? { signal } : {}),
    timedOut,
    elapsedMs,
    ...(stderrTail ? { stderrTail } : {}),
  };
  const command = opts.command.split(/[\\/]/).pop()?.split(/\s+/, 1)[0] ?? "child process";
  const error = new Error(`${command} failed`, { cause: err });
  Object.assign(error, fields);
  return { error, fields };
}
