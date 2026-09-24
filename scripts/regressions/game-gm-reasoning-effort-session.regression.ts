// Regression: the per-game GM reasoning effort (chat metadata gameGmReasoningEffort) is a game setting, so starting
// the next session of the same game carries it into the new session chat.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "../../packages/server/node_modules/fastify/fastify.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-gm-effort-session-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.LOG_DIR = join(dataDir, "logs");
const { gameRoutes } = await import("../../packages/server/src/routes/game.routes.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { isEngineOwnedMetadataKeyPrefix } = await import("../../packages/shared/src/index.js").then((shared) => ({
  isEngineOwnedMetadataKeyPrefix: (key: string) =>
    shared.ENGINE_OWNED_METADATA_KEY_PREFIXES.some(
      (owned) => key === owned || (key.startsWith(owned) && /^[A-Z]/.test(key.charAt(owned.length))),
    ),
}));
const db = await getDB();
const chats = createChatsStorage(db);
const app = Fastify();
app.decorate("db", db);
await app.register(gameRoutes, { prefix: "/api/game" });

const readMetadata = async (chatId: string): Promise<Record<string, unknown>> => {
  const chat = await chats.getById(chatId);
  assert.ok(chat, "chat should exist");
  const raw = (chat as { metadata?: unknown }).metadata;
  return typeof raw === "string"
    ? (JSON.parse(raw) as Record<string, unknown>)
    : ((raw as Record<string, unknown>) ?? {});
};

try {
  // Capability packages cannot claim the key: it sits under the engine-owned "game" namespace.
  assert.ok(isEngineOwnedMetadataKeyPrefix("gameGmReasoningEffort"));

  const gameId = `gm-effort-session-${Date.now()}`;
  const previous = await chats.create({
    name: "Effort Game, Session 1",
    mode: "game",
    characterIds: [],
    groupId: gameId,
  } as Parameters<typeof chats.create>[0]);
  assert.ok(previous);
  await chats.createMessage({
    chatId: previous.id,
    role: "assistant",
    characterId: null,
    content: "Opening.",
  } as Parameters<typeof chats.createMessage>[0]);
  await chats.patchMetadata(previous.id, () => ({
    gameSessionStatus: "concluded",
    gameSessionNumber: 1,
    gameGmReasoningEffort: "medium",
  }));

  const started = await app.inject({ method: "POST", url: "/api/game/session/start", payload: { gameId } });
  assert.equal(started.statusCode, 200, `session start should succeed: ${started.statusCode} ${started.body}`);
  const sessionChatId = started.json().sessionChat.id as string;
  assert.notEqual(sessionChatId, previous.id);
  const carried = await readMetadata(sessionChatId);
  assert.equal(carried.gameGmReasoningEffort, "medium", "the GM reasoning effort carries to the new session");

  console.log("game GM reasoning effort session regression passed");
} finally {
  await app.close();
  await closeDB();
  rmSync(dataDir, { recursive: true, force: true });
}
