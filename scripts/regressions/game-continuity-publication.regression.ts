import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GameContinuityReceipt } from "@marinara-engine/shared";

const root = mkdtempSync(join(tmpdir(), "marinara-continuity-publication-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { apiConnections, chats, messages, lorebookEntries, lorebooks } =
    await import("../../packages/server/src/db/schema/index.js");
  const { createGameContinuityStorage } =
    await import("../../packages/server/src/services/storage/game-continuity.storage.js");
  const { prepareContinuitySources } = await import("../../packages/server/src/services/game/continuity-sources.js");
  const { createGameContinuityRecordId } = await import("../../packages/server/src/services/game/continuity-review.js");
  const { publishContinuityReceipt } =
    await import("../../packages/server/src/services/game/continuity-publication.js");
  const { readContinuityConfig } = await import("../../packages/server/src/services/game/continuity-provider.js");
  const { applyFeatureSettingsValue } = await import("../../packages/server/src/services/features/feature-settings.js");
  applyFeatureSettingsValue(JSON.stringify({ gameContinuity: true, campaignMemory: true, campaignIndex: true }));
  const { eq } = await import("../../packages/server/src/db/file-query.js");

  const db = await createFileNativeDB();
  const now = new Date().toISOString();
  const metadata = JSON.stringify({ gameContinuity: { mode: "active", extractionInstructions: "fixed" } });
  await db
    .insert(apiConnections)
    .values({ id: "conn", name: "Continuity test", provider: "custom", model: "test-model" });
  await db.insert(chats).values({
    id: "chat",
    name: "Continuity",
    mode: "game",
    connectionId: "conn",
    metadata,
    createdAt: now,
    updatedAt: now,
  });
  await db
    .insert(messages)
    .values({ id: "m1", chatId: "chat", role: "user", content: "I promise to return.", createdAt: now });
  await db.insert(lorebooks).values({ id: "book", name: "Book", chatId: "chat", createdAt: now, updatedAt: now });
  await db
    .insert(lorebookEntries)
    .values({ id: "manual", lorebookId: "book", name: "Manual", content: "Preserve me." });
  const current = await db.select().from(messages).where(eq(messages.chatId, "chat"));
  const source = prepareContinuitySources(current, { gameContinuity: { mode: "active" } }).find(
    (item) => item.messageId === "m1",
  )!;
  const config = await readContinuityConfig(db, "chat");
  const id = "gcb-publication";
  const record = {
    kind: "promise" as const,
    text: "The player promises to return.",
    subjects: ["player"],
    conditions: [],
    status: "proposed" as const,
    evidence: [{ messageId: "m1", quote: "I promise to return." }],
    keys: ["return"],
  };
  const receipt: GameContinuityReceipt = {
    id,
    chatId: "chat",
    sessionNumber: 1,
    sourceHash: "source",
    sources: [source],
    context: [],
    configHash: config.hash,
    config: config.frozen,
    status: "verified",
    attempts: 1,
    repairAttempts: 0,
    records: [{ ...record, id: createGameContinuityRecordId(id, record) }],
    dispositions: [{ messageId: "m1", status: "covered", reason: "explicit" }],
    review: { findings: [], dispositions: [{ messageId: "m1", status: "covered", reason: "clean" }] },
    entryIds: [],
    createdAt: now,
    updatedAt: now,
  };
  await createGameContinuityStorage(db).enqueue(receipt);
  await db
    .update(chats)
    .set({ metadata: JSON.stringify({ gameContinuity: { mode: "shadow", extractionInstructions: "fixed" } }) })
    .where(eq(chats.id, "chat"));
  assert.equal((await publishContinuityReceipt(db, id))?.status, "verified");
  assert.deepEqual(
    (await db.select().from(lorebookEntries).where(eq(lorebookEntries.lorebookId, "book"))).map((entry) => entry.id),
    ["manual"],
  );
  await db.update(chats).set({ metadata }).where(eq(chats.id, "chat"));
  const published = await publishContinuityReceipt(db, id);
  assert.equal(published?.status, "published");
  assert.equal(
    (await db.select().from(lorebookEntries).where(eq(lorebookEntries.id, "manual")))[0]?.content,
    "Preserve me.",
  );
  assert.equal((await publishContinuityReceipt(db, id))?.entryIds.length, 1);

  await db.insert(chats).values({
    id: "tie-chat",
    name: "Tie ordering",
    mode: "game",
    connectionId: "conn",
    metadata,
    createdAt: now,
    updatedAt: now,
  });
  await db
    .insert(lorebooks)
    .values({ id: "tie-book", name: "Tie book", chatId: "tie-chat", createdAt: now, updatedAt: now });
  const tieTimestamp = "2026-09-13T00:00:00.000Z";
  await db.insert(messages).values([
    {
      id: "z-assistant",
      chatId: "tie-chat",
      role: "assistant",
      content: "Understood; the correction is accepted.",
      createdAt: tieTimestamp,
    },
    {
      id: "a-user",
      chatId: "tie-chat",
      role: "user",
      content: "[To the GM] The gate is open.",
      createdAt: tieTimestamp,
    },
  ]);
  const tieSources = prepareContinuitySources(
    (await db.select().from(messages).where(eq(messages.chatId, "tie-chat"))).sort(
      (left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    ),
    { gameContinuity: { mode: "active" } },
  );
  const tieId = "gcb-publication-tie";
  const tieRecord = {
    kind: "event" as const,
    text: "The gate was confirmed open.",
    subjects: [],
    conditions: [],
    status: "accepted" as const,
    evidence: [{ messageId: "a-user", quote: "[To the GM] The gate is open." }],
    keys: [],
  };
  await createGameContinuityStorage(db).enqueue({
    id: tieId,
    chatId: "tie-chat",
    sessionNumber: 1,
    sourceHash: "tie-source",
    sources: tieSources,
    context: [],
    configHash: config.hash,
    config: config.frozen,
    status: "verified",
    attempts: 1,
    repairAttempts: 0,
    records: [{ ...tieRecord, id: createGameContinuityRecordId(tieId, tieRecord) }],
    dispositions: tieSources.map((source) => ({
      messageId: source.messageId,
      status: source.messageId === "a-user" ? ("covered" as const) : ("no_durable_facts" as const),
      reason: "tie ordering",
    })),
    review: {
      findings: [],
      dispositions: tieSources.map((source) => ({
        messageId: source.messageId,
        status: source.messageId === "a-user" ? ("covered" as const) : ("no_durable_facts" as const),
        reason: "tie ordering",
      })),
    },
    entryIds: [],
    createdAt: now,
    updatedAt: now,
  });
  assert.equal((await publishContinuityReceipt(db, tieId))?.status, "published");

  await db.update(messages).set({ content: "Edited after review." }).where(eq(messages.id, "m1"));
  const staleRecord = { ...record, id: createGameContinuityRecordId("gcb-stale", record) };
  const stale = {
    ...receipt,
    id: "gcb-stale",
    records: [staleRecord],
    sources: [source],
    updatedAt: new Date().toISOString(),
  };
  await createGameContinuityStorage(db).enqueue(stale);
  await assert.rejects(() => publishContinuityReceipt(db, stale.id), /CONTINUITY_SOURCE_CHANGED/u);
  await db._fileStore.close();
  console.log("game continuity publication regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
