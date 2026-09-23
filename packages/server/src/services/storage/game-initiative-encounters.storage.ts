// ──────────────────────────────────────────────
// Storage: saved initiative encounters
// ──────────────────────────────────────────────
import { sanitizeInitiativeState, type InitiativeEncounterState } from "@marinara-engine/shared";
import { eq } from "../../db/file-query.js";
import type { DB } from "../../db/connection.js";
import { gameInitiativeEncounters } from "../../db/schema/index.js";
import { newId, now } from "../../utils/id-generator.js";

type EncounterDbRow = typeof gameInitiativeEncounters.$inferSelect;

export interface InitiativeEncounterRecord {
  id: string;
  gameId: string;
  name: string;
  state: InitiativeEncounterState;
  createdAt: string;
  updatedAt: string;
}

/** Most encounters one game may keep; a guard against a runaway client, not a design limit. */
export const MAX_INITIATIVE_ENCOUNTERS = 500;
export const MAX_ENCOUNTER_NAME = 120;

function parseState(value: string): InitiativeEncounterState {
  try {
    return sanitizeInitiativeState(JSON.parse(value));
  } catch {
    return sanitizeInitiativeState(null);
  }
}

function recordFrom(row: EncounterDbRow): InitiativeEncounterRecord {
  return {
    id: row.id,
    gameId: row.gameId,
    name: row.name,
    state: parseState(row.state),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function cleanName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, MAX_ENCOUNTER_NAME);
}

export function createInitiativeEncountersStorage(db: DB) {
  async function getById(id: string): Promise<InitiativeEncounterRecord | null> {
    const row = (await db.select().from(gameInitiativeEncounters).where(eq(gameInitiativeEncounters.id, id)))[0] as
      | EncounterDbRow
      | undefined;
    return row ? recordFrom(row) : null;
  }

  return {
    getById,

    /** A game's encounters, most recently changed first. */
    async listForGame(gameId: string): Promise<InitiativeEncounterRecord[]> {
      const rows = (await db
        .select()
        .from(gameInitiativeEncounters)
        .where(eq(gameInitiativeEncounters.gameId, gameId))) as EncounterDbRow[];
      return rows.map(recordFrom).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    },

    async countForGame(gameId: string): Promise<number> {
      return db.count(gameInitiativeEncounters, eq(gameInitiativeEncounters.gameId, gameId));
    },

    /** Create an encounter. Returns null when the name is empty. */
    async create(gameId: string, name: string, state: unknown): Promise<InitiativeEncounterRecord | null> {
      const clean = cleanName(name);
      if (!clean) return null;
      const id = newId();
      const timestamp = now();
      await db.insert(gameInitiativeEncounters).values({
        id,
        gameId,
        name: clean,
        state: JSON.stringify(sanitizeInitiativeState(state)),
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      return getById(id);
    },

    /** Replace an encounter's state and optionally its name. */
    async update(id: string, input: { name?: string; state?: unknown }): Promise<InitiativeEncounterRecord | null> {
      const existing = await getById(id);
      if (!existing) return null;
      const name = input.name === undefined ? existing.name : cleanName(input.name) || existing.name;
      await db
        .update(gameInitiativeEncounters)
        .set({
          name,
          ...(input.state !== undefined && { state: JSON.stringify(sanitizeInitiativeState(input.state)) }),
          updatedAt: now(),
        })
        .where(eq(gameInitiativeEncounters.id, id));
      return getById(id);
    },

    async remove(id: string): Promise<boolean> {
      const existing = await getById(id);
      if (!existing) return false;
      await db.delete(gameInitiativeEncounters).where(eq(gameInitiativeEncounters.id, id));
      return true;
    },
  };
}
