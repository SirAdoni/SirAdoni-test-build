import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify");

const root = mkdtempSync(join(tmpdir(), "marinara-campaign-memory-api-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { chats, characters, messages, campaignMemoryFacts } =
    await import("../../packages/server/src/db/schema/index.js");
  const { eq } = await import("../../packages/server/src/db/file-query.js");
  const { createCampaignMemoryStorage } =
    await import("../../packages/server/src/services/storage/campaign-memory.storage.js");
  const { campaignMemoryRoutes } = await import("../../packages/server/src/routes/campaign-memory.routes.js");
  const db = await createFileNativeDB();
  const createdAt = new Date().toISOString();
  await db.insert(chats).values([
    {
      id: "memory-api-chat",
      name: "Memory API",
      mode: "game",
      characterIds: JSON.stringify(["api-alice", "api-bob", "api-carol"]),
      createdAt,
      updatedAt: createdAt,
    },
    {
      id: "memory-api-other",
      name: "Other Memory API",
      mode: "game",
      characterIds: JSON.stringify(["other-alice"]),
      createdAt,
      updatedAt: createdAt,
    },
    { id: "memory-api-chat-mode", name: "Wrong mode", mode: "chat", createdAt, updatedAt: createdAt },
  ]);
  await db.insert(characters).values(
    ["api-alice", "api-bob", "api-carol", "other-alice"].map((id) => ({
      id,
      data: "{}",
      createdAt,
      updatedAt: createdAt,
    })),
  );
  await db.insert(messages).values([
    { id: "memory-api-fresh", chatId: "memory-api-chat", role: "user", content: "Original evidence" },
    { id: "memory-api-legacy", chatId: "memory-api-chat", role: "user", content: "Legacy evidence" },
  ]);
  const storage = createCampaignMemoryStorage(db);
  const provenance = { source: "regression", sourceRevision: "r1", actor: "user" as const };
  const makeEntity = async (entityId: string, alias: string) =>
    storage.createEntity({
      entityId,
      chatId: "memory-api-chat",
      kind: "character",
      owner: { type: "existing", store: "characters", recordId: entityId },
      aliases: [alias],
      tags: ["test"],
      summary: "API test entity",
      attributes: {},
      status: "active",
      manualLock: false,
      provenance,
    });
  const alice = await makeEntity("api-alice", "<Alice & Eve>");
  await makeEntity("api-bob", "Bob");
  await makeEntity("api-carol", "Carol");
  await storage.createEntity({
    entityId: "other-alice",
    chatId: "memory-api-other",
    kind: "character",
    owner: { type: "existing", store: "characters", recordId: "other-alice" },
    aliases: ["Other Alice"],
    tags: [],
    attributes: {},
    status: "active",
    manualLock: false,
    provenance,
  });
  const fact = await storage.createFact({
    chatId: "memory-api-chat",
    subjectEntityId: alice.entityId,
    predicate: "mentions",
    value: { entityId: "api-bob" },
    conditions: [],
    status: "verified",
    sourceRevision: "r1",
    evidence: [
      {
        messageId: "memory-api-fresh",
        quote: "Original evidence",
        sourceHash: createHash("sha256").update("Original evidence", "utf8").digest("hex"),
      },
    ],
    author: "user",
    provenance,
    manualLock: false,
  });
  await storage.createKnowledge({
    knowledgeId: "api-alice-knowledge",
    chatId: "memory-api-chat",
    holderEntityId: alice.entityId,
    factId: fact.factId,
    epistemicState: "knows",
    learnedFrom: [],
    provenance,
    manualLock: false,
  });
  const legacyFact = await storage.createFact({
    chatId: "memory-api-chat",
    subjectEntityId: alice.entityId,
    predicate: "legacy",
    value: "legacy",
    conditions: [],
    status: "proposed",
    sourceRevision: "r1",
    evidence: [{ messageId: "memory-api-legacy", quote: "Legacy evidence" }],
    author: "import",
    provenance: { source: "legacy", sourceRevision: "r0", actor: "import" },
    manualLock: false,
  });
  const missingFact = await storage.createFact({
    chatId: "memory-api-chat",
    predicate: "missing",
    value: "missing",
    subjectEntityId: alice.entityId,
    conditions: [],
    status: "proposed",
    sourceRevision: "r1",
    evidence: [],
    author: "import",
    provenance: { source: "import", sourceRevision: "r1", actor: "import" },
    manualLock: false,
  });
  const manualFact = await storage.createFact({
    chatId: "memory-api-chat",
    predicate: "manual",
    value: "manual",
    subjectEntityId: alice.entityId,
    conditions: [],
    status: "proposed",
    sourceRevision: "r1",
    evidence: [],
    author: "user",
    provenance: { source: "manual", sourceRevision: "r1", actor: "user" },
    manualLock: false,
  });
  await db
    .update(campaignMemoryFacts)
    .set({ evidence: JSON.stringify([{ messageId: "missing-message", quote: "Missing" }]) })
    .where(eq(campaignMemoryFacts.factId, missingFact.factId));
  await db
    .update(campaignMemoryFacts)
    .set({ evidence: JSON.stringify([{ messageId: "memory-api-legacy", quote: "Legacy evidence" }]) })
    .where(eq(campaignMemoryFacts.factId, legacyFact.factId));
  await db.update(messages).set({ content: "Changed evidence" }).where(eq(messages.id, "memory-api-fresh"));

  const app = Fastify();
  app.decorate("db", db);
  await app.register(campaignMemoryRoutes, { prefix: "/api/game" });
  await app.ready();
  const get = (url: string) => app.inject({ method: "GET", url });

  let response = await get("/api/game/memory-api-chat/memory/entities?q=%3CAlice%20%26%20Eve%3E");
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().items[0].entityId, "api-alice");
  assert.equal(response.json().items[0].aliases[0], "<Alice & Eve>");

  response = await get("/api/game/memory-api-chat/memory/entities?limit=1&offset=1");
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().total, 3);
  assert.equal(response.json().items.length, 1);
  assert.equal(response.json().offset, 1);

  response = await get("/api/game/memory-api-chat/memory/entities?limit=nope");
  assert.equal(response.statusCode, 400);
  response = await get("/api/game/memory-api-chat/memory/entities?kind=invalid");
  assert.equal(response.statusCode, 400);

  response = await get("/api/game/memory-api-chat/memory/entities/api-alice");
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().facts.total, 4);
  assert.equal(response.json().referencedFacts.length, 1);
  assert.equal(response.json().sourceChecks[fact.factId].state, "stale");
  assert.equal(response.json().sourceChecks["api-alice-knowledge"].state, "stale");
  assert.equal(response.json().sourceChecks[legacyFact.factId].state, "legacy");
  assert.equal(response.json().sourceChecks[missingFact.factId].state, "stale");
  assert.equal(response.json().sourceChecks[manualFact.factId].state, "manual");
  assert.equal(
    response.json().facts.items.find((item: { factId: string }) => item.factId === fact.factId).status,
    "verified",
  );
  assert.equal(response.json().relatedEntities[0].entityId, "api-bob");

  response = await get("/api/game/memory-api-chat/memory/entities/api-alice/facts?limit=1");
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().total, 4);
  assert.equal(response.json().limit, 1);

  response = await get("/api/game/memory-api-chat/memory/entities/api-alice/missing");
  assert.equal(response.statusCode, 400);
  response = await get("/api/game-api-missing/memory/entities");
  assert.equal(response.statusCode, 404);
  response = await get("/api/game/memory-api-chat-mode/memory/entities");
  assert.equal(response.statusCode, 404);
  response = await get("/api/game/memory-api-chat/memory/entities/missing-entity");
  assert.equal(response.statusCode, 404);
  response = await get("/api/game/memory-api-chat/memory/entities/other-alice");
  assert.equal(response.statusCode, 404);
  response = await get("/api/game/memory-api-other/memory/entities");
  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    response.json().items.map((item: { entityId: string }) => item.entityId),
    ["other-alice"],
  );

  await app.close();
  await db._fileStore.close();
  console.log("campaign-memory-api regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
