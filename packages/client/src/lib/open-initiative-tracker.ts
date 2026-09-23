import { useChatStore } from "../stores/chat.store";
import { useUIStore } from "../stores/ui.store";

/** Open the initiative tracker window for a game chat (the open one by default). */
export function openInitiativeTracker(chatId?: string | null) {
  const id = chatId ?? useChatStore.getState().activeChatId ?? "";
  if (!id) return;
  useUIStore.getState().openModal("initiative-tracker", { chatId: id });
}
