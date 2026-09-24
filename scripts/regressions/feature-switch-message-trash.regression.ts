import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Settings > Features "Message trash" (messageTrash + messageTrashDays). ON (default) is today: user
// deletes move to the chat Trash, kept 30 days (the number replaces 30). OFF is upstream: the same
// routes fall back to the existing permanent delete and nothing reaches the Trash.
const dataDir = mkdtempSync(join(tmpdir(), "marinara-feature-trash-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
process.env.LOG_LEVEL = "silent";
process.env.DISABLE_REQUEST_LOGGING = "true";
process.env.AUTO_CREATE_DEFAULT_CONNECTION = "false";

type TestApp = {
  close(): Promise<void>;
  inject(options: Record<string, unknown>): Promise<{ statusCode: number; json(): any }>;
  ready(): Promise<void>;
};
let app: TestApp | null = null;
const { resetFeatureSettingsForTests } =
  await import("../../packages/server/src/services/features/feature-settings.js");
try {
  const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
  const Fastify = requireServer("fastify") as typeof import("fastify").default;
  const { chatsRoutes } = await import("../../packages/server/src/routes/chats.routes.js");
  const { getDB } = await import("../../packages/server/src/db/connection.js");
  const { chats } = await import("../../packages/server/src/db/schema/index.js");
  const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
  const { createMessageTrashStorage } =
    await import("../../packages/server/src/services/storage/message-trash.storage.js");

  const db = await getDB();
  const fastify = Fastify();
  fastify.decorate("db", db);
  await fastify.register(chatsRoutes, { prefix: "/api/chats" });
  app = fastify as unknown as TestApp;
  await app.ready();
  const storage = createChatsStorage(db);
  const trash = createMessageTrashStorage(db);
  await db.insert(chats).values({
    id: "chat-grove",
    name: "Grove",
    mode: "roleplay",
    characterIds: "[]",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  });
  const add = async (content: string) =>
    (await storage.createMessage({ chatId: "chat-grove", role: "user", content } as never))!.id;
  const del = (id: string) => app!.inject({ method: "DELETE", url: `/api/chats/chat-grove/messages/${id}` });
  const bulk = (ids: string[]) =>
    app!.inject({ method: "POST", url: "/api/chats/chat-grove/messages/bulk-delete", payload: { messageIds: ids } });

  // ON = today
  resetFeatureSettingsForTests();
  const onSingle = await add("Tamsin waves.");
  assert.equal((await del(onSingle)).statusCode, 204);
  assert.equal(await storage.getMessage(onSingle), null);
  assert.equal(await trash.count("chat-grove"), 1, "ON: a delete moves the message to the Trash");
  const onBulk = [await add("one"), await add("two")];
  assert.equal((await bulk(onBulk)).statusCode, 204);
  assert.equal(await trash.count("chat-grove"), 3, "ON: bulk deletes go to the Trash too");
  const [entry] = await trash.list("chat-grove");
  const day = 24 * 60 * 60 * 1000;
  assert.equal(Date.parse(entry!.expiresAt) - Date.parse(entry!.deletedAt), 30 * day, "ON: kept 30 days");
  resetFeatureSettingsForTests({ messageTrashDays: 5 });
  const [shortEntry] = await trash.list("chat-grove");
  assert.equal(Date.parse(shortEntry!.expiresAt) - Date.parse(shortEntry!.deletedAt), 5 * day, "days are adjustable");

  // OFF = upstream permanent delete
  resetFeatureSettingsForTests({ messageTrash: false });
  const offSingle = await add("Ysolde leaves.");
  assert.equal((await del(offSingle)).statusCode, 204);
  assert.equal(await storage.getMessage(offSingle), null, "OFF: the message is gone");
  const offBulk = [await add("three"), await add("four")];
  assert.equal((await bulk(offBulk)).statusCode, 204);
  for (const id of offBulk) assert.equal(await storage.getMessage(id), null, "OFF: bulk delete is permanent");
  assert.equal(await trash.count("chat-grove"), 3, "OFF: nothing new reaches the Trash");
  assert.equal(
    (await trash.list("chat-grove")).some((item) => [offSingle, ...offBulk].includes(item.messageId)),
    false,
  );
} finally {
  resetFeatureSettingsForTests();
  await app?.close();
  rmSync(dataDir, { recursive: true, force: true });
}

console.log("feature-switch-message-trash regression passed");
