import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Cross-lane contract: actor-local accepted dialogue, global accepted-turn indexing,
// state-only corrections, and source-text retirement must agree without inventing coverage.
const root = mkdtempSync(join(tmpdir(), "marinara-personal-integration-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
const { chats, messages, gameStateSnapshots } = await import("../../packages/server/src/db/schema/index.js");
const { eq } = await import("../../packages/server/src/db/file-query.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { readContinuityInventory } = await import("../../packages/server/src/routes/game-continuity-backfill.routes.js");
const { coverage } = await import("../../packages/server/src/routes/campaign-index.routes.js");
const { getGameTurnReview, correctGameTurnReview } =
  await import("../../packages/server/src/services/game/turn-review.service.js");
const { findSourceChangedReceipts } = await import("../../packages/server/src/services/game/continuity-retirement.js");
const { buildRecentOwnAcceptedDialogue } =
  await import("../../packages/server/src/services/game/isolated-game-history.js");
try {
  const db = await createFileNativeDB();
  const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  await db
    .insert(chats)
    .values({
      id: "integration",
      name: "Synthetic integration",
      mode: "game",
      metadata: JSON.stringify({ gameTime: { day: 1, hour: 10, minute: 0 } }),
      createdAt: at(0),
      updatedAt: at(5),
    });
  const first = "[Robin] [main]: The ledger is in the tower.";
  const last = "[Robin] [main]: The gate is open.";
  await db.insert(messages).values([
    { id: "u1", chatId: "integration", role: "user", content: "Report.", createdAt: at(1) },
    {
      id: "a1",
      chatId: "integration",
      role: "assistant",
      content: first,
      createdAt: at(2),
      extra: JSON.stringify({
        isolatedGameTurn: {
          actorDiagnostics: [
            { actorId: "robin", status: "accepted" },
            { actorId: "other", status: "rejected" },
          ],
        },
      }),
    },
    { id: "u2", chatId: "integration", role: "user", content: "And the gate?", createdAt: at(3) },
    {
      id: "a2",
      chatId: "integration",
      role: "assistant",
      content: last,
      createdAt: at(4),
      extra: JSON.stringify({
        isolatedGameTurn: { actorDiagnostics: [{ actorId: "robin", status: "accepted" }] },
        gameTurnClock: { before: { day: 1, hour: 9, minute: 0 }, after: { day: 1, hour: 10, minute: 0 } },
      }),
    },
  ]);
  for (const id of ["a1", "a2"])
    await db
      .insert(gameStateSnapshots)
      .values({
        id: `state-${id}`,
        chatId: "integration",
        messageId: id,
        swipeIndex: 0,
        committed: 1,
        time: "Day 1, 10:00",
        createdAt: at(5),
      });
  const rows = await createChatsStorage(db).listMessages("integration");
  assert.ok(buildRecentOwnAcceptedDialogue(rows, {}, "robin", "Robin").includes(first));
  assert.equal(
    buildRecentOwnAcceptedDialogue(rows, {}, "other", "Robin"),
    "",
    "Rejected actor output is not actor history",
  );
  const app = { db, gameContinuity: { list: async () => [] } } as never;
  const initial = (await readContinuityInventory(app, "integration", { includePreparedSources: true }))!;
  assert.deepEqual(initial.acceptedAssistantIds, ["a1", "a2"]);
  assert.equal(coverage(initial as never, []).estimatedTurns, 2);
  const receipts = ["a1", "a2"].map((id) => ({
    id: `receipt-${id}`,
    status: "published",
    sources: initial.preparedSources.filter((source) => source.messageId === id),
  }));
  assert.ok(receipts.every((receipt) => receipt.sources.length === 1));
  const review = await getGameTurnReview(db, "integration", "a2");
  assert.equal(review.canCorrect, true);
  await correctGameTurnReview(
    db,
    "integration",
    "a2",
    {
      revision: review.revision,
      swipeIndex: 0,
      correction: { field: "time", value: { day: 1, hour: 10, minute: 15 } },
    },
    () => false,
  );
  const afterState = (await readContinuityInventory(app, "integration", { includePreparedSources: true }))!;
  assert.deepEqual(afterState.acceptedAssistantIds, initial.acceptedAssistantIds);
  assert.deepEqual(
    afterState.preparedSources,
    initial.preparedSources,
    "State-only correction does not rewrite source prose or invalidate text coverage",
  );
  assert.deepEqual(findSourceChangedReceipts(receipts as never, afterState.preparedSources, ["a2"]), []);
  const correctedReview = await getGameTurnReview(db, "integration", "a2");
  assert.equal(correctedReview.changes.find((change) => change.id === "time")?.corrected, true);
  await db.update(messages).set({ content: "[Robin] [main]: The gate is closed." }).where(eq(messages.id, "a2"));
  const afterText = (await readContinuityInventory(app, "integration", { includePreparedSources: true }))!;
  assert.deepEqual(
    findSourceChangedReceipts(receipts as never, afterText.preparedSources, ["a2"]).map((receipt) => receipt.id),
    ["receipt-a2"],
    "Only the changed source receipt loses coverage",
  );
  assert.equal(
    coverage(afterText as never, receipts as never).estimatedTurns,
    1,
    "Unchanged source remains covered while changed turn is indexable",
  );
  await db.update(gameStateSnapshots).set({ committed: 0 }).where(eq(gameStateSnapshots.messageId, "a2"));
  const uncommitted = (await readContinuityInventory(app, "integration", { includePreparedSources: true }))!;
  assert.deepEqual(
    uncommitted.acceptedAssistantIds,
    ["a1"],
    "An explicitly uncommitted selected swipe cannot close an indexing window",
  );
  console.info(
    "Personal integration: isolated dialogue, accepted index, state correction, selective source invalidation and uncommitted exclusion passed.",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
