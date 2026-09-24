// ──────────────────────────────────────────────
// Structured log events: shared vocabulary helpers
// ──────────────────────────────────────────────
// Every structured line carries `event` (a dotted name from EventName) and, where
// it applies, `outcome`, `state`, `kind`, `errorCode` and `elapsedMs`. The same
// `state`, `kind` and `errorCode` values are the vocabulary of the generation-jobs
// work (E02), so a job's log lines and its stored record read the same way.
// See docs/development/logging.md.
import type pino from "pino";
import type { DiagnosticContext } from "./diagnostics.js";
import { createDiagnostic } from "./diagnostics.js";
import { reportDiagnosticError } from "./diagnostic-operation.js";
import { logger } from "./logger.js";

export type Outcome = "ok" | "failed" | "cancelled" | "skipped";
export type JobState =
  | "accepted"
  | "running"
  | "progress"
  | "completed"
  | "failed"
  | "cancelled"
  | "recovered"
  | "expired";
export type JobKind = "image" | "sprite" | "tts" | "video" | "illustration";

export type EventName =
  | "startup.build"
  | "startup.config"
  | "startup.phase"
  | "startup.early_boot"
  | "startup.inject_held"
  | "startup.inject_released"
  | "startup.build_check"
  | "startup.ready"
  | "startup.failed"
  | "shutdown.service"
  | "shutdown.complete"
  | "process.fatal"
  | "process.warning"
  | "request.end"
  | "request.slow"
  | "request.stream.end"
  | "request.aborted"
  | "request.error"
  | "operation.start"
  | "operation.end"
  | "operation.slow"
  | "diagnostic.failure"
  | "diagnostic.rethrown"
  | "package.activate"
  | "package.activate.summary"
  | "package.rollback"
  | "package.state"
  | "package.tables"
  | "package.contribute"
  | "package.service.missing"
  | "generation.start"
  | "generation.finished"
  | "generation.abort"
  | "generation.empty_response"
  | "generation.influence_consume"
  | "agent.result"
  | "agent.run"
  | "agent.batch"
  | "agent.retry"
  | "agent.pipeline.failed"
  | "agent.pipeline.degraded"
  | "agent.pipeline.parallel_failed"
  | "llm.call"
  | "llm.http"
  | "llm.retry"
  | "llm.throttle"
  | "llm.fallback"
  | "llm.stream.malformed"
  | "llm.stream.close"
  | "llm.context.trim"
  | "llm.config.invalid"
  | "llm.provider.unknown"
  | "llm.toolcall.invalid_args"
  | "llm.auth.refresh"
  | "llm.request.capture"
  | "job.state"
  | "job.progress"
  | "job.summary"
  | "job.result.large"
  | "media.queue"
  | "media.generate"
  | "media.fallback"
  | "provider.response.unexpected"
  | "continuity.stage"
  | "continuity.breaker"
  | "continuity.reconcile"
  | "continuity.publish"
  | "autonomous.backoff"
  | "autonomous.poll"
  | "conversation.summary"
  | "ltm.recall"
  | "storage.load"
  | "storage.flush"
  | "storage.flush.slow"
  | "storage.flush.deferred"
  | "storage.recover"
  | "storage.migrate"
  | "storage.close"
  | "storage.lazy.full_residency"
  | "storage.json_corrupt"
  | "storage.fsync"
  | "storage.rename.retry"
  | "storage.read.fallback"
  | "storage.materialize"
  | "backup.automatic"
  | "backup.failed"
  | "profile.import"
  | "profile.import.skip"
  | "profile.import.rollback"
  | "import.st"
  | "import.st.item"
  | "sidecar.spawn"
  | "sidecar.ready"
  | "sidecar.exit"
  | "sidecar.crashloop"
  | "sidecar.start"
  | "sidecar.sync"
  | "sidecar.download"
  | "sidecar.download.file"
  | "sidecar.download.retry"
  | "utility_sidecar.start"
  | "utility_sidecar.exit"
  | "utility_sidecar.fallback"
  | "sprite.cleanup.fallback"
  | "tts.speak"
  | "update.step"
  | "update.apply"
  | "update.build.verify"
  | "console_tray.start"
  | "console_tray.stop"
  | "console_tray.skipped"
  | "console_tray.failed"
  | "console_tray.quit"
  | "console_tray.open"
  | "runtime.memory"
  | "runtime.memory_pressure"
  | "runtime.freeze"
  | "log.write_failed"
  | "log.sink_failed"
  | "log.dropped"
  | "config.reload"
  | "prompt.debug"
  | "sse.unreferenced_error";

/**
 * Fields for a structured line. `prompt`, `messages` and `content` are typed `never`
 * so prompt text and message content cannot be passed by accident.
 */
export interface EventFields extends DiagnosticContext {
  outcome?: Outcome;
  state?: JobState;
  kind?: JobKind;
  elapsedMs?: number;
  errorCode?: string;
  errorId?: string;
  err?: unknown;
  prompt?: never;
  messages?: never;
  content?: never;
  [key: string]: unknown;
}

type RepeatLevel = "debug" | "info" | "warn" | "error";

/** Writes one structured line: `{ event, ...fields }` with `msg` defaulting to the event name. */
export function logEvent(level: pino.Level, event: EventName, fields: EventFields = {}, msg?: string): void {
  logger[level]({ event, ...fields }, msg ?? event);
}

/**
 * Runs `work`, measures `elapsedMs` and logs one line under `event`. Success logs
 * `outcome: "ok"` at opts.level (default debug), or at warn above opts.slowMs. A
 * rejection is reported once through reportDiagnosticError (outcome cancelled or
 * failed) and rethrown.
 */
export async function timed<T>(
  event: EventName,
  fields: EventFields,
  work: () => Promise<T>,
  opts: { level?: pino.Level; slowMs?: number } = {},
): Promise<T> {
  const started = Date.now();
  try {
    const result = await work();
    const elapsedMs = Date.now() - started;
    const slow = opts.slowMs !== undefined && elapsedMs > opts.slowMs;
    logEvent(slow ? "warn" : (opts.level ?? "debug"), event, {
      ...fields,
      outcome: "ok",
      elapsedMs,
      ...(slow ? { slow: true } : {}),
    });
    return result;
  } catch (error) {
    const elapsedMs = Date.now() - started;
    const { err: _err, ...rest } = fields;
    const cancelled = createDiagnostic(error).code === "ME_CANCELLED";
    reportDiagnosticError(error, undefined, undefined, {
      event,
      message: `${event} ${cancelled ? "cancelled" : "failed"}`,
      fields: { ...rest, outcome: cancelled ? "cancelled" : "failed", elapsedMs },
    });
    throw error;
  }
}

interface RepeatEntry {
  firstAt: number;
  windowStart: number;
  windowMs: number;
  suppressed: number;
  lastErrorCode?: string;
  event: string;
  level: RepeatLevel;
  fields: Record<string, unknown>;
}

const MAX_REPEAT_KEYS = 500;
const DEFAULT_REPEAT_WINDOW_MS = 15 * 60_000;
const repeats = new Map<string, RepeatEntry>();
let flushTimer: NodeJS.Timeout | undefined;
let flushEveryMs = DEFAULT_REPEAT_WINDOW_MS;

function contextOnly(fields: Record<string, unknown>): Record<string, unknown> {
  const keep: Record<string, unknown> = {};
  for (const key of [
    "chatId",
    "jobId",
    "stage",
    "operation",
    "provider",
    "model",
    "connectionId",
    "kind",
    "packageId",
  ]) {
    if (fields[key] !== undefined) keep[key] = fields[key];
  }
  return keep;
}

function writeSummary(key: string, entry: RepeatEntry): void {
  if (entry.suppressed === 0) return;
  logger[entry.level](
    {
      ...contextOnly(entry.fields),
      event: entry.event,
      repeatKey: key,
      suppressedCount: entry.suppressed,
      firstAt: new Date(entry.firstAt).toISOString(),
      ...(entry.lastErrorCode ? { lastErrorCode: entry.lastErrorCode } : {}),
    },
    "%s repeated %d more times",
    entry.event,
    entry.suppressed,
  );
  entry.suppressed = 0;
}

function flushRepeats(now = Date.now()): void {
  for (const [key, entry] of repeats) {
    if (now - entry.windowStart >= entry.windowMs && entry.suppressed > 0) {
      writeSummary(key, entry);
      entry.windowStart = now;
    }
  }
}

function ensureFlushTimer(windowMs: number): void {
  if (flushTimer && windowMs >= flushEveryMs) return;
  if (flushTimer) clearInterval(flushTimer);
  flushEveryMs = Math.min(flushEveryMs, windowMs);
  flushTimer = setInterval(() => flushRepeats(), flushEveryMs);
  flushTimer.unref?.();
}

function errorCodeOf(fields: Record<string, unknown>): string | undefined {
  if (typeof fields.errorCode === "string") return fields.errorCode;
  if (fields.err !== undefined) return createDiagnostic(fields.err).code;
  return undefined;
}

/**
 * Logs a line that can repeat many times (a poll that keeps failing, a stuck
 * provider). The first occurrence of `key` logs normally with `repeatKey`.
 * Repeats inside the window (default 15 min) are counted, not written. The first
 * call after the window closes writes one summary line with `suppressedCount`,
 * `firstAt` and `lastErrorCode`, then logs the current occurrence.
 */
export function logRepeated(
  key: string,
  level: RepeatLevel,
  fields: EventFields & { event: string },
  msg: string,
  opts: { windowMs?: number } = {},
): void {
  const now = Date.now();
  const windowMs = opts.windowMs ?? DEFAULT_REPEAT_WINDOW_MS;
  const entry = repeats.get(key);
  if (entry && now - entry.windowStart < entry.windowMs) {
    entry.suppressed++;
    entry.lastErrorCode = errorCodeOf(fields) ?? entry.lastErrorCode;
    return;
  }
  if (entry) {
    writeSummary(key, entry);
    entry.windowStart = now;
    entry.windowMs = windowMs;
    entry.level = level;
    entry.fields = fields;
    entry.lastErrorCode = undefined;
  } else {
    if (repeats.size >= MAX_REPEAT_KEYS) {
      const oldest = repeats.keys().next().value;
      if (oldest !== undefined) {
        const evicted = repeats.get(oldest);
        if (evicted) writeSummary(oldest, evicted);
        repeats.delete(oldest);
      }
    }
    repeats.set(key, { firstAt: now, windowStart: now, windowMs, suppressed: 0, event: fields.event, level, fields });
  }
  ensureFlushTimer(windowMs);
  logger[level]({ ...fields, repeatKey: key }, msg);
}

/**
 * Closes a repeat key after the failing thing works again: writes one info line
 * with `state: "recovered"`, `suppressedCount` and `failingForMs`. Does nothing
 * when the key was never logged through logRepeated.
 */
export function logRecovered(key: string, fields: EventFields = {}, msg?: string): void {
  const entry = repeats.get(key);
  if (!entry) return;
  repeats.delete(key);
  logger.info(
    {
      ...contextOnly(entry.fields),
      ...fields,
      event: entry.event,
      state: "recovered",
      repeatKey: key,
      suppressedCount: entry.suppressed,
      failingForMs: Date.now() - entry.firstAt,
    },
    msg ?? `${entry.event} recovered`,
  );
}
