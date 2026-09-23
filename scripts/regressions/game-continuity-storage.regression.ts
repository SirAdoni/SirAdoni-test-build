import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GameContinuityReceipt } from "@marinara-engine/shared";

const root = mkdtempSync(join(tmpdir(), "marinara-game-continuity-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { createGameContinuityStorage } =
    await import("../../packages/server/src/services/storage/game-continuity.storage.js");
  const { createGameContinuityRecordId } = await import("../../packages/server/src/services/game/continuity-review.js");
  const { gameContinuityBatches, lorebookEntries, lorebooks } =
    await import("../../packages/server/src/db/schema/index.js");
  const source = {
    messageId: "message-1",
    swipeIndex: 0,
    hash: "message-1",
    role: "user",
    content: "I promise to return.",
  };
  const record = {
    kind: "promise" as const,
    text: "The player promises to return.",
    subjects: ["player"],
    conditions: [],
    status: "proposed" as const,
    evidence: [{ messageId: source.messageId, quote: "I promise to return." }],
    keys: ["return"],
  };
  const receipt: GameContinuityReceipt = {
    id: "continuity-chat-1-source-1-config-1",
    chatId: "chat-1",
    sessionNumber: 1,
    sourceHash: "source-1",
    sources: [source],
    context: [],
    configHash: "config-1",
    config: {},
    status: "queued",
    attempts: 0,
    repairAttempts: 0,
    records: [{ ...record, id: createGameContinuityRecordId("continuity-chat-1-source-1-config-1", record) }],
    dispositions: [{ messageId: source.messageId, status: "covered", reason: "The promise is explicit." }],
    review: { findings: [], dispositions: [{ messageId: source.messageId, status: "covered", reason: "Reviewed." }] },
    entryIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const db = await createFileNativeDB();
  const storage = createGameContinuityStorage(db);
  assert.equal((await storage.enqueue(receipt)).created, true);
  assert.equal((await storage.enqueue(receipt)).created, false);
  await storage.save({ ...receipt, status: "extracting", attempts: 1, updatedAt: new Date().toISOString() });
  assert.equal((await storage.recover()).length, 1);
  await db._fileStore.close();

  const reopenedDb = await createFileNativeDB();
  const reopened = createGameContinuityStorage(reopenedDb);
  const recovered = await reopened.get(receipt.id);
  assert.equal(recovered?.status, "extracting");

  await reopened.save({ ...recovered!, status: "verified", updatedAt: new Date().toISOString() });
  await reopenedDb.insert(lorebooks).values({
    id: "book-1",
    name: "Continuity test book",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  await reopenedDb.insert(lorebookEntries).values({
    id: "manual-entry",
    lorebookId: "book-1",
    name: "Manual canon",
    content: "Keep this author-written fact.",
  });
  await assert.rejects(() =>
    reopened.publish(receipt.id, async (tx) => {
      await tx
        .insert(lorebookEntries)
        .values({ id: "failed-entry", lorebookId: "book-1", name: "Failed", content: "Must roll back." });
      throw new Error("source changed");
    }),
  );
  assert.equal((await reopened.get(receipt.id))?.status, "verified");
  assert.equal(
    (
      await reopenedDb
        .select()
        .from(lorebookEntries)
        .where((await import("../../packages/server/src/db/file-query.js")).eq(lorebookEntries.id, "failed-entry"))
    ).length,
    0,
  );

  const published = await reopened.publish(receipt.id, async (tx) => {
    await tx
      .insert(lorebookEntries)
      .values({ id: "entry-1", lorebookId: "book-1", name: "Promise", content: "The player promises to return." });
    return ["entry-1"];
  });
  assert.equal(published.status, "published");
  assert.deepEqual(published.entryIds, ["entry-1"]);
  await assert.rejects(() => reopened.save({ ...published, error: "tamper" }), /CONTINUITY_IMMUTABLE/u);
  assert.deepEqual(
    (
      await reopened.publish(receipt.id, async () => {
        throw new Error("must be idempotent");
      })
    ).entryIds,
    ["entry-1"],
  );

  const exhausted = {
    ...receipt,
    id: "continuity-exhausted",
    attempts: 3,
    status: "extracting" as const,
    errorCode: "PROBE_FAILURE",
    error: "PROBE_FAILURE",
  };
  await reopened.enqueue(exhausted);
  assert.equal(
    (await reopened.recover()).some((item) => item.id === exhausted.id),
    false,
  );
  assert.equal((await reopened.get(exhausted.id))?.status, "extracting");
  const interrupted = { ...receipt, id: "continuity-interrupted", attempts: 3, status: "extracting" as const };
  await reopened.enqueue(interrupted);
  assert.equal(
    (await reopened.recover()).some((item) => item.id === interrupted.id),
    true,
  );
  await reopenedDb.insert(gameContinuityBatches).values({
    ...(
      await reopenedDb
        .select()
        .from(gameContinuityBatches)
        .where((await import("../../packages/server/src/db/file-query.js")).eq(gameContinuityBatches.id, receipt.id))
        .limit(1)
    )[0]!,
    id: "continuity-corrupt",
    sources: "not-json",
  });
  await assert.rejects(() => reopened.get("continuity-corrupt"), /CONTINUITY_INVALID/u);
  const inspected = await reopened.inspect();
  assert.ok(inspected.receipts.some((item) => item.id === receipt.id));
  assert.deepEqual(
    inspected.invalid.find((item) => item.id === "continuity-corrupt")?.code,
    "CONTINUITY_INVALID_RECEIPT",
  );

  assert.equal(
    (
      await reopenedDb
        .select()
        .from(lorebookEntries)
        .where((await import("../../packages/server/src/db/file-query.js")).eq(lorebookEntries.id, "manual-entry"))
    )[0]?.content,
    "Keep this author-written fact.",
  );

  await reopenedDb._fileStore.close();
  console.log("game continuity storage regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
