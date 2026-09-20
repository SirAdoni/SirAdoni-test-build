import { createHash } from "node:crypto";
import { fitMessagesToContext, type ChatMessage } from "../llm/base-provider.js";

export interface PromptHistoryReplayScope {
  provider: string;
  model: string;
  scope: string;
}

// Any change to the canonical message boundary invalidates persisted replay
// descriptors instead of risking reuse against a differently scoped prompt.
export const PROMPT_HISTORY_REPLAY_SCOPE_VERSION = 2 as const;

export interface PromptHistoryReplayDescriptor {
  descriptorVersion: 1;
  scopeVersion: typeof PROMPT_HISTORY_REPLAY_SCOPE_VERSION;
  messageFingerprints: string[];
  tailStart: number;
  currentUserFingerprint: string;
  promptSha256: string;
  canonicalCharCount: number;
  textOnly: boolean;
  hasMarkedFullLore: boolean;
  scope: PromptHistoryReplayScope;
}

export interface PromptHistoryReplayOptions {
  currentMessages: readonly ChatMessage[];
  previousPrompt: readonly ChatMessage[];
  previousDescriptor: PromptHistoryReplayDescriptor;
  scope: PromptHistoryReplayScope;
  maxContext?: number;
  maxTokens?: number;
}

export interface PromptHistoryReplayResult {
  prompt: ChatMessage[];
  appendedMessages: ChatMessage[];
  canonicalMessages: ChatMessage[];
  descriptor: PromptHistoryReplayDescriptor;
}

export const PROMPT_HISTORY_REPLAY_TAIL_PREAMBLE =
  "The following context applies to the following user turn. The newest snapshot replaces prior snapshots, including fields now absent. Prior snapshots describe only prior turns. The standing instruction hierarchy remains unchanged.";

const SNAPSHOT_MARKER = "marinaraPromptHistoryReplaySnapshot";
const RUNTIME_MARKER = "marinaraRuntimeContext";
const PREAMBLE_MARKER = "marinaraPromptHistoryReplayPreamble";

function isReplaySnapshot(message: ChatMessage): boolean {
  return (
    message.role === "system" &&
    message.contextKind === "injection" &&
    message.providerMetadata?.[SNAPSHOT_MARKER] === true &&
    message.providerMetadata?.[RUNTIME_MARKER] === true
  );
}

function isReplayPreamble(message: ChatMessage): boolean {
  return (
    message.role === "system" &&
    message.content === PROMPT_HISTORY_REPLAY_TAIL_PREAMBLE &&
    message.contextKind === "injection" &&
    message.providerMetadata?.[PREAMBLE_MARKER] === true &&
    message.providerMetadata?.[RUNTIME_MARKER] === true
  );
}

/**
 * Seed the producer-owned boundary before the first current-turn injection.
 * The marker is deliberately narrow: arbitrary system text cannot become
 * archived replay state merely by resembling a runtime snapshot.
 */
export function seedPromptHistoryReplaySnapshot(messages: readonly ChatMessage[]): ChatMessage[] {
  const historyIndexes = messages
    .map((message, index) => (message.contextKind === "history" ? index : -1))
    .filter((index) => index >= 0);
  const currentUserIndex = historyIndexes.at(-1);
  const previousHistoryIndex = historyIndexes.at(-2);
  if (
    currentUserIndex === undefined ||
    previousHistoryIndex === undefined ||
    currentUserIndex !== messages.length - 1 ||
    messages[currentUserIndex]?.role !== "user"
  )
    return [...messages];
  const mutableTail = messages.slice(previousHistoryIndex + 1, currentUserIndex);
  if (
    mutableTail.some((message) => message.role === "system" && !isReplayPreamble(message) && !isReplaySnapshot(message))
  )
    return [...messages];
  const firstInjection = messages.findIndex(
    (message, index) => index > previousHistoryIndex && index < currentUserIndex && message.contextKind === "injection",
  );
  if (firstInjection < 0) return [...messages];
  const preambleIndex = messages.findIndex(
    (message, index) => index > previousHistoryIndex && index < currentUserIndex && isReplayPreamble(message),
  );
  if (preambleIndex === firstInjection) return [...messages];
  const preamble: ChatMessage = {
    role: "system",
    content: PROMPT_HISTORY_REPLAY_TAIL_PREAMBLE,
    contextKind: "injection",
    // Keep the preamble at the same provider priority and cache boundary as
    // the snapshot it scopes; otherwise adjacent-message merging can erase it.
    providerMetadata: { [PREAMBLE_MARKER]: true, [RUNTIME_MARKER]: true },
  };
  return [...messages.slice(0, firstInjection), preamble, ...messages.slice(firstInjection)];
}

function validReplaySystemLayout(messages: readonly ChatMessage[], tailStart: number): boolean {
  const tail = messages.slice(tailStart);
  const firstInjection = tail.findIndex((message) => message.contextKind === "injection");
  if (firstInjection < 0 || !isReplayPreamble(tail[firstInjection]!)) return false;
  for (const message of tail) {
    if (isReplayPreamble(message)) continue;
    if (isReplaySnapshot(message)) continue;
    if (message.role === "system") return false;
  }
  return true;
}

/** Retained state adds input: only opt in after a measured large partial cache hit. */
export function shouldReplayPromptHistory(input: {
  replayed?: unknown;
  promptTokens?: unknown;
  cachedTokens?: unknown;
}): boolean {
  const { promptTokens, cachedTokens } = input;
  if (
    typeof promptTokens !== "number" ||
    !Number.isFinite(promptTokens) ||
    promptTokens < 200_000 ||
    typeof cachedTokens !== "number" ||
    !Number.isFinite(cachedTokens) ||
    cachedTokens <= 0 ||
    cachedTokens > promptTokens
  ) {
    return false;
  }
  // These are conservative optimization thresholds, not provider cache limits.
  // Keep an established chain when its improved hit rate crosses the entry threshold.
  return input.replayed === true || cachedTokens / promptTokens < 0.8;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function wireMessage(message: ChatMessage): Record<string, unknown> {
  // contextKind is a fitting hint, not provider wire content. In particular,
  // a saved history message may be reclassified by a later prompt assembly.
  return {
    role: message.role,
    content: message.content,
    ...(message.tool_call_id === undefined ? {} : { tool_call_id: message.tool_call_id }),
    ...(message.tool_calls === undefined ? {} : { tool_calls: message.tool_calls }),
    ...(message.images === undefined ? {} : { images: message.images }),
    ...(message.files === undefined ? {} : { files: message.files }),
    ...(message.media === undefined ? {} : { media: message.media }),
    ...(message.providerMetadata === undefined ? {} : { providerMetadata: message.providerMetadata }),
  };
}

function wireText(message: ChatMessage): string {
  return JSON.stringify(canonicalize(wireMessage(message)));
}

function fingerprint(message: ChatMessage): string {
  return createHash("sha256").update(wireText(message), "utf8").digest("hex");
}

function promptSha256(prompt: readonly ChatMessage[]): string {
  const serialized = JSON.stringify(prompt.map(wireMessage).map(canonicalize));
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

function canonicalCharCount(messages: readonly ChatMessage[]): number {
  return messages.reduce((total, message) => total + wireText(message).length, 0);
}

function isTextOnly(message: ChatMessage): boolean {
  return (
    !message.tool_call_id &&
    !message.tool_calls?.length &&
    !message.images?.length &&
    !message.files?.length &&
    !message.media?.length
  );
}

function sameScope(a: PromptHistoryReplayScope, b: PromptHistoryReplayScope): boolean {
  return a.provider === b.provider && a.model === b.model && a.scope === b.scope;
}

function isMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<ChatMessage>;
  return (
    (message.role === "system" || message.role === "user" || message.role === "assistant" || message.role === "tool") &&
    typeof message.content === "string"
  );
}

/** Create the small descriptor persisted alongside an exact saved prompt. */
export function createPromptHistoryReplayDescriptor(
  messages: readonly ChatMessage[],
  prompt: readonly ChatMessage[],
  scope: PromptHistoryReplayScope,
): PromptHistoryReplayDescriptor | null {
  const last = messages.at(-1);
  if (!last || last.role !== "user" || last.contextKind !== "history") return null;

  const historyIndexes = messages
    .map((message, index) => (message.contextKind === "history" ? index : -1))
    .filter((index) => index >= 0);
  if (historyIndexes.length < 2 || historyIndexes.at(-1) !== messages.length - 1) return null;

  const tailStart = historyIndexes.at(-2)! + 1;
  const previousHistoryIndex = historyIndexes.at(-2)!;
  if (
    previousHistoryIndex >= tailStart ||
    tailStart >= messages.length - 1 ||
    !validReplaySystemLayout(messages, tailStart) ||
    !messages.slice(tailStart, -1).some((m) => m.contextKind === "injection") ||
    !messages.every(isTextOnly) ||
    !messages.some((message) => message.providerMetadata?.marinaraFullLoreContext === true)
  ) {
    return null;
  }

  return {
    descriptorVersion: 1,
    scopeVersion: PROMPT_HISTORY_REPLAY_SCOPE_VERSION,
    messageFingerprints: messages.map(fingerprint),
    tailStart,
    currentUserFingerprint: fingerprint(last),
    promptSha256: promptSha256(prompt),
    canonicalCharCount: canonicalCharCount(messages),
    textOnly: messages.every(isTextOnly),
    hasMarkedFullLore: messages.some((message) => message.providerMetadata?.marinaraFullLoreContext === true),
    scope: { ...scope },
  };
}

function validDescriptor(descriptor: unknown): descriptor is PromptHistoryReplayDescriptor {
  if (!descriptor || typeof descriptor !== "object") return false;
  const candidate = descriptor as Partial<PromptHistoryReplayDescriptor>;
  const tailStart = candidate.tailStart;
  const canonicalChars = candidate.canonicalCharCount;
  const fingerprints = candidate.messageFingerprints;
  return (
    candidate.descriptorVersion === 1 &&
    candidate.scopeVersion === PROMPT_HISTORY_REPLAY_SCOPE_VERSION &&
    Array.isArray(fingerprints) &&
    fingerprints.length > 0 &&
    Number.isInteger(tailStart) &&
    typeof tailStart === "number" &&
    tailStart >= 0 &&
    tailStart < fingerprints.length &&
    typeof candidate.currentUserFingerprint === "string" &&
    typeof candidate.promptSha256 === "string" &&
    Number.isFinite(canonicalChars) &&
    typeof canonicalChars === "number" &&
    canonicalChars > 0 &&
    candidate.textOnly === true &&
    typeof candidate.hasMarkedFullLore === "boolean" &&
    !!candidate.scope &&
    typeof candidate.scope.provider === "string" &&
    typeof candidate.scope.model === "string" &&
    typeof candidate.scope.scope === "string"
  );
}

function appendableTail(messages: readonly ChatMessage[], tailStart: number): ChatMessage[] | null {
  const tail = messages.slice(tailStart + 1);
  const current = messages.at(-1);
  if (!current || current.role !== "user" || current.contextKind !== "history") return null;
  if (
    tail.length < 2 ||
    tail.some((message) => message.role === "tool") ||
    tail.some((message) => message.role === "system" && !isReplayPreamble(message) && !isReplaySnapshot(message)) ||
    !tail.some(isReplayPreamble)
  )
    return null;
  if (!tail.some((message) => message.role === "assistant" && message.contextKind === "history")) return null;
  return [...tail];
}

/**
 * Reuse an exact saved prompt only when the canonical prefix and provider
 * scope still match. Returns null for any uncertain or unsafe case.
 */
export function tryReplayPromptHistory(options: PromptHistoryReplayOptions): PromptHistoryReplayResult | null {
  const { currentMessages, previousPrompt, previousDescriptor, scope, maxContext, maxTokens } = options;
  if (!Array.isArray(previousPrompt) || previousPrompt.length === 0 || !previousPrompt.every(isMessage)) return null;
  if (!validDescriptor(previousDescriptor)) return null;
  if (!sameScope(previousDescriptor.scope, scope)) return null;
  try {
    if (promptSha256(previousPrompt) !== previousDescriptor.promptSha256) return null;
  } catch {
    return null;
  }

  const currentLast = currentMessages.at(-1);
  if (!currentLast || currentLast.role !== "user" || currentLast.contextKind !== "history") return null;
  if (!currentMessages.every(isTextOnly) || !previousDescriptor.textOnly) return null;
  if (
    !previousDescriptor.hasMarkedFullLore ||
    !currentMessages.some((message) => message.providerMetadata?.marinaraFullLoreContext === true)
  ) {
    return null;
  }
  if (currentMessages.length <= previousDescriptor.tailStart + 1) return null;

  const oldFingerprints = previousDescriptor.messageFingerprints;
  const candidatePrefix = currentMessages.slice(0, previousDescriptor.tailStart);
  if (candidatePrefix.length !== previousDescriptor.tailStart) return null;
  if (candidatePrefix.some((message, index) => fingerprint(message) !== oldFingerprints[index])) return null;
  if (fingerprint(currentMessages[previousDescriptor.tailStart]!) !== previousDescriptor.currentUserFingerprint)
    return null;

  const tail = appendableTail(currentMessages, previousDescriptor.tailStart);
  if (!tail) return null;
  const currentChars = canonicalCharCount(currentMessages);
  // Persist the descriptor from canonical messages while replaying the exact
  // expanded prompt separately; this keeps the next turn's prefix index valid.
  const prompt = [...previousPrompt, ...tail];
  const expandedChars = canonicalCharCount(prompt);
  const extraLimit = Math.min(500_000, Math.floor(currentChars * 0.5));
  if (expandedChars - currentChars > extraLimit) return null;

  if (maxContext !== undefined || maxTokens !== undefined) {
    try {
      const fitted = fitMessagesToContext([...prompt], { maxContext, maxTokens });
      if (fitted.trimmed) return null;
    } catch {
      return null;
    }
  }

  const descriptor = createPromptHistoryReplayDescriptor(currentMessages, prompt, scope);
  if (!descriptor) return null;
  return { prompt, appendedMessages: tail, canonicalMessages: [...currentMessages], descriptor };
}
