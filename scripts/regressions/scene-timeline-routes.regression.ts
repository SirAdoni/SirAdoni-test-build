import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify");
const root = mkdtempSync(join(tmpdir(), "marinara-scene-timeline-routes-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");

let app: ReturnType<typeof Fastify> | undefined;
let db: Awaited<ReturnType<typeof createDb>> | undefined;
let setFeatureSettings: ((value: string | null) => unknown) | undefined;

async function createDb() {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  return createFileNativeDB();
}

try {
  const { chats } = await import("../../packages/server/src/db/schema/index.js");
  const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
  ({ applyFeatureSettingsValue: setFeatureSettings } =
    await import("../../packages/server/src/services/features/feature-settings.js"));
  const { gameSceneTimelineRoutes } = await import("../../packages/server/src/routes/game-scene-timeline.routes.js");
  db = await createDb();
  const chatId = "scene-timeline-api";
  const now = new Date().toISOString();
  await db.insert(chats).values({
    id: chatId,
    name: "Scene timeline API fixture",
    mode: "game",
    characterIds: "[]",
    metadata: "{}",
    createdAt: now,
    updatedAt: now,
  });

  app = Fastify();
  let databaseReads = 0;
  app.decorate(
    "db",
    new Proxy(db, {
      get(target, key) {
        if (key === "select")
          return (...args: unknown[]) => {
            databaseReads++;
            return Reflect.apply(target.select, target, args);
          };
        return Reflect.get(target, key);
      },
    }),
  );
  app.decorate("activeGenerations", new Map([[chatId, {}]]));
  await app.register(gameSceneTimelineRoutes, { prefix: "/api/game" });
  await app.ready();

  const expectDisabled = async (method: "GET" | "POST", path: string, allowedReads = 0) => {
    const before = databaseReads;
    const response = await app!.inject({ method, url: path });
    assert.equal(response.statusCode, 403);
    assert.deepEqual(response.json(), {
      error: { code: "FEATURE_DISABLED", feature: "sceneTimeline", message: "This feature is disabled in Settings." },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(databaseReads - before, allowedReads, "A rejected request must stop after its admission read");
  };
  const readPath = `/api/game/${chatId}/scene-timeline`;
  const syncPath = `${readPath}/sync`;
  setFeatureSettings!(null);
  await expectDisabled("GET", readPath);
  await expectDisabled("POST", syncPath);

  setFeatureSettings!(JSON.stringify({ sceneTimeline: true }));
  for (const [method, url] of [
    ["GET", "/api/game/missing/scene-timeline"],
    ["POST", "/api/game/missing/scene-timeline/sync"],
  ] as const) {
    const missing = await app.inject({ method, url });
    assert.equal(missing.statusCode, 404);
    assert.deepEqual(missing.json(), { error: "Chat not found" });
  }
  await createChatsStorage(db).updateMetadata(chatId, { gameSceneTimelineEnabled: false });
  await expectDisabled("GET", readPath, 1);
  await expectDisabled("POST", syncPath, 1);

  await createChatsStorage(db).updateMetadata(chatId, {});
  const enabled = await app.inject({ method: "GET", url: readPath });
  assert.equal(enabled.statusCode, 200);
  assert.deepEqual(enabled.json().scenes, []);
  const sync = await app.inject({ method: "POST", url: syncPath });
  assert.equal(sync.statusCode, 200);
  assert.deepEqual(sync.json(), { queued: true });

  console.log("scene-timeline-routes regression passed");
} finally {
  setFeatureSettings?.(null);
  if (app) await app.close();
  if (db) await db._fileStore.close();
  rmSync(root, { recursive: true, force: true });
}
