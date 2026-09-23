import { logger } from "./logger.js";
import { noteSessionExitKind } from "./session-postmortem.js";
import type { ShutdownDeadlineOptions } from "./shutdown-deadline.js";
import { RUNTIME_STOP_BUDGET_MS } from "./shutdown-steps.js";

/**
 * Which stop requests reach the graceful shutdown path.
 *
 * Windows maps console events onto Node signals: Ctrl+C is SIGINT, Ctrl+Break
 * is SIGBREAK and closing the console window is SIGHUP. Without a listener the
 * default action for SIGBREAK and SIGHUP terminates the process at once, which
 * drops the file store's debounced writes. Closing the console window is the
 * most common way a desktop user stops the server, so both are handled here.
 */
export function shutdownSignalsFor(platform: NodeJS.Platform = process.platform): NodeJS.Signals[] {
  return platform === "win32" ? ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"] : ["SIGINT", "SIGTERM", "SIGHUP"];
}

/**
 * Windows gives a process roughly five seconds after a console close before it
 * is terminated regardless of handlers, so that stop gets a tighter deadline:
 * sever connections quickly, give the runtime stops a shorter budget, and
 * leave the rest of the window (STORE_CLOSE_RESERVE_MS or more) to the store
 * close and its final flush.
 */
export const WINDOWS_CONSOLE_CLOSE_DEADLINES: Required<
  Pick<ShutdownDeadlineOptions, "connectionDeadlineMs" | "forceExitDeadlineMs">
> = {
  connectionDeadlineMs: 1_000,
  forceExitDeadlineMs: 4_000,
};
export const WINDOWS_CONSOLE_CLOSE_RUNTIME_STOP_BUDGET_MS = 1_000;

function isWindowsConsoleClose(signal: NodeJS.Signals, platform: NodeJS.Platform): boolean {
  return platform === "win32" && signal === "SIGHUP";
}

export function shutdownDeadlinesFor(
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
): ShutdownDeadlineOptions {
  return isWindowsConsoleClose(signal, platform) ? { ...WINDOWS_CONSOLE_CLOSE_DEADLINES } : {};
}

/** The runtime stop budget (see shutdown-steps.ts) that fits inside shutdownDeadlinesFor(signal). */
export function runtimeStopBudgetFor(signal: NodeJS.Signals, platform: NodeJS.Platform = process.platform): number {
  return isWindowsConsoleClose(signal, platform)
    ? WINDOWS_CONSOLE_CLOSE_RUNTIME_STOP_BUDGET_MS
    : RUNTIME_STOP_BUDGET_MS;
}

/**
 * Only a keypress (Ctrl+C is SIGINT, Ctrl+Break is SIGBREAK) is a person
 * asking to stop now. A later SIGHUP (the terminal tab closing after Ctrl+C)
 * or a supervisor repeating SIGTERM must not cut the close short before the
 * store flush and the writer lease release, so those repeats stay ignored.
 */
export const FORCE_EXIT_SIGNALS: ReadonlySet<NodeJS.Signals> = new Set(["SIGINT", "SIGBREAK"]);

/**
 * A repeated stop request only counts as "stop now" once this long has passed
 * since the first one. A single Ctrl+C commonly arrives twice (the terminal
 * signals the whole process group and the launcher forwards it as well), and
 * that duplicate must never cut off the flush.
 */
export const REPEATED_SIGNAL_GRACE_MS = 1_500;

export interface ShutdownSignalControllerOptions {
  /** Starts the graceful shutdown. Called once, for the first signal. */
  onShutdown(signal: NodeJS.Signals): void;
  /**
   * True when a close is already running that did not come from a signal (a
   * fatal-error close, which must still end with its own nonzero exit code).
   * The first signal then counts as a duplicate instead of starting a second
   * close that would exit 0; a later keypress can still force the exit.
   */
  alreadyStopping?(): boolean;
  /** Ends the process immediately. Defaults to process.exit(130). */
  forceExit?(signal: NodeJS.Signals): void;
  now?(): number;
  repeatGraceMs?: number;
}

export interface ShutdownSignalController {
  handle(signal: NodeJS.Signals): "shutdown" | "duplicate" | "forced";
  readonly shuttingDown: boolean;
}

/**
 * First signal: graceful shutdown (bounded by armShutdownDeadline). Repeats
 * inside the grace window are treated as duplicate delivery and ignored. A
 * keypress repeat (SIGINT or SIGBREAK) after the grace window is a deliberate
 * second request from the user, and forces the exit instead of making them
 * wait out the deadline. Repeated SIGHUP and SIGTERM are always ignored.
 */
export function createShutdownSignalController(options: ShutdownSignalControllerOptions): ShutdownSignalController {
  const now = options.now ?? Date.now;
  const repeatGraceMs = options.repeatGraceMs ?? REPEATED_SIGNAL_GRACE_MS;
  const forceExit =
    options.forceExit ??
    (() => {
      process.exit(130);
    });
  let firstSignalAt: number | null = null;
  let forced = false;

  return {
    get shuttingDown() {
      return firstSignalAt !== null;
    },
    handle(signal) {
      if (firstSignalAt === null) {
        firstSignalAt = now();
        if (options.alreadyStopping?.()) {
          logger.warn("Received %s while shutdown is already in progress", signal);
          return "duplicate";
        }
        options.onShutdown(signal);
        return "shutdown";
      }
      const elapsed = now() - firstSignalAt;
      if (forced || elapsed < repeatGraceMs || !FORCE_EXIT_SIGNALS.has(signal)) {
        logger.warn("Received %s while shutdown is already in progress", signal);
        return "duplicate";
      }
      forced = true;
      logger.warn(
        "Received %s again %d ms into shutdown; forcing exit now. Writes not yet flushed may be lost.",
        signal,
        elapsed,
      );
      noteSessionExitKind("forced");
      forceExit(signal);
      return "forced";
    },
  };
}

export function installShutdownSignalHandlers(
  controller: ShutdownSignalController,
  platform: NodeJS.Platform = process.platform,
): () => void {
  const installed: Array<[NodeJS.Signals, () => void]> = [];
  for (const signal of shutdownSignalsFor(platform)) {
    const listener = () => {
      controller.handle(signal);
    };
    process.on(signal, listener);
    installed.push([signal, listener]);
  }
  return () => {
    for (const [signal, listener] of installed) process.off(signal, listener);
  };
}
