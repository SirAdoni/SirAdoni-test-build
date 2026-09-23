import { useChatStore } from "../stores/chat.store";
import { useUIStore } from "../stores/ui.store";

/** Open the GM prep board full-screen for the open game chat. */
export function openPrepBoard(chatId?: string | null) {
  useUIStore.getState().openModal("prep-board", { chatId: chatId ?? useChatStore.getState().activeChatId ?? "" });
}
