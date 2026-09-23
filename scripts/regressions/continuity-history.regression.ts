import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GameContinuityReceipt } from "@marinara-engine/shared";

const root = mkdtempSync(join(tmpdir(), "marinara-continuity-history-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { createGameContinuityStorage } =
    await import("../../packages/server/src/services/storage/game-continuity.storage.js");
  const { createGameContinuityRecordId } = await import("../../packages/server/src/services/game/continuity-review.js");
  const { gameContinuityBatches } = await import("../../packages/server/src/db/schema/index.js");
  const { eq } = await import("../../packages/server/src/db/file-query.js");

  const now = new Date().toISOString();
  const source = { messageId: "m1", swipeIndex: 0, hash: "h1", role: "user", content: "A durable promise." };
  const base: GameContinuityReceipt = {
    id: "history-batch",
    chatId: "history-chat",
    sessionNumber: 1,
    sourceHash: "source",
    sources: [source],
    context: [],
    configHash: "config",
    config: {},
    status: "queued",
    attempts: 0,
    repairAttempts: 0,
    records: [],
    dispositions: [],
    review: null,
    entryIds: [],
    createdAt: now,
    updatedAt: now,
  };
  const recordA = {
    kind: "promise" as const,
    text: "The promise is recorded.",
    subjects: ["player"],
    conditions: [],
    status: "proposed" as const,
    evidence: [{ messageId: "m1", quote: "A durable promise." }],
    keys: ["promise"],
  };
  const recordAWithId = { ...recordA, id: createGameContinuityRecordId(base.id, recordA) };
  const recordB = { ...recordAWithId, text: "The promise was reviewed.", id: createGameContinuityRecordId(base.id, { ...recordA, text: "The promise was reviewed." }) };
  const dispositionA = { messageId: "m1", status: "covered" as const, reason: "extracted" };
  const dispositionB = { ...dispositionA, reason: "repaired" };
  const reviewA = { findings: [], dispositions: [dispositionA] };
  const reviewB = { findings: [], dispositions: [dispositionB] };

  const db = await createFileNativeDB();
  const storage = createGameContinuityStorage(db);
  await storage.enqueue(base);
  await storage.save({ ...base, status: "extracting", attempts: 1, records: [recordAWithId], dispositions: [dispositionA], updatedAt: "2026-09-13T00:00:01.000Z" });
  await storage.save({ ...base, status: "reviewing", attempts: 1, records: [recordAWithId], dispositions: [dispositionA], review: reviewA, updatedAt: "2026-09-13T00:00:02.000Z" });
  await storage.save({ ...base, status: "repairing", attempts: 1, repairAttempts: 1, records: [recordB], dispositions: [dispositionB], review: reviewA, updatedAt: "2026-09-13T00:00:03.000Z" });
  const verified = { ...base, status: "verified" as const, attempts: 1, repairAttempts: 1, records: [recordB], dispositions: [dispositionB], review: reviewB, updatedAt: "2026-09-13T00:00:04.000Z" };
  await storage.save(verified);
  const beforeDuplicate = await storage.getHistory(base.chatId, base.id);
  await storage.save(verified);
  assert.equal((await storage.getHistory(base.chatId, base.id)).length, beforeDuplicate.length);
  assert.deepEqual(beforeDuplicate.map((snapshot) => snapshot.records[0]?.text), [
    "The promise is recorded.",
    "The promise is recorded.",
    "The promise was reviewed.",
    "The promise was reviewed.",
  ]);
  await db._fileStore.close();

  const reopenedDb = await createFileNativeDB();
  const reopened = createGameContinuityStorage(reopenedDb);
  const reopenedHistory = await reopened.getHistory(base.chatId, base.id);
  assert.equal(reopenedHistory.length, beforeDuplicate.length);
  assert.equal(Object.isFrozen(reopenedHistory), true);
  assert.equal(Object.isFrozen(reopenedHistory[0]), true);
  const persistedRow = (await reopenedDb.select().from(gameContinuityBatches).where(eq(gameContinuityBatches.id, base.id)))[0]!;
  await reopenedDb.insert(gameContinuityBatches).values({
    ...persistedRow,
    id: "history-malformed-record",
    history: JSON.stringify([{ ...reopenedHistory[0], records: [{ id: "broken" }] }]),
  });
  await assert.rejects(() => reopened.get("history-malformed-record"), /CONTINUITY_INVALID.*record/u);
  await assert.rejects(
    () => reopened.publish(base.id, async () => { throw new Error("injected publish failure"); }),
    /injected publish failure/u,
  );
  assert.equal((await reopened.get(base.id))?.status, "verified");
  assert.equal((await reopened.getHistory(base.chatId, base.id)).length, reopenedHistory.length);
  await reopened.publish(base.id, async () => []);
  assert.equal((await reopened.get(base.id))?.status, "published");
  assert.equal((await reopened.getHistory(base.chatId, base.id)).length, reopenedHistory.length);
  assert.deepEqual((await reopened.getHistory("other-chat", base.id)), []);
  await reopenedDb._fileStore.close();
  console.log("continuity history regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
