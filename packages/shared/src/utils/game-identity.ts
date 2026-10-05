/** Resolve the stable campaign identity shared by current and legacy chats. */
export function resolveEffectiveGameId(
  metadataGameId: unknown,
  groupId: string | null | undefined,
  chatId: string,
): string {
  const explicit = typeof metadataGameId === "string" ? metadataGameId.trim() : "";
  return explicit || groupId?.trim() || chatId;
}
