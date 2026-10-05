import { useUIStore } from "../stores/ui.store";

export function openLorebookEntry(lorebookId: string, entryId: string): void {
  useUIStore.getState().openLorebookDetail(lorebookId, {
    initialTab: "entries",
    entryId,
  });
}
