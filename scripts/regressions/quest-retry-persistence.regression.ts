import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileNativeDB } from "../../packages/server/src/db/file-backed-store.js";
import { eq } from "../../packages/server/src/db/file-query.js";
import { chats, gameStateSnapshots } from "../../packages/server/src/db/schema/index.js";
import { createChatsStorage } from "../../packages/server/src/services/storage/chats.storage.js";
import { persistRetryQuestUpdate } from "../../packages/server/src/services/game/quest-retry-persistence.js";

const fixtureDir = mkdtempSync(join(tmpdir(), "marinara-quest-retry-persistence-"));
const previousDataDir = process.env.DATA_DIR;
const previousFileStorageDir = process.env.FILE_STORAGE_DIR;
let failChatTableWrites = false;
const parseMetadata = (value: unknown): { gameJournal?: { quests?: Array<{ id: string }> } } =>
  typeof value === "string"
    ? JSON.parse(value)
    : ((value ?? {}) as { gameJournal?: { quests?: Array<{ id: string }> } });

process.env.DATA_DIR = fixtureDir;
process.env.FILE_STORAGE_DIR = join(fixtureDir, "storage");

try {
  const db = await createFileNativeDB({
    beforeTableWrite: (table) => {
      if (failChatTableWrites && table.startsWith("chats")) {
        failChatTableWrites = false;
        throw new Error("injected journal write failure");
      }
    },
  });
  const chatsStore = createChatsStorage(db);
  const chat = await chatsStore.create({ name: "Retry quest persistence", mode: "game", characterIds: [] });
  assert.ok(chat);
  const foreignChat = await chatsStore.create({ name: "Foreign retry quest", mode: "game", characterIds: [] });
  assert.ok(foreignChat);
  await chatsStore.patchMetadata(chat.id, {
    gameJournal: { entries: [], quests: [], locations: [], npcLog: [], inventoryLog: [] },
  });

  const stamp = new Date().toISOString();
  await db.insert(gameStateSnapshots).values({
    id: "retry-state",
    chatId: chat.id,
    messageId: "retry-message",
    swipeIndex: 0,
    playerStats: JSON.stringify({ activeQuests: [{ questEntryId: "retry-quest", name: "Retry Quest" }] }),
    presentCharacters: "[]",
    committed: 1,
    createdAt: stamp,
  });

  const completedStats = { activeQuests: [] };
  const complete = { action: "complete" as const, questName: "retry-quest", objectives: [] };
  await assert.rejects(
    persistRetryQuestUpdate(db, chat.id, "missing-state", completedStats, [complete]),
    /RETRY_QUEST_SNAPSHOT_NOT_FOUND/,
  );
  await assert.rejects(
    persistRetryQuestUpdate(db, foreignChat.id, "retry-state", completedStats, [complete]),
    /RETRY_QUEST_SNAPSHOT_NOT_FOUND/,
  );
  const foreignMetadata = await chatsStore.getById(foreignChat.id);
  assert.deepEqual(parseMetadata(foreignMetadata?.metadata).gameJournal?.quests, undefined);
  failChatTableWrites = true;
  await assert.rejects(persistRetryQuestUpdate(db, chat.id, "retry-state", completedStats, [complete]));
  failChatTableWrites = false;

  const rolledBackState = (
    await db.select().from(gameStateSnapshots).where(eq(gameStateSnapshots.id, "retry-state"))
  )[0];
  assert.match(String(rolledBackState?.playerStats), /retry-quest/);
  const rolledBackChat = await chatsStore.getById(chat.id);
  assert.deepEqual(parseMetadata(rolledBackChat?.metadata).gameJournal?.quests, []);

  await persistRetryQuestUpdate(db, chat.id, "retry-state", completedStats, [complete]);
  await persistRetryQuestUpdate(db, chat.id, "retry-state", completedStats, [complete]);
  const committedState = (
    await db.select().from(gameStateSnapshots).where(eq(gameStateSnapshots.id, "retry-state"))
  )[0];
  assert.equal(committedState?.playerStats, JSON.stringify(completedStats));
  const committedChat = await chatsStore.getById(chat.id);
  const quests = parseMetadata(committedChat?.metadata).gameJournal?.quests ?? [];
  assert.deepEqual(
    quests.map((quest) => quest.id),
    ["retry-quest"],
  );
  await db._fileStore.close();
  console.info("Quest retry persistence regression passed");
} finally {
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  if (previousFileStorageDir === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousFileStorageDir;
  rmSync(fixtureDir, { recursive: true, force: true });
}
