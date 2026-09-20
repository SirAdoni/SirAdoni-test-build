// Regression: starting a new Game session must not carry the previous session's continuity backfill
// manifests (they name receipts and messages of the old chat) or its activation boundary (a message id
// of the old chat). Only the continuity settings travel, and an enabled mode gets a fresh activation time.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "../../packages/server/node_modules/fastify/fastify.js";

// Isolated store: the runner does not set DATA_DIR, so every regression must, before the DB module loads.
const dataDir = mkdtempSync(join(tmpdir(), "marinara-session-start-continuity-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
const { gameRoutes } = await import("../../packages/server/src/routes/game.routes.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const db = await getDB();
const chats = createChatsStorage(db);
const app = Fastify();
app.decorate("db", db);
await app.register(gameRoutes, { prefix: "/api/game" });

const readMetadata = async (chatId: string): Promise<Record<string, unknown>> => {
  const chat = await chats.getById(chatId);
  assert.ok(chat, "chat should exist");
  const raw = (chat as { metadata?: unknown }).metadata;
  return typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : ((raw as Record<string, unknown>) ?? {});
};

try {
  const gameId = `continuity-session-${Date.now()}`;
  const previous = await chats.create({ name: "Continuity Game — Session 1", mode: "game", characterIds: [], groupId: gameId } as Parameters<
    typeof chats.create
  >[0]);
  assert.ok(previous);
  const boundary = await chats.createMessage({ chatId: previous.id, role: "assistant", characterId: null, content: "Opening." } as Parameters<
    typeof chats.createMessage
  >[0]);
  assert.ok(boundary);
  const startedAt = new Date().toISOString();
  await chats.patchMetadata(previous.id, () => ({
    gameSessionStatus: "concluded",
    gameSessionNumber: 1,
    gameContinuity: {
      mode: "shadow",
      extractorConnectionId: "conn-extract",
      verifierConnectionId: "conn-verify",
      extractionInstructions: "Keep terms.",
      activationAt: "2026-01-01T00:00:00.000Z",
      activationMessageId: boundary.id,
    },
    gameContinuityBackfills: [
      { id: "historical-continuity-old", fromMessageId: boundary.id, toMessageId: boundary.id, sessionNumber: 1, receiptIds: ["gch_old"] },
    ],
  }));

  const started = await app.inject({ method: "POST", url: "/api/game/session/start", payload: { gameId } });
  assert.equal(started.statusCode, 200, `session start should succeed: ${started.statusCode} ${started.body}`);
  const sessionChatId = started.json().sessionChat.id as string;
  assert.notEqual(sessionChatId, previous.id);

  const carried = await readMetadata(sessionChatId);
  assert.equal(carried.gameContinuityBackfills, undefined, "backfill manifests of the previous session must not travel");
  const continuity = carried.gameContinuity as Record<string, unknown>;
  assert.ok(continuity, "continuity settings travel to the new session");
  assert.equal(continuity.mode, "shadow");
  assert.equal(continuity.extractorConnectionId, "conn-extract");
  assert.equal(continuity.verifierConnectionId, "conn-verify");
  assert.equal(continuity.extractionInstructions, "Keep terms.");
  assert.equal(continuity.activationMessageId, undefined, "the previous session's boundary message id must not travel");
  assert.equal(typeof continuity.activationAt, "string");
  assert.ok(String(continuity.activationAt) >= startedAt, "an enabled mode gets a fresh activation time for the new session");

  const previousMeta = await readMetadata(previous.id);
  assert.equal((previousMeta.gameContinuityBackfills as unknown[]).length, 1, "the previous session keeps its own manifests");
  assert.equal((previousMeta.gameContinuity as Record<string, unknown>).activationMessageId, boundary.id);

  // A disabled continuity block still travels as plain settings without inventing an activation time.
  const gameIdOff = `continuity-off-${Date.now()}`;
  const previousOff = await chats.create({ name: "Continuity Off — Session 1", mode: "game", characterIds: [], groupId: gameIdOff } as Parameters<
    typeof chats.create
  >[0]);
  assert.ok(previousOff);
  await chats.patchMetadata(previousOff.id, () => ({
    gameSessionStatus: "concluded",
    gameSessionNumber: 1,
    gameContinuity: { mode: "off", extractorConnectionId: "conn-extract" },
  }));
  const startedOff = await app.inject({ method: "POST", url: "/api/game/session/start", payload: { gameId: gameIdOff } });
  assert.equal(startedOff.statusCode, 200, startedOff.body);
  const carriedOff = (await readMetadata(startedOff.json().sessionChat.id as string)).gameContinuity as Record<string, unknown>;
  assert.deepEqual(carriedOff, { mode: "off", extractorConnectionId: "conn-extract" });

  console.log("game-session-start-continuity regression passed");
} finally {
  await app.close();
  await closeDB();
  rmSync(dataDir, { recursive: true, force: true });
}
