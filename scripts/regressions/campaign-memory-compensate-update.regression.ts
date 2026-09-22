import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 1. Compensating an update restores optional fields the update added (entity summary/body, relationship
//    evidence-free fields): the journaled `before` has no key for them, so the restore used to keep the new value.
// 2. Once a cited message is edited or deleted, a fact, knowledge row or relationship can still change status,
//    be locked, or be undone: evidence the update does not touch is no longer re-checked against the chat.
const root = mkdtempSync(join(tmpdir(), "marinara-campaign-memory-compensate-update-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { chats, messages, characters } = await import("../../packages/server/src/db/schema/index.js");
  const { eq } = await import("../../packages/server/src/db/file-query.js");
  const { createCampaignMemoryStorage } =
    await import("../../packages/server/src/services/storage/campaign-memory.storage.js");
  const { applyCampaignMemoryMutation, compensateCampaignMemoryMutation } =
    await import("../../packages/server/src/services/game/campaign-memory-mutations.js");
  const db = await createFileNativeDB();
  const chatId = "compensate-update-chat";
  const scope = { chatId };
  const now = new Date().toISOString();
  await db.insert(chats).values({
    id: chatId,
    name: "Compensate update",
    mode: "game",
    characterIds: JSON.stringify(["char-1", "char-2"]),
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(characters).values({ id: "char-1", data: "{}", createdAt: now, updatedAt: now });
  await db.insert(characters).values({ id: "char-2", data: "{}", createdAt: now, updatedAt: now });
  await db.insert(messages).values([
    { id: "msg-1", chatId, role: "user", content: "Alice trusts Bob.", createdAt: "2026-01-01T00:00:01.000Z" },
    { id: "msg-2", chatId, role: "user", content: "Bob owes Alice.", createdAt: "2026-01-01T00:00:02.000Z" },
  ]);
  const storage = createCampaignMemoryStorage(db);
  const provenance = { source: "regression", sourceRevision: "r1", actor: "user" as const };
  const base = { chatId, actor: "user" as const, reason: "seed" };
  const entityInput = (id: string, recordId: string) => ({
    chatId,
    entityId: id,
    kind: "character" as const,
    owner: { type: "existing" as const, store: "characters", recordId },
    aliases: [id],
    tags: [],
    attributes: {},
    status: "active" as const,
    manualLock: false,
    provenance,
  });
  const compensate = (operationId: string, originalOperationId: string) =>
    compensateCampaignMemoryMutation(db, {
      chatId,
      operationId,
      originalOperationId,
      actor: "user",
      reason: `undo ${originalOperationId}`,
    });

  await applyCampaignMemoryMutation(db, {
    ...base,
    operationId: "create-alice",
    recordType: "entity",
    action: "create",
    input: entityInput("alice", "char-1"),
  });
  await applyCampaignMemoryMutation(db, {
    ...base,
    operationId: "create-bob",
    recordType: "entity",
    action: "create",
    input: entityInput("bob", "char-2"),
  });

  // 1. An update that adds a summary and a body, then its compensation.
  assert.equal((await storage.getEntity(scope, "alice"))!.summary, undefined);
  await applyCampaignMemoryMutation(db, {
    ...base,
    operationId: "describe-alice",
    recordType: "entity",
    action: "update",
    recordId: "alice",
    expectedRevision: 1,
    patch: { summary: "A wary scout.", body: "Alice keeps to the ridge.", tags: ["scout"] },
  });
  const restored = (await compensate("undo-describe-alice", "describe-alice")) as Record<string, unknown>;
  const alice = (await storage.getEntity(scope, "alice"))!;
  assert.equal(alice.summary, undefined, "the summary the update added is cleared");
  assert.equal(alice.body, undefined, "the body the update added is cleared");
  assert.deepEqual(alice.tags, [], "fields the record had are restored");
  assert.equal(restored.summary, undefined, "the result reports the cleared summary");

  // 2. Evidence goes stale after the cited messages change.
  const fact = (await applyCampaignMemoryMutation(db, {
    ...base,
    operationId: "create-fact",
    recordType: "fact",
    action: "create",
    input: {
      chatId,
      subjectEntityId: "alice",
      predicate: "trusts",
      value: "bob",
      conditions: [],
      status: "verified",
      sourceRevision: "r1",
      evidence: [{ messageId: "msg-1", quote: "Alice trusts Bob." }],
      author: "user",
      provenance,
      manualLock: false,
    },
  })) as { factId: string; revision: number };
  const knowledge = (await applyCampaignMemoryMutation(db, {
    ...base,
    operationId: "create-knowledge",
    recordType: "knowledge",
    action: "create",
    input: {
      chatId,
      holderEntityId: "bob",
      factId: fact.factId,
      epistemicState: "knows",
      learnedFrom: [{ messageId: "msg-1", quote: "Alice trusts Bob." }],
      provenance,
      manualLock: false,
    },
  })) as { knowledgeId: string; revision: number };
  const relationship = (await applyCampaignMemoryMutation(db, {
    ...base,
    operationId: "create-relationship",
    recordType: "relationship",
    action: "create",
    input: {
      chatId,
      sourceEntityId: "bob",
      targetEntityId: "alice",
      type: "owes",
      inverseLabel: "is owed by",
      status: "active",
      evidence: [{ messageId: "msg-2", quote: "Bob owes Alice." }],
      provenance,
      manualLock: false,
    },
  })) as { relationshipId: string; revision: number };
  await db.update(messages).set({ content: "Alice trusts Bob, mostly." }).where(eq(messages.id, "msg-1"));
  await db.delete(messages).where(eq(messages.id, "msg-2"));

  const held = (await applyCampaignMemoryMutation(db, {
    ...base,
    operationId: "hold-fact",
    recordType: "fact",
    action: "update",
    recordId: fact.factId,
    expectedRevision: fact.revision,
    patch: { status: "held" },
  })) as { status: string; evidence: unknown };
  assert.equal(held.status, "held", "a status change is not blocked by an edited cited message");
  assert.deepEqual(held.evidence, (await storage.getFact(scope, fact.factId))!.evidence);
  const doubted = (await applyCampaignMemoryMutation(db, {
    ...base,
    operationId: "doubt-knowledge",
    recordType: "knowledge",
    action: "update",
    recordId: knowledge.knowledgeId,
    expectedRevision: knowledge.revision,
    patch: { epistemicState: "believes" },
  })) as { epistemicState: string };
  assert.equal(doubted.epistemicState, "believes");
  const ended = (await applyCampaignMemoryMutation(db, {
    ...base,
    operationId: "end-relationship",
    recordType: "relationship",
    action: "update",
    recordId: relationship.relationshipId,
    expectedRevision: relationship.revision,
    patch: { status: "ended" },
  })) as { status: string };
  assert.equal(ended.status, "ended", "a relationship whose cited message was deleted can still end");
  const undone = (await compensate("undo-end-relationship", "end-relationship")) as { status: string };
  assert.equal(undone.status, "active", "and the change can be undone");

  // New or changed evidence is still checked.
  await assert.rejects(
    applyCampaignMemoryMutation(db, {
      ...base,
      operationId: "bad-evidence",
      recordType: "fact",
      action: "update",
      recordId: fact.factId,
      expectedRevision: fact.revision + 1,
      patch: { evidence: [{ messageId: "msg-2", quote: "Bob owes Alice." }] },
    }),
    (error: unknown) => (error as { code?: string }).code === "CAMPAIGN_MEMORY_INVALID_REFERENCE",
  );

  await db._fileStore.close();
  console.log("campaign memory compensate update regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
