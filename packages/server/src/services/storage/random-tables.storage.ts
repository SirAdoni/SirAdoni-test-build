// ──────────────────────────────────────────────
// Storage: random tables
// ──────────────────────────────────────────────
import { sanitizeRandomTable, type RandomTableRow } from "@marinara-engine/shared";
import { eq, inArray } from "../../db/file-query.js";
import type { DB } from "../../db/connection.js";
import { randomTables } from "../../db/schema/index.js";
import { newId, now } from "../../utils/id-generator.js";

type RandomTableDbRow = typeof randomTables.$inferSelect;

export interface RandomTableRecord {
  id: string;
  name: string;
  /** "" for a global table. */
  gameId: string;
  dice: string | null;
  description: string;
  rows: RandomTableRow[];
  createdAt: string;
  updatedAt: string;
}

export interface RandomTableInput {
  name: string;
  dice?: string | null;
  description?: string;
  rows: unknown[];
}

/** Most tables one scope may hold; a guard against a runaway import, not a design limit. */
export const MAX_RANDOM_TABLES = 2000;

function parseRows(value: string): RandomTableRow[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return sanitizeRandomTable({ name: "x", rows: Array.isArray(parsed) ? parsed : [] })?.rows ?? [];
  } catch {
    return [];
  }
}

function recordFrom(row: RandomTableDbRow): RandomTableRecord {
  return {
    id: row.id,
    name: row.name,
    gameId: row.gameId ?? "",
    dice: row.dice ? row.dice : null,
    description: row.description ?? "",
    rows: parseRows(row.rows),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function byName(left: RandomTableRecord, right: RandomTableRecord) {
  return left.name.localeCompare(right.name) || left.createdAt.localeCompare(right.createdAt);
}

export function createRandomTablesStorage(db: DB) {
  async function getById(id: string): Promise<RandomTableRecord | null> {
    const row = (await db.select().from(randomTables).where(eq(randomTables.id, id)))[0] as
      | RandomTableDbRow
      | undefined;
    return row ? recordFrom(row) : null;
  }

  return {
    getById,

    /**
     * The tables a game can see: its own first, then the global ones. With no game, only
     * the global tables. Game tables come first so a campaign's "Encounters" shadows a
     * global table of the same name when rows refer to it.
     */
    async listVisible(gameId: string | null): Promise<RandomTableRecord[]> {
      const scopes = gameId ? ["", gameId] : [""];
      const rows = (await db
        .select()
        .from(randomTables)
        .where(inArray(randomTables.gameId, scopes))) as RandomTableDbRow[];
      const records = rows.map(recordFrom);
      const own = records.filter((record) => record.gameId !== "").sort(byName);
      const global = records.filter((record) => record.gameId === "").sort(byName);
      return [...own, ...global];
    },

    async countInScope(gameId: string): Promise<number> {
      return db.count(randomTables, eq(randomTables.gameId, gameId));
    },

    /** Create a table. Returns null when the input has no name. */
    async create(input: RandomTableInput, gameId: string): Promise<RandomTableRecord | null> {
      const clean = sanitizeRandomTable(input);
      if (!clean) return null;
      const id = newId();
      const timestamp = now();
      await db.insert(randomTables).values({
        id,
        name: clean.name,
        gameId,
        dice: clean.dice ?? "",
        description: clean.description,
        rows: JSON.stringify(clean.rows),
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      return getById(id);
    },

    /** Replace a table's content, optionally moving it between global and a game. */
    async update(id: string, input: RandomTableInput, gameId?: string): Promise<RandomTableRecord | null> {
      const existing = await getById(id);
      if (!existing) return null;
      const clean = sanitizeRandomTable(input);
      if (!clean) return null;
      await db
        .update(randomTables)
        .set({
          name: clean.name,
          dice: clean.dice ?? "",
          description: clean.description,
          rows: JSON.stringify(clean.rows),
          ...(gameId !== undefined && { gameId }),
          updatedAt: now(),
        })
        .where(eq(randomTables.id, id));
      return getById(id);
    },

    async remove(id: string): Promise<boolean> {
      const existing = await getById(id);
      if (!existing) return false;
      await db.delete(randomTables).where(eq(randomTables.id, id));
      return true;
    },
  };
}
