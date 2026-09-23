import type { Chat, Lorebook } from "@marinara-engine/shared";
import { deriveActiveLorebookViews, getChatActiveLorebookIds, getChatExcludedLorebookIds } from "./chat-lorebooks";

/**
 * Ids from a lorebook selection that an Enable (or Disable) action would flip.
 * Unknown ids are skipped so a stale selection never reaches the server.
 */
export function planLorebookSelectionEnable(
  selectedIds: Iterable<string>,
  enabledById: ReadonlyMap<string, boolean>,
  enable: boolean,
): string[] {
  const ids: string[] = [];
  for (const id of selectedIds) {
    if (!enabledById.has(id)) continue;
    if (enabledById.get(id) !== enable) ids.push(id);
  }
  return ids;
}

/**
 * Lorebooks that feed the given chat right now: enabled, in scope, and pinned to the
 * chat, global, linked to its characters or persona, or chat-owned. Books switched
 * off for this chat (excludedLorebookIds) are left out.
 */
export function getInChatLorebookIds(
  chat: Pick<Chat, "id" | "characterIds" | "personaId" | "metadata"> | null | undefined,
  lorebooks: Lorebook[],
): Set<string> {
  if (!chat) return new Set();
  const views = deriveActiveLorebookViews({
    activeLorebookIds: getChatActiveLorebookIds(chat),
    excludedLorebookIds: getChatExcludedLorebookIds(chat),
    dropExcluded: true,
    chat,
    lorebooks,
  });
  return new Set(views.map((view) => view.id));
}
