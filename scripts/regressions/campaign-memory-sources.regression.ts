import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const root = mkdtempSync(join(tmpdir(), "marinara-campaign-memory-sources-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { chats, messageSwipes, messages } = await import("../../packages/server/src/db/schema/index.js");
  const { eq } = await import("../../packages/server/src/db/file-query.js");
  const { readCampaignMemorySources } = await import("../../packages/server/src/services/game/campaign-memory-sources.js");
  const { createCampaignMemoryStorage } = await import("../../packages/server/src/services/storage/campaign-memory.storage.js");
  const { buildCampaignMemoryContextFromStorage } = await import("../../packages/server/src/services/game/campaign-memory-context.js");
  const Fastify = createRequire(new URL("../../packages/server/package.json", import.meta.url))("fastify");
  const { campaignMemoryRoutes } = await import("../../packages/server/src/routes/campaign-memory.routes.js");
  const db = await createFileNativeDB();
  const createdAt = new Date().toISOString();
  await db.insert(chats).values([
    { id: "source-chat", name: "Source", mode: "game", metadata: "{}", createdAt, updatedAt: createdAt },
    { id: "other-chat", name: "Other", mode: "game", metadata: "{}", createdAt, updatedAt: createdAt },
  ]);
  await db.insert(messages).values([
    { id: "m1", chatId: "source-chat", role: "assistant", content: "Narration: Original fact" },
    { id: "hidden", chatId: "source-chat", role: "assistant", content: "Narration: Hidden fact", extra: JSON.stringify({ hiddenFromAI: true }) },
    { id: "derived", chatId: "source-chat", role: "assistant", content: "Narration: Derived fact", extra: JSON.stringify({ continuitySource: "derived_session_summary" }) },
    { id: "foreign", chatId: "other-chat", role: "assistant", content: "Narration: Foreign fact" },
  ]);
  const sources = await readCampaignMemorySources(db, { chatId: "source-chat" });
  assert.equal(sources.get("m1")?.content, "Narration: Original fact");
  assert.equal(sources.has("hidden"), false);
  assert.equal(sources.has("derived"), false);
  assert.equal((await readCampaignMemorySources(db, { chatId: "source-chat", messageIds: ["foreign"] })).size, 0);
  const initialHash = sources.get("m1")!.sourceHash;
  const storage = createCampaignMemoryStorage(db);
  const entity = await storage.createEntity({
    entityId: "entity", chatId: "source-chat", kind: "organization",
    owner: { type: "registry", store: "campaign-memory", recordId: "entity" }, aliases: [], tags: [], attributes: {},
    status: "active", manualLock: false, provenance: { source: "regression", sourceRevision: "1", actor: "user" },
  });
  const fact = await storage.createFact({
    factId: "fact", chatId: "source-chat", subjectEntityId: entity.entityId, predicate: "knows", value: "Original fact",
    conditions: [], status: "verified", sourceRevision: "1", evidence: [{ messageId: "m1", quote: "Original fact", sourceHash: initialHash }],
    author: "user", provenance: { source: "regression", sourceRevision: "1", actor: "user" }, manualLock: false,
  });
  await db.update(chats).set({ metadata: JSON.stringify({ "segmentEdit:m1:0": { content: "Edited fact" } }) }).where(eq(chats.id, "source-chat"));
  assert.equal((await readCampaignMemorySources(db, { chatId: "source-chat" })).get("m1")?.content, "Edited fact");
  const editedContext = await buildCampaignMemoryContextFromStorage(db, { chatId: "source-chat", audience: { kind: "gm" }, maxCharacters: 1000 });
  assert.equal(editedContext.text, "");
  assert.ok(editedContext.exclusions.some((item) => item.id === fact.factId && item.reason.includes("stale")));
  await db.update(chats).set({ metadata: "{}" }).where(eq(chats.id, "source-chat"));
  await db.insert(messageSwipes).values({ id: "m1-swipe", messageId: "m1", index: 1, content: "Narration: Swiped fact", extra: "{}", createdAt });
  await db.update(messages).set({ activeSwipeIndex: 1 }).where(eq(messages.id, "m1"));
  const swiped = await readCampaignMemorySources(db, { chatId: "source-chat" });
  assert.equal(swiped.get("m1")?.content, "Narration: Swiped fact");
  assert.notEqual(swiped.get("m1")?.sourceHash, initialHash);
  await db.update(messageSwipes).set({ content: "Narration: Swiped fact with more" }).where(eq(messageSwipes.id, "m1-swipe"));
  const unchangedQuote = await buildCampaignMemoryContextFromStorage(db, { chatId: "source-chat", audience: { kind: "gm" }, maxCharacters: 1000 });
  assert.equal(unchangedQuote.text, "");
  const app = Fastify();
  app.decorate("db", db);
  await app.register(campaignMemoryRoutes, { prefix: "/api/game" });
  await app.ready();
  const response = await app.inject({ method: "GET", url: "/api/game/source-chat/memory/entities/entity" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().sourceChecks.fact.state, "stale");
  await app.close();
  await db._fileStore.close();
  console.log("campaign memory sources regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
