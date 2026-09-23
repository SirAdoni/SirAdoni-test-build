import { useUIStore } from "../stores/ui.store";

export const CHARACTER_DUPLICATES_MODAL = "character-duplicates";

/** Open "Find duplicate characters" from anywhere (the Characters panel has its own copy). */
export function openCharacterDuplicates() {
  useUIStore.getState().openModal(CHARACTER_DUPLICATES_MODAL);
}
