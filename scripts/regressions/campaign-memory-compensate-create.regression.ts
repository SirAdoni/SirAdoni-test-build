import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = mkdtempSync(join(tmpdir(), "marinara-campaign-memory-compensate-create-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { chats, messages, characters, campaignMemoryMutationJournal } = await import("../../packages/server/src/db/schema/index.js");
  const { eq } = await import("../../packages/server/src/db/file-query.js");
  const { createCampaignMemoryStorage } = await import("../../packages/server/src/services/storage/campaign-memory.storage.js");
  const { formatCampaignMemoryMessageOrder } = await import("../../packages/server/src/services/game/campaign-memory-order.js");
  const { applyCampaignMemoryMutation, compensateCampaignMemoryMutation } = await import("../../packages/server/src/services/game/campaign-memory-mutations.js");
  const db = await createFileNativeDB();
  const chatId = "compensate-chat";
  const scope = { chatId };
  const now = new Date().toISOString();
  const stamps = ["2026-01-01T00:00:01.000Z", "2026-01-01T00:00:02.000Z"];
  await db.insert(chats).values({ id: chatId, name: "Compensate create", mode: "game", characterIds: JSON.stringify(["char-1", "char-2"]), createdAt: now, updatedAt: now });
  await db.insert(characters).values({ id: "char-1", data: "{}", createdAt: now, updatedAt: now });
  await db.insert(characters).values({ id: "char-2", data: "{}", createdAt: now, updatedAt: now });
  await db.insert(messages).values(stamps.map((stamp, index) => ({ id: `msg-${index + 1}`, chatId, role: "user", content: `Alice trusts Bob ${index + 1}`, createdAt: stamp })));
  const orders = stamps.map((stamp, index) => formatCampaignMemoryMessageOrder(`msg-${index + 1}`, stamp));
  const storage = createCampaignMemoryStorage(db);
  const provenance = { source: "regression", sourceRevision: "r1", actor: "user" as const };
  const base = { chatId, actor: "user" as const, reason: "seed" };
  const entityInput = (id: string, recordId: string) => ({ chatId, entityId: id, kind: "character" as const, owner: { type: "existing" as const, store: "characters", recordId }, aliases: [id], tags: [], attributes: {}, status: "active" as const, manualLock: false, provenance });
  const journal = (operationId: string) => db.select().from(campaignMemoryMutationJournal).where(eq(campaignMemoryMutationJournal.operationId, operationId)).then((rows) => rows.filter((row) => row.chatId === chatId));
  const compensate = (operationId: string, originalOperationId: string) => compensateCampaignMemoryMutation(db, { chatId, operationId, originalOperationId, actor: "user", reason: `undo ${originalOperationId}` });
  const code = (expected: string) => (e: unknown) => (e as { code?: string })?.code === expected;

  // Seed one journaled create per record type.
  await applyCampaignMemoryMutation(db, { ...base, operationId: "create-alice", recordType: "entity", action: "create", input: entityInput("alice", "char-1") });
  await applyCampaignMemoryMutation(db, { ...base, operationId: "create-bob", recordType: "entity", action: "create", input: entityInput("bob", "char-2") });
  const fact = await applyCampaignMemoryMutation(db, { ...base, operationId: "create-fact", recordType: "fact", action: "create", input: { chatId, subjectEntityId: "alice", predicate: "trusts", value: "bob", conditions: [], status: "verified", sourceRevision: "r1", evidence: [{ messageId: "msg-1", quote: "Alice trusts Bob" }], author: "user", provenance, manualLock: false } });
  const knowledge = await applyCampaignMemoryMutation(db, { ...base, operationId: "create-knowledge", recordType: "knowledge", action: "create", input: { chatId, holderEntityId: "alice", factId: (fact as { factId: string }).factId, epistemicState: "knows", learnedFrom: [], provenance, manualLock: false } });
  const relationship = await applyCampaignMemoryMutation(db, { ...base, operationId: "create-relationship", recordType: "relationship", action: "create", input: { chatId, sourceEntityId: "alice", targetEntityId: "bob", type: "trusts", inverseLabel: "trusted-by", status: "active", evidence: [], provenance, manualLock: false } });
  const event = await applyCampaignMemoryMutation(db, { ...base, operationId: "create-event", recordType: "event", action: "create", input: { chatId, occurrenceOrder: orders[0]!, participantEntityIds: ["alice"], sourceRevision: "r1", transitions: [], evidence: [], provenance } });
  const later = await applyCampaignMemoryMutation(db, { ...base, operationId: "create-event-2", recordType: "event", action: "create", input: { chatId, occurrenceOrder: orders[1]!, participantEntityIds: ["alice"], sourceRevision: "r1", transitions: [], evidence: [], provenance } });
  const state = await applyCampaignMemoryMutation(db, { ...base, operationId: "create-state", recordType: "current-state", action: "create", input: { chatId, entityId: "alice", property: "mood", value: "calm", sourceEventId: (event as { eventId: string }).eventId, validAtOrder: orders[0]!, protected: false, provenance, manualLock: false } });
  const factId = (fact as { factId: string }).factId;
  const knowledgeId = (knowledge as { knowledgeId: string }).knowledgeId;
  const relationshipId = (relationship as { relationshipId: string }).relationshipId;
  const stateId = (state as { stateId: string }).stateId;

  // Unrelated later writes that must survive every compensation below.
  await applyCampaignMemoryMutation(db, { ...base, operationId: "create-dave", recordType: "entity", action: "create", input: entityInput("dave", "char-2") });
  const bobRenamed = await applyCampaignMemoryMutation(db, { ...base, operationId: "rename-bob", recordType: "entity", action: "update", recordId: "bob", expectedRevision: 1, patch: { aliases: ["Bob the Bold"] } });

  // Entity create -> archived.
  const archived = await compensate("undo-alice", "create-alice");
  assert.equal((archived as { status: string }).status, "archived");
  assert.equal((archived as { revision: number }).revision, 2);
  assert.equal((await storage.getEntity(scope, "alice"))!.status, "archived");
  const archivedJournal = await journal("undo-alice");
  assert.equal(archivedJournal.length, 1);
  assert.equal(archivedJournal[0]!.compensationOperationId, "create-alice");
  assert.equal(archivedJournal[0]!.expectedRevision, 1);
  assert.equal(JSON.parse(archivedJournal[0]!.before!).status, "active");
  // Idempotent: same operationId replays the journaled result, no second effect.
  assert.deepEqual(await compensate("undo-alice", "create-alice"), archived);
  assert.equal((await storage.getEntity(scope, "alice"))!.revision, 2);
  assert.equal((await journal("undo-alice")).length, 1);
  // A different operationId against the same create is CAS-refused: the row moved on (revision 2 != 1).
  await assert.rejects(() => compensate("undo-alice-again", "create-alice"), code("CAMPAIGN_MEMORY_CAS_MISMATCH"));
  assert.equal((await journal("undo-alice-again")).length, 0);

  // Fact create -> retracted.
  const retracted = await compensate("undo-fact", "create-fact");
  assert.equal((retracted as { status: string }).status, "retracted");
  assert.equal((await storage.getFact(scope, factId))!.status, "retracted");
  assert.equal((await storage.getFact(scope, factId))!.predicate, "trusts");
  assert.equal((await journal("undo-fact"))[0]!.compensationOperationId, "create-fact");
  assert.deepEqual(await compensate("undo-fact", "create-fact"), retracted);

  // Knowledge create -> epistemicState unknown (schema has no status and storage has no delete).
  const unknown = await compensate("undo-knowledge", "create-knowledge");
  assert.equal((unknown as { epistemicState: string }).epistemicState, "unknown");
  assert.equal((await storage.getKnowledge(scope, knowledgeId))!.epistemicState, "unknown");
  assert.equal((await storage.getKnowledge(scope, knowledgeId))!.factId, factId);
  assert.deepEqual(await compensate("undo-knowledge", "create-knowledge"), unknown);

  // Relationship create -> ended.
  const ended = await compensate("undo-relationship", "create-relationship");
  assert.equal((ended as { status: string }).status, "ended");
  assert.equal((await storage.getRelationship(scope, relationshipId))!.status, "ended");
  assert.deepEqual(await compensate("undo-relationship", "create-relationship"), ended);

  // Event create -> immutable, reported as skipped and journaled once.
  const skipped = await compensate("undo-event", "create-event");
  assert.deepEqual(skipped, { skipped: "immutable", recordType: "event", recordId: (event as { eventId: string }).eventId, compensates: "create-event" });
  assert.deepEqual(await storage.getEvent(scope, (event as { eventId: string }).eventId), event);
  assert.deepEqual(await compensate("undo-event", "create-event"), skipped);
  const skippedJournal = await journal("undo-event");
  assert.equal(skippedJournal.length, 1);
  assert.equal(skippedJournal[0]!.compensationOperationId, "create-event");
  assert.equal(skippedJournal[0]!.before, null);

  // Current-state create -> value cleared, order anchor kept.
  const cleared = await compensate("undo-state", "create-state");
  assert.equal((cleared as { value: unknown }).value, null);
  const clearedState = (await storage.getCurrentState(scope, stateId))!;
  assert.equal(clearedState.value, null);
  assert.equal(clearedState.validAtOrder, orders[0]);
  assert.equal(clearedState.sourceEventId, (event as { eventId: string }).eventId);
  assert.deepEqual(await compensate("undo-state", "create-state"), cleared);

  // Current-state update compensation restores the value but never regresses the order anchor (CAMPAIGN_MEMORY_STALE_ORDER).
  const moved = await applyCampaignMemoryMutation(db, { ...base, operationId: "move-state", recordType: "current-state", action: "update", recordId: stateId, expectedRevision: clearedState.revision, patch: { value: "angry", sourceEventId: (later as { eventId: string }).eventId, validAtOrder: orders[1]! } });
  assert.equal((moved as { value: unknown }).value, "angry");
  const restored = await compensate("undo-move-state", "move-state");
  assert.equal((restored as { value: unknown }).value, null);
  assert.equal((restored as { validAtOrder: string }).validAtOrder, orders[1]);
  assert.equal((restored as { sourceEventId: string }).sourceEventId, (later as { eventId: string }).eventId);
  assert.equal((await journal("undo-move-state"))[0]!.compensationOperationId, "move-state");

  // CAS refusal when the created row moved on before compensation (an unrelated update bumped the revision).
  await applyCampaignMemoryMutation(db, { ...base, operationId: "create-carol", recordType: "entity", action: "create", input: entityInput("carol", "char-1") });
  await applyCampaignMemoryMutation(db, { ...base, operationId: "retag-carol", recordType: "entity", action: "update", recordId: "carol", expectedRevision: 1, patch: { tags: ["moved"] } });
  await assert.rejects(() => compensate("undo-carol", "create-carol"), code("CAMPAIGN_MEMORY_CAS_MISMATCH"));
  const carol = (await storage.getEntity(scope, "carol"))!;
  assert.equal(carol.status, "active");
  assert.equal(carol.revision, 2);
  assert.equal((await journal("undo-carol")).length, 0);

  // Non-record journal rows (for example transition envelopes) are refused, not misread as creates.
  await db.insert(campaignMemoryMutationJournal).values({ journalId: "foreign-row", chatId, operationId: "transition-envelope", recordType: "transition", recordId: "t1", actor: "user", expectedRevision: null, before: null, after: JSON.stringify({ operations: [] }), reason: "seed", evidence: "[]", compensationOperationId: null, payloadHash: "x", createdAt: now });
  await assert.rejects(() => compensate("undo-envelope", "transition-envelope"), code("CAMPAIGN_MEMORY_INVALID_VALUE"));

  // Unrelated later writes survived untouched.
  const dave = (await storage.getEntity(scope, "dave"))!;
  assert.equal(dave.status, "active");
  assert.equal(dave.revision, 1);
  assert.deepEqual(await storage.getEntity(scope, "bob"), bobRenamed);
  assert.deepEqual((await storage.getEntity(scope, "bob"))!.aliases, ["Bob the Bold"]);

  await db._fileStore.close();
  console.log("campaign memory compensate create regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
