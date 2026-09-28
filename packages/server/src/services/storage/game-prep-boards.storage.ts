// ──────────────────────────────────────────────
// Storage: GM prep boards (one per game)
// ──────────────────────────────────────────────
import { sanitizePrepBoard, type PrepBoard } from "@marinara-engine/shared";
import { eq } from "../../db/file-query.js";
import type { DB } from "../../db/connection.js";
import { gamePrepBoards } from "../../db/schema/index.js";
import { newId, now } from "../../utils/id-generator.js";

type PrepBoardDbRow = typeof gamePrepBoards.$inferSelect;

export interface PrepBoardRecord {
  gameId: string;
  board: PrepBoard;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export type PrepBoardSaveResult =
  { ok: true; record: PrepBoardRecord } | { ok: false; conflict: PrepBoardRecord | null };

function parseBoard(value: string): PrepBoard {
  try {
    return sanitizePrepBoard(JSON.parse(value));
  } catch {
    return sanitizePrepBoard(null);
  }
}

function recordFrom(row: PrepBoardDbRow): PrepBoardRecord {
  return {
    gameId: row.gameId,
    board: parseBoard(row.board),
    revision: Number(row.revision) || 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createGamePrepBoardsStorage(db: DB) {
  async function rowFor(gameId: string): Promise<PrepBoardDbRow | undefined> {
    return (await db.select().from(gamePrepBoards).where(eq(gamePrepBoards.gameId, gameId)))[0] as
      PrepBoardDbRow | undefined;
  }

  // Saves for one game run one at a time, so the revision check and the write
  // cannot interleave with another save of the same board.
  const tails = new Map<string, Promise<unknown>>();
  function serialized<T>(gameId: string, work: () => Promise<T>): Promise<T> {
    const previous = tails.get(gameId) ?? Promise.resolve();
    const run = previous.then(work, work);
    const tail = run.catch(() => undefined);
    tails.set(gameId, tail);
    void tail.then(() => {
      if (tails.get(gameId) === tail) tails.delete(gameId);
    });
    return run;
  }

  return {
    async get(gameId: string): Promise<PrepBoardRecord | null> {
      const row = await rowFor(gameId);
      return row ? recordFrom(row) : null;
    },

    /**
     * Save a board when `baseRevision` matches the stored one (0 for a board not
     * saved yet). A mismatch returns the stored board instead of overwriting it.
     */
    save(gameId: string, board: unknown, baseRevision: number): Promise<PrepBoardSaveResult> {
      return serialized(gameId, async () => {
        const existing = await rowFor(gameId);
        const current = existing ? Number(existing.revision) || 0 : 0;
        if (current !== baseRevision) return { ok: false, conflict: existing ? recordFrom(existing) : null };
        const clean = JSON.stringify(sanitizePrepBoard(board));
        const timestamp = now();
        if (existing) {
          await db
            .update(gamePrepBoards)
            .set({ board: clean, revision: current + 1, updatedAt: timestamp })
            .where(eq(gamePrepBoards.id, existing.id));
        } else {
          await db.insert(gamePrepBoards).values({
            id: newId(),
            gameId,
            board: clean,
            revision: 1,
            createdAt: timestamp,
            updatedAt: timestamp,
          });
        }
        const saved = await rowFor(gameId);
        return { ok: true, record: recordFrom(saved!) };
      });
    },

    remove(gameId: string): Promise<boolean> {
      return serialized(gameId, async () => {
        const existing = await rowFor(gameId);
        if (!existing) return false;
        await db.delete(gamePrepBoards).where(eq(gamePrepBoards.gameId, gameId));
        return true;
      });
    },
  };
}
