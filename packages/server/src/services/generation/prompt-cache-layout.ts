export interface PromptCacheLayoutMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  contextKind?: "prompt" | "history" | "injection";
  providerMetadata?: Record<string, unknown>;
}

export interface FullLorebookContextParts {
  stable: string | undefined;
  dynamic: string | undefined;
}

/**
 * Keep the most recent assistant history directly beside the current Game
 * user turn when app-owned volatile context was inserted between them. This
 * preserves the stable lore and older transcript prefix. An adjacent final
 * exchange is ineligible for the old mutable-tail replay optimization: we
 * trade that optimization for clearer conversational continuity.
 */
export function keepGameDialogueAdjacent<T extends PromptCacheLayoutMessage>(input: readonly T[]): T[] {
  const currentUserIndex = input.length - 1;
  const currentUser = input[currentUserIndex];
  if (currentUser?.role !== "user" || currentUser.contextKind !== "history") return input.slice();
  const messages = moveLeadingRuntimeSystemContextToCurrentTurn(input);

  let historyIndex = -1;
  for (let index = currentUserIndex - 1; index >= 0; index -= 1) {
    if (messages[index]?.contextKind === "history") {
      historyIndex = index;
      break;
    }
  }
  if (historyIndex < 0 || messages[historyIndex]?.role !== "assistant") return messages.slice();

  const isMovableRuntimeContext = (message: T): boolean =>
    (message.role === "user" &&
      (message.contextKind === "injection" ||
        message.providerMetadata?.marinaraRuntimeContext === true ||
        message.providerMetadata?.marinaraDynamicLoreContext === true)) ||
    (message.role === "system" &&
      message.contextKind === "injection" &&
      (message.providerMetadata?.marinaraRuntimeContext === true ||
        message.providerMetadata?.marinaraDynamicLoreContext === true));
  for (let index = historyIndex + 1; index < currentUserIndex; index += 1) {
    if (!isMovableRuntimeContext(messages[index]!)) return messages.slice();
  }
  if (historyIndex === currentUserIndex - 1) return messages.slice();

  const next = messages.slice();
  const [assistant] = next.splice(historyIndex, 1);
  next.splice(next.length - 1, 0, assistant!);
  return next;
}

/**
 * App-owned runtime system blocks inserted straight after the system prompt (for example the World Maps
 * spatial context, which names the current location) change whenever the scene does. Left there, every
 * change rewrites the whole history behind them and breaks prefix caching for providers that cache by
 * prefix. Move them to just before the current user turn, the same place the subscription layout uses.
 * Only system injections marked as runtime or dynamic lore context move; user-authored prompt sections
 * and everything else keep their position.
 */
function moveLeadingRuntimeSystemContextToCurrentTurn<T extends PromptCacheLayoutMessage>(messages: readonly T[]): T[] {
  const isLeadingRuntime = (message: T): boolean =>
    message.role === "system" &&
    message.contextKind === "injection" &&
    (message.providerMetadata?.marinaraRuntimeContext === true ||
      message.providerMetadata?.marinaraDynamicLoreContext === true);
  let prefixEnd = 0;
  while (prefixEnd < messages.length && messages[prefixEnd]?.role === "system") prefixEnd += 1;
  const moving = messages.slice(0, prefixEnd).filter(isLeadingRuntime);
  if (moving.length === 0 || prefixEnd >= messages.length - 1) return messages.slice();
  const movingSet = new Set(moving);
  const next = messages.filter((message) => !movingSet.has(message));
  next.splice(next.length - 1, 0, ...moving);
  return next;
}

export function splitFullLorebookContext(
  scan:
    | {
        fullContext?: string;
        stableFullContext?: string;
        dynamicFullContext?: string;
      }
    | null
    | undefined,
): FullLorebookContextParts {
  return { stable: scan?.stableFullContext ?? scan?.fullContext, dynamic: scan?.dynamicFullContext };
}

/** Providers whose request shape has a dedicated stable lore prefix. */
export function supportsFullLorebookContext(provider: string | null | undefined): boolean {
  return provider === "openai_chatgpt" || provider === "claude_subscription";
}

export function shouldUseFullLorebookContext(
  provider: string | null | undefined,
  explicitlyDisabled: boolean,
): boolean {
  return supportsFullLorebookContext(provider) && !explicitlyDisabled;
}

/**
 * Keep the marked lore prefix byte-for-byte at the front while moving app-owned
 * leading injections next to the current turn. User-authored prompt sections
 * and runtime agent sections retain their existing placement.
 */
export function normalizePromptCacheLayout<T extends PromptCacheLayoutMessage>(messages: readonly T[]): T[] {
  const next = messages.map((message) => ({ ...message })) as T[];
  const hasPromptMacroSyntax = (value: string) => /\{\{[^{}]+\}\}/u.test(value);
  const loreIndex = next.findIndex((message) => message.providerMetadata?.marinaraFullLoreContext === true);
  if (loreIndex > 0) {
    const [lore] = next.splice(loreIndex, 1);
    if (lore) next.unshift(lore);
  }
  const prefixLore = next[0]?.providerMetadata?.marinaraFullLoreContext === true ? 1 : 0;
  const leadingInjections: T[] = [];
  let index = prefixLore;
  while (index < next.length) {
    const message = next[index];
    if (message?.role !== "system") break;
    if (
      message.contextKind === "injection" &&
      (message.providerMetadata?.marinaraRuntimeContext === true ||
        message.providerMetadata?.marinaraDynamicLoreContext === true)
    ) {
      leadingInjections.push(message);
    }
    index += 1;
  }
  if (leadingInjections.length > 0) {
    const movable = new Set(leadingInjections);
    const retainedPrefix = next.slice(0, index).filter((message) => !movable.has(message));
    next.splice(0, index, ...retainedPrefix);
    const currentTurnIndex = next.reduce((found, message, currentIndex) => {
      return message.contextKind === "history" && message.role === "user" ? currentIndex : found;
    }, -1);
    const prefillIndex = next.length > 0 && next[next.length - 1]?.role === "assistant" ? next.length - 1 : next.length;
    const insertAt = currentTurnIndex >= 0 ? currentTurnIndex : prefillIndex;
    next.splice(insertAt, 0, ...leadingInjections);
  }

  const references: T[] = [];
  for (let cursor = next.length - 1; cursor >= 0; cursor -= 1) {
    if (next[cursor]?.providerMetadata?.marinaraGmReference !== true) continue;
    references.unshift(next[cursor]!);
    next.splice(cursor, 1);
  }
  if (references.length > 0) {
    const stableReferences: T[] = [];
    const macroReferences: T[] = [];
    for (const reference of references) {
      if (hasPromptMacroSyntax(reference.content) || reference.providerMetadata?.marinaraRuntimeContext === true) {
        macroReferences.push(reference);
        continue;
      }
      stableReferences.push({
        ...reference,
        role: "user",
        contextKind: "injection",
      } as T);
    }
    const systemPrefixEnd = next.findIndex((message) => message.role !== "system");
    next.splice(systemPrefixEnd >= 0 ? systemPrefixEnd : next.length, 0, ...stableReferences);
    if (macroReferences.length > 0) {
      const currentTurnIndex = next.reduce((found, message, currentIndex) => {
        return message.contextKind === "history" && message.role === "user" ? currentIndex : found;
      }, -1);
      const prefillIndex =
        next.length > 0 && next[next.length - 1]?.role === "assistant" ? next.length - 1 : next.length;
      const macroInsertAt = currentTurnIndex >= 0 ? currentTurnIndex : prefillIndex;
      next.splice(
        macroInsertAt,
        0,
        ...macroReferences.map(
          (reference) =>
            ({
              ...reference,
              role: "user",
              contextKind: "injection",
            }) as T,
        ),
      );
    }
  }
  return next;
}

export function markNewRuntimeContextMessages<T extends PromptCacheLayoutMessage>(
  before: readonly T[],
  transform: (messages: T[]) => T[],
  replaySnapshot = false,
): T[] {
  const marker = Symbol("prompt-cache-origin");
  const tagged = before.map((message) => ({ ...message, [marker]: true }) as T);
  return transform(tagged).map((message) => {
    const marked = (message as Record<PropertyKey, unknown>)[marker] === true;
    const clean = { ...message } as Record<PropertyKey, unknown>;
    delete clean[marker];
    if (marked || message.role !== "system") return clean as T;
    // Runtime context is common infrastructure; only explicit producer-owned
    // snapshots may opt into history replay, so generic injections stay untrusted.
    return {
      ...(clean as T),
      contextKind: message.contextKind ?? "injection",
      providerMetadata: {
        ...(message.providerMetadata ?? {}),
        marinaraRuntimeContext: true,
        ...(replaySnapshot ? { marinaraPromptHistoryReplaySnapshot: true } : {}),
      },
    } as T;
  });
}
