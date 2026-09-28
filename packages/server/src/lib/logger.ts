// Shared by Fastify and application code. File writes are synchronous so an
// immediate process.exit after a fatal error does not discard the diagnostic.
import pino from "pino";
import { randomBytes } from "node:crypto";
import type { EventEmitter } from "node:events";
import { writeSync } from "node:fs";
import { hostname } from "node:os";
import { logContextMixin } from "./log-context.js";
import { join } from "node:path";
import { isatty } from "node:tty";
import pretty from "pino-pretty";
import { RotatingFileSink } from "./rotating-sink.js";
import {
  createDiagnostic,
  getDiagnosticContext,
  markDiagnosticReported,
  sanitizeDiagnosticText,
  sanitizeDiagnosticValue,
} from "./diagnostics.js";
import {
  getLogDirectory,
  getLogFileKeep,
  getLogFileLevel,
  getLogFileMaxBytes,
  getLogLevel,
  getNodeEnv,
} from "../config/runtime-config.js";

type TerminalLogStream = EventEmitter & {
  fd?: number;
  write: (chunk: string) => unknown;
  end: () => unknown;
  flushSync: () => unknown;
  destroy: () => unknown;
};

const stdoutWasTerminal = process.platform !== "win32" && isatty(1);
const terminalStreams = new Set<TerminalLogStream>();
const noop = () => undefined;
function isBrokenTerminalError(error: unknown) {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "EIO" || code === "EPIPE";
}
function isTerminalUnavailable() {
  try {
    // macOS can still report isatty(1) after hangup, and zero-byte writes need
    // not probe a PTY. Send one ignorable NUL byte to exercise the actual fd.
    writeSync(1, "\0");
    return false;
  } catch (error) {
    return isBrokenTerminalError(error);
  }
}
function silenceTerminalStream(stream: TerminalLogStream) {
  // Match Pino's broken-pipe policy: the terminal is gone, so stop writing to it.
  stream.write = noop;
  stream.end = noop;
  stream.flushSync = noop;
  stream.destroy = noop;
}

// Register BEFORE the Pino instance below: shutdown can reach exit before an async
// EIO arrives, and SonicBoom's exit-time flush otherwise retries the dead fd forever.
if (stdoutWasTerminal) {
  process.once("exit", () => {
    if (isTerminalUnavailable()) for (const stream of terminalStreams) silenceTerminalStream(stream);
  });
}

// prettyStdout is only for our pino-pretty transport with its default stdout destination.
export function protectTerminalLogger(log: object, prettyStdout = false): void {
  if (!stdoutWasTerminal) return;
  const stream = Reflect.get(log, pino.symbols.streamSym) as TerminalLogStream | undefined;
  // File and custom transports are not ours; their errors must remain visible.
  if (!stream || (stream.fd !== 1 && !prettyStdout) || terminalStreams.has(stream)) return;
  terminalStreams.add(stream);
  stream.once("close", () => terminalStreams.delete(stream));
  stream.on("error", (error: NodeJS.ErrnoException) => {
    // ThreadStream can lose the errno or report only "the worker has exited".
    // For our pretty transport, verify the actual stdout failure before silencing it.
    if (prettyStdout ? isTerminalUnavailable() : isBrokenTerminalError(error)) {
      silenceTerminalStream(stream);
      return;
    }
    throw error;
  });
}

function levelNumber(value: string, fallback: number): number {
  return value === "silent" ? Infinity : (pino.levels.values[value] ?? fallback);
}
const fileThreshold = () => levelNumber(getLogFileLevel(), 30);
let consoleThreshold = levelNumber(getLogLevel(), 40);
let sink: RotatingFileSink | undefined;
let promptSink: RotatingFileSink | undefined;
let droppedLines = 0;
let lastWriteFailureAt = 0;
let suppressedWriteFailures = 0;
let consoleSink: ReturnType<typeof pretty> | undefined;
// One id per process start. Every line carries it, so two runs that reuse a pid never blur together.
const bootId = randomBytes(4).toString("hex");
export function getBootId(): string {
  return bootId;
}

function combinedLevel(): pino.Level {
  return (pino.levels.labels[Math.min(fileThreshold(), consoleThreshold)] ?? "fatal") as pino.Level;
}

export const logger = pino(
  {
    level: combinedLevel(),
    base: { pid: process.pid, hostname: hostname(), bootId },
    serializers: { err: (value: unknown) => value },
    mixin: (mergeObject, level, log) =>
      sanitizeDiagnosticValue({ ...logContextMixin(mergeObject, level, log), ...getDiagnosticContext() }) as Record<
        string,
        unknown
      >,
    hooks: {
      logMethod(input, method, level) {
        const first = input[0];
        const fields =
          first && typeof first === "object" && !(first instanceof Error)
            ? (first as Record<string, unknown>)
            : undefined;
        const originalError = first instanceof Error ? first : (fields?.err ?? fields?.error);
        // Only an explicit debugPrompt line may carry prompt text; the debug level alone no longer unredacts it.
        const unredacted = fields?.debugPrompt === true;
        const args = input.map((value) => sanitizeDiagnosticValue(value, 0, new WeakSet(), unredacted));
        // A caller-specific code (EADDRINUSE, SPATIAL_OWNER_TURN, ...) moves to errorCode; `code` keeps the ME_* class.
        const explicit =
          typeof fields?.errorCode === "string"
            ? fields.errorCode
            : typeof fields?.code === "string" && !/^ME_/.test(fields.code)
              ? fields.code
              : undefined;
        if ((level >= 50 || originalError instanceof Error) && !fields?.diagnostic && !fields?.errorId) {
          const reference = createDiagnostic(
            originalError ?? new Error(typeof first === "string" ? first : String(input[1] ?? "Logged failure")),
            undefined,
            explicit && /^ME_/.test(explicit) ? explicit : undefined,
          );
          const metadata = { ...reference, diagnostic: reference };
          const errorCode =
            (typeof fields?.errorCode === "string" ? fields.errorCode : undefined) ?? explicit ?? reference.code;
          if (first instanceof Error) args[0] = { err: args[0], ...metadata, errorCode };
          else if (fields) args[0] = { ...(args[0] as Record<string, unknown>), ...metadata, errorCode };
          else args.unshift({ ...metadata, errorCode });
        }
        if (level >= 50 && originalError && typeof originalError === "object") markDiagnosticReported(originalError);
        method.apply(this, args as Parameters<pino.LogFn>);
      },
    },
  },
  {
    write(chunk: string) {
      // Lazy initialization avoids the runtime-config/logger import cycle and
      // resolves DATA_DIR only after the .env file has been loaded.
      let droppedLevel: number | null = null;
      try {
        const parsed = JSON.parse(chunk) as Record<string, unknown>;
        const severity = Number(parsed.level);
        droppedLevel = Number.isFinite(severity) ? severity : null;
        const debugPrompt = parsed.debugPrompt === true;
        const safe = sanitizeDiagnosticValue(parsed, 0, new WeakSet(), debugPrompt);
        const line = `${JSON.stringify(safe)}\n`;
        if (debugPrompt) {
          // Prompt text never reaches the main files that problem views and lookup_error read.
          promptSink ??= new RotatingFileSink({
            directory: join(getLogDirectory(), "prompt-debug"),
            prefix: "prompt-debug",
            runId: bootId,
            maxBytes: getLogFileMaxBytes(),
            keep: 3,
          });
          promptSink.write(line);
        } else if (severity >= fileThreshold()) {
          sink ??= new RotatingFileSink({
            directory: getLogDirectory(),
            runId: bootId,
            maxBytes: getLogFileMaxBytes(),
            keep: getLogFileKeep(),
          });
          if (droppedLines > 0) {
            const count = droppedLines;
            droppedLines = 0;
            sink.write(
              `${JSON.stringify({ level: 40, time: Date.now(), pid: process.pid, bootId, event: "log.dropped", count, msg: "Log lines were dropped after a write failure" })}\n`,
            );
          }
          sink.write(line);
        }
        if (severity >= consoleThreshold) {
          if (getNodeEnv() !== "production" && process.stderr.isTTY) {
            consoleSink ??= pretty({ sync: true, colorize: true, destination: 2, translateTime: "SYS:standard" });
            consoleSink.write(line);
          } else process.stderr.write(line);
        }
      } catch (error) {
        // Never replay an unsanitized line or throw from error reporting itself.
        droppedLines++;
        const now = Date.now();
        if (now - lastWriteFailureAt < 30_000) {
          suppressedWriteFailures++;
          return;
        }
        lastWriteFailureAt = now;
        const suppressedCount = suppressedWriteFailures;
        suppressedWriteFailures = 0;
        try {
          const reason = sanitizeDiagnosticText(
            error instanceof Error ? `${error.name}: ${error.message}` : String(error),
            200,
          ).slice(0, 200);
          process.stderr.write(
            `${JSON.stringify({ level: 50, time: now, bootId, errorCode: "ME_LOG_WRITE", event: "log.write_failed", reason, droppedLevel, suppressedCount })}\n`,
          );
        } catch {
          /* stderr unavailable */
        }
      }
    },
  },
);
protectTerminalLogger(logger, false);

export function refreshConsoleLogLevel(): void {
  consoleThreshold = levelNumber(getLogLevel(), 40);
  logger.level = combinedLevel();
}

// runtime-config may be the first module imported, in which case its .env load
// finishes after this cyclic dependency initializes. Reconcile after evaluation.
queueMicrotask(refreshConsoleLogLevel);

export function logDebugOverride(overrideEnabled: boolean, message: string, ...args: unknown[]) {
  if (overrideEnabled && !logger.isLevelEnabled("debug")) {
    logger.warn({ debugPrompt: true }, message, ...args);
  } else logger.debug({ debugPrompt: true }, message, ...args);
}

/** Keep Fastify child loggers in step with the shared logger after LOG_LEVEL reloads. */
export function followLogLevel(child: { level: string }): () => void {
  child.level = logger.level;
  const listener = (label: string, _value: number, _previous: string, _previousValue: number, from: unknown) => {
    if (from === logger && child.level !== label) child.level = label;
  };
  logger.on("level-change", listener);
  return () => logger.off("level-change", listener);
}
