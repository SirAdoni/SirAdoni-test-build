import { AsyncLocalStorage } from "node:async_hooks";
import { DEFAULT_MEDIA_GENERATION_CONCURRENCY } from "@marinara-engine/shared";
import { logger } from "../../lib/logger.js";
import { createDiagnostic } from "../../lib/diagnostics.js";
import { logEvent, type JobKind, type Outcome } from "../../lib/log-events.js";
import { safeHost } from "../llm/provider-error.js";
import { timeStoryboardStage } from "../game/storyboard-progress.js";

type MediaGenerationQueueTask<T> = () => Promise<T>;
export type MediaGenerationPriority = "foreground" | "background";
export type MediaGenerationPermitProfile = "shared" | "openai_chatgpt_image";

/** ChatGPT Subscription image requests use a separate provider pool matching
 *  the largest automatic Game portrait batch Marinara accepts per request. */
export const OPENAI_CHATGPT_IMAGE_GENERATION_CONCURRENCY = 10;

const mediaGenerationQueueTails = new Map<string, Promise<void>>();

// ── Provider concurrency ceilings (#5097) ────────────────────────────────────
// Applies IN ADDITION to the per-connection FIFO below. Most media shares the
// default process pool; ChatGPT Subscription images use an isolated wider pool
// so raising their throughput cannot stampede a local GPU or video provider.
// The invariants that keep each pool hang-proof (a leaked or deadlocked permit
// stalls that provider silently, the worst available failure mode):
//   1. the permit is acquired AFTER the per-connection turn, never before, so
//      the two queues cannot hold each other in a cycle;
//   2. release happens in `finally` on every path and is idempotent;
//   3. a task that RE-ENTERS this module while holding a permit (for example a
//      video fallback hop) reuses it only within the same pool. A cross-pool
//      nested acquire fails loudly instead of bypassing a cap or creating a
//      lock-order cycle;
//   4. waits are bounded: a waiter times out with a clear error instead of
//      parking forever behind a hung provider call;
//   5. the shared pool reserves its last permit for foreground work. The
//      isolated ChatGPT pool instead fills all ten requested slots, but still
//      grants a waiting foreground request before the next background job.
const heldMediaPermit = new AsyncLocalStorage<MediaGenerationPermitProfile>();
let warnedInvalidConcurrencyEnv = false;

function parseStrictNonNegativeInt(raw: string): number | null {
  return /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : null;
}

/** `0` is the explicit opt-out (unlimited); invalid values warn once and use the default. */
function resolveGlobalMediaGenerationLimit(): number {
  const raw = (process.env.MARINARA_MEDIA_GENERATION_CONCURRENCY ?? "").trim();
  if (!raw) return DEFAULT_MEDIA_GENERATION_CONCURRENCY;
  const value = parseStrictNonNegativeInt(raw);
  if (value === null) {
    if (!warnedInvalidConcurrencyEnv) {
      warnedInvalidConcurrencyEnv = true;
      logger.warn(
        "Ignoring invalid MARINARA_MEDIA_GENERATION_CONCURRENCY value %s; using the default of %d",
        raw,
        DEFAULT_MEDIA_GENERATION_CONCURRENCY,
      );
    }
    return DEFAULT_MEDIA_GENERATION_CONCURRENCY;
  }
  return value === 0 ? Number.POSITIVE_INFINITY : value;
}

const DEFAULT_MEDIA_GENERATION_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
let warnedInvalidWaitTimeoutEnv = false;

/** Bound on how long a caller may WAIT for a permit (`0` disables the bound); invalid values
 *  warn once and use the default, matching `resolveGlobalMediaGenerationLimit`. */
function resolveGlobalMediaGenerationWaitTimeoutMs(): number {
  const raw = (process.env.MARINARA_MEDIA_GENERATION_WAIT_TIMEOUT_MS ?? "").trim();
  if (!raw) return DEFAULT_MEDIA_GENERATION_WAIT_TIMEOUT_MS;
  const value = parseStrictNonNegativeInt(raw);
  if (value === null) {
    if (!warnedInvalidWaitTimeoutEnv) {
      warnedInvalidWaitTimeoutEnv = true;
      logger.warn(
        "Ignoring invalid MARINARA_MEDIA_GENERATION_WAIT_TIMEOUT_MS value %s; using the default of %dms",
        raw,
        DEFAULT_MEDIA_GENERATION_WAIT_TIMEOUT_MS,
      );
    }
    return DEFAULT_MEDIA_GENERATION_WAIT_TIMEOUT_MS;
  }
  return value === 0 ? Number.POSITIVE_INFINITY : value;
}

interface GlobalPermitWaiter {
  grant: () => void;
  fail: (error: Error) => void;
}

interface MediaGenerationPermitPool {
  activePermits: number;
  foregroundWaiters: GlobalPermitWaiter[];
  backgroundWaiters: GlobalPermitWaiter[];
}

const mediaGenerationPermitPools: Record<MediaGenerationPermitProfile, MediaGenerationPermitPool> = {
  shared: { activePermits: 0, foregroundWaiters: [], backgroundWaiters: [] },
  openai_chatgpt_image: { activePermits: 0, foregroundWaiters: [], backgroundWaiters: [] },
};

function resolveMediaGenerationLimit(profile: MediaGenerationPermitProfile): number {
  const configuredLimit = resolveGlobalMediaGenerationLimit();
  return profile === "openai_chatgpt_image"
    ? Math.max(configuredLimit, OPENAI_CHATGPT_IMAGE_GENERATION_CONCURRENCY)
    : configuredLimit;
}

/** Shared background work reserves one slot; ChatGPT uses its isolated pool in full. */
function backgroundPermitCapacity(limit: number, profile: MediaGenerationPermitProfile): number {
  // The ChatGPT pool is already isolated from local/video providers. Let an
  // automatic ten-portrait batch use all ten slots, then admit queued
  // foreground work first as soon as any one finishes.
  if (profile === "openai_chatgpt_image") return limit;
  return Number.isFinite(limit) ? Math.max(1, limit - 1) : limit;
}

/** Grants as many parked waiters as the CURRENT limit allows, foreground first.
 *  Called on every release and every acquire, so a live limit raise wakes
 *  parked waiters and a live lower converges as in-flight tasks complete. */
function pumpGlobalPermitWaiters(profile: MediaGenerationPermitProfile): void {
  const pool = mediaGenerationPermitPools[profile];
  const limit = resolveMediaGenerationLimit(profile);
  while (pool.activePermits < limit && pool.foregroundWaiters.length > 0) {
    pool.activePermits += 1;
    pool.foregroundWaiters.shift()!.grant();
  }
  const backgroundCap = backgroundPermitCapacity(limit, profile);
  while (pool.activePermits < backgroundCap && pool.backgroundWaiters.length > 0) {
    pool.activePermits += 1;
    pool.backgroundWaiters.shift()!.grant();
  }
}

function releaseGlobalPermit(profile: MediaGenerationPermitProfile): void {
  const pool = mediaGenerationPermitPools[profile];
  if (pool.activePermits <= 0) {
    // The idempotent release wrapper should make this unreachable; if it ever
    // fires there is an accounting bug that must announce itself.
    logger.warn("Media generation permit released more times than acquired — permit accounting bug");
    pool.activePermits = 0;
  } else {
    pool.activePermits -= 1;
  }
  pumpGlobalPermitWaiters(profile);
}

async function acquireGlobalPermit(
  signal?: AbortSignal,
  priority: MediaGenerationPriority = "foreground",
  profile: MediaGenerationPermitProfile = "shared",
): Promise<() => void> {
  // Re-entrant work in the same pool reuses its parent's permit. Crossing
  // pools while holding one would either bypass the target cap or introduce a
  // lock-order cycle, so physical fallback legs must reacquire after unwinding.
  const heldProfile = heldMediaPermit.getStore();
  if (heldProfile === profile) return () => undefined;
  if (heldProfile) {
    throw new Error(`Nested media generation cannot switch permit pools from ${heldProfile} to ${profile}`);
  }
  if (signal?.aborted) throw mediaGenerationAbortError(signal);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseGlobalPermit(profile);
  };
  const pool = mediaGenerationPermitPools[profile];
  // Wake anyone a live limit-raise has stranded before judging our own turn.
  pumpGlobalPermitWaiters(profile);
  const limit = resolveMediaGenerationLimit(profile);
  const capacity = priority === "background" ? backgroundPermitCapacity(limit, profile) : limit;
  const mustQueue =
    pool.foregroundWaiters.length > 0 || (priority === "background" && pool.backgroundWaiters.length > 0);
  if (!mustQueue && pool.activePermits < capacity) {
    pool.activePermits += 1;
    return release;
  }
  const waiters = priority === "background" ? pool.backgroundWaiters : pool.foregroundWaiters;
  await new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | null = null;
    const cleanup = () => {
      if (signal) signal.removeEventListener("abort", onAbort);
      if (timer) clearTimeout(timer);
    };
    const waiter: GlobalPermitWaiter = {
      grant: () => {
        cleanup();
        resolve();
      },
      fail: (error: Error) => {
        cleanup();
        reject(error);
      },
    };
    const removeSelf = () => {
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
    };
    const onAbort = () => {
      removeSelf();
      waiter.fail(mediaGenerationAbortError(signal!));
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    const timeoutMs = resolveGlobalMediaGenerationWaitTimeoutMs();
    if (Number.isFinite(timeoutMs)) {
      timer = setTimeout(() => {
        removeSelf();
        logger.warn(
          "Media generation request timed out after waiting %dms for a concurrency permit (%d in flight, profile %s)",
          timeoutMs,
          pool.activePermits,
          profile,
        );
        waiter.fail(
          new Error(
            `Media generation queue is saturated: waited ${Math.round(timeoutMs / 1000)}s for one of ` +
              `${resolveMediaGenerationLimit(profile)} concurrency slots. Retry later, or raise ` +
              `MARINARA_MEDIA_GENERATION_CONCURRENCY if your provider can take more parallel requests.`,
          ),
        );
      }, timeoutMs);
      timer.unref?.();
    }
    waiters.push(waiter);
  });
  return release;
}

/** Test-only: waits for a quiescent queue would race; expose the counters. */
export function inspectMediaGenerationConcurrencyForTests(profile: MediaGenerationPermitProfile = "shared") {
  const pool = mediaGenerationPermitPools[profile];
  return {
    activeGlobalPermits: pool.activePermits,
    queuedWaiters: pool.foregroundWaiters.length + pool.backgroundWaiters.length,
    foregroundWaiters: pool.foregroundWaiters.length,
    backgroundWaiters: pool.backgroundWaiters.length,
  };
}

function mediaGenerationAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Media generation request aborted");
}

async function waitForMediaGenerationTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  const settledPrevious = previous.catch(() => undefined);
  if (!signal) {
    await settledPrevious;
    return;
  }
  if (signal.aborted) throw mediaGenerationAbortError(signal);

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(mediaGenerationAbortError(signal)));

    signal.addEventListener("abort", onAbort, { once: true });
    void settledPrevious.then(() => finish(resolve));
  });
}

interface MediaGenerationRequestArgs<T> {
  connectionKey: string;
  queue: boolean;
  task: MediaGenerationQueueTask<T>;
  signal?: AbortSignal;
  /** Batch/automatic work should pass "background" so it can never occupy the
   *  last permit ahead of interactive requests. Defaults to foreground. */
  priority?: MediaGenerationPriority;
  /** ChatGPT Subscription images use an isolated ten-request provider pool. */
  permitProfile?: MediaGenerationPermitProfile;
  /** Which media the request produces; names the `${kind}.queue` operation in the log. Defaults to image. */
  kind?: "image" | "video";
}

async function runAfterConnectionQueue<T>(
  args: Pick<MediaGenerationRequestArgs<T>, "connectionKey" | "queue" | "signal">,
  task: MediaGenerationQueueTask<T>,
): Promise<T> {
  if (!args.queue) {
    if (args.signal?.aborted) throw mediaGenerationAbortError(args.signal);
    return task();
  }

  const connectionKey = args.connectionKey.trim() || "default";
  const previous = mediaGenerationQueueTails.get(connectionKey) ?? Promise.resolve();
  let releaseCurrent: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const queuedTail = previous.catch(() => undefined).then(() => current);
  mediaGenerationQueueTails.set(connectionKey, queuedTail);

  try {
    await timeStoryboardStage("Connection queue", () => waitForMediaGenerationTurn(previous, args.signal));
    if (args.signal?.aborted) throw mediaGenerationAbortError(args.signal);
    return await task();
  } finally {
    releaseCurrent();
    void queuedTail.finally(() => {
      if (mediaGenerationQueueTails.get(connectionKey) === queuedTail) {
        mediaGenerationQueueTails.delete(connectionKey);
      }
    });
  }
}

/** Queue waits longer than this are logged at info instead of debug. */
const MEDIA_QUEUE_SLOW_WAIT_MS = 5_000;

/** The host part of a queue key such as `image:https://host/path`, or its prefix when it holds no URL. Never the full URL. */
export function mediaConnectionKeyHost(connectionKey: string): string {
  const key = connectionKey.trim();
  if (!key) return "default";
  const urlStart = key.search(/https?:\/\//i);
  if (urlStart >= 0) return safeHost(key.slice(urlStart)) ?? "unparsed";
  const colon = key.indexOf(":");
  // Connection ids and service names carry no secrets; keep them short.
  return (colon > 0 ? key.slice(0, colon) : key).slice(0, 80);
}

function outcomeOf(error: unknown, signal?: AbortSignal): { outcome: Outcome; errorCode: string; errorId: string } {
  const reference = createDiagnostic(error);
  const cancelled = signal?.aborted === true || reference.code === "ME_CANCELLED";
  return { outcome: cancelled ? "cancelled" : "failed", errorCode: reference.code, errorId: reference.errorId };
}

/**
 * Serialize media provider requests per configured connection when the caller's
 * global queue preference is enabled, then acquire the selected provider pool.
 * Callers that disable the preference bypass only the FIFO, never the permit.
 *
 * Writes one `media.queue` line when the request settles: debug normally, info
 * when it waited more than five seconds for its turn and permit. Failures are not
 * reported here (the caller owns the one failure line); the settle line carries
 * the errorId so the two can be matched.
 */
export async function runMediaGenerationRequest<T>(args: MediaGenerationRequestArgs<T>): Promise<T> {
  const kind = args.kind ?? "image";
  const priority = args.priority ?? "foreground";
  const permitProfile = args.permitProfile ?? "shared";
  const startedAt = Date.now();
  let turnAt: number | undefined;
  let grantedAt: number | undefined;
  const settleLine = (fields: { outcome: Outcome; errorCode?: string; errorId?: string }) => {
    const now = Date.now();
    const waitMs = (grantedAt ?? now) - startedAt;
    const pool = mediaGenerationPermitPools[permitProfile];
    logEvent(waitMs > MEDIA_QUEUE_SLOW_WAIT_MS ? "info" : "debug", "media.queue", {
      operation: `${kind}.queue`,
      kind: kind as JobKind,
      connectionKey: mediaConnectionKeyHost(args.connectionKey),
      permitProfile,
      priority,
      queued: args.queue,
      waitMs,
      turnWaitMs: (turnAt ?? grantedAt ?? now) - startedAt,
      runMs: grantedAt === undefined ? 0 : now - grantedAt,
      activePermits: pool.activePermits,
      queuedWaiters: pool.foregroundWaiters.length + pool.backgroundWaiters.length,
      ...fields,
    });
  };
  // The task keeps the caller's diagnostic context; only the settle line names the queue operation.
  try {
    const result = await runAfterConnectionQueue(args, async () => {
      turnAt = Date.now();
      // Invariant: acquire AFTER the per-connection turn. Otherwise a full pool
      // could be held by tasks waiting on connection turns behind that pool.
      const releasePermit = await timeStoryboardStage("Provider slot wait", () =>
        acquireGlobalPermit(args.signal, args.priority, args.permitProfile),
      );
      grantedAt = Date.now();
      try {
        if (args.signal?.aborted) throw mediaGenerationAbortError(args.signal);
        return await heldMediaPermit.run(permitProfile, () => args.task());
      } finally {
        releasePermit();
      }
    });
    settleLine({ outcome: "ok" });
    return result;
  } catch (error) {
    settleLine(outcomeOf(error, args.signal));
    throw error;
  }
}

/** Low-level FIFO helper retained for queue regression coverage and callers
 * that do not perform provider fallback. Normal image generation passes the
 * preference into `generateImage`, which resolves every physical leg itself. */
export async function runImageGenerationRequest<T>(
  args: Omit<MediaGenerationRequestArgs<T>, "priority" | "permitProfile">,
): Promise<T> {
  return runAfterConnectionQueue(args, args.task);
}

// ── Media provider diagnostics ───────────────────────────────────────────────
// Shared by image, video and Atlas Cloud adapters. Unexpected provider bodies are
// logged by shape only; long-running provider tasks are polled through one helper
// so every provider writes the same `job.progress` lines.

/** The shape of a provider response for a log line: type, top-level keys and size. Never its text. */
export function providerResponseShape(value: unknown, text?: string): Record<string, unknown> {
  const isRecord = !!value && typeof value === "object" && !Array.isArray(value);
  return {
    bodyType: Array.isArray(value) ? "array" : value === null ? "null" : typeof value,
    ...(isRecord ? { topLevelKeys: Object.keys(value as Record<string, unknown>).slice(0, 20) } : {}),
    ...(Array.isArray(value) ? { itemCount: value.length } : {}),
    ...(text !== undefined ? { bodyBytes: Buffer.byteLength(text) } : {}),
  };
}

export interface ProviderTaskPollResult<T> {
  /** The provider's own status word for this poll (for example "queued", "running", "done"). */
  providerStatus: string | null;
  /** True when the task finished; `value` is then returned from pollProviderTask. */
  done: boolean;
  value?: T;
}

/** Thrown when a provider task outlives its deadline; carries the task id and last provider status. */
export class ProviderTaskTimeoutError extends Error {
  constructor(
    readonly provider: string,
    readonly providerTaskId: string,
    readonly lastProviderStatus: string | null,
    deadlineMs: number,
  ) {
    super(
      `${provider} task ${providerTaskId} did not finish within ${Math.round(deadlineMs / 1000)} seconds` +
        (lastProviderStatus ? ` (last status: ${lastProviderStatus})` : ""),
    );
    this.name = "ProviderTaskTimeoutError";
  }
}

/**
 * Polls a provider task until `poll` reports done, then returns its value. Waits
 * `intervalMs` (through `wait`, which should honour the request's abort signal)
 * before every poll. `poll` throws for a failed task.
 *
 * Logs info `job.progress` state accepted at the start, debug state progress on
 * each providerStatus change (with pollCount and elapsedMs), and one terminal
 * line: info for completed or cancelled, warn for failed. A thrown error gets
 * `providerTaskId` and `lastProviderStatus` attached when it has none.
 */
export async function pollProviderTask<T>(args: {
  provider: string;
  taskId: string;
  kind?: JobKind;
  poll: (pollCount: number) => Promise<ProviderTaskPollResult<T>>;
  intervalMs: number;
  deadlineMs?: number;
  wait: (ms: number) => Promise<void>;
}): Promise<T> {
  const startedAt = Date.now();
  const base = { kind: args.kind ?? ("video" as JobKind), provider: args.provider, providerTaskId: args.taskId };
  let pollCount = 0;
  let lastProviderStatus: string | null = null;
  logEvent("info", "job.progress", { ...base, state: "accepted" });
  try {
    while (true) {
      if (args.deadlineMs !== undefined && Date.now() - startedAt >= args.deadlineMs) {
        throw new ProviderTaskTimeoutError(args.provider, args.taskId, lastProviderStatus, args.deadlineMs);
      }
      await args.wait(args.intervalMs);
      pollCount += 1;
      const step = await args.poll(pollCount);
      if (step.providerStatus !== lastProviderStatus) {
        lastProviderStatus = step.providerStatus;
        logEvent("debug", "job.progress", {
          ...base,
          state: "progress",
          providerStatus: step.providerStatus,
          pollCount,
          elapsedMs: Date.now() - startedAt,
        });
      }
      if (step.done) {
        logEvent("info", "job.progress", {
          ...base,
          state: "completed",
          outcome: "ok",
          providerStatus: step.providerStatus,
          pollCount,
          elapsedMs: Date.now() - startedAt,
        });
        return step.value as T;
      }
    }
  } catch (error) {
    if (error && typeof error === "object" && Object.isExtensible(error)) {
      const target = error as { providerTaskId?: unknown; lastProviderStatus?: unknown };
      if (target.providerTaskId === undefined) target.providerTaskId = args.taskId;
      if (target.lastProviderStatus === undefined) target.lastProviderStatus = lastProviderStatus;
    }
    const failure = outcomeOf(error);
    logEvent(failure.outcome === "cancelled" ? "info" : "warn", "job.progress", {
      ...base,
      state: failure.outcome === "cancelled" ? "cancelled" : "failed",
      ...failure,
      lastProviderStatus,
      pollCount,
      elapsedMs: Date.now() - startedAt,
    });
    throw error;
  }
}
