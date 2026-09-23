import { useChatStore } from "../stores/chat.store";
import { useUIStore } from "../stores/ui.store";

/** Open the random tables and oracle window, scoped to the open chat's game when there is one. */
export function openRandomTables(chatId?: string | null) {
  useUIStore.getState().openModal("random-tables", { chatId: chatId ?? useChatStore.getState().activeChatId ?? "" });
}
