// ──────────────────────────────────────────────
// Storage: game dice roll history
// ──────────────────────────────────────────────
import { resolveEffectiveGameId } from "@marinara-engine/shared";
import { desc, eq } from "../../db/file-query.js";
import type { DB } from "../../db/connection.js";
import { chats, gameDiceRolls } from "../../db/schema/index.js";
import { isFeatureEnabled } from "../features/feature-settings.js";
import { logger } from "../../lib/logger.js";
import { newTimeSortableId, now } from "../../utils/id-generator.js";
import type { DiceRollLogEntry, DiceRollLogRecord, DiceRollLogSource } from "../game/dice-roll-log.js";

type GameDiceRollRow = typeof gameDiceRolls.$inferSelect;

function parseRolls(value: string): number[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((roll): roll is number => typeof roll === "number") : [];
  } catch {
    return [];
  }
}

function recordFrom(row: GameDiceRollRow): DiceRollLogRecord {
  return {
    id: row.id,
    chatId: row.chatId,
    gameId: row.gameId,
    messageId: row.messageId ?? null,
    source: row.source as DiceRollLogSource,
    actor: row.actor ?? null,
    label: row.label ?? null,
    notation: row.notation,
    rolls: parseRolls(row.rolls),
    modifier: row.modifier,
    total: row.total,
    critical: row.critical === 1,
    fumble: row.fumble === 1,
    createdAt: row.createdAt,
  };
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function createGameDiceRollsStorage(db: DB) {
  async function gameIdForChat(chatId: string): Promise<string | null> {
    const chat = (await db.select().from(chats).where(eq(chats.id, chatId)))[0];
    if (!chat || chat.mode !== "game") return null;
    return resolveEffectiveGameId(parseMetadata(chat.metadata).gameId, chat.groupId, chat.id);
  }

  return {
    gameIdForChat,

    /** Append entries for one chat. Returns how many were written; an unknown chat writes none. */
    async record(chatId: string, entries: readonly DiceRollLogEntry[], options: { messageId?: string | null } = {}) {
      if (entries.length === 0 || !isFeatureEnabled("diceLog")) return 0;
      const gameId = await gameIdForChat(chatId);
      if (gameId === null) return 0;
      const createdAt = now();
      let recorded = 0;
      for (const entry of entries) {
        // Recheck at the final write boundary so a switch changed while this batch was queued
        // cannot persist additional optional history after it is turned off.
        if (!isFeatureEnabled("diceLog")) break;
        await db.insert(gameDiceRolls).values({
          // Time-sortable so rolls written in the same millisecond keep their order.
          id: newTimeSortableId(),
          chatId,
          gameId,
          messageId: options.messageId ?? null,
          source: entry.source,
          actor: entry.actor,
          label: entry.label,
          notation: entry.notation,
          rolls: JSON.stringify(entry.rolls),
          modifier: entry.modifier,
          total: entry.total,
          critical: entry.critical ? 1 : 0,
          fumble: entry.fumble ? 1 : 0,
          createdAt,
        });
        recorded += 1;
      }
      return recorded;
    },

    /** Newest first, for one session chat or a whole game. */
    async list(scope: { chatId: string } | { gameId: string }) {
      const where = "chatId" in scope ? eq(gameDiceRolls.chatId, scope.chatId) : eq(gameDiceRolls.gameId, scope.gameId);
      const rows = (await db
        .select()
        .from(gameDiceRolls)
        .where(where)
        .orderBy(desc(gameDiceRolls.id))) as GameDiceRollRow[];
      return rows.map(recordFrom);
    },

    async clear(scope: { chatId: string } | { gameId: string }) {
      const where = "chatId" in scope ? eq(gameDiceRolls.chatId, scope.chatId) : eq(gameDiceRolls.gameId, scope.gameId);
      await db.delete(gameDiceRolls).where(where);
    },
  };
}

/**
 * Fire-and-forget logging for the roll paths. The roll has already happened and been
 * shown by the time this runs, so nothing here may throw into its caller: a failed
 * write is a warning in the log, never a failed roll.
 */
export function recordGameDiceRollsSafely(
  db: DB,
  chatId: string,
  entries: ReadonlyArray<DiceRollLogEntry | null | undefined>,
  options: { messageId?: string | null } = {},
): Promise<number> {
  const clean = entries.filter((entry): entry is DiceRollLogEntry => entry != null);
  if (clean.length === 0) return Promise.resolve(0);
  try {
    return createGameDiceRollsStorage(db)
      .record(chatId, clean, options)
      .catch((error: unknown) => {
        logger.warn(error, "[game/dice-log] Could not record %d roll(s) for chat %s", clean.length, chatId);
        return 0;
      });
  } catch (error) {
    logger.warn(error, "[game/dice-log] Could not record %d roll(s) for chat %s", clean.length, chatId);
    return Promise.resolve(0);
  }
}
