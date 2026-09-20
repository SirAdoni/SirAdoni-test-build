import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify");
const root = mkdtempSync(join(tmpdir(), "marinara-campaign-memory-source-api-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";

const hash = (content: string) => createHash("sha256").update(content, "utf8").digest("hex");

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { chats, messages, messageSwipes } = await import("../../packages/server/src/db/schema/index.js");
  const { eq } = await import("../../packages/server/src/db/file-query.js");
  const { campaignMemoryRoutes } = await import("../../packages/server/src/routes/campaign-memory.routes.js");
  const db = await createFileNativeDB();
  const createdAt = new Date().toISOString();
  await db.insert(chats).values([
    { id: "source-game", name: "Source game", mode: "game", characterIds: "[]", createdAt, updatedAt: createdAt },
    { id: "source-conversation", name: "Source conversation", mode: "conversation", characterIds: "[]", createdAt, updatedAt: createdAt },
  ]);
  await db.insert(messages).values({
    id: "source-message",
    chatId: "source-game",
    role: "user",
    content: "Original source",
    activeSwipeIndex: 0,
    createdAt,
  });
  await db.insert(messageSwipes).values({
    id: "source-swipe",
    messageId: "source-message",
    index: 1,
    content: "Swipe source",
    createdAt,
  });

  const app = Fastify();
  app.decorate("db", db);
  await app.register(campaignMemoryRoutes, { prefix: "/api/game" });
  await app.ready();
  const get = (url: string) => app.inject({ method: "GET", url });

  let response = await get(`/api/game/source-game/memory/sources/source-message?sourceHash=${hash("Original source")}`);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    messageId: "source-message",
    sourceHash: hash("Original source"),
    swipeIndex: 0,
    content: "Original source",
  });

  await db.update(messages).set({ content: "Changed source" }).where(eq(messages.id, "source-message"));
  response = await get(`/api/game/source-game/memory/sources/source-message?sourceHash=${hash("Original source")}`);
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, "CAMPAIGN_MEMORY_SOURCE_CHANGED");
  const unchangedAfterRead = (await db.select().from(messages).where(eq(messages.id, "source-message")))[0];
  assert.equal(unchangedAfterRead?.content, "Changed source", "source read does not rewrite message content");
  assert.equal(unchangedAfterRead?.activeSwipeIndex, 0, "source read does not change the active swipe");

  await db.update(messages).set({ activeSwipeIndex: 1 }).where(eq(messages.id, "source-message"));
  response = await get(`/api/game/source-game/memory/sources/source-message?sourceHash=${hash("Changed source")}`);
  assert.equal(response.statusCode, 409, "the old base hash is stale after the active swipe changes");
  response = await get(`/api/game/source-game/memory/sources/source-message?sourceHash=${hash("Swipe source")}`);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().content, "Swipe source");
  assert.equal(response.json().swipeIndex, 1);

  assert.equal((await get(`/api/game/source-conversation/memory/sources/source-message?sourceHash=${hash("Swipe source")}`)).statusCode, 404);
  assert.equal((await get(`/api/game/missing-chat/memory/sources/source-message?sourceHash=${hash("Swipe source")}`)).statusCode, 404);
  assert.equal((await get(`/api/game/source-game/memory/sources/source-message?sourceHash=invalid`)).statusCode, 400);

  await app.close();
  await db._fileStore.close();
  process.stdout.write("campaign-memory-source-api regression passed\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
