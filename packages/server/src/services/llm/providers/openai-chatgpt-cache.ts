import { createHash } from "node:crypto";
import type { ChatMessage } from "../base-provider.js";
import { isFeatureEnabled } from "../../features/feature-settings.js";

export const OPENAI_CHATGPT_CACHE_AFFINITY_METADATA_KEY = "marinaraChatGPTCacheAffinityScope";
const CACHE_AFFINITY_NAMESPACE = "marinara-chatgpt-cache-affinity:v1:";
const CACHE_IDENTITY_PATTERN = /^[a-f0-9]{40}$/u;

/** Add an opaque, chat-stable provider marker without changing prompt roles or content. */
export function prepareOpenAIChatGPTCacheAffinityMessages(
  messages: ChatMessage[],
  provider: string,
  chatId: string | null | undefined,
): ChatMessage[] {
  const scope = typeof chatId === "string" ? chatId.trim() : "";
  if (provider !== "openai_chatgpt" || !isFeatureEnabled("chatgptCacheAffinity") || !scope || messages.length === 0) {
    return messages;
  }

  const digest = createHash("sha256").update(CACHE_AFFINITY_NAMESPACE).update(scope).digest("hex").slice(0, 40);
  return messages.map((message, index) =>
    index === 0
      ? {
          ...message,
          providerMetadata: {
            ...message.providerMetadata,
            [OPENAI_CHATGPT_CACHE_AFFINITY_METADATA_KEY]: digest,
          },
        }
      : message,
  );
}

/** Resolve only the trusted opaque scope marker; never infer a cache identity from prompt content. */
export function resolveOpenAIChatGPTCacheIdentity(messages: ChatMessage[]): string | undefined {
  if (!isFeatureEnabled("chatgptCacheAffinity")) return undefined;
  for (const message of messages) {
    const value = message.providerMetadata?.[OPENAI_CHATGPT_CACHE_AFFINITY_METADATA_KEY];
    if (typeof value === "string" && CACHE_IDENTITY_PATTERN.test(value)) return value;
  }
  return undefined;
}

export function formatOpenAIChatGPTCacheSession(identity: string): string {
  return `${identity.slice(0, 8)}-${identity.slice(8, 12)}-5${identity.slice(13, 16)}-8${identity.slice(17, 20)}-${identity.slice(20, 32)}`;
}

/** Add the ChatGPT-supported session header when the request carries a marked scope. */
export function applyOpenAIChatGPTCacheSessionHeader(
  headers: Record<string, string>,
  messages: ChatMessage[],
): Record<string, string> {
  const identity = resolveOpenAIChatGPTCacheIdentity(messages);
  if (identity) headers["session-id"] = formatOpenAIChatGPTCacheSession(identity);
  return headers;
}
