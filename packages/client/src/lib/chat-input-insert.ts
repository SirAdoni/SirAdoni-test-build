import { dispatchCardAssetInsert } from "./card-asset-links";

/**
 * Put text into the chat input of `chatId` (or whichever input is open) without sending
 * it. Rides the card-asset insert event that ChatInput and GameInput already listen to.
 */
export function insertIntoChatInput(text: string, chatId?: string | null): void {
  const clean = text.trim();
  if (!clean) return;
  dispatchCardAssetInsert(clean, chatId ?? undefined);
}

/** An out-of-character note the GM can read but the story should not: "(OOC: ...)". */
export function formatOocNote(text: string): string {
  return `(OOC: ${text.replace(/\s+/g, " ").trim()})`;
}
