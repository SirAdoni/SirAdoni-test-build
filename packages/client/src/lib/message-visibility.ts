/** Safely read the hidden-from-AI flag from a message's extra payload. */
export function isMessageHidden(message: { extra?: unknown }): boolean {
  if (!message.extra) return false;
  try {
    const extra = typeof message.extra === "string" ? JSON.parse(message.extra) : message.extra;
    return !!extra && typeof extra === "object" && (extra as Record<string, unknown>).hiddenFromAI === true;
  } catch {
    return false;
  }
}
