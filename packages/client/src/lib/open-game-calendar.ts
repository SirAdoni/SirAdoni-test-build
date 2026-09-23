import { useChatStore } from "../stores/chat.store";
import { useUIStore } from "../stores/ui.store";

/** Open the in-world calendar window for a game chat (the open one by default). */
export function openGameCalendar(chatId?: string | null) {
  const id = chatId ?? useChatStore.getState().activeChatId ?? "";
  if (!id) return;
  useUIStore.getState().openModal("game-calendar", { chatId: id });
}
