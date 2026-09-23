import type { Message } from "@marinara-engine/shared";

export function normalizeHydratedMessage(message: Message): Message {
  const rawContent = (message as Message & { content?: unknown }).content;
  let normalizedContent: string;
  let normalizedExtra = message.extra;
  if (typeof rawContent === "string") {
    normalizedContent = rawContent;
  } else if (rawContent && typeof rawContent === "object" && !Array.isArray(rawContent)) {
    const legacyPayload = rawContent as Record<string, unknown>;
    const nestedText = typeof legacyPayload.content === "string" ? legacyPayload.content : "";
    normalizedContent =
      nestedText ||
      (Object.keys(legacyPayload).every((key) => key === "reactions") ? "" : JSON.stringify(legacyPayload));
    if (Array.isArray(legacyPayload.reactions)) {
      const extra =
        normalizedExtra && typeof normalizedExtra === "object" && !Array.isArray(normalizedExtra)
          ? (normalizedExtra as unknown as Record<string, unknown>)
          : {};
      normalizedExtra = {
        displayText: null,
        isGenerated: message.role === "assistant",
        tokenCount: null,
        generationInfo: null,
        ...extra,
        reactions: Array.isArray(extra.reactions) ? extra.reactions : legacyPayload.reactions,
      } as unknown as Message["extra"];
    }
  } else {
    normalizedContent = rawContent == null ? "" : String(rawContent);
  }
  const activeSwipeIndex = (message as Message & { activeSwipeIndex?: unknown }).activeSwipeIndex;
  if (typeof activeSwipeIndex === "number" && Number.isInteger(activeSwipeIndex) && activeSwipeIndex >= 0) {
    return normalizedContent === rawContent && normalizedExtra === message.extra
      ? message
      : { ...message, content: normalizedContent, extra: normalizedExtra };
  }
  return { ...message, content: normalizedContent, extra: normalizedExtra, activeSwipeIndex: 0 };
}
