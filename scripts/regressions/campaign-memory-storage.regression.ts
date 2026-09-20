import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = mkdtempSync(join(tmpdir(), "marinara-campaign-memory-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { chats, messages } = await import("../../packages/server/src/db/schema/index.js");
  const { createCampaignMemoryStorage, CampaignMemoryStorageError } =
    await import("../../packages/server/src/services/storage/campaign-memory.storage.js");
  const db = await createFileNativeDB();
  const createdAt = new Date().toISOString();
  await db
    .insert(chats)
    .values({ id: "memory-chat", name: "Memory test", mode: "game", createdAt, updatedAt: createdAt });
  await db
    .insert(chats)
    .values({ id: "other-chat", name: "Other memory test", mode: "game", createdAt, updatedAt: createdAt });
  await db
    .insert(messages)
    .values({ id: "m1", chatId: "memory-chat", role: "user", content: "I trust this place I know Arrived" });
  const ownerReader = {
    async readChatScope(chatId: string) {
      return {
        chatId,
        characterIds: ["character-1"],
        spatialDefinition: { locations: [{ id: "place-1" }] },
      } as never;
    },
    async readExistingOwner(owner: { store: string; recordId: string }) {
      if (owner.store === "characters" && owner.recordId === "character-1")
        return { store: owner.store, recordId: owner.recordId, kind: "character" as const };
      if (owner.store === "spatial-context" && owner.recordId === "place-1")
        return { store: owner.store, recordId: owner.recordId, kind: "location" as const };
      return null;
    },
  };
  const storage = createCampaignMemoryStorage(db, ownerReader);
  const scope = { chatId: "memory-chat" };
  const provenance = { source: "regression", sourceRevision: "r1", actor: "user" as const };
  const defaultStorage = createCampaignMemoryStorage(db);
  const organization = await defaultStorage.createEntity({
    entityId: "organization-1",
    chatId: scope.chatId,
    kind: "organization",
    owner: { type: "registry", store: "campaign-memory", recordId: "organization-1" },
    aliases: [],
    tags: [],
    attributes: {},
    status: "active",
    manualLock: false,
    provenance,
  });
  assert.equal(organization.entityId, "organization-1");
  await assert.rejects(
    () =>
      defaultStorage.createEntity({
        entityId: "organization-2",
        chatId: scope.chatId,
        kind: "character",
        owner: { type: "registry", store: "campaign-memory", recordId: "organization-2" },
        aliases: [],
        tags: [],
        attributes: {},
        status: "active",
        manualLock: false,
        provenance,
      }),
    /Registry owners are allowed only/u,
  );
  const alice = await storage.createEntity({
    chatId: scope.chatId,
    kind: "character",
    owner: { type: "existing", store: "characters", recordId: "character-1" },
    aliases: ["A"],
    tags: ["party"],
    attributes: { level: 2 },
    status: "active",
    manualLock: false,
    provenance,
  });
  const place = await storage.createEntity({
    chatId: scope.chatId,
    kind: "location",
    owner: { type: "existing", store: "spatial-context", recordId: "place-1" },
    aliases: [],
    tags: [],
    attributes: {},
    status: "active",
    manualLock: false,
    provenance,
  });
  assert.equal((await storage.listEntities(scope)).length, 3);
  const fact = await storage.createFact({
    chatId: scope.chatId,
    subjectEntityId: alice.entityId,
    predicate: "trusts",
    value: { target: place.entityId },
    conditions: [],
    status: "verified",
    sourceRevision: "r1",
    evidence: [{ messageId: "m1", quote: "I trust this place" }],
    author: "user",
    provenance,
    manualLock: false,
  });
  const event = await storage.createEvent({
    chatId: scope.chatId,
    occurrenceOrder: "m1",
    participantEntityIds: [alice.entityId],
    locationEntityId: place.entityId,
    sourceRevision: "r1",
    transitions: [],
    evidence: [{ messageId: "m1", quote: "Arrived" }],
    provenance,
  });
  assert.match(event.evidence[0]?.sourceHash ?? "", /^[a-f0-9]{64}$/u);
  const knowledge = await storage.createKnowledge({
    chatId: scope.chatId,
    holderEntityId: alice.entityId,
    factId: fact.factId,
    epistemicState: "knows",
    learnedFrom: [{ messageId: "m1", quote: "I know" }],
    provenance,
    manualLock: false,
  });
  assert.match(knowledge.learnedFrom[0]?.sourceHash ?? "", /^[a-f0-9]{64}$/u);
  await storage.createCurrentState({
    chatId: scope.chatId,
    entityId: alice.entityId,
    property: "location",
    value: place.entityId,
    sourceEventId: event.eventId,
    validAtOrder: "m1",
    protected: false,
    provenance,
    manualLock: false,
  });
  const relationship = await storage.createRelationship({
    chatId: scope.chatId,
    sourceEntityId: alice.entityId,
    targetEntityId: place.entityId,
    type: "visits",
    inverseLabel: "visited-by",
    status: "active",
    evidence: [{ messageId: "m1", quote: "Arrived" }],
    provenance,
    manualLock: false,
  });
  assert.match(relationship.evidence[0]?.sourceHash ?? "", /^[a-f0-9]{64}$/u);
  assert.equal((await storage.listBacklinks(scope, place.entityId))[0]?.label, "visited-by");
  assert.equal((await storage.getKnowledge(scope, knowledge.knowledgeId))?.factId, fact.factId);
  const sourceHash = fact.evidence[0]?.sourceHash;
  assert.match(sourceHash ?? "", /^[a-f0-9]{64}$/u);
  await db
    .update(messages)
    .set({ content: "I trust this place I know Arrived after an edit" })
    .where((await import("../../packages/server/src/db/file-query.js")).eq(messages.id, "m1"));
  await assert.rejects(
    () =>
      storage.updateFact(
        scope,
        fact.factId,
        { status: "verified", evidence: fact.evidence },
        { expectedRevision: 1, actor: "user", reason: "stale source" },
      ),
    /source changed/u,
  );
  const updated = await storage.updateFact(
    scope,
    fact.factId,
    { status: "verified", evidence: [{ messageId: "m1", quote: "I trust this place" }] },
    { expectedRevision: 1, actor: "user", reason: "manual acceptance", operationId: "op-1" },
  );
  assert.equal(updated.revision, 2);
  const locked = await storage.updateFact(
    scope,
    fact.factId,
    { manualLock: true },
    { expectedRevision: 2, actor: "user", reason: "protect fact" },
  );
  assert.equal(locked.revision, 3);
  await assert.rejects(
    () =>
      storage.updateFact(
        scope,
        fact.factId,
        { predicate: "tampered" },
        { expectedRevision: 1, actor: "user", reason: "stale" },
      ),
    (error) => error instanceof CampaignMemoryStorageError && error.code === "CAMPAIGN_MEMORY_CAS_MISMATCH",
  );
  await assert.rejects(
    () =>
      storage.updateFact(
        scope,
        fact.factId,
        { predicate: "different" },
        { expectedRevision: 3, actor: "system", reason: "automatic" },
      ),
    (error) => error instanceof CampaignMemoryStorageError && error.code === "CAMPAIGN_MEMORY_LOCKED",
  );
  await assert.rejects(
    () =>
      storage.createRelationship({
        chatId: "other-chat",
        sourceEntityId: alice.entityId,
        targetEntityId: place.entityId,
        type: "wrong",
        inverseLabel: "wrong",
        status: "active",
        evidence: [],
        provenance,
        manualLock: false,
      }),
    /outside chat scope|not in chat scope|not found/u,
  );
  assert.equal((await storage.listMutationJournal(scope)).length, 1);
  await assert.rejects(
    () =>
      storage.updateFact(
        scope,
        fact.factId,
        { status: "verified" },
        { expectedRevision: 2, actor: "user", reason: "different", operationId: "op-1" },
      ),
    (error) => error instanceof CampaignMemoryStorageError && error.code === "CAMPAIGN_MEMORY_IDEMPOTENCY_CONFLICT",
  );
  assert.equal((await storage.getEvent(scope, event.eventId))?.immutable, true);
  await db._fileStore.close();
  console.log("campaign memory storage regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
