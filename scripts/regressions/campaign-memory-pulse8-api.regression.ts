import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify");
const root = mkdtempSync(join(tmpdir(), "marinara-campaign-memory-pulse8-api-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

const wikiSource = readFileSync(
  new URL("../../packages/client/src/components/game/CampaignWiki.tsx", import.meta.url),
  "utf8",
);
const relationshipBlock = wikiSource.slice(
  wikiSource.indexOf("{relationships.items.map"),
  wikiSource.indexOf("</WikiSection>", wikiSource.indexOf("{relationships.items.map")),
);
assert.equal(
  /<button[\s\S]*CampaignWikiEvidence[\s\S]*<\/button>/.test(relationshipBlock),
  false,
  "relationship evidence must not be nested inside the navigation button",
);

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { chats, messages } = await import("../../packages/server/src/db/schema/index.js");
  const { eq } = await import("../../packages/server/src/db/file-query.js");
  const { createCampaignMemoryStorage } =
    await import("../../packages/server/src/services/storage/campaign-memory.storage.js");
  const { campaignMemoryRoutes } = await import("../../packages/server/src/routes/campaign-memory.routes.js");
  const db = await createFileNativeDB();
  const createdAt = new Date().toISOString();
  await db.insert(chats).values([
    { id: "pulse8-main", name: "Pulse8 main", mode: "game", characterIds: "[]", createdAt, updatedAt: createdAt },
    { id: "pulse8-other", name: "Pulse8 other", mode: "game", characterIds: "[]", createdAt, updatedAt: createdAt },
  ]);
  await db.insert(messages).values([
    { id: "pulse8-source", chatId: "pulse8-main", role: "user", content: "Cause source", createdAt },
    { id: "pulse8-other-source", chatId: "pulse8-other", role: "user", content: "Other source", createdAt },
  ]);
  const storage = createCampaignMemoryStorage(db);
  const provenance = { source: "pulse8-regression", sourceRevision: "r1", actor: "system" as const };
  await storage.createEntity({
    entityId: "pulse8-entity",
    chatId: "pulse8-main",
    kind: "note",
    owner: { type: "registry", store: "campaign-memory", recordId: "pulse8-entity" },
    aliases: ["Pulse8 entity"],
    tags: [],
    attributes: {},
    status: "active",
    manualLock: false,
    provenance,
  });
  await storage.createEntity({
    entityId: "pulse8-other-entity",
    chatId: "pulse8-other",
    kind: "note",
    owner: { type: "registry", store: "campaign-memory", recordId: "pulse8-other-entity" },
    aliases: ["Other entity"],
    tags: [],
    attributes: {},
    status: "active",
    manualLock: false,
    provenance,
  });
  const evidence = [{ messageId: "pulse8-source", quote: "Cause source", sourceHash: hash("Cause source") }];
  // Event ids sort the opposite way to occurrence order so ordering by id would fail below.
  const occurrenceOrders: Record<string, string> = { "event-a": "order-2", "event-z": "order-1" };
  const createEvent = (eventId: string, chatId: string, entityId: string) =>
    storage.createEvent({
      eventId,
      chatId,
      occurrenceOrder: occurrenceOrders[eventId] ?? eventId,
      participantEntityIds: [entityId],
      sourceRevision: "r1",
      transitions: [`Transition ${eventId}`],
      evidence:
        chatId === "pulse8-main"
          ? evidence
          : [{ messageId: "pulse8-other-source", quote: "Other source", sourceHash: hash("Other source") }],
      provenance,
      immutable: true,
    });
  await createEvent("event-a", "pulse8-main", "pulse8-entity");
  await createEvent("event-z", "pulse8-main", "pulse8-entity");
  await createEvent("event-other", "pulse8-other", "pulse8-other-entity");
  await storage.createCurrentState({
    stateId: "state-z",
    chatId: "pulse8-main",
    entityId: "pulse8-entity",
    property: "location",
    value: "The archive",
    sourceEventId: "event-a",
    validAtOrder: "state-order",
    protected: false,
    provenance,
    manualLock: false,
  });
  await db.update(messages).set({ content: "Changed cause source" }).where(eq(messages.id, "pulse8-source"));

  const app = Fastify();
  app.decorate("db", db);
  await app.register(campaignMemoryRoutes, { prefix: "/api/game" });
  await app.ready();
  const response = await app.inject({
    method: "GET",
    url: "/api/game/pulse8-main/memory/entities/pulse8-entity?limit=1&offset=0",
  });
  assert.equal(response.statusCode, 200);
  const detail = response.json();
  assert.equal(detail.events.items.length, 1, "event page remains bounded");
  assert.equal(detail.events.items[0].eventId, "event-z", "events page orders by occurrenceOrder, not id");
  assert.deepEqual(
    detail.referencedEvents.map((event: { eventId: string }) => event.eventId),
    ["event-a"],
    "cause event is projected despite event-page pagination",
  );
  assert.equal(detail.referencedEvents[0].evidence[0].messageId, "pulse8-source");
  assert.equal(detail.sourceChecks["event-a"].state, "stale", "referenced cause event includes freshness");
  assert.equal(detail.sourceChecks["state-z"].state, "stale", "state inherits stale freshness from its cause event");
  assert.equal(
    detail.referencedEvents.some((event: { eventId: string }) => event.eventId === "event-other"),
    false,
    "cross-chat event is excluded",
  );
  await app.close();
  await db._fileStore.close();
  process.stdout.write("campaign-memory-pulse8-api regression passed\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
