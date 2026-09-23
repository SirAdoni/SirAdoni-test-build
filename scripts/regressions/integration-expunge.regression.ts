import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Settings > Danger Zone: clearing chats and lorebooks must also clear the per-chat and
// per-entry rows the newer features keep beside them (message trash, dice log, game-scoped
// random tables, campaign links, lorebook activation stats), while global random tables
// and anything outside the cleared scopes stay.
const dataDir = mkdtempSync(join(tmpdir(), "marinara-integration-expunge-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
process.env.LOG_LEVEL = "silent";
process.env.DISABLE_REQUEST_LOGGING = "true";
process.env.AUTO_CREATE_DEFAULT_CONNECTION = "false";

type TestApp = {
  close(): Promise<void>;
  inject(options: Record<string, unknown>): Promise<{ statusCode: number; json(): any; body: string }>;
  ready(): Promise<void>;
};
let app: TestApp | null = null;
try {
  const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
  const Fastify = requireServer("fastify") as typeof import("fastify").default;
  const { adminRoutes } = await import("../../packages/server/src/routes/admin.routes.js");
  const { getDB } = await import("../../packages/server/src/db/connection.js");
  const schema = await import("../../packages/server/src/db/schema/index.js");

  const db = await getDB();
  const fastify = Fastify();
  fastify.decorate("db", db);
  await fastify.register(adminRoutes, { prefix: "/api/admin" });
  app = fastify as unknown as TestApp;
  await app.ready();

  const stamp = "2026-09-01T00:00:00.000Z";
  await db.insert(schema.chats).values({
    id: "chat-x",
    name: "Game",
    mode: "game",
    characterIds: "[]",
    metadata: JSON.stringify({ gameId: "game-x" }),
    createdAt: stamp,
    updatedAt: stamp,
  });
  await db.insert(schema.messageTrash).values({
    id: "trash-x",
    chatId: "chat-x",
    messageId: "m-x",
    role: "user",
    content: "gone",
    snapshot: "{}",
    messageCreatedAt: stamp,
    deletedAt: stamp,
  } as never);
  await db.insert(schema.gameDiceRolls).values({
    id: "roll-x",
    chatId: "chat-x",
    gameId: "game-x",
    source: "player",
    notation: "1d6",
    rolls: "[3]",
    total: 3,
    createdAt: stamp,
  } as never);
  for (const [id, gameId] of [
    ["table-game", "game-x"],
    ["table-global", ""],
  ] as const) {
    await db.insert(schema.randomTables).values({ id, name: id, gameId, createdAt: stamp, updatedAt: stamp } as never);
  }
  await db.insert(schema.libraryCampaignLinks).values({
    id: "link-x",
    campaignId: "game-x",
    itemType: "character",
    itemId: "someone",
    mode: "include",
    createdAt: stamp,
  });
  await db.insert(schema.lorebooks).values({ id: "lb-x", name: "Lore", createdAt: stamp, updatedAt: stamp } as never);
  await db.insert(schema.lorebookEntries).values({
    id: "entry-x",
    lorebookId: "lb-x",
    name: "Entry",
    content: "text",
    createdAt: stamp,
    updatedAt: stamp,
  } as never);
  await db.insert(schema.lorebookEntryActivationStats).values({
    entryId: "entry-x",
    lorebookId: "lb-x",
    count: 3,
    lastActivatedAt: stamp,
    lastChatId: "chat-x",
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/admin/expunge",
    payload: { confirm: true, scopes: ["chats", "lorebooks"] },
  });
  assert.equal(response.statusCode, 200, response.body);

  const count = async (table: any) => (await db.select().from(table)).length;
  assert.equal(await count(schema.chats), 0);
  assert.equal(await count(schema.messageTrash), 0, "message trash goes with the chats");
  assert.equal(await count(schema.gameDiceRolls), 0, "the dice log goes with the chats");
  assert.deepEqual(
    (await db.select().from(schema.randomTables)).map((row: any) => row.id),
    ["table-global"],
    "game-scoped random tables go with their games; global tables stay",
  );
  assert.equal(await count(schema.libraryCampaignLinks), 0, "campaign links go with the games they describe");
  assert.equal(await count(schema.lorebookEntries), 0);
  assert.equal(await count(schema.lorebookEntryActivationStats), 0, "activation stats go with the entries");

  console.log("integration-expunge regression passed");
} finally {
  await app?.close().catch(() => undefined);
  rmSync(dataDir, { recursive: true, force: true });
}
