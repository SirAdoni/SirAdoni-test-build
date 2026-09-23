import { buildQuestJournalData, type NormalizedQuestUpdate } from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { and, eq } from "../../db/file-query.js";
import { gameStateSnapshots } from "../../db/schema/index.js";
import { updateJournal } from "../generation/game-journal-runtime.js";
import { upsertQuest } from "./journal.service.js";

export async function persistRetryQuestUpdate(
  db: DB,
  chatId: string,
  snapshotId: string,
  playerStats: unknown,
  updates: readonly NormalizedQuestUpdate[],
): Promise<void> {
  await db.transaction(
    async (tx) => {
      const target = await tx
        .select({ id: gameStateSnapshots.id })
        .from(gameStateSnapshots)
        .where(and(eq(gameStateSnapshots.id, snapshotId), eq(gameStateSnapshots.chatId, chatId)))
        .limit(1);
      if (!target[0]) throw new Error(`RETRY_QUEST_SNAPSHOT_NOT_FOUND: ${snapshotId}`);

      await tx
        .update(gameStateSnapshots)
        .set({ playerStats: JSON.stringify(playerStats) })
        .where(and(eq(gameStateSnapshots.id, snapshotId), eq(gameStateSnapshots.chatId, chatId)));

      for (const update of updates) {
        await updateJournal(tx, chatId, (journal) => upsertQuest(journal, buildQuestJournalData(update)), {
          rethrowOnError: true,
        });
      }
    },
    { durable: true },
  );
}
