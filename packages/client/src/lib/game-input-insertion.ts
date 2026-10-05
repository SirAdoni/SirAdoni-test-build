import type { CardAssetInsertDetail } from "./card-asset-links";

export function buildGameInputInsertion(
  detail: CardAssetInsertDetail | null | undefined,
  activeChatId: string | undefined,
  currentValue: string,
  selectionStart: number | null,
  selectionEnd: number | null,
): { value: string; cursor: number } | null {
  if (!detail?.markdown || (detail.chatId && detail.chatId !== activeChatId)) return null;
  const start = Math.max(0, Math.min(selectionStart ?? currentValue.length, currentValue.length));
  const end = Math.max(start, Math.min(selectionEnd ?? start, currentValue.length));
  return {
    value: `${currentValue.slice(0, start)}${detail.markdown}${currentValue.slice(end)}`,
    cursor: start + detail.markdown.length,
  };
}
