import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// With gameContinuity.mode "off" the read routes still serve data: the continuity
// state, the entity list, and the entity detail (facts included) all answer 200.
const dataDir = mkdtempSync(join(tmpdir(), "marinara-game-continuity-mode-off-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";

let app: { close(): Promise<void>; inject(options: Record<string, unknown>): Promise<any> } | null = null;

try {
  const { buildApp } = await import("../../packages/server/src/app.js");
  const { getDB } = await import("../../packages/server/src/db/connection.js");
  const { createGameContinuityStorage } = await import("../../packages/server/src/services/storage/game-continuity.storage.js");
  const { createCampaignMemoryStorage } = await import("../../packages/server/src/services/storage/campaign-memory.storage.js");
  const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
  app = await buildApp();
  await app.ready();
  const db = await getDB();
  const chatsStorage = createChatsStorage(db);

  const created = await app.inject({ method: "POST", url: "/api/chats", payload: { name: "Mode off reads", mode: "game", characterIds: [] } });
  assert.equal(created.statusCode, 200);
  const chat = created.json();
  const message = await app.inject({ method: "POST", url: `/api/chats/${chat.id}/messages`, payload: { role: "assistant", content: "Robert promises to return before dawn." } });
  assert.equal(message.statusCode, 200);
  const messageId = message.json().id;

  // Seed a receipt, an entity, a fact and knowledge, then switch continuity explicitly off.
  const now = new Date().toISOString();
  await createGameContinuityStorage(db).enqueue({
    id: "mode-off-receipt", chatId: chat.id, sessionNumber: 1, sourceHash: "source-hash",
    sources: [{ messageId, swipeIndex: 0, hash: "message-hash", role: "assistant", content: "Robert promises to return before dawn." }],
    context: [], configHash: "config-hash", config: {}, status: "extracting", attempts: 1, repairAttempts: 0, records: [], dispositions: [], review: null, entryIds: [], createdAt: now, updatedAt: now,
  });
  await chatsStorage.updateMetadata(chat.id, { gameNpcs: [{ id: "npc-robert", name: "Robert" }] });
  const memory = createCampaignMemoryStorage(db);
  const provenance = { source: "regression", sourceRevision: "r1", actor: "user" as const };
  await memory.createEntity({ entityId: "mode-off-robert", chatId: chat.id, kind: "character", owner: { type: "existing", store: "game-npcs", recordId: "npc-robert" }, aliases: ["Robert"], tags: [], summary: "Robert", attributes: {}, status: "active", manualLock: false, provenance });
  const fact = await memory.createFact({
    chatId: chat.id, subjectEntityId: "mode-off-robert", predicate: "promise", value: { text: "Robert promises to return before dawn." }, conditions: [], status: "verified", sourceRevision: "r1",
    evidence: [{ messageId, quote: "Robert promises to return before dawn.", sourceHash: createHash("sha256").update("Robert promises to return before dawn.", "utf8").digest("hex") }],
    author: "system", provenance: { ...provenance, actor: "system" }, manualLock: false,
  });
  await memory.createKnowledge({ knowledgeId: "mode-off-knowledge", chatId: chat.id, holderEntityId: "mode-off-robert", factId: fact.factId, epistemicState: "knows", learnedFrom: [], provenance, manualLock: false });
  await chatsStorage.updateMetadata(chat.id, { gameContinuity: { mode: "off" } });
  const stored = await chatsStorage.getById(chat.id);
  const metadata = typeof stored!.metadata === "string" ? JSON.parse(stored!.metadata) : stored!.metadata;
  assert.equal(metadata.gameContinuity.mode, "off");

  const state = await app.inject({ method: "GET", url: `/api/game/${chat.id}/continuity` });
  assert.equal(state.statusCode, 200, "GET /continuity serves with mode off");
  assert.equal(state.json().config.mode, "off");
  assert.deepEqual(state.json().counts, { extracting: 1 }, "receipts are still reported with mode off");
  assert.ok(state.json().batches.some((batch: { id: string }) => batch.id === "mode-off-receipt"));

  const list = await app.inject({ method: "GET", url: `/api/game/${chat.id}/memory/entities` });
  assert.equal(list.statusCode, 200, "GET /memory/entities serves with mode off");
  assert.equal(list.json().total, 1);
  assert.deepEqual(list.json().items.map((item: { entityId: string }) => item.entityId), ["mode-off-robert"]);

  const detail = await app.inject({ method: "GET", url: `/api/game/${chat.id}/memory/entities/mode-off-robert` });
  assert.equal(detail.statusCode, 200, "GET /memory/entities/:id serves with mode off");
  assert.equal(detail.json().entity.entityId, "mode-off-robert");
  assert.equal(detail.json().facts.total, 1);
  assert.equal(detail.json().facts.items[0].factId, fact.factId);
  assert.equal(detail.json().facts.items[0].status, "verified");
  assert.ok(detail.json().sourceChecks[fact.factId], "source checks are still computed with mode off");

  const missing = await app.inject({ method: "GET", url: `/api/game/${chat.id}/memory/entities/absent` });
  assert.equal(missing.statusCode, 404, "unknown entities still 404 rather than being masked by mode off");
  console.log("game-continuity-mode-off-reads regression passed");
} finally {
  if (app) await app.close();
  rmSync(dataDir, { recursive: true, force: true });
}
