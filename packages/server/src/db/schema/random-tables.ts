// ──────────────────────────────────────────────
// Game: random tables
//
// The GM's own roll tables ("1-3: Bandits, 4-5: Wolves"), rolled from the Game
// Mode Tools tab or the command palette. A table is global when `gameId` is
// empty and belongs to one campaign otherwise. `gameId` is a campaign identity,
// not a chat, so the row declares no foreign key and no cascade: a table outlives
// any one session and is removed only on purpose.
// ──────────────────────────────────────────────

import { fileTable, text } from "../file-schema.js";

export const randomTables = fileTable("random_tables", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** "" for a global table, otherwise the effective game id it is scoped to. */
  gameId: text("game_id").notNull().default(""),
  /** Dice notation such as "2d6"; empty rolls the rows by weight. */
  dice: text("dice").notNull().default(""),
  description: text("description").notNull().default(""),
  /** Serialized RandomTableRow[]. */
  rows: text("rows").notNull().default("[]"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
