import { create } from "zustand";

interface ConversationGamesStore {
  pickerChatId: string | null;
  setup: { packageId: string; chatId: string } | null;
  openPicker: (chatId: string) => void;
  closePicker: () => void;
  openSetup: (packageId: string, chatId: string) => void;
  closeSetup: () => void;
}

export const useConversationGamesStore = create<ConversationGamesStore>((set) => ({
  pickerChatId: null,
  setup: null,
  openPicker: (chatId) => set({ pickerChatId: chatId }),
  closePicker: () => set({ pickerChatId: null }),
  openSetup: (packageId, chatId) => set({ pickerChatId: null, setup: { packageId, chatId } }),
  closeSetup: () => set({ setup: null }),
}));
