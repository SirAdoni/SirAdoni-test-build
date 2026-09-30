import { allowsDefaultChatModel } from "./local-context-limit.js";
import type { ChatCompletionResult, ChatMessage, ChatOptions, LLMUsage } from "./base-provider.js";
import { BaseLLMProvider } from "./base-provider.js";
import { createLLMProvider } from "./provider-registry.js";
import { RateLimitAwareProvider, withRateLimitAwareProvider } from "./rate-limit-aware-provider.js";
import { mergeCustomParameters, parseStoredGenerationParameters } from "../../routes/generate/generate-route-utils.js";
import { logger } from "../../lib/logger.js";
import { createDiagnostic } from "../../lib/diagnostics.js";
import { logSuppressed } from "../../lib/best-effort.js";
import { notifyGenerationFallback, type GenerationFallbackNotifier } from "../generation/fallback-notification.js";
import {
  isConnectionAdmissionFailure,
  splitConnectionAttemptAcrossFallback,
  withConnectionAdmissionProvider,
} from "../generation/connection-admission.js";

import type { FallbackConnection, GenerationProviderOrigin } from "@marinara-engine/shared";
export type { FallbackConnection, GenerationProviderOrigin } from "@marinara-engine/shared";

type ConnectionFallbackProviderArgs = Omit<
  import("@marinara-engine/shared").CapabilityConnectionFallbackOptions,
  "primary"
> & {
  primary: BaseLLMProvider;
  wrapProvider?: (provider: BaseLLMProvider) => BaseLLMProvider;
};

function isEnabled(value: unknown): boolean {
  return value === true || value === "true";
}

function isAbortFailure(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === "AbortError" || candidate.code === "ABORT_ERR";
}

export function prepareAssistantReasoningPrefillMessages(messages: ChatMessage[], supported: boolean): ChatMessage[] {
  if (supported) return messages;

  return messages.flatMap((message) => {
    const metadata = message.providerMetadata;
    if (metadata?.partial !== true || typeof metadata.reasoning_content !== "string") return [message];

    const { partial: _partial, reasoning_content: _reasoningContent, ...remainingMetadata } = metadata;
    const next: ChatMessage = { ...message };
    if (Object.keys(remainingMetadata).length > 0) next.providerMetadata = remainingMetadata;
    else delete next.providerMetadata;

    const hasPayload =
      !!next.content.trim() ||
      !!next.images?.length ||
      !!next.files?.length ||
      Object.keys(next.providerMetadata ?? {}).length > 0 ||
      !!next.tool_calls?.length ||
      !!next.tool_call_id;
    return hasPayload ? [next] : [];
  });
}

export type FallbackUnusableReason = "not-configured" | "same-connection" | "no-model" | "no-base-url";

/** Why a fallback connection cannot be used, or null when it can. */
export function fallbackConnectionUnusableReason(
  fallbackConnection: FallbackConnection | null | undefined,
  primaryConnectionId: string,
  fallbackBaseUrl: string,
): FallbackUnusableReason | null {
  if (!fallbackConnection) return "not-configured";
  if (fallbackConnection.id === primaryConnectionId) return "same-connection";
  if (!fallbackConnection.model?.trim() && !allowsDefaultChatModel(fallbackConnection)) return "no-model";
  if (!fallbackBaseUrl.trim()) return "no-base-url";
  return null;
}

export function isFallbackConnectionUsable(
  fallbackConnection: FallbackConnection | null | undefined,
  primaryConnectionId: string,
  fallbackBaseUrl: string,
): fallbackConnection is FallbackConnection {
  return fallbackConnectionUnusableReason(fallbackConnection, primaryConnectionId, fallbackBaseUrl) === null;
}

const warnedUnusableFallbacks = new Set<string>();

/** Warns once per primary and fallback pair when a configured fallback cannot be used. */
function warnUnusableFallback(
  fallbackConnection: FallbackConnection | null | undefined,
  primaryConnectionId: string,
  category: "main" | "agents",
  reason: FallbackUnusableReason,
): void {
  if (!fallbackConnection || reason === "not-configured") return;
  const key = `${primaryConnectionId}:${fallbackConnection.id}:${reason}`;
  if (warnedUnusableFallbacks.has(key)) return;
  if (warnedUnusableFallbacks.size >= 500) warnedUnusableFallbacks.clear();
  warnedUnusableFallbacks.add(key);
  logger.warn(
    {
      event: "llm.fallback",
      stage: "config",
      outcome: "skipped",
      reason,
      category,
      primaryConnectionId,
      fallbackConnectionId: fallbackConnection.id,
    },
    "Configured fallback connection cannot be used",
  );
}

function numberField(error: unknown, key: string): number | undefined {
  const value = error && typeof error === "object" ? (error as Record<string, unknown>)[key] : undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringField(error: unknown, key: string): string | undefined {
  const value = error && typeof error === "object" ? (error as Record<string, unknown>)[key] : undefined;
  return typeof value === "string" && value ? value : undefined;
}

function fallbackOptions(options: ChatOptions, connection: FallbackConnection): ChatOptions {
  const stored = parseStoredGenerationParameters(connection.defaultParameters);
  const maxTokensOverride =
    typeof connection.maxTokensOverride === "number" && connection.maxTokensOverride > 0
      ? Math.floor(connection.maxTokensOverride)
      : null;
  const maxTokens =
    typeof stored?.maxTokens === "number"
      ? stored.maxTokens
      : typeof options.maxTokens === "number"
        ? options.maxTokens
        : undefined;
  const reasoningSendDisabled = stored?.enabledParameters?.reasoningEffort === false;
  const hasStoredReasoningEffort = stored?.reasoningEffort !== undefined;
  const reasoningEffort = reasoningSendDisabled
    ? undefined
    : stored?.reasoningEffort === "maximum"
      ? "max"
      : stored?.reasoningEffort === null
        ? "none"
        : (stored?.reasoningEffort ?? options.reasoningEffort);
  const enableThinking = reasoningSendDisabled
    ? false
    : hasStoredReasoningEffort
      ? stored?.reasoningEffort !== null
      : options.enableThinking;

  return {
    ...options,
    model: connection.model,
    maxContext:
      typeof connection.maxContext === "number" && connection.maxContext > 0
        ? Math.floor(connection.maxContext)
        : options.maxContext,
    maxTokens: typeof maxTokens === "number" && maxTokensOverride ? Math.min(maxTokens, maxTokensOverride) : maxTokens,
    temperature: stored?.temperature ?? options.temperature,
    topP: stored?.topP ?? options.topP,
    topK: stored?.topK ?? options.topK,
    minP: stored?.minP ?? options.minP,
    frequencyPenalty: stored?.frequencyPenalty ?? options.frequencyPenalty,
    presencePenalty: stored?.presencePenalty ?? options.presencePenalty,
    reasoningEffort,
    enableThinking,
    verbosity: stored?.verbosity === null ? undefined : (stored?.verbosity ?? options.verbosity),
    serviceTier: stored?.serviceTier ?? options.serviceTier,
    stop: stored?.stopSequences ?? options.stop,
    customParameters: mergeCustomParameters(stored?.customParameters, options.customParameters),
    enabledParameters: stored?.enabledParameters,
    enableCaching: isEnabled(connection.enableCaching),
    anthropicExtendedCacheTtl: isEnabled(connection.anthropicExtendedCacheTtl),
    cachingAtDepth:
      typeof connection.cachingAtDepth === "number" && connection.cachingAtDepth >= 0 ? connection.cachingAtDepth : 5,
    openrouterProvider: connection.openrouterProvider ?? undefined,
    encryptedReasoningItems: undefined,
  };
}

export class ConnectionFallbackProvider extends BaseLLMProvider {
  constructor(
    private readonly primary: BaseLLMProvider,
    private readonly fallback: BaseLLMProvider,
    private readonly connection: FallbackConnection,
    private readonly category: "main" | "agents",
    private readonly onFallback?: GenerationFallbackNotifier,
    /** Reports the one logical attempt's outcome once the primary-plus-fallback chain settles. */
    private readonly settleAttempt?: (outcome: "completed" | "failed") => Promise<void>,
    private readonly onProviderUsed?: (origin: GenerationProviderOrigin) => void,
    private readonly primarySupportsAssistantReasoningPrefill = true,
    private readonly fallbackSupportsAssistantReasoningPrefill = true,
    private readonly primaryConnectionId?: string,
  ) {
    super("", "", primary.maxContextValue ?? undefined, null, primary.maxTokensOverrideValue);
  }

  /**
   * Writes the activation line and notifies the client. `primaryError` is undefined when the
   * primary answered with nothing usable. Returns the primary failure's errorId, if any.
   */
  private async logFallback(primaryError: unknown, startedAt: number): Promise<string | undefined> {
    const diagnostic = primaryError === undefined ? undefined : createDiagnostic(primaryError);
    logger.warn(
      {
        event: "llm.fallback",
        stage: "activate",
        category: this.category,
        reason: primaryError === undefined ? "primary-empty" : "primary-error",
        primaryConnectionId: this.primaryConnectionId,
        fallbackConnectionId: this.connection.id,
        fallbackProvider: this.connection.provider,
        fallbackModel: this.connection.model,
        httpStatus: numberField(primaryError, "status"),
        providerCode: stringField(primaryError, "providerCode"),
        errorCode: diagnostic?.code,
        errorId: diagnostic?.errorId,
        elapsedMs: Date.now() - startedAt,
      },
      "Primary generation produced no usable output; retrying with the fallback connection",
    );
    try {
      await (this.onFallback ?? notifyGenerationFallback)({
        category: this.category,
        connectionId: this.connection.id,
        connectionName: this.connection.name?.trim() || this.connection.id,
        model: this.connection.model,
      });
    } catch (noticeError) {
      logSuppressed(noticeError, { event: "llm.fallback", stage: "notify", connectionId: this.connection.id });
    }
    return diagnostic?.errorId;
  }

  private logSkip(reason: "after-output" | "aborted" | "admission", startedAt: number): void {
    logger.info(
      {
        event: "llm.fallback",
        stage: "skip",
        reason,
        category: this.category,
        primaryConnectionId: this.primaryConnectionId,
        fallbackConnectionId: this.connection.id,
        elapsedMs: Date.now() - startedAt,
      },
      "Fallback not used",
    );
  }

  /** The fallback leg's result line. A failed leg carries `primaryErrorId` on the thrown error. */
  private logFallbackResult(
    error: unknown,
    primaryErrorId: string | undefined,
    startedAt: number,
    signal?: AbortSignal,
  ): void {
    const outcome = error === undefined ? "ok" : isAbortFailure(error, signal) ? "cancelled" : "failed";
    if (error !== undefined && primaryErrorId && error && typeof error === "object") {
      Object.assign(error, { primaryErrorId });
    }
    logger[outcome === "failed" ? "warn" : "info"](
      {
        event: "llm.fallback",
        stage: "result",
        outcome,
        category: this.category,
        primaryConnectionId: this.primaryConnectionId,
        fallbackConnectionId: this.connection.id,
        primaryErrorId,
        elapsedMs: Date.now() - startedAt,
        ...(outcome === "failed" ? { errorId: createDiagnostic(error).errorId } : {}),
      },
      outcome === "ok" ? "Fallback connection answered" : "Fallback connection did not answer",
    );
  }

  private closeWarn(closeError: unknown, what: string): void {
    logger.warn(
      { event: "llm.stream.close", outcome: "failed", category: this.category, stage: what, err: closeError },
      "Failed to close a fallback chain stream",
    );
  }

  async *chat(messages: ChatMessage[], options: ChatOptions): AsyncGenerator<string, LLMUsage | void, unknown> {
    // Only the whole chain's result is the logical attempt's outcome. Reporting a leg's own
    // result would record a successful fallback as the primary's failure, and would call an
    // empty-primary-then-rejected-fallback chain completed.
    //
    // Delivered output settles the attempt just as completion does: a consumer that walks away
    // after reading usable tokens, or a stream that breaks after emitting them, got what the
    // attempt was for. Tracking here rather than reusing chatChain's own flag covers tokens the
    // fallback leg delivered too — that flag only watches the primary.
    let delivered = false;
    let outcome: "completed" | "failed" = "failed";
    const chain = this.chatChain(messages, options);
    try {
      let result = await chain.next();
      while (!result.done) {
        delivered ||= result.value.trim().length > 0;
        yield result.value;
        result = await chain.next();
      }
      outcome = "completed";
      return result.value;
    } finally {
      // The manual loop does not forward an early return the way `yield*` would, so close the
      // chain explicitly or its own cleanup — and the admission slots it holds — never runs.
      await chain.return(undefined).catch((closeError: unknown) => this.closeWarn(closeError, "chain"));
      await this.settleAttempt?.(outcome === "completed" || delivered ? "completed" : "failed");
    }
  }

  private async *chatChain(
    messages: ChatMessage[],
    options: ChatOptions,
  ): AsyncGenerator<string, LLMUsage | void, unknown> {
    const startedAt = Date.now();
    let primaryErrorId: string | undefined;
    let emittedUsableOutput = false;
    let reportedPrimary = false;
    const reportPrimary = () => {
      if (reportedPrimary) return;
      reportedPrimary = true;
      this.onProviderUsed?.({ kind: "primary" });
    };
    try {
      const primaryOptions = options.onToken
        ? {
            ...options,
            onToken: async (chunk: string) => {
              emittedUsableOutput ||= chunk.trim().length > 0;
              if (chunk.trim().length > 0) reportPrimary();
              await options.onToken?.(chunk);
            },
          }
        : options;
      const generation = this.primary.chat(
        prepareAssistantReasoningPrefillMessages(messages, this.primarySupportsAssistantReasoningPrefill),
        primaryOptions,
      );
      try {
        let result = await generation.next();
        while (!result.done) {
          emittedUsableOutput ||= result.value.trim().length > 0;
          if (result.value.trim().length > 0) reportPrimary();
          yield result.value;
          result = await generation.next();
        }
        if (emittedUsableOutput || options.signal?.aborted) {
          if (emittedUsableOutput) reportPrimary();
          else this.logSkip("aborted", startedAt);
          return result.value;
        }
      } finally {
        // Drive the primary to completion if our consumer abandoned us mid-stream. The manual
        // loop above does not forward an early return the way `yield*` would, so without this
        // an admission wrapper around the primary never runs its own finally and leaks the
        // connection's foreground slot for the lifetime of the process. A cleanup rejection is
        // logged rather than thrown: the provider error the catch below inspects is what decides
        // whether we fall back, and it must not be replaced by a teardown failure.
        await generation.return(undefined).catch((closeError: unknown) => this.closeWarn(closeError, "primary"));
      }
      primaryErrorId = await this.logFallback(undefined, startedAt);
    } catch (error) {
      const skip = emittedUsableOutput
        ? "after-output"
        : isAbortFailure(error, options.signal)
          ? "aborted"
          : isConnectionAdmissionFailure(error)
            ? "admission"
            : undefined;
      if (skip) {
        this.logSkip(skip, startedAt);
        throw error;
      }
      primaryErrorId = await this.logFallback(error, startedAt);
    }
    options.signal?.throwIfAborted();
    let reportedFallback = false;
    const reportFallback = () => {
      if (reportedFallback) return;
      reportedFallback = true;
      this.onProviderUsed?.({
        kind: "fallback",
        provider: this.connection.provider,
        model: this.connection.model,
      });
    };
    const nextOptions = fallbackOptions(options, this.connection);
    if (nextOptions.onToken) {
      const onToken = nextOptions.onToken;
      nextOptions.onToken = async (chunk: string) => {
        if (chunk.trim().length > 0) reportFallback();
        await onToken(chunk);
      };
    }
    const fallbackStartedAt = Date.now();
    const fallbackGeneration = this.fallback.chat(
      prepareAssistantReasoningPrefillMessages(messages, this.fallbackSupportsAssistantReasoningPrefill),
      nextOptions,
    );
    try {
      let result = await fallbackGeneration.next();
      while (!result.done) {
        if (result.value.trim().length > 0) reportFallback();
        yield result.value;
        result = await fallbackGeneration.next();
      }
      reportFallback();
      this.logFallbackResult(undefined, primaryErrorId, fallbackStartedAt, options.signal);
      return result.value;
    } catch (fallbackError) {
      this.logFallbackResult(fallbackError, primaryErrorId, fallbackStartedAt, options.signal);
      throw fallbackError;
    } finally {
      await fallbackGeneration.return(undefined).catch((closeError: unknown) => this.closeWarn(closeError, "fallback"));
    }
  }

  async chatComplete(messages: ChatMessage[], options: ChatOptions): Promise<ChatCompletionResult> {
    let outcome: "completed" | "failed" = "failed";
    try {
      const result = await this.chatCompleteChain(messages, options);
      outcome = "completed";
      return result;
    } finally {
      await this.settleAttempt?.(outcome);
    }
  }

  private async chatCompleteChain(messages: ChatMessage[], options: ChatOptions): Promise<ChatCompletionResult> {
    const startedAt = Date.now();
    let primaryErrorId: string | undefined;
    // Like chat(): once the primary has streamed visible text through onToken, falling back would
    // append a second reply to what the caller already received, so rethrow instead.
    let emittedUsableOutput = false;
    const primaryOptions = options.onToken
      ? {
          ...options,
          onToken: async (chunk: string) => {
            emittedUsableOutput ||= chunk.trim().length > 0;
            await options.onToken?.(chunk);
          },
        }
      : options;
    try {
      const result = await this.primary.chatComplete(
        prepareAssistantReasoningPrefillMessages(messages, this.primarySupportsAssistantReasoningPrefill),
        primaryOptions,
      );
      const hasUsableOutput = Boolean(result.content?.trim()) || result.toolCalls.length > 0;
      if (hasUsableOutput || emittedUsableOutput || options.signal?.aborted) {
        if (hasUsableOutput || emittedUsableOutput) this.onProviderUsed?.({ kind: "primary" });
        else this.logSkip("aborted", startedAt);
        return result;
      }
      primaryErrorId = await this.logFallback(undefined, startedAt);
    } catch (error) {
      const skip = emittedUsableOutput
        ? "after-output"
        : isAbortFailure(error, options.signal)
          ? "aborted"
          : isConnectionAdmissionFailure(error)
            ? "admission"
            : undefined;
      if (skip) {
        this.logSkip(skip, startedAt);
        throw error;
      }
      primaryErrorId = await this.logFallback(error, startedAt);
    }
    options.signal?.throwIfAborted();
    const fallbackStartedAt = Date.now();
    let result: ChatCompletionResult;
    try {
      result = await this.fallback.chatComplete(
        prepareAssistantReasoningPrefillMessages(messages, this.fallbackSupportsAssistantReasoningPrefill),
        fallbackOptions(options, this.connection),
      );
    } catch (fallbackError) {
      this.logFallbackResult(fallbackError, primaryErrorId, fallbackStartedAt, options.signal);
      throw fallbackError;
    }
    this.logFallbackResult(undefined, primaryErrorId, fallbackStartedAt, options.signal);
    this.onProviderUsed?.({
      kind: "fallback",
      provider: this.connection.provider,
      model: this.connection.model,
    });
    return result;
  }

  async embed(texts: string[], model: string, signal?: AbortSignal): Promise<number[][]> {
    return this.primary.embed(texts, model, signal);
  }
}

export function withConnectionFallbackProvider({
  primary,
  wrapProvider = (provider) => provider,
  primaryConnectionId,
  fallbackConnection,
  fallbackBaseUrl,
  category,
  onFallback,
  onProviderUsed,
  admissionMode = { kind: "foreground" },
  primarySupportsAssistantReasoningPrefill = true,
  fallbackSupportsAssistantReasoningPrefill = true,
}: ConnectionFallbackProviderArgs): BaseLLMProvider {
  const { primaryMode, fallbackMode, settle } = splitConnectionAttemptAcrossFallback(admissionMode);
  const unusable = fallbackConnectionUnusableReason(fallbackConnection, primaryConnectionId, fallbackBaseUrl);
  if (unusable) warnUnusableFallback(fallbackConnection, primaryConnectionId, category, unusable);
  if (unusable !== null || !fallbackConnection) {
    // No fallback exists, so the primary is the whole logical attempt and owns its own outcome.
    // Rate-limit-aware wraps outside admission so a 429 pauses/retries this connection here too —
    // the main chat/agent path builds `primary` without a connectionId, so it is added here.
    return withRateLimitAwareProvider(
      withConnectionAdmissionProvider(wrapProvider(primary), primaryConnectionId, admissionMode),
      primaryConnectionId,
    );
  }
  // A fallback exists, so a transient failure on the primary goes straight to it instead of
  // waiting out a transient backoff first (PROVIDER_RETRY_TRANSIENT_ERRORS). Rate limits are
  // unchanged. A primary that is already wrapped (createLLMProvider with a connectionId, or a
  // capability package passing one to llm.withFallback) has its own wrapper opted out too, since
  // admission may sit between it and the outer wrapper below.
  const primaryLeg = primary instanceof RateLimitAwareProvider ? primary.withoutTransientRetry() : primary;
  const admittedPrimary = withRateLimitAwareProvider(
    withConnectionAdmissionProvider(wrapProvider(primaryLeg), primaryConnectionId, primaryMode),
    primaryConnectionId,
    { transientRetry: false },
  );
  const fallback = withRateLimitAwareProvider(
    withConnectionAdmissionProvider(
      wrapProvider(
        createLLMProvider(
          fallbackConnection.provider,
          fallbackBaseUrl,
          fallbackConnection.apiKey,
          fallbackConnection.maxContext,
          fallbackConnection.openrouterProvider,
          fallbackConnection.maxTokensOverride,
          isEnabled(fallbackConnection.claudeFastMode),
          isEnabled(fallbackConnection.treatAsLocalEndpoint),
          fallbackConnection.defaultParameters,
          // Keep fallback diagnostics attributed to this connection; admission and retry wrap it below.
          fallbackConnection.id,
          false,
        ),
      ),
      fallbackConnection.id,
      fallbackMode,
    ),
    fallbackConnection.id,
  );
  return new ConnectionFallbackProvider(
    admittedPrimary,
    fallback,
    fallbackConnection,
    category,
    onFallback,
    settle,
    onProviderUsed,
    primarySupportsAssistantReasoningPrefill,
    fallbackSupportsAssistantReasoningPrefill,
    primaryConnectionId,
  );
}
