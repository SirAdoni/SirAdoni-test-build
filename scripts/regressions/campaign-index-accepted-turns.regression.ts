import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "marinara-campaign-index-accepted-"));
process.env.DATA_DIR = directory;
process.env.FILE_STORAGE_DIR = join(directory, "storage");
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.MARINARA_LITE = "true";

const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { gameStateSnapshots } = await import("../../packages/server/src/db/schema/index.js");
const { readContinuityInventory } = await import("../../packages/server/src/routes/game-continuity-backfill.routes.js");
const { coverage } = await import("../../packages/server/src/routes/campaign-index.routes.js");
const db = await getDB();

try {
  const chats = createChatsStorage(db);
  const chat = await chats.create({ name: "Accepted turns", mode: "game", characterIds: [] });
  assert.ok(chat);
  await chats.patchMetadata(chat.id, { gameContinuity: { mode: "off" } });
  await chats.createMessagesBatch(chat.id, [
    {
      role: "assistant",
      characterId: null,
      content: "Current swipe is uncommitted.",
      activeSwipeIndex: 0,
      swipes: [
        { index: 0, content: "Current swipe is uncommitted." },
        { index: 1, content: "Other swipe was committed." },
      ],
    },
    { role: "user", characterId: null, content: "Follow-up." },
    { role: "assistant", characterId: null, content: "Accepted by reply." },
    { role: "user", characterId: null, content: "Next turn." },
    { role: "assistant", characterId: null, content: "Recap source.", extra: { continuitySource: "recap" } },
    { role: "user", characterId: null, content: "End." },
    { role: "assistant", characterId: null, content: "Committed final assistant." },
  ]);
  const messages = await chats.listMessages(chat.id);
  const [selectedSwipe, , repliedAssistant, , recapAssistant, , finalAssistant] = messages;
  await db.insert(gameStateSnapshots).values([
    {
      id: "accepted-final-committed",
      chatId: chat.id,
      messageId: finalAssistant!.id,
      swipeIndex: 0,
      committed: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "selected-swipe-uncommitted",
      chatId: chat.id,
      messageId: selectedSwipe!.id,
      swipeIndex: 0,
      committed: 0,
      createdAt: "2026-01-01T00:00:01.000Z",
    },
    {
      id: "other-swipe-committed",
      chatId: chat.id,
      messageId: selectedSwipe!.id,
      swipeIndex: 1,
      committed: 1,
      createdAt: "2026-01-01T00:00:02.000Z",
    },
    {
      id: "recap-committed",
      chatId: chat.id,
      messageId: recapAssistant!.id,
      swipeIndex: 0,
      committed: 1,
      createdAt: "2026-01-01T00:00:03.000Z",
    },
  ]);

  const app = { db, gameContinuity: { list: async () => [] } } as never;
  const inventory = await readContinuityInventory(app, chat.id, { includePreparedSources: true });
  assert.ok(inventory);
  assert.deepEqual(
    inventory.acceptedAssistantIds,
    [repliedAssistant!.id, finalAssistant!.id],
    "historical inventory accepts a committed final turn and a snapshot-free turn followed by a user, using only the selected swipe and prepared non-recap sources",
  );
  const uncovered = coverage(inventory as never, []);
  assert.equal(
    uncovered.range?.toMessageId,
    finalAssistant!.id,
    "the final committed turn remains indexable without a trailing user",
  );
  assert.equal(uncovered.estimatedTurns, 2, "only accepted, prepared turns close historical batches");
  const publicInventory = await readContinuityInventory(app, chat.id);
  assert.equal(publicInventory?.acceptedAssistantIds, undefined, "internal accepted IDs are opt-in");
  console.info("Campaign index accepted turns regression passed.");
} finally {
  await closeDB();
  rmSync(directory, { recursive: true, force: true });
}
