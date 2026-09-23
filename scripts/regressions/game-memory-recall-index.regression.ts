import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "../../packages/server/src/db/file-query.js";
import { createFileNativeDB } from "../../packages/server/src/db/file-backed-store.js";
import { chats, memoryChunks, messages } from "../../packages/server/src/db/schema/index.js";
import {
  GAME_MEMORY_TRANSCRIPT_PREFIX,
  chunkAndEmbedMessages,
  recallMemories,
} from "../../packages/server/src/services/memory-recall.js";

const dir = mkdtempSync(join(tmpdir(), "marinara-game-memory-recall-"));
process.env.FILE_STORAGE_DIR = dir;
const db = await createFileNativeDB();
const embeddingSource = {
  spaceId: "test:game-memory:plain-v1",
  label: "deterministic regression embeddings",
  async embed(texts: string[]) {
    return texts.map(() => [1, 0]);
  },
};

try {
  await db.insert(chats).values({ id: "game-memory", name: "Game Memory", mode: "game" });
  await db.insert(chats).values({ id: "conversation-memory", name: "Conversation Memory", mode: "conversation" });
  await db.insert(chats).values({ id: "conversation-label", name: "Conversation Labels", mode: "conversation" });

  const longScene = `Quenby remains in the archive hall. ${"The old shelves hold a clue. ".repeat(900)}`;
  for (let index = 0; index < 6; index += 1) {
    await db.insert(messages).values({
      id: `game-message-${index}`,
      chatId: "game-memory",
      role: index % 2 === 0 ? "user" : "assistant",
      characterId: index % 2 === 0 ? null : "corvina",
      content: index === 1 ? longScene : `Game turn ${index}`,
      createdAt: `2026-09-13T10:00:0${index}.000Z`,
    });
  }

  await chunkAndEmbedMessages(
    db,
    "game-memory",
    { userName: "Edmund", characterNames: { corvina: "Corvina" } },
    { embeddingSource },
  );
  let stored = await db.select().from(memoryChunks).where(eq(memoryChunks.chatId, "game-memory"));
  assert.ok(stored.length >= 2, "the long Game transcript is split into multiple embedded parts");
  assert.ok(
    stored.every((chunk) => chunk.content.startsWith(GAME_MEMORY_TRANSCRIPT_PREFIX)),
    "every split Game embedding part carries the historical transcript marker",
  );
  const initialTranscript = stored.map((chunk) => chunk.content).join("\n");
  assert.match(initialTranscript, /Quenby remains/u, "original VN character names remain inside transcript content");
  assert.doesNotMatch(initialTranscript, /Corvina: Quenby/u, "Game assistant turns use the GM speaker label");
  assert.match(initialTranscript, /Game Master:/u, "Game assistant turns are labeled Game Master");

  const importedId = "imported-game-memory";
  await db.insert(memoryChunks).values({
    id: importedId,
    chatId: "game-memory",
    sourceChatId: "source-campaign",
    content: "Imported historical memory",
    embedding: JSON.stringify([1, 0]),
    embeddingSpaceId: embeddingSource.spaceId,
    messageCount: 1,
    firstMessageAt: "2026-09-12T00:00:00.000Z",
    lastMessageAt: "2026-09-12T00:00:00.000Z",
    createdAt: "2026-09-12T00:00:00.000Z",
  });
  await db.insert(memoryChunks).values({
    id: "legacy-game-memory",
    chatId: "game-memory",
    content: "Legacy unmarked Game memory",
    embedding: JSON.stringify([1, 0]),
    embeddingSpaceId: embeddingSource.spaceId,
    messageCount: 1,
    firstMessageAt: "2026-09-11T00:00:00.000Z",
    lastMessageAt: "2026-09-11T00:00:00.000Z",
    createdAt: "2026-09-11T00:00:00.000Z",
  });
  await chunkAndEmbedMessages(
    db,
    "game-memory",
    { userName: "Edmund", characterNames: { corvina: "Corvina" } },
    { embeddingSource },
  );
  stored = await db.select().from(memoryChunks).where(eq(memoryChunks.chatId, "game-memory"));
  assert.ok(
    stored.some((chunk) => chunk.id === importedId),
    "imported chunks survive native Game index replacement",
  );
  assert.ok(!stored.some((chunk) => chunk.id === "legacy-game-memory"), "legacy native Game chunks are rebuilt");
  assert.ok(
    stored
      .filter((chunk) => !chunk.sourceChatId)
      .every((chunk) => chunk.content.startsWith(GAME_MEMORY_TRANSCRIPT_PREFIX)),
    "rebuilt native Game chunks are marked",
  );

  for (let index = 0; index < 5; index += 1) {
    await db.insert(messages).values({
      id: `conversation-label-message-${index}`,
      chatId: "conversation-label",
      role: index % 2 === 0 ? "user" : "assistant",
      characterId: index % 2 === 0 ? null : "dottore",
      content: `Conversation turn ${index}`,
      createdAt: `2026-09-13T11:00:0${index}.000Z`,
    });
  }
  await chunkAndEmbedMessages(
    db,
    "conversation-label",
    { userName: "Edmund", characterNames: { dottore: "Dottore" } },
    { embeddingSource },
  );
  const conversationLabelChunks = await db
    .select()
    .from(memoryChunks)
    .where(eq(memoryChunks.chatId, "conversation-label"));
  assert.match(
    conversationLabelChunks[0]?.content ?? "",
    /Dottore:/u,
    "non-Game assistant turns retain their card name label",
  );

  const gameRecall = await recallMemories(db, "archive", ["game-memory"], {
    embeddingSource,
    gameMode: true,
    topK: null,
  });
  assert.ok(
    gameRecall.every((memory) => memory.content !== "Legacy unmarked Game memory"),
    "Game recall skips unmarked native chunks",
  );
  assert.ok(
    gameRecall.every((memory) => memory.chunkId),
    "recall results expose chunk IDs",
  );
  assert.ok(
    gameRecall.some((memory) => memory.sourceChatId === "source-campaign"),
    "recall preserves sourceChatId diagnostics",
  );

  for (let index = 0; index < 9; index += 1) {
    await db.insert(memoryChunks).values({
      id: `conversation-memory-${index}`,
      chatId: "conversation-memory",
      content: `Conversation memory ${index}`,
      embedding: JSON.stringify([1, 0]),
      embeddingSpaceId: embeddingSource.spaceId,
      messageCount: 1,
      firstMessageAt: `2026-09-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      lastMessageAt: `2026-09-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      createdAt: `2026-09-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    });
  }
  const defaultRecall = await recallMemories(db, "conversation", ["conversation-memory"], { embeddingSource });
  assert.equal(defaultRecall.length, 8, "default recall remains capped at eight results");
  const uncappedRecall = await recallMemories(db, "conversation", ["conversation-memory"], {
    embeddingSource,
    topK: null,
    excludeFromMessageAt: "2026-09-08T00:00:00.000Z",
  });
  assert.equal(
    uncappedRecall.length,
    7,
    "null topK returns all eligible ranked results while preserving cutoff filtering",
  );
} finally {
  await db._fileStore.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log("Game memory recall index regression checks passed.");
