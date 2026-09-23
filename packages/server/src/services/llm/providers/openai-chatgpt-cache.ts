import { createHash } from "node:crypto";

import type { ChatMessage } from "../base-provider.js";
import { isFeatureEnabled } from "../../features/feature-settings.js";

const FULL_LORE_METADATA_KEY = "marinaraFullLoreContext";
const CACHE_SCOPE_NAMESPACE = "marinara-chat-cache-scope:v1:";

export function formatOpenAIChatGPTCacheSession(identity: string): string {
  const hash = identity;
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/**
 * Resolve the opaque routing identity used by the ChatGPT subscription cache.
 * A caller-provided chat scope stays stable when lore changes; legacy callers
 * retain the historical full-lore hash behavior. Undefined when the ChatGPT history replay
 * feature is off: no session-id header and no prompt_cache_key, as upstream sends.
 */
export function resolveOpenAIChatGPTCacheIdentity(messages: ChatMessage[]): string | undefined {
  if (!isFeatureEnabled("chatgptHistoryReplay")) return undefined;
  const lore = messages.find((message) => message.providerMetadata?.[FULL_LORE_METADATA_KEY] === true);
  if (!lore) return undefined;

  const rawScope = lore.providerMetadata?.marinaraCacheScope;
  const scope = typeof rawScope === "string" ? rawScope.trim() : "";
  const material = scope ? `${CACHE_SCOPE_NAMESPACE}${scope}` : lore.content;
  return createHash("sha256").update(material).digest("hex").slice(0, 40);
}
