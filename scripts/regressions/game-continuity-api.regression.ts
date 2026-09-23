import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-game-continuity-api-"));
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
  const db = await getDB();
  const continuityStorage = createGameContinuityStorage(db);
  const chatsStorage = createChatsStorage(db);

  const createGame = async (name: string) => {
    const response = await app!.inject({
      method: "POST",
      url: "/api/chats",
      payload: { name, mode: "game", characterIds: [] },
    });
    assert.equal(response.statusCode, 200);
    return response.json();
  };
  const addMessage = async (chatId: string, role: "user" | "assistant", content: string) => {
    const response = await app!.inject({
      method: "POST",
      url: `/api/chats/${chatId}/messages`,
      payload: { role, content },
    });
    assert.equal(response.statusCode, 200);
    return response.json();
  };

  const chat = await createGame("Continuity API contract");
  const before = await app.inject({ method: "GET", url: `/api/game/${chat.id}/continuity` });
  assert.equal(before.statusCode, 200);
  assert.equal(before.json().config.mode, "off");
  assert.deepEqual(before.json().counts, {});

  await addMessage(chat.id, "user", "We enter the old hall.");
  const assistant = await addMessage(chat.id, "assistant", "Edmund promises to return before dawn.");
  await chatsStorage.updateMetadata(chat.id, { gameLorebookKeeperEnabled: true });

  const enabled = await app.inject({
    method: "PATCH",
    url: `/api/game/${chat.id}/continuity`,
    payload: { mode: "shadow", extractionInstructions: "extract only durable facts" },
  });
  assert.equal(enabled.statusCode, 200);
  const enabledBody = enabled.json();
  assert.equal(enabledBody.config.mode, "shadow");
  assert.equal(enabledBody.config.activationMessageId, assistant.id);
  assert.equal(typeof enabledBody.config.activationAt, "string");
  const activationAt = enabledBody.config.activationAt;
  const malicious = await app.inject({
    method: "PATCH",
    url: `/api/game/${chat.id}/continuity`,
    payload: { activationAt: "1970-01-01T00:00:00.000Z" },
  });
  assert.equal(malicious.statusCode, 400);

  const changed = await app.inject({
    method: "PATCH",
    url: `/api/game/${chat.id}/continuity`,
    payload: { mode: "active", extractorConnectionId: "conn-x", verifierConnectionId: "conn-y" },
  });
  assert.equal(changed.statusCode, 200);
  assert.equal(changed.json().config.activationAt, activationAt);
  assert.equal(changed.json().config.activationMessageId, assistant.id);
  const cleared = await app.inject({
    method: "PATCH",
    url: `/api/game/${chat.id}/continuity`,
    payload: {
      mode: "active",
      extractorConnectionId: null,
      verifierConnectionId: null,
      extractionInstructions: null,
      verificationInstructions: null,
    },
  });
  assert.equal(cleared.statusCode, 200);
  assert.equal(cleared.json().config.extractorConnectionId, undefined);
  assert.equal(cleared.json().config.verificationInstructions, undefined);
  assert.equal(cleared.json().config.activationAt, activationAt);
  const chatAfter = cleared.json().chat;
  const chatMetadata = typeof chatAfter.metadata === "string" ? JSON.parse(chatAfter.metadata) : chatAfter.metadata;
  assert.equal(chatMetadata.gameLorebookKeeperEnabled, true);

  const missing = await app.inject({ method: "GET", url: `/api/game/${chat.id}/continuity/missing-batch` });
  assert.equal(missing.statusCode, 404);
  const foreignChat = await createGame("Foreign continuity chat");
  const foreign = await app.inject({ method: "GET", url: `/api/game/${foreignChat.id}/continuity/${chat.id}` });
  assert.equal(foreign.statusCode, 404);

  const now = new Date().toISOString();
  await continuityStorage.enqueue({
    id: "continuity-running-proof",
    chatId: chat.id,
    sessionNumber: 1,
    sourceHash: "source-hash",
    sources: [
      { messageId: assistant.id, swipeIndex: 0, hash: "message-hash", role: "assistant", content: assistant.content },
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
  const runningRetry = await app.inject({
    method: "POST",
    url: `/api/game/${chat.id}/continuity/retry`,
    payload: { batchId: "continuity-running-proof" },
  });
  assert.equal(runningRetry.statusCode, 409);

  // Summary refresh descriptors (including a background conflict) and the verified watermark are exposed.
  const conflictDescriptor = {
    version: 1,
    sessionNumber: 1,
    sourceRange: { startMessageId: null, endMessageId: null, messages: [], sourceHash: "source" },
    expectedSummaryHash: "summary",
    dependencies: { continuityRequired: true, continuityReceiptIds: [], sceneTimelineHash: null },
    status: "conflict",
    reason: "summary_changed",
    attempts: 1,
    maxAttempts: 3,
    updatedAt: now,
  };
  await chatsStorage.updateMetadata(chat.id, { gameSessionSummaryRefreshes: { "1": conflictDescriptor } });
  const withRefreshes = await app.inject({ method: "GET", url: `/api/game/${chat.id}/continuity` });
  assert.equal(withRefreshes.statusCode, 200);
  const refreshBody = withRefreshes.json();
  assert.deepEqual(
    refreshBody.summaryRefreshes.map((item: Record<string, unknown>) => [item.sessionNumber, item.status, item.reason]),
    [[1, "conflict", "summary_changed"]],
  );
  assert.equal(refreshBody.summaryRefreshes[0].updatedAt, now);
  assert.equal(refreshBody.verifiedThroughMessageId, null);
  assert.ok(refreshBody.gaps.some((gap: Record<string, unknown>) => gap.batchId === "continuity-running-proof"));
} finally {
  if (app) await app.close();
  rmSync(dataDir, { recursive: true, force: true });
}
