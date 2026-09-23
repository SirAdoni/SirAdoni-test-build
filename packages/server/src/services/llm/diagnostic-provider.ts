import { randomUUID } from "node:crypto";
import type { DiagnosticContext } from "../../lib/diagnostics.js";
import {
  createDiagnostic,
  getDiagnosticContext,
  markDiagnosticReported,
  withDiagnosticContext,
} from "../../lib/diagnostics.js";
import { reportDiagnosticError } from "../../lib/diagnostic-operation.js";
import { logger } from "../../lib/logger.js";
import type { ChatCompletionResult, ChatMessage, ChatOptions, LLMUsage } from "./base-provider.js";
import { BaseLLMProvider } from "./base-provider.js";

type ProviderOperationContext = DiagnosticContext & {
  operationId: string;
  provider: string;
  model?: string;
  connectionId?: string;
};

function operationContext(
  provider: string,
  connectionId: string | undefined,
  model?: string,
): ProviderOperationContext {
  return {
    ...getDiagnosticContext(),
    operation: "llm.provider",
    stage: "completion",
    operationId: randomUUID(),
    provider,
    ...(connectionId ? { connectionId } : {}),
    ...(model ? { model } : {}),
  };
}

function safeLength(value: unknown): number | undefined {
  return typeof value === "string" ? value.length : undefined;
}

type CallKind = "stream" | "complete" | "embed";
type FailureStage = "cancelled" | "partial-stream" | "failure";

function numberField(error: unknown, key: string): number | undefined {
  const value = error && typeof error === "object" ? (error as Record<string, unknown>)[key] : undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringField(error: unknown, key: string): string | undefined {
  const value = error && typeof error === "object" ? (error as Record<string, unknown>)[key] : undefined;
  return typeof value === "string" && value ? value : undefined;
}

function usageFields(usage: LLMUsage | void | undefined) {
  return usage
    ? {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        cachedPromptTokens: usage.cachedPromptTokens,
        cacheWritePromptTokens: usage.cacheWritePromptTokens,
        finishReason: usage.finishReason,
      }
    : undefined;
}

function logStart(context: ProviderOperationContext, callKind: CallKind): void {
  logger.debug({ ...context, event: "llm.call", stage: "start", callKind }, "LLM provider call started");
}

/** Writes the one line for a failed provider call, chosen by stage. */
function logFailure(
  context: ProviderOperationContext,
  error: unknown,
  startedAt: number,
  stage: FailureStage,
  callKind: CallKind,
): void {
  const elapsedMs = Date.now() - startedAt;
  if (stage === "failure") {
    reportDiagnosticError(error, { ...context, stage }, undefined, {
      event: "llm.call",
      message: "LLM provider call failed",
      fields: {
        outcome: "failed",
        stage,
        elapsedMs,
        httpStatus: numberField(error, "status"),
        providerCode: stringField(error, "providerCode"),
        retryAfterMs: numberField(error, "retryAfterMs"),
        retryAttempts: numberField(error, "retryAttempts"),
        callKind,
      },
    });
    return;
  }
  const diagnostic = createDiagnostic(error, { ...context, stage });
  if (stage === "cancelled") {
    logger.info(
      {
        ...context,
        event: "llm.call",
        stage,
        outcome: "cancelled",
        callKind,
        elapsedMs,
        errorId: diagnostic.errorId,
        errorCode: diagnostic.code,
      },
      "LLM provider call cancelled",
    );
  } else {
    logger.warn(
      {
        ...context,
        event: "llm.call",
        stage,
        outcome: "failed",
        degraded: true,
        callKind,
        elapsedMs,
        httpStatus: numberField(error, "status"),
        providerCode: stringField(error, "providerCode"),
        errorId: diagnostic.errorId,
        errorCode: diagnostic.code,
        err: error,
      },
      "LLM provider stream failed after partial output",
    );
  }
  markDiagnosticReported(error);
}

function logCompletion(context: ProviderOperationContext, startedAt: number, result: ChatCompletionResult): void {
  const cancelled = result.finishReason === "abort";
  const degraded = result.finishReason === "error";
  const record = {
    ...context,
    event: "llm.call",
    callKind: "complete",
    stage: cancelled ? "cancelled" : degraded ? "partial-stream" : "success",
    outcome: cancelled ? "cancelled" : degraded ? "failed" : "ok",
    ...(degraded ? { degraded: true } : {}),
    elapsedMs: Date.now() - startedAt,
    finishReason: result.finishReason,
    outputLength: safeLength(result.content),
    usage: usageFields(result.usage),
  };
  if (cancelled) logger.info(record, "LLM provider completion cancelled");
  else if (degraded) logger.warn(record, "LLM provider completion degraded after partial output");
  else logger.info(record, "LLM provider completion succeeded");
}

function wrapChatIterator(
  iterator: AsyncGenerator<string, LLMUsage | void, unknown>,
  context: ProviderOperationContext,
  startedAt: number,
  signal?: AbortSignal,
): AsyncGenerator<string, LLMUsage | void, unknown> {
  let outputLength = 0;
  let firstYieldMs: number | undefined;
  let settled = false;
  const run = <T>(operation: () => Promise<T>): Promise<T> => withDiagnosticContext(context, operation);
  const finishFailure = (error: unknown) => {
    if (settled) return;
    settled = true;
    logFailure(
      context,
      error,
      startedAt,
      signal?.aborted ? "cancelled" : outputLength > 0 ? "partial-stream" : "failure",
      "stream",
    );
  };
  const finishSuccess = (usage: LLMUsage | void) => {
    if (settled) return;
    settled = true;
    const stage =
      usage && (usage.finishReason === "abort" || usage.finishReason === "error")
        ? usage.finishReason === "abort"
          ? "cancelled"
          : "partial-stream"
        : "success";
    const record = {
      ...context,
      event: "llm.call",
      callKind: "stream",
      stage,
      outcome: stage === "cancelled" ? "cancelled" : stage === "partial-stream" ? "failed" : "ok",
      ...(stage === "partial-stream" ? { degraded: true } : {}),
      elapsedMs: Date.now() - startedAt,
      firstYieldMs,
      outputLength,
      usage: usageFields(usage),
    };
    if (stage === "cancelled") logger.info(record, "LLM provider stream cancelled");
    else if (stage === "partial-stream") logger.warn(record, "LLM provider stream degraded after partial output");
    else logger.info(record, "LLM provider stream succeeded");
  };
  const wrapped = {
    next(value?: unknown) {
      return run(() => iterator.next(value)).then(
        (result) => {
          if (result.done) finishSuccess(result.value);
          else {
            outputLength += result.value.length;
            firstYieldMs ??= Date.now() - startedAt;
          }
          return result;
        },
        (error) => {
          finishFailure(error);
          throw error;
        },
      );
    },
    return(value?: LLMUsage | void) {
      return run(() => iterator.return(value)).then(
        (result) => {
          if (!settled) {
            settled = true;
            logger.info(
              {
                ...context,
                event: "llm.call",
                callKind: "stream",
                stage: "cancelled",
                outcome: "cancelled",
                elapsedMs: Date.now() - startedAt,
                firstYieldMs,
                outputLength,
              },
              "LLM provider stream closed early",
            );
          }
          return result;
        },
        (error) => {
          finishFailure(error);
          throw error;
        },
      );
    },
    throw(error?: unknown) {
      return run(() => iterator.throw(error)).then(
        (result) => {
          if (result.done) finishSuccess(result.value);
          else {
            outputLength += result.value.length;
            firstYieldMs ??= Date.now() - startedAt;
          }
          return result;
        },
        (failure) => {
          finishFailure(failure);
          throw failure;
        },
      );
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  } as AsyncGenerator<string, LLMUsage | void, unknown>;
  return wrapped;
}

class DiagnosticProvider extends BaseLLMProvider {
  constructor(
    private readonly provider: BaseLLMProvider,
    private readonly providerName: string,
    private readonly connectionId?: string,
  ) {
    super("", "", provider.maxContextValue ?? undefined, null, provider.maxTokensOverrideValue);
  }

  override setCustomRequestHeaders(headers: Record<string, string>): void {
    super.setCustomRequestHeaders(headers);
    this.provider.setCustomRequestHeaders(headers);
  }

  chat(messages: ChatMessage[], options: ChatOptions): AsyncGenerator<string, LLMUsage | void, unknown> {
    const context = operationContext(this.providerName, this.connectionId, options.model);
    const startedAt = Date.now();
    logStart(context, "stream");
    try {
      const iterator = withDiagnosticContext(context, () => this.provider.chat(messages, options));
      return wrapChatIterator(iterator, context, startedAt, options.signal);
    } catch (error) {
      logFailure(context, error, startedAt, options.signal?.aborted ? "cancelled" : "failure", "stream");
      throw error;
    }
  }

  override chatComplete(messages: ChatMessage[], options: ChatOptions): Promise<ChatCompletionResult> {
    const startedAt = Date.now();
    const context = operationContext(this.providerName, this.connectionId, options.model);
    logStart(context, "complete");
    let result: Promise<ChatCompletionResult>;
    try {
      result = withDiagnosticContext(context, () => this.provider.chatComplete(messages, options));
    } catch (error) {
      logFailure(context, error, startedAt, "failure", "complete");
      throw error;
    }
    return result.then(
      (value) => {
        logCompletion(context, startedAt, value);
        return value;
      },
      (error) => {
        logFailure(context, error, startedAt, options.signal?.aborted ? "cancelled" : "failure", "complete");
        throw error;
      },
    );
  }

  override embed(texts: string[], model: string, signal?: AbortSignal): Promise<number[][]> {
    const startedAt = Date.now();
    const context = operationContext(this.providerName, this.connectionId, model);
    logStart(context, "embed");
    let result: Promise<number[][]>;
    try {
      result = withDiagnosticContext(context, () => this.provider.embed(texts, model, signal));
    } catch (error) {
      logFailure(context, error, startedAt, "failure", "embed");
      throw error;
    }
    return result.then(
      (value) => {
        logger.info(
          {
            ...context,
            event: "llm.call",
            callKind: "embed",
            stage: "success",
            outcome: "ok",
            elapsedMs: Date.now() - startedAt,
            outputLength: value.length,
          },
          "LLM provider embedding succeeded",
        );
        return value;
      },
      (error) => {
        logFailure(context, error, startedAt, signal?.aborted ? "cancelled" : "failure", "embed");
        throw error;
      },
    );
  }
}

export function withDiagnosticProvider(
  provider: BaseLLMProvider,
  providerName: string,
  connectionId?: string,
): BaseLLMProvider {
  if (provider instanceof DiagnosticProvider) return provider;
  return new DiagnosticProvider(provider, providerName, connectionId);
}
