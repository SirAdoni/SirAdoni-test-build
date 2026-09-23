// ──────────────────────────────────────────────
// Open the Chapters tab of the chat search panel from elsewhere (command palette)
// ──────────────────────────────────────────────
export const CHAT_CHAPTERS_OPEN_EVENT = "marinara:open-chat-chapters";

export function requestChatChapters(chatId: string) {
  window.dispatchEvent(new CustomEvent(CHAT_CHAPTERS_OPEN_EVENT, { detail: { chatId } }));
}

export function readChatChaptersRequest(event: Event): string | null {
  const detail = (event as CustomEvent<{ chatId?: unknown }>).detail;
  return typeof detail?.chatId === "string" ? detail.chatId : null;
}
