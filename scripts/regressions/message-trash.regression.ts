import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Message trash: deletes move rows to a per-chat trash; restore puts them back in place
// with their swipes and extra; delete forever and the 30-day purge remove them for good.
const dataDir = mkdtempSync(join(tmpdir(), "marinara-message-trash-"));
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
  // Only the chat routes are mounted: a full buildApp() pushed this past the 30 s runner cap under load.
  const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
  const Fastify = requireServer("fastify") as typeof import("fastify").default;
  const { chatsRoutes } = await import("../../packages/server/src/routes/chats.routes.js");
  const { getDB } = await import("../../packages/server/src/db/connection.js");
  const { eq } = await import("../../packages/server/src/db/file-query.js");
  const { chats, messageTrash } = await import("../../packages/server/src/db/schema/index.js");
  const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
  const { createMessageTrashStorage, sweepExpiredMessageTrash } =
    await import("../../packages/server/src/services/storage/message-trash.storage.js");

  const db = await getDB();
  const fastify = Fastify();
  fastify.decorate("db", db);
  await fastify.register(chatsRoutes, { prefix: "/api/chats" });
  app = fastify as unknown as TestApp;
  await app.ready();
  const storage = createChatsStorage(db);
  const trash = createMessageTrashStorage(db);
  const base = Date.parse("2026-09-01T00:00:00.000Z");
  for (const id of ["chat-trash", "chat-other"]) {
    await db.insert(chats).values({
      id,
      name: id,
      mode: "roleplay",
      characterIds: "[]",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    });
  }
  const ids: string[] = [];
  for (let index = 0; index < 6; index++) {
    const created = await storage.createMessage(
      {
        chatId: "chat-trash",
        role: index % 2 === 0 ? "user" : "assistant",
        characterId: null,
        content: `MSG_${index}`,
        extra: { bookmark: index === 1 ? { label: "keep", createdAt: "x" } : undefined },
      } as never,
      { createdAt: new Date(base + index * 60_000).toISOString() },
    );
    ids.push(created!.id);
  }
  const otherMessage = await storage.createMessage({ chatId: "chat-other", role: "user", content: "OTHER" } as never);
  await storage.addSwipe(ids[1]!, "MSG_1_ALT");
  await storage.updateMessageExtra(ids[1]!, { privateNote: "note survives" });
  const beforeDelete = (await storage.listMessages("chat-trash")).map((message) => ({
    id: message.id,
    content: message.content,
    activeSwipeIndex: message.activeSwipeIndex,
    extra: message.extra,
    createdAt: message.createdAt,
  }));
  const swipesBefore = (await storage.getSwipes(ids[1]!)).map(({ id, index, content, extra }) => ({
    id,
    index,
    content,
    extra,
  }));

  // Single delete via the route moves the message to the trash.
  const single = await app.inject({ method: "DELETE", url: `/api/chats/chat-trash/messages/${ids[1]}` });
  assert.equal(single.statusCode, 204);
  assert.equal(await storage.getMessage(ids[1]!), null, "the message leaves the transcript");
  // Bulk delete, including an id from another chat that must be ignored.
  const bulk = await app.inject({
    method: "POST",
    url: "/api/chats/chat-trash/messages/bulk-delete",
    payload: { messageIds: [ids[3], ids[4], otherMessage!.id] },
  });
  assert.equal(bulk.statusCode, 204);
  assert.ok(await storage.getMessage(otherMessage!.id), "bulk delete stays scoped to its chat");
  assert.deepEqual(
    (await storage.listMessages("chat-trash")).map((message) => message.content),
    ["MSG_0", "MSG_2", "MSG_5"],
  );
  // Rollback deletes skip the trash.
  const rollback = await storage.createMessage({ chatId: "chat-trash", role: "user", content: "ROLLBACK" } as never);
  await app.inject({ method: "DELETE", url: `/api/chats/chat-trash/messages/${rollback!.id}?trash=false` });
  assert.equal(await storage.getMessage(rollback!.id), null);

  const listed = (await app.inject({ method: "GET", url: "/api/chats/chat-trash/trash" })).json() as Array<{
    id: string;
    messageId: string;
    content: string;
    swipeCount: number;
    expiresAt: string;
  }>;
  assert.equal(listed.length, 3, "three user deletes are in the trash, the rollback is not");
  assert.deepEqual(new Set(listed.map((entry) => entry.messageId)), new Set([ids[1], ids[3], ids[4]]));
  assert.equal(listed.find((entry) => entry.messageId === ids[1])!.swipeCount, 2, "swipes are kept");
  assert.equal(
    (await app.inject({ method: "GET", url: "/api/chats/chat-other/trash" })).json().length,
    0,
    "trash is per chat",
  );

  // Restore puts messages back at their original position with swipes and extra intact.
  const restoreResponse = await app.inject({
    method: "POST",
    url: "/api/chats/chat-trash/trash/restore",
    payload: { entryIds: listed.filter((entry) => entry.messageId !== ids[4]).map((entry) => entry.id) },
  });
  assert.equal(restoreResponse.statusCode, 200, restoreResponse.body);
  assert.deepEqual(new Set(restoreResponse.json().restoredMessageIds), new Set([ids[1], ids[3]]));
  assert.deepEqual(
    (await storage.listMessages("chat-trash")).map((message) => message.content),
    ["MSG_0", "MSG_1_ALT", "MSG_2", "MSG_3", "MSG_5"],
    "restored messages return to their original order",
  );
  const restored = await storage.getMessage(ids[1]!);
  const original = beforeDelete.find((message) => message.id === ids[1])!;
  assert.equal(restored!.createdAt, original.createdAt);
  assert.equal(restored!.activeSwipeIndex, original.activeSwipeIndex);
  assert.equal(restored!.content, original.content);
  assert.deepEqual(JSON.parse(restored!.extra), JSON.parse(original.extra), "extra (bookmark, note) is preserved");
  assert.deepEqual(
    (await storage.getSwipes(ids[1]!)).map(({ id, index, content, extra }) => ({ id, index, content, extra })),
    swipesBefore,
    "swipes come back unchanged",
  );
  // Restore must stay chat-scoped: an unscopable swipe probe leased the whole lazy table and
  // resurrected the deleted swipe rows from disk, duplicating every swipe.
  const fullyResident = (
    db as unknown as { _fileStore: { getFullyResidentLazyTables(): ReadonlySet<string> } }
  )._fileStore.getFullyResidentLazyTables();
  assert.ok(!fullyResident.has("message_swipes"), "restore does not lease the whole message_swipes table");
  assert.ok(!fullyResident.has("messages"), "delete and restore do not lease the whole messages table");
  // Swiping still works on a restored message.
  assert.ok(await storage.setActiveSwipe(ids[1]!, 0));

  // Restoring an entry whose message exists again is a conflict and changes nothing.
  const leftover = (await trash.list("chat-trash"))[0]!;
  assert.equal(leftover.messageId, ids[4]);
  await db.insert(messageTrash).values({
    id: "dup-entry",
    chatId: "chat-trash",
    messageId: ids[0]!,
    role: "user",
    characterId: null,
    content: "dup",
    snapshot: JSON.stringify({ message: { id: ids[0], chatId: "chat-trash", createdAt: "x" }, swipes: [] }),
    messageCreatedAt: "x",
    deletedAt: new Date().toISOString(),
  });
  const conflict = await trash.restore("chat-trash", ["dup-entry"]);
  assert.deepEqual(conflict, { restoredMessageIds: [], conflictEntryIds: ["dup-entry"] });
  assert.equal((await storage.listMessages("chat-trash")).length, 5);

  // Delete forever is scoped to the chat.
  assert.equal(await trash.deleteForever("chat-other", ["dup-entry"]), 0);
  const deleteForever = await app.inject({
    method: "POST",
    url: "/api/chats/chat-trash/trash/delete",
    payload: { entryIds: ["dup-entry"] },
  });
  assert.equal(deleteForever.json().deleted, 1);

  // Entries older than 30 days are purged automatically.
  await db
    .update(messageTrash)
    .set({ deletedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString() })
    .where(eq(messageTrash.id, leftover.id));
  assert.equal((await trash.list("chat-trash")).length, 0, "expired entries are purged on read");

  // Empty trash removes everything; deleting the chat cascades its trash.
  await app.inject({ method: "DELETE", url: `/api/chats/chat-trash/messages/${ids[5]}` });
  assert.equal((await trash.list("chat-trash")).length, 1);
  const emptied = await app.inject({
    method: "POST",
    url: "/api/chats/chat-trash/trash/delete",
    payload: { all: true },
  });
  assert.equal(emptied.json().deleted, 1);
  await app.inject({ method: "DELETE", url: `/api/chats/chat-trash/messages/${ids[0]}` });
  assert.equal(await trash.count("chat-trash"), 1);
  await storage.remove("chat-trash");
  assert.equal(await trash.count("chat-trash"), 0, "chat deletion cascades to its trash");

  // Game chats have no Trash view and their turns carry state a restore cannot rebuild,
  // so single and bulk deletes there stay permanent.
  await db.insert(chats).values({
    id: "chat-game",
    name: "chat-game",
    mode: "game",
    characterIds: "[]",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  });
  const gameIds: string[] = [];
  for (const content of ["G1", "G2", "G3"]) {
    gameIds.push((await storage.createMessage({ chatId: "chat-game", role: "user", content } as never))!.id);
  }
  await app.inject({ method: "DELETE", url: `/api/chats/chat-game/messages/${gameIds[0]}` });
  await app.inject({
    method: "POST",
    url: "/api/chats/chat-game/messages/bulk-delete",
    payload: { messageIds: [gameIds[1], gameIds[2]] },
  });
  assert.equal((await storage.listMessages("chat-game")).length, 0, "game deletes still remove the messages");
  assert.equal(await trash.count("chat-game"), 0, "game deletes skip the trash");

  // The background sweep purges expired entries of chats nobody lists, and keeps fresh ones.
  const sweepIds: string[] = [];
  for (const content of ["S1", "S2"]) {
    sweepIds.push((await storage.createMessage({ chatId: "chat-other", role: "user", content } as never))!.id);
  }
  await trash.trashMessages("chat-other", sweepIds);
  const [expiredEntry] = await db.select().from(messageTrash).where(eq(messageTrash.messageId, sweepIds[0]!));
  await db
    .update(messageTrash)
    .set({ deletedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString() })
    .where(eq(messageTrash.id, expiredEntry!.id));
  const swept = await sweepExpiredMessageTrash(db);
  assert.equal(swept.purged, 1, "the sweep removes only the expired entry");
  assert.equal(await trash.count("chat-other"), 1);
} finally {
  await app?.close();
  rmSync(dataDir, { recursive: true, force: true });
}

process.stdout.write("Message trash regression passed.\n");
