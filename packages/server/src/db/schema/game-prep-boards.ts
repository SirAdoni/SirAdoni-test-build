// ──────────────────────────────────────────────
// Game: GM prep boards
//
// One private planning board per campaign (Lazy DM style sections, items with
// done boxes, links and tags). `gameId` is a campaign identity, not a chat, so
// the row declares no foreign key and no cascade: deleting sessions, even the
// last one, leaves the board in place, and it is removed only on purpose.
// Nothing in prompt assembly reads this table; the board never reaches a model.
// ──────────────────────────────────────────────

import { fileTable, integer, text } from "../file-schema.js";

export const gamePrepBoards = fileTable("game_prep_boards", {
  id: text("id").primaryKey(),
  /** Effective game id (metadata.gameId, else the chat group, else the chat). */
  gameId: text("game_id").notNull(),
  /** Serialized PrepBoard. */
  board: text("board").notNull().default("{}"),
  /** Bumped on every save; a stale save is refused instead of overwriting. */
  revision: integer("revision").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
