import { isFeatureEnabled } from "../features/feature-settings.js";

export interface PromptCacheLayoutMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  contextKind?: "prompt" | "history" | "injection";
  providerMetadata?: Record<string, unknown>;
}

/** An invariant final-boundary check that may live in the cached prefix instead of the per-turn tail. */
export interface StableFinalCheck {
  /** The exact check text, as the prompt carries it at the final boundary. */
  content: string;
  /** The short reminder left at the final boundary in its place. */
  pointer: string;
}

export interface PromptCacheLayoutOptions {
  /**
   * Checks to keep in the cached prefix (the chat opted in with `gameCacheStableFinalChecks`). Their full text
   * moves just before the history and a short pointer stays at the final boundary. Omitted, nothing moves.
   */
  stableFinalChecks?: readonly StableFinalCheck[];
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
  // Settings > Features "Cache-friendly prompt layout" off: keep the assembled order, as upstream.
  if (!isFeatureEnabled("cacheFriendlyPromptLayout")) return input.slice();
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
/**
 * The layout a real turn would send, for a prompt preview that has no pending player message yet. The real
 * path reorders around the current user turn (generate.routes.ts prepareProviderMessages and the subscription
 * normalizePromptCacheLayout), so this adds a placeholder turn, applies the same reordering for the chat mode
 * and provider, and removes the placeholder: runtime blocks such as the World Maps spatial context end up where
 * the next real request will carry them.
 */
export function layoutAsNextTurn<T extends PromptCacheLayoutMessage>(
  messages: readonly T[],
  options: { chatMode: string | null | undefined; provider: string | null | undefined },
): T[] {
  const placeholder = { role: "user", content: "", contextKind: "history" } as T;
  const withTurn = [...messages, placeholder];
  const ordered = supportsFullLorebookContext(options.provider)
    ? normalizePromptCacheLayout(withTurn)
    : options.chatMode === "game"
      ? keepGameDialogueAdjacent(withTurn)
      : withTurn;
  return ordered.filter((message) => message !== placeholder);
}

export function supportsFullLorebookContext(provider: string | null | undefined): boolean {
  return provider === "openai_chatgpt" || provider === "claude_subscription";
}

/**
 * Full-lore layout is the default on subscription providers. With the "Cache-friendly prompt layout"
 * feature off it is no longer the default: only a chat that explicitly turned it on keeps it, and every
 * other chat gets the keyword lore scan.
 */
export function shouldUseFullLorebookContext(
  provider: string | null | undefined,
  explicitlyDisabled: boolean,
  explicitlyEnabled = false,
): boolean {
  if (!supportsFullLorebookContext(provider) || explicitlyDisabled) return false;
  return explicitlyEnabled || isFeatureEnabled("cacheFriendlyPromptLayout");
}

/**
 * Keep the marked lore prefix byte-for-byte at the front while moving app-owned
 * leading injections next to the current turn. User-authored prompt sections
 * and runtime agent sections retain their existing placement.
 */
export function normalizePromptCacheLayout<T extends PromptCacheLayoutMessage>(
  messages: readonly T[],
  options: PromptCacheLayoutOptions = {},
): T[] {
  if (!isFeatureEnabled("cacheFriendlyPromptLayout")) return messages.map((message) => ({ ...message })) as T[];
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
  return relocateStableFinalChecks(next, options.stableFinalChecks);
}

/**
 * Move invariant final-boundary checks into the cached prefix, just before the history and the per-turn blocks, and leave the
 * short pointer in their old place. Anything after the last completed exchange is written to the cache again on the
 * next turn, because the new exchange lands in front of it; a check whose bytes never change can sit before the
 * history instead and is then read from the cache on every later turn. Only checks the caller names by exact content
 * move, and only from inside or after the history. A check that is absent this turn moves nothing, so the request
 * is byte-for-byte the plain layout.
 */
function relocateStableFinalChecks<T extends PromptCacheLayoutMessage>(
  messages: T[],
  checks: readonly StableFinalCheck[] | undefined,
): T[] {
  if (!checks?.length) return messages;
  const next = messages.slice();
  const moved: T[] = [];
  for (const check of checks) {
    if (!check.content.trim() || !check.pointer.trim()) continue;
    const firstHistory = next.findIndex((message) => message.contextKind === "history");
    if (firstHistory < 0) break;
    let index = -1;
    for (let cursor = next.length - 1; cursor > firstHistory; cursor -= 1) {
      const message = next[cursor]!;
      if (message.contextKind === "injection" && message.content === check.content) {
        index = cursor;
        break;
      }
    }
    if (index < 0) continue;
    const original = next[index]!;
    next[index] = { ...original, content: check.pointer };
    moved.push({ ...original });
  }
  if (moved.length === 0) return next;
  // Ahead of the history and of every per-turn injection, so a first turn (whose runtime blocks sit before the only
  // history message) already puts the check where every later turn keeps it.
  const slot = next.findIndex(
    (message) =>
      message.contextKind === "history" ||
      (message.contextKind === "injection" &&
        (message.providerMetadata?.marinaraRuntimeContext === true ||
          message.providerMetadata?.marinaraDynamicLoreContext === true)),
  );
  next.splice(slot, 0, ...moved);
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
