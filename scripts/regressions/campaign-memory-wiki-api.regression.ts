/**
 * Pulse 6-8 wiki read API contract: search tiers, owner lookup, occurrence-ordered
 * timeline with cursor paging, fact co-holders, fact dependents, entity references.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpatialContextDefinition } from "@marinara-engine/shared";
import type { CampaignMemoryOwnerReader } from "../../packages/server/src/services/game/campaign-memory-owners.js";

const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify");
const root = mkdtempSync(join(tmpdir(), "marinara-campaign-memory-wiki-api-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const CHAT = "wiki-chat";

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { chats, characters, messages } = await import("../../packages/server/src/db/schema/index.js");
  const { createCampaignMemoryStorage } =
    await import("../../packages/server/src/services/storage/campaign-memory.storage.js");
  const { campaignMemoryRoutes } = await import("../../packages/server/src/routes/campaign-memory.routes.js");
  const db = await createFileNativeDB();
  const createdAt = new Date().toISOString();
  await db.insert(chats).values([
    {
      id: CHAT,
      name: "Wiki",
      mode: "game",
      characterIds: JSON.stringify(["char-ann", "char-annabel", "char-bob"]),
      createdAt,
      updatedAt: createdAt,
    },
  ]);
  await db.insert(characters).values(
    ["char-ann", "char-annabel", "char-bob"].map((id) => ({ id, data: "{}", createdAt, updatedAt: createdAt })),
  );
  await db.insert(messages).values([
    { id: "wiki-msg-1", chatId: CHAT, role: "user", content: "First source", createdAt },
    { id: "wiki-msg-2", chatId: CHAT, role: "user", content: "Second source", createdAt },
  ]);
  // Stub owner reader: stable ids only, so a location can be registered without live spatial metadata.
  const characterIds = ["char-ann", "char-annabel", "char-bob"];
  const ownerReader: CampaignMemoryOwnerReader = {
    async readChatScope(chatId) {
      if (chatId !== CHAT) return null;
      return {
        chatId,
        characterIds,
        spatialDefinition: { locations: [{ id: "hall" }] } as unknown as SpatialContextDefinition,
      };
    },
    async readExistingOwner(owner) {
      if (owner.store === "characters" && characterIds.includes(owner.recordId)) return { ...owner, kind: "character" };
      if (owner.store === "spatial-context" && owner.recordId === "hall") return { ...owner, kind: "location" };
      return null;
    },
    async readRegistryOwner() {
      return true;
    },
  };
  const storage = createCampaignMemoryStorage(db, ownerReader);
  const provenance = { source: "wiki-regression", sourceRevision: "r1", actor: "user" as const };
  const owners = {
    character: (recordId: string) => ({ type: "existing" as const, store: "characters", recordId }),
    location: (recordId: string) => ({ type: "existing" as const, store: "spatial-context", recordId }),
    note: (recordId: string) => ({ type: "registry" as const, store: "campaign-memory" as const, recordId }),
  };
  const makeEntity = (entityId: string, kind: keyof typeof owners, aliases: string[], summary: string) =>
    storage.createEntity({
      entityId,
      chatId: CHAT,
      kind,
      owner: owners[kind](entityId),
      aliases,
      tags: [],
      summary,
      attributes: {},
      status: "active",
      manualLock: false,
      provenance,
    });
  // Search fixture: the query "ann" hits every tier with ids chosen to sort against tier order.
  await makeEntity("ann", "note", ["Zed"], "Id match only");
  await makeEntity("char-ann", "character", ["Ann"], "Exact alias");
  await makeEntity("char-annabel", "character", ["Annabel"], "Alias prefix");
  await makeEntity("aaa-text", "note", ["Quill"], "Mentions ann in summary");
  await makeEntity("char-bob", "character", ["Bob"], "No match");
  await makeEntity("hall", "location", ["Great Hall"], "A place");

  const evidence1 = [{ messageId: "wiki-msg-1", quote: "First source", sourceHash: hash("First source") }];
  const evidence2 = [{ messageId: "wiki-msg-2", quote: "Second source", sourceHash: hash("Second source") }];
  const fact = await storage.createFact({
    factId: "fact-shared",
    chatId: CHAT,
    subjectEntityId: "char-bob",
    predicate: "title",
    value: "Steward",
    conditions: [],
    status: "verified",
    sourceRevision: "r1",
    evidence: evidence1,
    author: "user",
    provenance,
    manualLock: false,
  });
  const makeKnowledge = (knowledgeId: string, holderEntityId: string, epistemicState: "knows" | "believes") =>
    storage.createKnowledge({
      knowledgeId,
      chatId: CHAT,
      holderEntityId,
      factId: fact.factId,
      epistemicState,
      learnedFrom: [],
      provenance,
      manualLock: false,
    });
  await makeKnowledge("k-bob", "char-bob", "knows");
  await makeKnowledge("k-ann", "char-ann", "believes");
  await makeKnowledge("k-annabel", "char-annabel", "knows");
  // Event ids sort the opposite way to their occurrence order.
  const makeEvent = (eventId: string, occurrenceOrder: string, evidence: typeof evidence1, location?: string) =>
    storage.createEvent({
      eventId,
      chatId: CHAT,
      occurrenceOrder,
      participantEntityIds: ["char-bob"],
      ...(location ? { locationEntityId: location } : {}),
      sourceRevision: "r1",
      transitions: [`Transition ${eventId}`],
      evidence,
      provenance,
      immutable: true,
    });
  await makeEvent("event-c", "m1|2026-01-01T00:00:01.000Z|wiki-msg-1", evidence1, "hall");
  await makeEvent("event-b", "m1|2026-01-01T00:00:02.000Z|wiki-msg-2", evidence2);
  await makeEvent("event-a", "m1|2026-01-01T00:00:03.000Z|wiki-msg-2", evidence2, "hall");
  await storage.createCurrentState({
    stateId: "state-title",
    chatId: CHAT,
    entityId: "char-bob",
    property: "title",
    value: "Steward",
    sourceEventId: "event-c",
    validAtOrder: "m1|2026-01-01T00:00:01.000Z|wiki-msg-1",
    protected: false,
    provenance,
    manualLock: false,
  });
  await storage.createRelationship({
    relationshipId: "rel-1",
    chatId: CHAT,
    sourceEntityId: "char-ann",
    targetEntityId: "char-bob",
    type: "ally",
    inverseLabel: "ally",
    status: "active",
    evidence: [],
    provenance,
    manualLock: false,
  });

  const app = Fastify();
  app.decorate("db", db);
  await app.register(campaignMemoryRoutes, { prefix: "/api/game" });
  await app.ready();
  const get = (url: string) => app.inject({ method: "GET", url: `/api/game/${CHAT}/memory/${url}` });
  const ids = (items: { entityId?: string; eventId?: string }[]) => items.map((item) => item.entityId ?? item.eventId);

  // 1. Search tiers: id beats alias beats prefix beats text, regardless of alphabetical order.
  let response = await get("entities?q=ANN");
  assert.equal(response.statusCode, 200);
  assert.deepEqual(ids(response.json().items), ["ann", "char-ann", "char-annabel", "aaa-text"]);
  assert.deepEqual(
    response.json().items.map((item: { matchTier: string }) => item.matchTier),
    ["id", "alias", "prefix", "text"],
  );
  response = await get("entities");
  assert.equal("matchTier" in response.json().items[0], false, "no tier without a query");

  // 2. Owner lookup by stable identity; aliases never resolve an owner.
  response = await get("entities?owner=characters:char-bob");
  assert.deepEqual(ids(response.json().items), ["char-bob"]);
  response = await get("entities?owner=characters:Bob");
  assert.equal(response.json().total, 0);
  response = await get("entities?owner=spatial-context:hall");
  assert.deepEqual(ids(response.json().items), ["hall"]);
  response = await get("entities?owner=campaign-memory:ann");
  assert.deepEqual(ids(response.json().items), ["ann"], "registry owners resolve by their own entity id");
  response = await get("entities?owner=nocolon");
  assert.equal(response.statusCode, 400);

  // 3. Timeline sorted by occurrenceOrder (ids sort the opposite way), cursor paging, filters.
  response = await get("timeline?limit=2");
  assert.equal(response.statusCode, 200);
  let body = response.json();
  assert.deepEqual(ids(body.items), ["event-c", "event-b"]);
  assert.equal(body.nextCursor, "event-b");
  assert.deepEqual(body.items[0].location, { entityId: "hall", alias: "Great Hall" });
  assert.equal(body.items[1].location, null);
  assert.deepEqual(body.items[0].participants, [{ entityId: "char-bob", alias: "Bob" }]);
  assert.equal(body.items[0].summary, "Transition event-c");
  assert.deepEqual(body.items[0].stateChanges, [{ entityId: "char-bob", key: "title", value: "Steward" }]);
  assert.deepEqual(body.items[1].stateChanges, []);
  assert.equal(body.items[0].sourceMessageId, "wiki-msg-1");
  assert.equal(body.items[0].campaignTime, null);
  response = await get(`timeline?limit=2&cursor=${body.nextCursor}`);
  body = response.json();
  assert.deepEqual(ids(body.items), ["event-a"]);
  assert.equal(body.nextCursor, null);
  response = await get("timeline?cursor=event-missing");
  assert.equal(response.statusCode, 400);
  response = await get("timeline?locationId=hall");
  assert.deepEqual(ids(response.json().items), ["event-c", "event-a"]);
  response = await get("timeline?entityId=hall");
  assert.deepEqual(ids(response.json().items), ["event-c", "event-a"]);
  response = await get("timeline?entityId=char-ann");
  assert.deepEqual(ids(response.json().items), []);
  // Entity detail and section listings share the occurrence ordering.
  response = await get("entities/char-bob");
  assert.deepEqual(ids(response.json().events.items), ["event-c", "event-b", "event-a"]);
  response = await get("entities/char-bob/events");
  assert.deepEqual(ids(response.json().items), ["event-c", "event-b", "event-a"]);

  // 4. Co-holders on detail fact items, excluding the page entity, alphabetical.
  response = await get("entities/char-bob");
  const detailFact = response.json().facts.items.find((item: { factId: string }) => item.factId === fact.factId);
  assert.deepEqual(detailFact.coHolders, [
    { entityId: "char-ann", alias: "Ann", epistemicState: "believes" },
    { entityId: "char-annabel", alias: "Annabel", epistemicState: "knows" },
  ]);
  response = await get("entities/char-ann");
  assert.deepEqual(
    response.json().referencedFacts[0].coHolders.map((item: { entityId: string }) => item.entityId),
    ["char-annabel", "char-bob"],
    "referenced facts carry co-holders excluding the page entity",
  );

  // 5. Dependents of a fact.
  response = await get(`facts/${fact.factId}/dependents`);
  assert.equal(response.statusCode, 200);
  body = response.json();
  assert.deepEqual(body.knowledge, [
    { knowledgeId: "k-ann", holder: { entityId: "char-ann", alias: "Ann" }, epistemicState: "believes" },
    { knowledgeId: "k-annabel", holder: { entityId: "char-annabel", alias: "Annabel" }, epistemicState: "knows" },
    { knowledgeId: "k-bob", holder: { entityId: "char-bob", alias: "Bob" }, epistemicState: "knows" },
  ]);
  assert.deepEqual(body.events, [{ eventId: "event-c", summary: "Transition event-c" }]);
  assert.deepEqual(body.states, [{ entityId: "char-bob", key: "title", causeEventId: "event-c" }]);
  response = await get("facts/fact-missing/dependents");
  assert.equal(response.statusCode, 404);

  // 6. Reference counts and bounded samples.
  response = await get("entities/char-bob/references");
  assert.equal(response.statusCode, 200);
  body = response.json();
  assert.deepEqual(
    { facts: body.facts, knowledge: body.knowledge, events: body.events, relationships: body.relationships, states: body.states },
    { facts: 1, knowledge: 1, events: 3, relationships: 1, states: 1 },
  );
  assert.deepEqual(body.samples.events, ["event-c", "event-b", "event-a"]);
  assert.deepEqual(body.samples.relationships, ["rel-1"]);
  response = await get("entities/hall/references");
  assert.equal(response.json().events, 2);
  response = await get("entities/nobody/references");
  assert.equal(response.statusCode, 404);

  await app.close();
  await db._fileStore.close();
  console.log("campaign-memory-wiki-api regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
