// Per-game "Scene timeline" switch (chat metadata gameSceneTimelineEnabled; absent = ON).
//  1. ON (absent or true) keeps today's behaviour: the sync route queues the scene review.
//  2. OFF skips the queue (upstream has no scene timeline) and party presence falls back to the tracker
//     snapshot, keeping the whole party when the snapshot names nobody (upstream: no presence filter).
//  3. The post-turn queue, the session recap and isolated-actor presence are gated in the routes.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-switch-scene-timeline-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.on("exit", () => rmSync(dataDir, { recursive: true, force: true }));

const { isGameSceneTimelineEnabled } = await import("../../packages/shared/src/index.js");
const { snapshotPresenceTimeline } = await import("../../packages/server/src/services/game/game-feature-switches.js");
const { selectPresentPartySpeakers } = await import("../../packages/server/src/services/game/party-prompts.js");

assert.equal(isGameSceneTimelineEnabled(undefined), true);
assert.equal(isGameSceneTimelineEnabled({}), true, "absent key is ON");
assert.equal(isGameSceneTimelineEnabled({ gameSceneTimelineEnabled: true }), true);
assert.equal(isGameSceneTimelineEnabled({ gameSceneTimelineEnabled: false }), false);

const party = [
  { id: "char-tamsin", name: "Tamsin" },
  { id: "npc:ysolde", name: "Ysolde" },
];
const names = party.map((member) => member.name);
assert.deepEqual(
  selectPresentPartySpeakers(snapshotPresenceTimeline([{ characterId: "char-tamsin", name: "Someone" }], party), names),
  ["Tamsin"],
  "snapshot character ids decide presence",
);
assert.deepEqual(
  selectPresentPartySpeakers(snapshotPresenceTimeline([{ name: " ysolde " }], party), names),
  ["Ysolde"],
  "snapshot names match like the timeline does",
);
assert.deepEqual(
  selectPresentPartySpeakers(snapshotPresenceTimeline([], party), names),
  names,
  "an empty snapshot keeps upstream's unfiltered party",
);
assert.deepEqual(selectPresentPartySpeakers(snapshotPresenceTimeline("bad", party), names), names);

// Route gates: every timeline side effect reads the switch from the chat's metadata.
const root = new URL("../../packages/server/src/", import.meta.url);
const generate = readFileSync(new URL("routes/generate.routes.ts", root), "utf8");
const game = readFileSync(new URL("routes/game.routes.ts", root), "utf8");
assert.match(
  generate,
  /!generationSignal\.aborted &&\s+isGameSceneTimelineEnabled\(chatMeta\)\s+\) \{\s+queueSceneTimeline\(/,
);
assert.match(generate, /const timeline = isGameSceneTimelineEnabled\(chatMeta\)\s+\? await readSceneTimeline\(/);
assert.match(game, /\(isGameSceneTimelineEnabled\(meta\) \? await sceneTimelineRecap\(app\.db, chatId\) : ""\)/);
assert.match(
  game,
  /isGameSceneTimelineEnabled\(meta\)\s+\? await readSceneTimeline\(app\.db, input\.chatId\)[\s\S]{0,40}: snapshotPresenceTimeline\(/,
);

const Fastify = (await import("../../packages/server/node_modules/fastify/fastify.js")).default;
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { gameRoutes } = await import("../../packages/server/src/routes/game.routes.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const db = await getDB();
const app = Fastify();
app.decorate("db", db);
await app.register(gameRoutes, { prefix: "/api/game" });
await app.ready();
try {
  const chats = createChatsStorage(db);
  const sync = async (metadata: Record<string, unknown>) => {
    const chat = await chats.create({ name: "Switch test", mode: "game", characterIds: [] });
    assert(chat);
    await chats.updateMetadata(chat.id, metadata);
    const res = await app.inject({ method: "POST", url: `/api/game/${chat.id}/scene-timeline/sync`, payload: {} });
    assert.equal(res.statusCode, 200, res.body);
    return res.json() as { queued: boolean };
  };
  assert.deepEqual(await sync({}), { queued: true }, "absent key keeps today's queue");
  assert.deepEqual(await sync({ gameSceneTimelineEnabled: true }), { queued: true });
  assert.deepEqual(await sync({ gameSceneTimelineEnabled: false }), { queued: false }, "OFF queues nothing");
} finally {
  await app.close();
  await closeDB?.();
}
console.log("game-switch-scene-timeline regression passed");
