import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = mkdtempSync(join(tmpdir(), "marinara-isolated-presence-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
  const { readSceneTimeline } = await import("../../packages/server/src/services/game/scene-timeline.service.js");
  const { sceneTurnHash } = await import("../../packages/server/src/services/game/scene-timeline-model.js");
  const { resolveIsolatedPresentActorIds } = await import("../../packages/server/src/services/game/isolated-game-presence.js");
  const { messages } = await import("../../packages/server/src/db/schema/index.js");
  const { eq } = await import("../../packages/server/src/db/file-query.js");

  const db = await createFileNativeDB();
  const chats = createChatsStorage(db);
  const chat = await chats.create({ name: "isolated fixture", mode: "game", characterIds: [] });
  assert(chat);
  const messageIds = await chats.createMessagesBatch(chat.id, [
    { role: "user", content: "Dorian enters the observatory." },
    { role: "assistant", content: "Dorian is here beside the telescope." },
    { role: "user", content: "Dorian leaves the observatory." },
    { role: "assistant", content: "Dorian leaves now." },
  ]);

  let hash = sceneTurnHash("scene-timeline-v3", JSON.stringify([]));
  const rows = await chats.listMessages(chat.id);
  for (const message of rows) {
    hash = sceneTurnHash(hash, `${message.id}:${message.activeSwipeIndex}:${message.role}: ${message.content}`);
  }
  const entered = {
    hash: "placeholder",
    visits: [
      {
        location: "Observatory",
        present: ["Dorian"],
        participants: ["Dorian"],
        presenceEvidence: [{ name: "Dorian", quote: "Dorian is here beside the telescope." }],
        departures: [],
        facts: [],
      },
    ],
  };
  const departed = {
    hash: "placeholder",
    visits: [
      {
        location: "Observatory",
        present: [],
        participants: ["Dorian"],
        presenceEvidence: [],
        departures: [{ name: "Dorian", quote: "Dorian leaves now." }],
        facts: [],
      },
    ],
  };
  let cursor = sceneTurnHash("scene-timeline-v3", JSON.stringify([]));
  for (const message of rows) {
    cursor = sceneTurnHash(cursor, `${message.id}:${message.activeSwipeIndex}:${message.role}: ${message.content}`);
    if (message.id === messageIds[1]) entered.hash = cursor;
    if (message.id === messageIds[3]) departed.hash = cursor;
  }
  assert.equal(cursor, hash);
  await db.update(messages).set({ extra: JSON.stringify({ gameSceneTimeline: entered }) }).where(eq(messages.id, messageIds[1]!));
  await db.update(messages).set({ extra: JSON.stringify({ gameSceneTimeline: departed }) }).where(eq(messages.id, messageIds[3]!));

  const currentOnly = await readSceneTimeline(db, chat.id, { allowedMessageIds: new Set(messageIds.slice(0, 2)) });
  assert.equal(currentOnly.remaining, 0);
  assert.deepEqual(currentOnly.scenes.at(-1)?.present, ["Dorian"]);
  const withDeparture = await readSceneTimeline(db, chat.id, { allowedMessageIds: new Set(messageIds) });
  assert.equal(withDeparture.remaining, 0);
  assert.deepEqual(withDeparture.scenes.at(-1)?.present, []);
  assert.deepEqual(
    [...resolveIsolatedPresentActorIds({
      snapshotIds: [],
      sceneNames: currentOnly.scenes.at(-1)?.present.length ? currentOnly.scenes.at(-1)!.present : ["Dorian"],
      npcs: [{ id: "npc-dorian", characterId: "char-dorian", name: "Dorian" }],
      characters: [],
    })],
    ["char-dorian"],
  );

  await db.update(messages).set({ activeSwipeIndex: 1 }).where(eq(messages.id, messageIds[1]!));
  const staleSwipe = await readSceneTimeline(db, chat.id, { allowedMessageIds: new Set(messageIds.slice(0, 2)) });
  assert.equal(staleSwipe.remaining, 1, "changing the active swipe invalidates the stored timeline hash");
  await db._fileStore.close();
  console.info("Isolated presence boundary regression passed.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
