/** Stable game identity shared by continuity publication and per-campaign receipts. */
export function continuityCampaignIdentity(
  chatId: string,
  metadata: Record<string, unknown>,
  groupId?: string | null,
): string {
  const gameId = typeof metadata.gameId === "string" && metadata.gameId.trim() ? metadata.gameId.trim() : null;
  return gameId ?? (groupId?.trim() || chatId);
}

export function isContinuityBranch(metadata: Record<string, unknown>): boolean {
  return ["branchParentChatId", "branchName"].some((key) => typeof metadata[key] === "string" && metadata[key].trim());
}

export function continuitySessionNumber(metadata: Record<string, unknown>): number | null {
  const value = metadata.gameSessionNumber;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}
