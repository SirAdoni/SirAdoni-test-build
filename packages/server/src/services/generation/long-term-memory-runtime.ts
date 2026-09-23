import type { ChatMode } from "@marinara-engine/shared";
import { getAgentCallTimeoutMs } from "../../config/runtime-config.js";
import { logger } from "../../lib/logger.js";
import { createDiagnostic } from "../../lib/diagnostics.js";
import { logRecovered, logRepeated } from "../../lib/log-events.js";
import { getCapabilityService } from "../capability-packages/capability-service-registry.service.js";
import { withLlmRequestTimeout } from "../llm/base-provider.js";

const SERVICE_KEY = "long-term-memory:runtime";
const MAX_RECALL_CHARACTERS = 100_000;

export type LongTermMemoryRecallReceipt = unknown;

export interface LongTermMemoryRuntimeService {
  recall(input: {
    chatId: string;
    chatMode: ChatMode;
    characterIds: string[];
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    signal?: AbortSignal;
    debugMode: boolean;
  }): Promise<{ text: string; receipt?: LongTermMemoryRecallReceipt } | null>;
  recordPromptAccepted(input: {
    chatId: string;
    receipt: LongTermMemoryRecallReceipt;
    messages: Array<{ role: string; content: string }>;
  }): Promise<void>;
}

function runtimeService(chatId?: string) {
  const service = getCapabilityService<LongTermMemoryRuntimeService>(SERVICE_KEY);
  if (!service) {
    logRepeated(
      "ltm:service-missing",
      "warn",
      { event: "package.service.missing", packageId: "long-term-memory", serviceKey: SERVICE_KEY, chatId },
      "Long-term memory runtime not registered; recall skipped",
    );
  } else {
    logRecovered("ltm:service-missing", { packageId: "long-term-memory", serviceKey: SERVICE_KEY });
  }
  return service;
}

export async function withLongTermMemoryRuntimeTimeout<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const timeoutController = new AbortController();
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
  const timeoutError = Object.assign(new Error(`Long-term memory operation timed out after ${timeoutMs} ms`), {
    name: "TimeoutError",
  });
  let rejectOnAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectOnAbort = () => {
      reject(combinedSignal.reason instanceof Error ? combinedSignal.reason : timeoutError);
    };
    if (combinedSignal.aborted) rejectOnAbort();
    else combinedSignal.addEventListener("abort", rejectOnAbort, { once: true });
  });
  const timeout = setTimeout(() => timeoutController.abort(timeoutError), timeoutMs);
  try {
    return await withLlmRequestTimeout(timeoutMs, () => Promise.race([operation(combinedSignal), aborted]));
  } finally {
    clearTimeout(timeout);
    if (rejectOnAbort) combinedSignal.removeEventListener("abort", rejectOnAbort);
  }
}

export async function recallLongTermMemory(
  input: Parameters<LongTermMemoryRuntimeService["recall"]>[0],
): Promise<{ text: string; receipt?: LongTermMemoryRecallReceipt } | null> {
  const service = runtimeService(input.chatId);
  if (!service) return null;
  const started = Date.now();
  try {
    const recall = await withLongTermMemoryRuntimeTimeout(
      getAgentCallTimeoutMs(),
      (signal) => service.recall({ ...input, signal }),
      input.signal,
    );
    const text = recall?.text.trim().slice(0, MAX_RECALL_CHARACTERS) ?? "";
    // Only the size of the recall is logged, never its text.
    logger.debug(
      {
        event: "ltm.recall",
        chatId: input.chatId,
        elapsedMs: Date.now() - started,
        outcome: "ok",
        recalledChars: text.length,
      },
      "Long-term memory recall finished",
    );
    return text ? { text, receipt: recall?.receipt ?? null } : null;
  } catch (error) {
    if (input.signal?.aborted) return null;
    logger.warn(
      {
        event: "ltm.recall",
        chatId: input.chatId,
        elapsedMs: Date.now() - started,
        outcome: "failed",
        errorCode: createDiagnostic(error).code,
        err: error,
      },
      "Long-term memory recall failed; continuing without recalled context",
    );
    return null;
  }
}

export async function recordLongTermMemoryPromptAccepted(
  input: Parameters<LongTermMemoryRuntimeService["recordPromptAccepted"]>[0],
): Promise<void> {
  const service = runtimeService(input.chatId);
  if (!service) return;
  try {
    await withLongTermMemoryRuntimeTimeout(getAgentCallTimeoutMs(), () => service.recordPromptAccepted(input));
  } catch (error) {
    logger.warn(error, "Long-term memory prompt accounting failed");
  }
}
