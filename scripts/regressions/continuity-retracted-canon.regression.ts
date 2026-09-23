import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GameContinuityReceipt } from "@marinara-engine/shared";

// A player retracts a fact that contradicts their canon (an invented past, a child that never existed) and locks
// it. The locked fact itself was never touched again, but any later read of the same line (a new receipt for the
// same turn, a backfill, a repair) published the identical statement again under a new fact id. A statement the
// user retracted and locked now stays out of memory when it is read again.
const root = mkdtempSync(join(tmpdir(), "marinara-retracted-canon-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { apiConnections, chats, messages } = await import("../../packages/server/src/db/schema/index.js");
  const { createGameContinuityStorage } =
    await import("../../packages/server/src/services/storage/game-continuity.storage.js");
  const { createCampaignMemoryStorage } =
    await import("../../packages/server/src/services/storage/campaign-memory.storage.js");
  const { prepareContinuitySources } = await import("../../packages/server/src/services/game/continuity-sources.js");
  const { createGameContinuityRecordId } = await import("../../packages/server/src/services/game/continuity-review.js");
  const { publishContinuityReceipt } = await import("../../packages/server/src/services/game/continuity-publication.js");
  const { readContinuityConfig } = await import("../../packages/server/src/services/game/continuity-provider.js");
  const { applyCampaignMemoryMutation } =
    await import("../../packages/server/src/services/game/campaign-memory-mutations.js");
  const { eq } = await import("../../packages/server/src/db/file-query.js");

  const db = await createFileNativeDB();
  const now = new Date().toISOString();
  await db.insert(apiConnections).values({ id: "conn", name: "Canon test", provider: "custom", model: "m" });
  await db.insert(chats).values({
    id: "chat",
    name: "Canon",
    mode: "game",
    connectionId: "conn",
    metadata: JSON.stringify({ gameContinuity: { mode: "active", extractionInstructions: "fixed" } }),
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(messages).values([
    { id: "m1", chatId: "chat", role: "user", content: "Ask about her past.", createdAt: "2026-09-16T00:00:01.000Z" },
    {
      id: "m2",
      chatId: "chat",
      role: "assistant",
      content: "She speaks of the husband she buried years ago.",
      createdAt: "2026-09-16T00:00:02.000Z",
    },
  ]);
  const current = await db.select().from(messages).where(eq(messages.chatId, "chat"));
  const sources = prepareContinuitySources(current, { gameContinuity: { mode: "active" } });
  const config = await readContinuityConfig(db, "chat");
  const record = {
    kind: "decision" as const,
    text: "Maritza was married and buried her husband.",
    subjects: ["Maritza"],
    conditions: [],
    status: "completed" as const,
    evidence: [{ messageId: "m2", quote: "She speaks of the husband she buried years ago." }],
    keys: ["husband"],
  };
  const dispositions = sources.map((source) => ({
    messageId: source.messageId,
    status: source.messageId === "m2" ? "covered" : "no_durable_facts",
    reason: "test",
  }));
  const receiptFor = (id: string): GameContinuityReceipt =>
    ({
      id,
      chatId: "chat",
      sessionNumber: 1,
      sourceHash: `source-${id}`,
      sources,
      context: [],
      configHash: config.hash,
      config: config.frozen,
      status: "verified",
      attempts: 1,
      repairAttempts: 0,
      records: [{ ...record, id: createGameContinuityRecordId(id, record) }],
      dispositions,
      review: { findings: [], dispositions },
      entryIds: [],
      createdAt: now,
      updatedAt: now,
    }) as GameContinuityReceipt;

  const memory = createCampaignMemoryStorage(db);
  const live = async () =>
    (await memory.listFacts({ chatId: "chat" })).filter((fact) => fact.status === "verified" && JSON.stringify(fact.value).includes("husband"));

  await createGameContinuityStorage(db).enqueue(receiptFor("gcb-first"));
  assert.equal((await publishContinuityReceipt(db, "gcb-first"))?.status, "published");
  const published = await live();
  assert.ok(published.length >= 1, "the first read publishes the statement");

  // The player retracts and locks every copy: it contradicts canon.
  for (const fact of published) {
    await applyCampaignMemoryMutation(db, {
      chatId: "chat",
      operationId: `retract-${fact.factId}`,
      actor: "user",
      reason: "Contradicts canon",
      recordType: "fact",
      action: "update",
      recordId: fact.factId,
      expectedRevision: fact.revision,
      patch: { status: "retracted", manualLock: true },
    });
  }
  assert.equal((await live()).length, 0);

  // The same turn is read again under a new receipt: the retracted statement is not published again.
  await createGameContinuityStorage(db).enqueue(receiptFor("gcb-second"));
  assert.equal((await publishContinuityReceipt(db, "gcb-second"))?.status, "published");
  assert.equal((await live()).length, 0, "a statement the user retracted and locked is never republished");
  for (const fact of published)
    assert.equal((await memory.getFact({ chatId: "chat" }, fact.factId))?.status, "retracted", "the locked fact stays retracted");

  await db._fileStore.close();
  console.log("continuity-retracted-canon regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
