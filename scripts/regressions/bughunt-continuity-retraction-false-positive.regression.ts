import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GameContinuityReceipt } from "@marinara-engine/shared";

// Retracted-canon suppression keys a statement of five or more words on its lower-cased text alone: no subject, no
// evidence message, no time (shorter lines are now keyed per subject). A user retracts "Mara is dead and her body
// lies unburied." because an early rumour wrongly claimed it; later Mara really dies, in a different message, and
// the new, correctly evidenced record with the same sentence is silently dropped from memory (no fact, no journal
// entry, receipt still "published"). Any retracted sentence suppresses every later identical sentence forever.
const root = mkdtempSync(join(tmpdir(), "marinara-bughunt-retracted-"));
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
  const lines = { m2: "A scout swears Mara fell at the ford.", m4: "Mara dies in the courtyard, the arrow through her throat." };
  await db.insert(messages).values([
    { id: "m1", chatId: "chat", role: "user", content: "Any news?", createdAt: "2026-09-16T00:00:01.000Z" },
    { id: "m2", chatId: "chat", role: "assistant", content: lines.m2, createdAt: "2026-09-16T00:00:02.000Z" },
    { id: "m3", chatId: "chat", role: "user", content: "I storm the keep.", createdAt: "2026-09-16T00:00:03.000Z" },
    { id: "m4", chatId: "chat", role: "assistant", content: lines.m4, createdAt: "2026-09-16T00:00:04.000Z" },
  ]);
  const current = await db.select().from(messages).where(eq(messages.chatId, "chat"));
  const sources = prepareContinuitySources(current, { gameContinuity: { mode: "active" } });
  const config = await readContinuityConfig(db, "chat");
  const receiptFor = (id: string, userId: string, assistantId: "m2" | "m4"): GameContinuityReceipt => {
    const own = sources.filter((source) => source.messageId === userId || source.messageId === assistantId);
    const record = {
      kind: "event" as const,
      text: "Mara is dead and her body lies unburied.",
      subjects: ["Mara"],
      conditions: [],
      status: "completed" as const,
      evidence: [{ messageId: assistantId, quote: lines[assistantId] }],
      keys: ["Mara"],
    };
    const dispositions = own.map((source) => ({
      messageId: source.messageId,
      status: source.messageId === assistantId ? "covered" : "no_durable_facts",
      reason: "test",
    }));
    return {
      id,
      chatId: "chat",
      sessionNumber: 1,
      sourceHash: `source-${id}`,
      sources: own,
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
    } as GameContinuityReceipt;
  };

  const memory = createCampaignMemoryStorage(db);
  const liveFrom = async (messageId: string) =>
    (await memory.listFacts({ chatId: "chat" })).filter(
      (fact) => fact.status === "verified" && fact.evidence.some((item) => item.messageId === messageId),
    );

  await createGameContinuityStorage(db).enqueue(receiptFor("gcb-rumour", "m1", "m2"));
  assert.equal((await publishContinuityReceipt(db, "gcb-rumour"))?.status, "published");
  const wrong = await liveFrom("m2");
  assert.ok(wrong.length >= 1);
  // The player retracts and locks the rumour: Mara is alive in canon at this point.
  for (const fact of wrong)
    await applyCampaignMemoryMutation(db, {
      chatId: "chat",
      operationId: `retract-${fact.factId}`,
      actor: "user",
      reason: "She survived the ford",
      recordType: "fact",
      action: "update",
      recordId: fact.factId,
      expectedRevision: fact.revision,
      patch: { status: "retracted", manualLock: true },
    });

  // Later Mara really dies, in a different message with its own evidence.
  await createGameContinuityStorage(db).enqueue(receiptFor("gcb-death", "m3", "m4"));
  assert.equal((await publishContinuityReceipt(db, "gcb-death"))?.status, "published");
  assert.ok(
    (await liveFrom("m4")).length >= 1,
    "a new, differently evidenced statement must not be suppressed because an older one with the same words was retracted",
  );

  await db._fileStore.close();
  console.log("bughunt-continuity-retraction-false-positive regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
