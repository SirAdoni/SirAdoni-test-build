// ──────────────────────────────────────────────
// Rate-limit-aware provider decorator
// ──────────────────────────────────────────────
// Three behaviours, all keyed by connection id so they cover every caller of a connection
// (Professor Mari's rapid tool-call loop, normal chat generation, embeddings, …):
//
//   • Proactive throttle — when the connection has a `maxRequestsPerMinute` cap, requests are
//     paced so a burst (e.g. Mari's up-to-13 back-to-back rounds) cannot exceed it. Off by
//     default (no cap configured → no pacing).
//   • Reactive pause/resume — always on. A provider 429 / 529 is caught, the request pauses
//     (honouring `Retry-After` when present, else capped exponential backoff), then the SAME
//     request is retried so the task completes instead of aborting. Bounded and abort-aware.
//   • Transient transport retry: a network reset / refused connection or a gateway 502 / 503 is
//     retried at most MAX_TRANSIENT_RETRIES times with jittered backoff (Retry-After honoured).
//
// Every retry happens only BEFORE the first token reached the consumer; a stream that already
// yielded text is never replayed. Aborts (user cancel) and header/body timeouts are never retried.
//
// Mirrors the ConnectionAdmissionProvider decorator shape and installs alongside it.
import type { ChatCompletionResult, ChatMessage, ChatOptions, LLMUsage } from "./base-provider.js";
import { BaseLLMProvider, LLMHttpError, isRateLimitError, withLlmResolvedAddressOffset } from "./base-provider.js";
import { getConnectionRateLimit } from "./connection-rate-limit-registry.js";
import { isFeatureEnabled } from "../features/feature-settings.js";
import { logger } from "../../lib/logger.js";
import { withDiagnosticContext } from "../../lib/diagnostics.js";

export const MAX_RATE_LIMIT_RETRIES = 6;
/** Transient transport / gateway failures get a much smaller budget than rate limits. */
export const MAX_TRANSIENT_RETRIES = 2;
const BACKOFF_BASE_MS = 2_000;
const TRANSIENT_BACKOFF_BASE_MS = 1_000;
const TRANSIENT_BACKOFF_CAP_MS = 5_000;
const BACKOFF_CAP_MS = 60_000;

export interface RateLimitAwareProviderOptions {
  /** Disable transient retries for a connection primary leg that has a fallback. */
  transientRetry?: boolean;
}

/**
 * Connect-phase failure codes: the connection could not be opened, so the request body was never
 * sent and the upstream cannot have processed (or billed) it. Always safe to retry.
 */
const CONNECT_PHASE_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/**
 * Socket drop codes. A fast one is the classic stale keep-alive reset (the pooled socket was already
 * dead when the request was written), which is safe to retry. A slow one is not: a proxy idle timeout,
 * a NAT drop or an upstream worker crash can close the socket after the upstream read the whole
 * request and worked on it for a long time, before any header was sent (non-streaming calls send no
 * header until generation finishes). "No headers" does not mean "not processed", so these codes are
 * retried only when the failed attempt took at most STALE_SOCKET_MAX_ELAPSED_MS, and only when the
 * elapsed time is known (llmFetch puts `elapsedMs` on its LLMTransportError).
 *
 * Header/body timeouts are deliberately absent from both sets: the provider may still be generating
 * (and billing) behind a timed-out request. A socket that closes while the response BODY is being
 * read (undici "terminated") is excluded by `isBodyPhaseFailure` below.
 */
const SOCKET_DROP_ERROR_CODES = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"]);
export const STALE_SOCKET_MAX_ELAPSED_MS = 1_500;

/** First `elapsedMs` found on the error or its cause chain, as set by llmFetch. */
function attemptElapsedMs(error: unknown): number | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const elapsed = (current as { elapsedMs?: unknown }).elapsedMs;
    if (typeof elapsed === "number" && Number.isFinite(elapsed)) return elapsed;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * True when a failure happened after a response came back, while its body was being read. undici
 * names that rejection "terminated" (a fetch that never got a response rejects with "fetch failed"),
 * and llmFetch / providers keep it as the message or as a suffix ("LLM transport failed: terminated",
 * "Stream error: terminated"), with the original error kept on `cause`.
 */
function isBodyPhaseFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const message = (current as { message?: unknown }).message;
    if (typeof message === "string" && /(^|[:\s])terminated$/i.test(message.trim())) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function transientNetworkErrorCode(error: unknown): string | undefined {
  if (isBodyPhaseFailure(error)) return undefined;
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const candidate = current as { name?: unknown; code?: unknown; cause?: unknown };
    if (candidate.name === "AbortError" || candidate.name === "TimeoutError") return undefined;
    if (typeof candidate.code === "string") {
      if (CONNECT_PHASE_ERROR_CODES.has(candidate.code)) return candidate.code;
      if (SOCKET_DROP_ERROR_CODES.has(candidate.code)) {
        const elapsed = attemptElapsedMs(error);
        return elapsed !== undefined && elapsed <= STALE_SOCKET_MAX_ELAPSED_MS ? candidate.code : undefined;
      }
    }
    current = candidate.cause;
  }
  return undefined;
}

/**
 * True when an error is a transient transport or gateway failure that is safe to retry a small,
 * bounded number of times before any token reached the consumer: a refused / unreachable
 * connection, a fast (stale keep-alive) socket reset, or an HTTP 502 / 503 from a gateway. Rate limits (429 / 529 / throttling 503) are classified by `isRateLimitError` and keep
 * their own larger budget. 504 is excluded because the upstream model may already have produced
 * (and billed) the answer behind the gateway timeout.
 */
export function isTransientProviderError(error: unknown): boolean {
  if (error instanceof LLMHttpError) return error.status === 502 || error.status === 503;
  return transientNetworkErrorCode(error) !== undefined;
}

type RetryKind = "rate_limit" | "transient";
type RetryCounts = Record<RetryKind, number>;

/** HTTP status and provider code for log lines, read without assuming the error type. */
function errorFields(error: unknown): { httpStatus?: number; providerCode?: string } {
  if (!error || typeof error !== "object") return {};
  const { status, providerCode } = error as { status?: unknown; providerCode?: unknown };
  return {
    httpStatus: typeof status === "number" ? status : undefined,
    providerCode: typeof providerCode === "string" ? providerCode : undefined,
  };
}

/**
 * Classify a failed attempt, or null when it must propagate. Rate limits take precedence. With the
 * "Retry failed provider calls" feature off only rate limits retry, as upstream.
 */
function classifyRetry(error: unknown): RetryKind | null {
  if (isRateLimitError(error)) return "rate_limit";
  if (isFeatureEnabled("providerRetry") && isTransientProviderError(error)) return "transient";
  return null;
}

type RateLimitPauseInfo = { attempt: number; delayMs: number; reason: "rate_limit" | "throttle" };
type RetryContext = {
  signal?: AbortSignal;
  onRateLimitPause?: (info: RateLimitPauseInfo) => void;
  model?: string;
};

/** Counts the pauses of one logical call, for the give-up line. */
type RetryTally = { totalWaitMs: number };

// Per-connection pacing cursor: the earliest wall-clock time the next request may start. Reserving
// a slot pushes the cursor forward by the min interval so concurrent requests queue fairly.
const nextAllowedAt = new Map<string, number>();

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(signal?.reason ?? new Error("Aborted"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Delay before retry number `attempt + 1`. A server-supplied Retry-After is honoured exactly (capped)
 * so an explicit "retry in 0 s" stays instant. Otherwise capped exponential backoff with equal
 * jitter (half fixed, half random) so many requests failing together do not retry in lockstep.
 */
export function computeRetryDelayMs(
  attempt: number,
  retryAfterMs: number | undefined,
  kind: RetryKind = "rate_limit",
  random: () => number = Math.random,
): number {
  const cap = kind === "transient" ? TRANSIENT_BACKOFF_CAP_MS : BACKOFF_CAP_MS;
  if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return Math.min(retryAfterMs, cap);
  }
  const base = kind === "transient" ? TRANSIENT_BACKOFF_BASE_MS : BACKOFF_BASE_MS;
  const ceiling = Math.min(base * 2 ** attempt, cap);
  const jitter = Math.min(Math.max(random(), 0), 1);
  return Math.round(ceiling / 2 + (ceiling / 2) * jitter);
}

function retryAfterOf(error: unknown): number | undefined {
  return error instanceof LLMHttpError ? error.retryAfterMs : undefined;
}

/**
 * Reserve this request's proactive-throttle slot. Returns the pacing delay to await when the
 * connection is over its cap, or `undefined` when no wait is needed. Returning `undefined`
 * synchronously (the common, unthrottled path) is deliberate: it lets the caller invoke the wrapped
 * provider in the SAME microtask, so the inner admission slot is still acquired synchronously —
 * awaiting an already-resolved value here would yield a tick and briefly open the concurrency gate.
 */
function reserveThrottleSlot(connectionId: string, context: RetryContext): Promise<void> | undefined {
  const maxRpm = getConnectionRateLimit(connectionId);
  if (!maxRpm || maxRpm <= 0) return undefined;
  const minIntervalMs = Math.ceil(60_000 / maxRpm);
  const now = Date.now();
  const earliest = Math.max(now, nextAllowedAt.get(connectionId) ?? 0);
  const reserved = earliest + minIntervalMs;
  nextAllowedAt.set(connectionId, reserved);
  const waitMs = earliest - now;
  if (waitMs <= 0) return undefined;
  logger.debug(
    { event: "llm.throttle", connectionId, delayMs: waitMs, maxRpm },
    "Pacing request under the connection cap",
  );
  context.onRateLimitPause?.({ attempt: 0, delayMs: waitMs, reason: "throttle" });
  return abortableDelay(waitMs, context.signal).catch((error) => {
    // Aborted mid-wait: hand our reservation back if we are still the tail so a cancelled
    // request does not inject phantom pacing delay into the requests queued behind it.
    if (nextAllowedAt.get(connectionId) === reserved) {
      nextAllowedAt.set(connectionId, earliest);
    }
    throw error;
  });
}

/**
 * Resolved-address offset for an attempt: each retry tries the next DNS address. With provider
 * retry off every attempt uses the first address, as upstream.
 */
export function resolvedAddressOffsetForAttempt(attempt: number): number {
  return isFeatureEnabled("providerRetry") ? attempt : 0;
}

/**
 * Wrap the streaming callbacks of `options` so the retry loop can tell whether this attempt already
 * pushed text to the user. `chatComplete` on the tool path streams through `onToken`, and both paths
 * stream reasoning through `onThinking`, so a mid-body socket reset there must not trigger a replay
 * that would show the user the same text twice (and pay for it twice). When neither callback is
 * set the original options object is returned unchanged.
 */
function trackStreamedOutput(options: ChatOptions): { options: ChatOptions; emitted: () => boolean } {
  const { onToken, onThinking } = options;
  if (!onToken && !onThinking) return { options, emitted: () => false };
  let emitted = false;
  const tracked: ChatOptions = { ...options };
  if (onToken) {
    tracked.onToken = (chunk) => {
      if (chunk) emitted = true;
      return onToken(chunk);
    };
  }
  if (onThinking) {
    tracked.onThinking = (chunk) => {
      if (chunk) emitted = true;
      onThinking(chunk);
    };
  }
  return { options: tracked, emitted: () => emitted };
}

export class RateLimitAwareProvider extends BaseLLMProvider {
  private readonly transientRetryAllowed: boolean;

  constructor(
    readonly provider: BaseLLMProvider,
    private readonly connectionId: string,
    options: RateLimitAwareProviderOptions = {},
  ) {
    super("", "", provider.maxContextValue ?? undefined, null, provider.maxTokensOverrideValue);
    this.transientRetryAllowed = options.transientRetry !== false;
  }

  /**
   * Decide whether a failed attempt may be retried. Returns the retry kind, or null when the error
   * must propagate: not retryable, aborted, or the budget for that kind is spent. Budgets are
   * counted per kind so a transient blip cannot consume the rate-limit budget and vice versa.
   */
  withoutTransientRetry(): RateLimitAwareProvider {
    if (!this.transientRetryAllowed) return this;
    return new RateLimitAwareProvider(this.provider, this.connectionId, { transientRetry: false });
  }

  private transientRetryActive(): boolean {
    return this.transientRetryAllowed && isFeatureEnabled("providerRetry");
  }

  private nextRetry(error: unknown, counts: RetryCounts, signal: AbortSignal | undefined): RetryKind | null {
    if (signal?.aborted) return null;
    const kind = classifyRetry(error);
    if (!kind || (kind === "transient" && !this.transientRetryActive())) return null;
    const budget = kind === "rate_limit" ? MAX_RATE_LIMIT_RETRIES : MAX_TRANSIENT_RETRIES;
    return counts[kind] < budget ? kind : null;
  }

  private pauseForRetry(
    context: RetryContext,
    kind: RetryKind,
    counts: RetryCounts,
    error: unknown,
    tally: RetryTally,
  ): Promise<void> {
    const kindAttempt = counts[kind];
    counts[kind] += 1;
    const retryAfterMs = retryAfterOf(error);
    const delayMs = computeRetryDelayMs(kindAttempt, retryAfterMs, kind);
    tally.totalWaitMs += delayMs;
    const fields = errorFields(error);
    logger.warn(
      {
        event: "llm.retry",
        connectionId: this.connectionId,
        attempt: kindAttempt + 1,
        maxAttempts: kind === "rate_limit" ? MAX_RATE_LIMIT_RETRIES : MAX_TRANSIENT_RETRIES,
        delayMs,
        retryAfterMs,
        httpStatus: fields.httpStatus,
        providerCode: fields.providerCode,
        errorCode: kind === "transient" ? transientNetworkErrorCode(error) : undefined,
        model: context.model,
        reason: kind,
      },
      kind === "rate_limit"
        ? "Rate limited; pausing before retrying the same request"
        : "Transient provider failure; retrying the same request",
    );
    // Only rate-limit pauses are surfaced: callers (continuity, Professor Mari) treat that callback
    // as "provider quota exhausted", which a short transient retry is not.
    if (kind === "rate_limit") context.onRateLimitPause?.({ attempt: kindAttempt + 1, delayMs, reason: kind });
    return abortableDelay(delayMs, context.signal);
  }

  /**
   * On give-up for a retryable (rate-limit or transient) error: one warn line and `retryAttempts`
   * on the error. Other errors pass untouched.
   */
  private noteGiveUp(error: unknown, attempt: number, afterOutput: boolean, tally: RetryTally, model?: string): void {
    const kind = classifyRetry(error);
    if (!kind || !error || typeof error !== "object") return;
    Object.assign(error, { retryAttempts: attempt });
    const fields = errorFields(error);
    logger.warn(
      {
        event: "llm.retry",
        outcome: "failed",
        connectionId: this.connectionId,
        model,
        reason: afterOutput ? "after-output" : "exhausted",
        kind,
        attempt,
        totalWaitMs: tally.totalWaitMs,
        httpStatus: fields.httpStatus,
        providerCode: fields.providerCode,
        errorCode: kind === "transient" ? transientNetworkErrorCode(error) : undefined,
      },
      afterOutput
        ? "Retryable provider failure after output was sent; not retrying"
        : kind === "rate_limit"
          ? "Rate limit retries exhausted"
          : "Transient failure retries exhausted",
    );
  }

  private attemptContext<T>(attempt: number, work: () => T): T {
    return withDiagnosticContext({ attempt: attempt + 1, connectionId: this.connectionId }, work);
  }

  async *chat(messages: ChatMessage[], options: ChatOptions): AsyncGenerator<string, LLMUsage | void, unknown> {
    const tally: RetryTally = { totalWaitMs: 0 };
    const counts: RetryCounts = { rate_limit: 0, transient: 0 };
    for (let attempt = 0; ; attempt += 1) {
      // Reserve a throttle slot per attempt, since each retry is a fresh outbound request. When
      // unthrottled this returns undefined synchronously, so the first attempt still starts the
      // wrapped provider in the same microtask (keeping admission-slot acquisition synchronous).
      const throttleWait = reserveThrottleSlot(this.connectionId, options);
      if (throttleWait) await throttleWait;
      let yieldedAny = false;
      const tracked = trackStreamedOutput(options);
      const iterator = this.attemptContext(attempt, () => this.provider.chat(messages, tracked.options));
      const next = () =>
        this.attemptContext(attempt, () =>
          withLlmResolvedAddressOffset(resolvedAddressOffsetForAttempt(attempt), () => iterator.next()),
        );
      try {
        let step = await next();
        while (!step.done) {
          yieldedAny = true;
          yield step.value;
          step = await next();
        }
        return step.value;
      } catch (error) {
        // Once tokens (or streamed reasoning) have reached the consumer the stream cannot be
        // replayed, so only a pre-first-token failure is retryable; anything else propagates.
        const afterOutput = yieldedAny || tracked.emitted();
        const kind = afterOutput ? null : this.nextRetry(error, counts, options.signal);
        if (!kind) {
          if (!options.signal?.aborted) this.noteGiveUp(error, attempt, afterOutput, tally, options.model);
          throw error;
        }
        await this.pauseForRetry(options, kind, counts, error, tally);
      } finally {
        // Close the wrapped generator so its slot-releasing finally runs even when the consumer
        // abandons this stream early (break/return/abort) while we are suspended at a yield, or
        // before we retry with a fresh iterator. Mirrors the gen.return() guards elsewhere.
        await iterator.return(undefined).catch((closeError: unknown) => {
          logger.warn(
            { event: "llm.stream.close", outcome: "failed", connectionId: this.connectionId, err: closeError },
            "Failed to close the wrapped provider stream",
          );
        });
      }
    }
  }

  async chatComplete(messages: ChatMessage[], options: ChatOptions): Promise<ChatCompletionResult> {
    const tally: RetryTally = { totalWaitMs: 0 };
    const counts: RetryCounts = { rate_limit: 0, transient: 0 };
    for (let attempt = 0; ; attempt += 1) {
      const throttleWait = reserveThrottleSlot(this.connectionId, options);
      if (throttleWait) await throttleWait;
      const tracked = trackStreamedOutput(options);
      try {
        return await this.attemptContext(attempt, () =>
          withLlmResolvedAddressOffset(resolvedAddressOffsetForAttempt(attempt), () =>
            this.provider.chatComplete(messages, tracked.options),
          ),
        );
      } catch (error) {
        // Tokens already streamed through onToken / onThinking cannot be taken back: no replay.
        const afterOutput = tracked.emitted();
        const kind = afterOutput ? null : this.nextRetry(error, counts, options.signal);
        if (!kind) {
          if (!options.signal?.aborted) this.noteGiveUp(error, attempt, afterOutput, tally, options.model);
          throw error;
        }
        await this.pauseForRetry(options, kind, counts, error, tally);
      }
    }
  }

  async embed(texts: string[], model: string, signal?: AbortSignal): Promise<number[][]> {
    const context: RetryContext = { signal, model };
    const tally: RetryTally = { totalWaitMs: 0 };
    const counts: RetryCounts = { rate_limit: 0, transient: 0 };
    for (let attempt = 0; ; attempt += 1) {
      const throttleWait = reserveThrottleSlot(this.connectionId, context);
      if (throttleWait) await throttleWait;
      try {
        return await this.attemptContext(attempt, () =>
          withLlmResolvedAddressOffset(resolvedAddressOffsetForAttempt(attempt), () =>
            this.provider.embed(texts, model, signal),
          ),
        );
      } catch (error) {
        const kind = this.nextRetry(error, counts, signal);
        if (!kind) {
          if (!signal?.aborted) this.noteGiveUp(error, attempt, false, tally, model);
          throw error;
        }
        await this.pauseForRetry(context, kind, counts, error, tally);
      }
    }
  }
}

export function withRateLimitAwareProvider(
  provider: BaseLLMProvider,
  connectionId: string,
  options?: RateLimitAwareProviderOptions,
): BaseLLMProvider {
  // Idempotent: never nest two retry layers (which would multiply retries), since the decorator is
  // installed both in createLLMProvider and around the connection-fallback legs. An existing wrapper
  // still honours transientRetry: false, so the caller's opt-out is never silently dropped.
  if (provider instanceof RateLimitAwareProvider) {
    return options?.transientRetry === false ? provider.withoutTransientRetry() : provider;
  }
  return new RateLimitAwareProvider(provider, connectionId, options);
}
