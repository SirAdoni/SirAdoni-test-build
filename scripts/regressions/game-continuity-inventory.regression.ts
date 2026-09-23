import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// GET /game/:chatId/continuity/inventory: message counts by role, prepared vs
// excluded sources with reasons, and every backfill manifest reported frozen
// (rangeHash + manifestHash) with receipt counts and coverage gaps.
const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify");
const root = mkdtempSync(join(tmpdir(), "marinara-continuity-inventory-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";

const chatId = "inventory-chat";
const backfillId = "historical-continuity-inventory";
const receiptId = "gch_inventory_receipt";

let app: any = null;
try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { chats, messages } = await import("../../packages/server/src/db/schema/index.js");
  const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
  const { createGameContinuityStorage } =
    await import("../../packages/server/src/services/storage/game-continuity.storage.js");
  const { gameContinuityBackfillRoutes } =
    await import("../../packages/server/src/routes/game-continuity-backfill.routes.js");

  const db = await createFileNativeDB();
  const at = (seconds: number) => new Date(Date.UTC(2026, 8, 12, 0, 0, seconds)).toISOString();
  const manifest = {
    id: backfillId,
    fromMessageId: "inv-u1",
    toMessageId: "inv-a2",
    receiptIds: [receiptId, "gch_ghost"],
    sessionNumber: 2,
  };
  const brokenManifest = {
    id: "historical-continuity-broken",
    fromMessageId: "inv-missing",
    toMessageId: "inv-a2",
    receiptIds: [],
    sessionNumber: 2,
  };
  await db.insert(chats).values({
    id: chatId,
    name: "Inventory",
    mode: "game",
    metadata: JSON.stringify({ gameContinuity: { mode: "off" }, gameContinuityBackfills: [manifest, brokenManifest] }),
    createdAt: at(0),
    updatedAt: at(0),
  });
  await db.insert(messages).values([
    { id: "inv-u1", chatId, role: "user", content: "Alice opens the gate.", createdAt: at(1) },
    { id: "inv-a1", chatId, role: "assistant", content: "The gate opens.", createdAt: at(2) },
    { id: "inv-system", chatId, role: "system", content: "System note.", createdAt: at(3) },
    {
      id: "inv-hidden",
      chatId,
      role: "assistant",
      content: "Hidden recap.",
      extra: JSON.stringify({ hiddenFromAI: true }),
      createdAt: at(4),
    },
    {
      id: "inv-derived",
      chatId,
      role: "assistant",
      content: "Derived text.",
      extra: JSON.stringify({ continuitySource: "derived_recap" }),
      createdAt: at(5),
    },
    { id: "inv-empty", chatId, role: "user", content: "", createdAt: at(6) },
    { id: "inv-conclusion", chatId, role: "assistant", content: "**Session 1 Concluded**\nRest.", createdAt: at(7) },
    { id: "inv-u2", chatId, role: "user", content: "Alice enters.", createdAt: at(8) },
    { id: "inv-a2", chatId, role: "assistant", content: "Alice is inside.", createdAt: at(9) },
  ]);

  const storage = createGameContinuityStorage(db);
  await storage.enqueue({
    id: receiptId,
    chatId,
    sessionNumber: 2,
    sourceHash: "inventory-source-hash",
    sources: [
      { messageId: "inv-u1", swipeIndex: 0, hash: "h1", role: "user", content: "Alice opens the gate." },
      { messageId: "inv-a1", swipeIndex: 0, hash: "h2", role: "assistant", content: "The gate opens." },
    ],
    context: [],
    configHash: "config-hash",
    config: { historicalBackfill: { id: backfillId, fromMessageId: "inv-u1", toMessageId: "inv-a2", sessionNumber: 2 } },
    status: "failed",
    attempts: 3,
    repairAttempts: 0,
    records: [],
    dispositions: [],
    review: null,
    entryIds: [],
    errorCode: "CONTINUITY_TIMEOUT",
    error: "CONTINUITY_TIMEOUT",
    createdAt: at(10),
    updatedAt: at(10),
  });

  // Stubbed runtime: the inventory route only reads receipts, so nothing is processed.
  app = Fastify();
  app.decorate("db", db);
  app.decorate("gameContinuity", { list: (id?: string) => storage.list(id) });
  await app.register(gameContinuityBackfillRoutes, { prefix: "/api/game" });

  const missing = await app.inject({ method: "GET", url: "/api/game/no-such-chat/continuity/inventory" });
  assert.equal(missing.statusCode, 404);

  const response = await app.inject({ method: "GET", url: `/api/game/${chatId}/continuity/inventory` });
  assert.equal(response.statusCode, 200, response.body);
  const inventory = response.json();
  assert.equal(inventory.chatId, chatId);
  assert.deepEqual(inventory.messageCounts, { user: 3, assistant: 5, system: 1 });
  assert.deepEqual(
    inventory.prepared.map((source: { messageId: string }) => source.messageId),
    ["inv-u1", "inv-a1", "inv-u2", "inv-a2"],
  );
  const reasons = Object.fromEntries(
    inventory.excluded.map((item: { messageId: string; reason: string }) => [item.messageId, item.reason]),
  );
  assert.deepEqual(reasons, {
    "inv-system": "system_role",
    "inv-hidden": "hidden_from_ai",
    "inv-derived": "derived_source",
    "inv-empty": "empty_content",
    "inv-conclusion": "session_conclusion",
  });
  assert.deepEqual(inventory.receiptCounts, { failed: 1 });

  assert.equal(inventory.manifests.length, 2);
  const [frozen, broken] = inventory.manifests;
  assert.equal(frozen.id, backfillId);
  assert.equal(frozen.rangeValid, true);
  assert.equal(frozen.sessionNumber, 2);
  assert.deepEqual(frozen.receiptIds, [receiptId, "gch_ghost"]);
  assert.deepEqual(frozen.missingReceiptIds, ["gch_ghost"]);
  assert.deepEqual(frozen.countsByStatus, { failed: 1 });
  assert.deepEqual(frozen.countsByErrorCode, { CONTINUITY_TIMEOUT: 1 });
  assert.equal(frozen.preparedInRange, 4);
  assert.deepEqual(frozen.coverageGaps, ["inv-u2", "inv-a2"], "prepared messages in range without any receipt");
  assert.equal(
    frozen.rangeHash,
    createHash("sha256").update(`${chatId}\0inv-u1\0inv-a2`).digest("hex"),
    "rangeHash is a stable digest of chat + range",
  );
  assert.match(frozen.manifestHash, /^[0-9a-f]{64}$/u);
  assert.equal(broken.rangeValid, false);
  assert.deepEqual(broken.coverageGaps, []);
  assert.equal(broken.preparedInRange, 0);

  // Frozen proof: an identical manifest hashes identically; a rewritten receipt list changes
  // manifestHash while rangeHash stays put, so a later diff can prove the range was not rewritten.
  const again = (await app.inject({ method: "GET", url: `/api/game/${chatId}/continuity/inventory` })).json();
  assert.equal(again.manifests[0].manifestHash, frozen.manifestHash);
  assert.equal(again.manifests[0].rangeHash, frozen.rangeHash);
  await createChatsStorage(db).patchMetadata(chatId, () => ({
    gameContinuityBackfills: [{ ...manifest, receiptIds: [...manifest.receiptIds, "gch_extra"] }, brokenManifest],
  }));
  const rewritten = (await app.inject({ method: "GET", url: `/api/game/${chatId}/continuity/inventory` })).json();
  assert.notEqual(rewritten.manifests[0].manifestHash, frozen.manifestHash);
  assert.equal(rewritten.manifests[0].rangeHash, frozen.rangeHash);

  await app.close();
  app = null;
  console.log("game continuity inventory regression passed");
} finally {
  if (app) await app.close().catch(() => {});
  rmSync(root, { recursive: true, force: true });
}
