// ──────────────────────────────────────────────
// Game: dice roll history
//
// An append-only log of every roll the Engine made for a game: the player's own
// rolls from the dice tray, the GM's [dice:] and roll_dice results, and skill
// checks. It is a history, not game state: nothing reads it back into a turn,
// so a rewind or a swipe leaves the record of what was rolled in place. Rows
// go away only with their chat.
//
// `gameId` is stamped at write time so the whole campaign can be read without
// walking every session chat.
// ──────────────────────────────────────────────

import { fileTable, text, integer } from "../file-schema.js";
import { chats } from "./chats.js";

export const gameDiceRolls = fileTable("game_dice_rolls", {
  id: text("id").primaryKey(),
  chatId: text("chat_id")
    .notNull()
    .references(() => chats.id, { onDelete: "cascade" }),
  gameId: text("game_id").notNull().default(""),
  messageId: text("message_id"),
  /** "player" (dice tray), "gm" (narration or tool roll) or "skill_check". */
  source: text("source").notNull(),
  /** Who rolled, when known: a party member's name for a ruleset check. */
  actor: text("actor"),
  /** What the roll was for: the tray context or the checked skill. */
  label: text("label"),
  notation: text("notation").notNull(),
  /** Serialized number[]: every die thrown, in order. */
  rolls: text("rolls").notNull().default("[]"),
  modifier: integer("modifier").notNull().default(0),
  total: integer("total").notNull(),
  critical: integer("critical").notNull().default(0),
  fumble: integer("fumble").notNull().default(0),
  createdAt: text("created_at").notNull(),
});
