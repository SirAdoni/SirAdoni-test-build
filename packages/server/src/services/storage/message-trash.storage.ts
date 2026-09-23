// ──────────────────────────────────────────────
// Storage: Message Trash
// ──────────────────────────────────────────────
// User deletes snapshot the exact message + swipe rows before the normal delete path runs,
// so every delete side effect (interruption undo, game state, lore cascade, memory chunk
// invalidation) stays in one place. Restore reinserts the rows under their original ids and
// createdAt, which puts them back at their original position in the timeline.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type MessageTrashEntry } from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { encodeShardKey, isLazyUnitTable } from "../../db/file-backed-store.js";
import { and, desc, eq, gt, inArray, isNull, lt } from "../../db/file-query.js";
import { chats, memoryChunks, messages, messageSwipes, messageTrash } from "../../db/schema/index.js";
import { newId, now } from "../../utils/id-generator.js";
import { createChatsStorage } from "./chats.storage.js";
import { getFeatureNumber } from "../features/feature-settings.js";

type MessageRow = typeof messages.$inferSelect;
type SwipeRow = typeof messageSwipes.$inferSelect;
type TrashRow = typeof messageTrash.$inferSelect;
type TrashSnapshot = { message: MessageRow; swipes: SwipeRow[] };

/** Retention window from Settings > Features "Message trash" days (default 30). */
const retentionMs = () => getFeatureNumber("messageTrashDays") * 24 * 60 * 60 * 1000;
const CHUNK = 500;

function parseSnapshot(row: TrashRow): TrashSnapshot | null {
  try {
    const parsed = JSON.parse(row.snapshot) as Partial<TrashSnapshot> | null;
    if (!parsed?.message || typeof parsed.message.id !== "string") return null;
    return { message: parsed.message, swipes: Array.isArray(parsed.swipes) ? parsed.swipes : [] };
  } catch {
    return null;
  }
}

export function toMessageTrashEntry(row: TrashRow): MessageTrashEntry {
  const snapshot = parseSnapshot(row);
  const deletedMs = Date.parse(row.deletedAt);
  return {
    id: row.id,
    chatId: row.chatId,
    messageId: row.messageId,
    role: row.role,
    characterId: row.characterId ?? null,
    content: row.content,
    swipeCount: snapshot?.swipes.length ?? 0,
    messageCreatedAt: row.messageCreatedAt,
    deletedAt: row.deletedAt,
    expiresAt: new Date((Number.isNaN(deletedMs) ? Date.now() : deletedMs) + retentionMs()).toISOString(),
  };
}

export type RestoreTrashResult = {
  restoredMessageIds: string[];
  /** Entries left in the trash because a message with the same id exists again. */
  conflictEntryIds: string[];
};

export function createMessageTrashStorage(db: DB) {
  const chatsStorage = createChatsStorage(db);

  const readTrash = async (chatId: string, entryIds?: string[]) =>
    entryIds
      ? db
          .select()
          .from(messageTrash)
          .where(and(eq(messageTrash.chatId, chatId), inArray(messageTrash.id, entryIds)))
      : db.select().from(messageTrash).where(eq(messageTrash.chatId, chatId));

  return {
    /** Drop entries older than the retention window. Returns how many were purged. */
    async purgeExpired(chatId: string, nowMs = Date.now()): Promise<number> {
      const cutoff = new Date(nowMs - retentionMs()).toISOString();
      const expired = await db
        .select({ id: messageTrash.id })
        .from(messageTrash)
        .where(and(eq(messageTrash.chatId, chatId), lt(messageTrash.deletedAt, cutoff)));
      if (expired.length === 0) return 0;
      await db.delete(messageTrash).where(
        inArray(
          messageTrash.id,
          expired.map((row) => row.id),
        ),
      );
      return expired.length;
    },

    async list(chatId: string): Promise<MessageTrashEntry[]> {
      await this.purgeExpired(chatId);
      const rows = await db
        .select()
        .from(messageTrash)
        .where(eq(messageTrash.chatId, chatId))
        .orderBy(desc(messageTrash.deletedAt), desc(messageTrash.messageCreatedAt));
      return rows.map(toMessageTrashEntry);
    },

    async count(chatId: string): Promise<number> {
      return db.count(messageTrash, eq(messageTrash.chatId, chatId));
    },

    /**
     * Move messages of one chat to its trash, then delete them through the normal path.
     * Ids outside the chat are ignored. Returns the ids that were trashed.
     */
    async trashMessages(chatId: string, messageIds: string[]): Promise<string[]> {
      const uniqueIds = [...new Set(messageIds)];
      if (uniqueIds.length === 0) return [];
      await this.purgeExpired(chatId);
      const rows: MessageRow[] = [];
      for (let i = 0; i < uniqueIds.length; i += CHUNK) {
        rows.push(
          ...(await db
            .select()
            .from(messages)
            .where(and(eq(messages.chatId, chatId), inArray(messages.id, uniqueIds.slice(i, i + CHUNK))))),
        );
      }
      if (rows.length === 0) return [];
      const ids = rows.map((row) => row.id);
      const swipesByMessage = new Map<string, SwipeRow[]>();
      for (const swipe of await chatsStorage.listSwipesByMessageIds(ids)) {
        const list = swipesByMessage.get(swipe.messageId) ?? [];
        list.push(swipe);
        swipesByMessage.set(swipe.messageId, list);
      }
      const deletedAt = now();
      const entries = rows.map((row) => ({
        id: newId(),
        chatId,
        messageId: row.id,
        role: row.role,
        characterId: row.characterId ?? null,
        content: row.content,
        snapshot: JSON.stringify({
          message: row,
          swipes: (swipesByMessage.get(row.id) ?? []).sort((a, b) => a.index - b.index),
        } satisfies TrashSnapshot),
        messageCreatedAt: row.createdAt,
        deletedAt,
      }));
      for (let i = 0; i < entries.length; i += CHUNK) {
        await db.insert(messageTrash).values(entries.slice(i, i + CHUNK));
      }
      try {
        await chatsStorage.removeMessages(ids, chatId);
      } finally {
        // A partially failed delete must not leave trash copies of messages that still exist.
        const survivors = new Set(
          (
            await db
              .select({ id: messages.id })
              .from(messages)
              .where(and(eq(messages.chatId, chatId), inArray(messages.id, ids)))
          ).map((row) => row.id),
        );
        const orphaned = entries.filter((entry) => survivors.has(entry.messageId)).map((entry) => entry.id);
        if (orphaned.length > 0) await db.delete(messageTrash).where(inArray(messageTrash.id, orphaned));
      }
      return ids;
    },

    /** Put trashed messages back at their original position (same id, createdAt, swipes and extra). */
    async restore(chatId: string, entryIds: string[]): Promise<RestoreTrashResult> {
      const result: RestoreTrashResult = { restoredMessageIds: [], conflictEntryIds: [] };
      const rows = (await readTrash(chatId, [...new Set(entryIds)])).sort((a, b) =>
        a.messageCreatedAt.localeCompare(b.messageCreatedAt),
      );
      let earliest: string | null = null;
      let latest: string | null = null;
      for (const row of rows) {
        const snapshot = parseSnapshot(row);
        if (!snapshot || (await chatsStorage.getMessage(row.messageId))) {
          result.conflictEntryIds.push(row.id);
          continue;
        }
        const message = { ...snapshot.message, chatId, id: row.messageId };
        await db.insert(messages).values({
          id: message.id,
          chatId,
          role: message.role,
          characterId: message.characterId ?? null,
          content: message.content ?? "",
          activeSwipeIndex: message.activeSwipeIndex ?? 0,
          extra: typeof message.extra === "string" ? message.extra : JSON.stringify(message.extra ?? {}),
          createdAt: message.createdAt,
        });
        // Swipe ids are reused as-is: they left with their message. Probing them by id would be an
        // unscopable query that leases the whole lazy message_swipes table and can resurrect
        // stale rows from disk, which then duplicated every restored swipe.
        if (snapshot.swipes.length > 0) {
          await db.insert(messageSwipes).values(
            snapshot.swipes.map((swipe) => ({
              id: typeof swipe.id === "string" && swipe.id ? swipe.id : newId(),
              messageId: message.id,
              index: swipe.index,
              content: swipe.content ?? "",
              extra: typeof swipe.extra === "string" ? swipe.extra : JSON.stringify(swipe.extra ?? {}),
              createdAt: swipe.createdAt,
            })),
          );
        }
        await db.delete(messageTrash).where(eq(messageTrash.id, row.id));
        result.restoredMessageIds.push(message.id);
        if (!earliest || message.createdAt < earliest) earliest = message.createdAt;
        if (!latest || message.createdAt > latest) latest = message.createdAt;
      }
      if (earliest && latest) {
        // Recall chunks built across the gap no longer match the transcript.
        await db
          .delete(memoryChunks)
          .where(
            and(
              eq(memoryChunks.chatId, chatId),
              isNull(memoryChunks.sourceChatId),
              gt(memoryChunks.lastMessageAt, earliest),
            ),
          );
        await db
          .delete(memoryChunks)
          .where(
            and(
              eq(memoryChunks.chatId, chatId),
              isNull(memoryChunks.sourceChatId),
              eq(memoryChunks.lastMessageAt, earliest),
            ),
          );
        const chat = (
          await db.select({ lastMessageAt: chats.lastMessageAt }).from(chats).where(eq(chats.id, chatId))
        )[0];
        if (chat && (!chat.lastMessageAt || chat.lastMessageAt < latest)) {
          await db.update(chats).set({ lastMessageAt: latest }).where(eq(chats.id, chatId));
        }
        // Deleting undid any roleplay interruption this message applied; re-apply it where still valid.
        for (const id of result.restoredMessageIds) {
          const restored = await chatsStorage.getMessage(id);
          if (restored && restored.extra.includes("roleplayCommandActivity")) {
            await chatsStorage.reconcileRoleplayInterruption(id);
          }
        }
      }
      return result;
    },

    /** Permanently remove trash entries (all of the chat's entries when `entryIds` is omitted). */
    async deleteForever(chatId: string, entryIds?: string[]): Promise<number> {
      const rows = await readTrash(chatId, entryIds ? [...new Set(entryIds)] : undefined);
      if (rows.length === 0) return 0;
      await db.delete(messageTrash).where(
        inArray(
          messageTrash.id,
          rows.map((row) => row.id),
        ),
      );
      return rows.length;
    },
  };
}

/** True when a trash shard file holds at least one entry deleted before `cutoff`. Unreadable means yes. */
function shardHasExpiredEntry(path: string, cutoff: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return true; // Let the store's own loader arbitrate a damaged shard.
  }
  const stack: unknown[] = [parsed];
  while (stack.length > 0) {
    const value = stack.pop();
    if (!value || typeof value !== "object") continue;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if ((key === "deletedAt" || key === "deleted_at") && typeof child === "string" && child < cutoff) return true;
      if (child && typeof child === "object") stack.push(child);
    }
  }
  return false;
}

/**
 * Purge expired trash in chats nobody has opened. Listing a chat's trash purges it too, but
 * without this sweep a never-reopened chat would keep expired entries forever. Resident chats
 * are purged in memory; for the rest only chats whose trash shard file holds an expired entry
 * are loaded, at most `maxChats` per sweep so one pass never loads the whole library.
 */
export async function sweepExpiredMessageTrash(
  db: DB,
  options: { nowMs?: number; maxChats?: number } = {},
): Promise<{ purged: number; chats: number }> {
  const nowMs = options.nowMs ?? Date.now();
  const maxChats = options.maxChats ?? 25;
  const cutoff = new Date(nowMs - retentionMs()).toISOString();
  const store = createMessageTrashStorage(db);
  const fileStore = db._fileStore;
  const resident = fileStore.getResidentChatUnits();
  const lazy = isLazyUnitTable("message_trash") && !fileStore.getFullyResidentLazyTables().has("message_trash");
  const shardDir = join(fileStore.rootDir, "tables", "message_trash");
  let purged = 0;
  let touched = 0;
  for (const { id } of await db.select({ id: chats.id }).from(chats)) {
    if (lazy && !resident.has(id)) {
      if (touched >= maxChats) continue;
      const shardPath = join(shardDir, `${encodeShardKey(id)}.json`);
      if (!existsSync(shardPath) || !shardHasExpiredEntry(shardPath, cutoff)) continue;
      touched += 1;
    }
    purged += await store.purgeExpired(id, nowMs);
  }
  return { purged, chats: touched };
}
