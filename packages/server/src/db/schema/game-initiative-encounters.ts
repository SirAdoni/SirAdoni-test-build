// ──────────────────────────────────────────────
// Game: saved initiative encounters
//
// Encounters the GM built in the Tools tab's initiative tracker: who is in the
// fight, the turn order, the round, and HP and condition notes. Like random
// tables, `gameId` is a campaign identity, not a chat, so an encounter outlives
// any one session and the row declares no foreign key and no cascade.
// ──────────────────────────────────────────────

import { fileTable, text } from "../file-schema.js";

export const gameInitiativeEncounters = fileTable("game_initiative_encounters", {
  id: text("id").primaryKey(),
  /** The effective game id the encounter belongs to. */
  gameId: text("game_id").notNull(),
  name: text("name").notNull(),
  /** Serialized InitiativeEncounterState. */
  state: text("state").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
