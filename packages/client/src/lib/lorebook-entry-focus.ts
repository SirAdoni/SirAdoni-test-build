import { useUIStore } from "../stores/ui.store";

// A tool outside the lorebook editor (the GM prep board) can ask the editor to
// open on one entry. The request is picked up once the editor has loaded that
// lorebook's entries, then cleared.
let pending: { lorebookId: string; entryId: string } | null = null;

export function openLorebookEntry(lorebookId: string, entryId: string) {
  pending = { lorebookId, entryId };
  useUIStore.getState().openLorebookDetail(lorebookId, { initialTab: "entries" });
}

/** The entry to reveal in `lorebookId`, consumed on read. */
export function takePendingLorebookEntryFocus(lorebookId: string): string | null {
  if (!pending || pending.lorebookId !== lorebookId) return null;
  const { entryId } = pending;
  pending = null;
  return entryId;
}

export function hasPendingLorebookEntryFocus(lorebookId: string): boolean {
  return pending?.lorebookId === lorebookId;
}
