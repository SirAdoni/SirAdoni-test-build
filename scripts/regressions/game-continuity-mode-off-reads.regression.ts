import assert from "node:assert/strict";
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
  const { createGameContinuityStorage } =
    await import("../../packages/server/src/services/storage/game-continuity.storage.js");
  const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
  app = await buildApp();
  await app.ready();
  const { applyFeatureSettingsValue } = await import("../../packages/server/src/services/features/feature-settings.js");
  applyFeatureSettingsValue(JSON.stringify({ gameContinuity: true }));
  const db = await getDB();
  const chatsStorage = createChatsStorage(db);

  const created = await app.inject({
    method: "POST",
    url: "/api/chats",
    payload: { name: "Mode off reads", mode: "game", characterIds: [] },
  });
  assert.equal(created.statusCode, 200);
  const chat = created.json();
  const message = await app.inject({
    method: "POST",
    url: `/api/chats/${chat.id}/messages`,
    payload: { role: "assistant", content: "Edmund promises to return before dawn." },
  });
  assert.equal(message.statusCode, 200);
  const messageId = message.json().id;

  // Preserve the original extracting receipt fixture; per-chat mode remains off.
  const now = new Date().toISOString();
  await createGameContinuityStorage(db).enqueue({
    id: "mode-off-receipt",
    chatId: chat.id,
    sessionNumber: 1,
    sourceHash: "source-hash",
    sources: [
      {
        messageId,
        swipeIndex: 0,
        hash: "message-hash",
        role: "assistant",
        content: "Edmund promises to return before dawn.",
      },
    ],
    context: [],
    configHash: "config-hash",
    config: {},
    status: "extracting",
    attempts: 1,
    repairAttempts: 0,
    records: [],
    dispositions: [],
    review: null,
    entryIds: [],
    createdAt: now,
    updatedAt: now,
  });
  await chatsStorage.updateMetadata(chat.id, { gameContinuity: { mode: "off" } });
  const stored = await chatsStorage.getById(chat.id);
  const metadata = typeof stored!.metadata === "string" ? JSON.parse(stored!.metadata) : stored!.metadata;
  assert.equal(metadata.gameContinuity.mode, "off");

  const state = await app.inject({ method: "GET", url: `/api/game/${chat.id}/continuity` });
  assert.equal(state.statusCode, 200, "GET /continuity serves with mode off");
  assert.equal(state.json().config.mode, "off");
  assert.deepEqual(state.json().counts, { extracting: 1 }, "receipts are still reported with mode off");
  assert.ok(state.json().batches.some((batch: { id: string }) => batch.id === "mode-off-receipt"));

  applyFeatureSettingsValue(null);
  const disabled = await app.inject({ method: "GET", url: `/api/game/${chat.id}/continuity` });
  assert.equal(disabled.statusCode, 403, "global opt-out denies continuity status reads");
  assert.equal((await createGameContinuityStorage(db).get("mode-off-receipt"))?.id, "mode-off-receipt");

  console.log("game-continuity-mode-off-reads regression passed");
} finally {
  if (app) await app.close();
  rmSync(dataDir, { recursive: true, force: true });
}
