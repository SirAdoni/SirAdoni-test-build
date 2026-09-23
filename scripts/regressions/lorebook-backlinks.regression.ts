import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";

// Covers lorebook backlinks (the bounded per-entry list of chats an entry fired
// in, including rows written before the list existed) and the stale-entries finder.

const dataDir = mkdtempSync(join(tmpdir(), "marinara-lorebook-backlinks-"));
const previous = {
  DATA_DIR: process.env.DATA_DIR,
  FILE_STORAGE_DIR: process.env.FILE_STORAGE_DIR,
  MARINARA_FILE_STORAGE_DIR: process.env.MARINARA_FILE_STORAGE_DIR,
};
type Response = { statusCode: number; body: string; json(): any };
let app: {
  close(): Promise<void>;
  inject(options: Record<string, unknown>): Promise<Response>;
} | null = null;
let closeStore: (() => Promise<void>) | undefined;

try {
  const fileStorageDir = join(dataDir, "file-storage");
  process.env.DATA_DIR = dataDir;
  process.env.FILE_STORAGE_DIR = fileStorageDir;
  process.env.MARINARA_FILE_STORAGE_DIR = fileStorageDir;

  const [{ createFileNativeDB }, { lorebooksRoutes }, stats, backlinks, schema, fileQuery] = await Promise.all([
    import("../../packages/server/src/db/file-backed-store.js"),
    import("../../packages/server/src/routes/lorebooks.routes.js"),
    import("../../packages/server/src/services/lorebook/activation-stats.js"),
    import("../../packages/server/src/services/lorebook/activation-backlinks.js"),
    import("../../packages/server/src/db/schema/index.js"),
    import("../../packages/server/src/db/file-query.js"),
  ]);

  // ── Pure helpers ──
  const { parseRecentChats, mergeRecentChats, findStaleEntries, clampStaleDays, MAX_RECENT_CHATS_PER_ENTRY } =
    backlinks;
  assert.equal(MAX_RECENT_CHATS_PER_ENTRY, 20);
  assert.deepEqual(parseRecentChats(null), [], "no data, no legacy chat");
  assert.deepEqual(
    parseRecentChats(undefined, { lastChatId: "old-chat", lastActivatedAt: "2026-01-01T00:00:00.000Z" }),
    [{ chatId: "old-chat", count: 0, lastActivatedAt: "2026-01-01T00:00:00.000Z" }],
    "rows from before backlinks fall back to lastChatId",
  );
  assert.deepEqual(
    parseRecentChats("{not json", { lastChatId: "old-chat" }),
    [{ chatId: "old-chat", count: 0, lastActivatedAt: null }],
    "a broken value falls back too",
  );
  assert.deepEqual(
    parseRecentChats('[{"chatId":"a","count":2,"lastActivatedAt":"2026-01-01"},{"chatId":"a"},{"bad":1},null]'),
    [{ chatId: "a", count: 2, lastActivatedAt: "2026-01-01" }],
    "junk and duplicate items are dropped",
  );

  let merged = mergeRecentChats(
    [{ chatId: "a", count: 1, lastActivatedAt: "2026-01-01T00:00:00.000Z" }],
    new Map([
      ["b", { count: 1, lastActivatedAt: "2026-01-03T00:00:00.000Z" }],
      ["a", { count: 2, lastActivatedAt: "2026-01-02T00:00:00.000Z" }],
    ]),
  );
  assert.deepEqual(
    merged.map((chat) => [chat.chatId, chat.count]),
    [
      ["b", 1],
      ["a", 3],
    ],
    "counts add up, newest first",
  );
  const many = new Map(
    Array.from({ length: 30 }, (_, index) => [
      `chat-${String(index).padStart(2, "0")}`,
      { count: 1, lastActivatedAt: `2026-02-${String(index + 1).padStart(2, "0")}T00:00:00.000Z` },
    ]),
  );
  merged = mergeRecentChats(merged, many);
  assert.equal(merged.length, 20, "the list is capped");
  assert.equal(merged[0]?.chatId, "chat-29", "newest chat first");
  assert.ok(!merged.some((chat) => chat.chatId === "a" || chat.chatId === "chat-00"), "oldest chats drop off");

  assert.equal(clampStaleDays(undefined), 30);
  assert.equal(clampStaleDays("0"), 30);
  assert.equal(clampStaleDays("7"), 7);
  assert.equal(clampStaleDays(999999), 3650);

  const now = new Date("2026-06-30T00:00:00.000Z");
  const old = "2026-01-01T00:00:00.000Z";
  const stale = findStaleEntries({
    now,
    days: 30,
    entries: [
      { id: "recent", createdAt: old },
      { id: "quiet", createdAt: old },
      { id: "never", createdAt: old },
      { id: "off", createdAt: old, enabled: false },
      { id: "foldered", createdAt: old, folderId: "f-off" },
      { id: "brand-new", createdAt: "2026-06-29T00:00:00.000Z" },
    ],
    stats: [
      { entryId: "recent", lastActivatedAt: "2026-06-25T00:00:00.000Z" },
      { entryId: "quiet", lastActivatedAt: "2026-03-01T00:00:00.000Z" },
      { entryId: "off", lastActivatedAt: "2026-02-01T00:00:00.000Z" },
    ],
    disabledFolderIds: new Set(["f-off"]),
  });
  assert.equal(stale.lorebookActive, true);
  assert.equal(stale.lorebookLastActivatedAt, "2026-06-25T00:00:00.000Z");
  assert.deepEqual(
    stale.entries.map((entry) => entry.entryId),
    ["never", "quiet"],
    "never fired first, then longest silent; disabled, disabled-folder and new entries are skipped",
  );
  const idle = findStaleEntries({
    now,
    days: 7,
    entries: [{ id: "quiet", createdAt: old }],
    stats: [{ entryId: "quiet", lastActivatedAt: "2026-03-01T00:00:00.000Z" }],
  });
  assert.equal(idle.lorebookActive, false, "a lorebook that did not fire in the window has no stale entries");
  assert.deepEqual(idle.entries, []);

  // ── Storage and routes ──
  const db = await createFileNativeDB();
  closeStore = () => (db as unknown as { _fileStore: { close(): Promise<void> } })._fileStore.close();
  const Fastify = createRequire(new URL("../../packages/server/package.json", import.meta.url))("fastify");
  const server = Fastify();
  server.decorate("db", db);
  await server.register(lorebooksRoutes, { prefix: "/api/lorebooks" });
  app = server;
  const request = async (method: string, url: string, payload?: unknown) => {
    const response = await app!.inject({ method, url, payload });
    assert.ok(response.statusCode < 400, `${method} ${url} -> ${response.statusCode}`);
    return response.body ? response.json() : null;
  };

  const book = await request("POST", "/api/lorebooks", { name: "Harbor Notes" });
  const entry = (name: string) =>
    request("POST", `/api/lorebooks/${book.id}/entries`, { lorebookId: book.id, name, keys: [name], content: "x" });
  const lighthouse = await entry("Lighthouse");
  const ferry = await entry("Ferry");

  const stamp = new Date().toISOString();
  await db.insert(schema.chats).values({
    id: "chat-kept",
    name: "Harbor Watch",
    mode: "roleplay",
    createdAt: stamp,
    updatedAt: stamp,
  });

  stats.recordLorebookActivations(db, { entryIds: [lighthouse.id], chatId: "chat-kept", at: stamp });
  stats.recordLorebookActivations(db, { entryIds: [lighthouse.id], chatId: "chat-gone", at: stamp });
  stats.recordLorebookActivations(db, { entryIds: [lighthouse.id], chatId: "chat-kept", at: stamp });
  await stats.flushLorebookActivationStats(db);
  // A second batch merges into the stored list.
  stats.recordLorebookActivations(db, { entryIds: [lighthouse.id], chatId: "chat-kept", at: stamp });
  await stats.flushLorebookActivationStats(db);

  const statsUrl = `/api/lorebooks/${book.id}/activation-stats`;
  let rows = (await request("GET", statsUrl)) as Array<Record<string, any>>;
  const lighthouseStat = rows.find((row) => row.entryId === lighthouse.id);
  assert.equal(lighthouseStat?.count, 4);
  const byChat = new Map(
    (lighthouseStat?.recentChats as Array<Record<string, unknown>>).map((chat) => [chat.chatId, chat]),
  );
  assert.equal(byChat.get("chat-kept")?.count, 3);
  assert.equal(byChat.get("chat-kept")?.chatName, "Harbor Watch");
  assert.equal(byChat.get("chat-kept")?.chatMode, "roleplay");
  assert.equal(byChat.get("chat-gone")?.count, 1);
  assert.equal(byChat.get("chat-gone")?.chatName, null, "deleted chats keep a null name");

  // A stats row written before backlinks existed (no recentChats) still reads and upgrades.
  await db.insert(schema.lorebookEntryActivationStats).values({
    entryId: ferry.id,
    lorebookId: book.id,
    count: 5,
    lastActivatedAt: "2026-01-01T00:00:00.000Z",
    lastChatId: "chat-kept",
  });
  rows = await request("GET", statsUrl);
  assert.deepEqual(rows.find((row) => row.entryId === ferry.id)?.recentChats, [
    {
      chatId: "chat-kept",
      count: 0,
      lastActivatedAt: "2026-01-01T00:00:00.000Z",
      chatName: "Harbor Watch",
      chatMode: "roleplay",
    },
  ]);
  stats.recordLorebookActivations(db, { entryIds: [ferry.id], chatId: "chat-new", at: stamp });
  await stats.flushLorebookActivationStats(db);
  const [ferryStat] = await stats.listLorebookActivationStats(db, [ferry.id]);
  assert.equal(ferryStat?.count, 6);
  assert.deepEqual(
    ferryStat?.recentChats.map((chat) => chat.chatId),
    ["chat-new", "chat-kept"],
    "the legacy chat is kept when the list is first written",
  );

  // Stale route: entries created just now had no fair chance, so nothing is stale yet.
  const staleResult = await request("GET", `/api/lorebooks/${book.id}/stale-entries?days=14`);
  assert.equal(staleResult.days, 14);
  assert.equal(staleResult.lorebookActive, true);
  assert.deepEqual(staleResult.entries, []);

  // Old entries are stale, except one in an enabled subfolder of a disabled
  // folder: the disabled parent gates it, so it never had a chance to fire.
  const parentFolder = await request("POST", `/api/lorebooks/${book.id}/folders`, { name: "Archive", enabled: false });
  const childFolder = await request("POST", `/api/lorebooks/${book.id}/folders`, {
    name: "Archive Inner",
    enabled: true,
    parentFolderId: parentFolder.id,
  });
  const oldStamp = "2025-01-01T00:00:00.000Z";
  const loose = await entry("Tidepool");
  const nested = await entry("Seawall");
  await db
    .update(schema.lorebookEntries)
    .set({ createdAt: oldStamp })
    .where(fileQuery.inArray(schema.lorebookEntries.id, [loose.id, nested.id]));
  await db
    .update(schema.lorebookEntries)
    .set({ folderId: childFolder.id })
    .where(fileQuery.eq(schema.lorebookEntries.id, nested.id));
  const nestedStale = await request("GET", `/api/lorebooks/${book.id}/stale-entries?days=14`);
  assert.deepEqual(
    nestedStale.entries.map((item: { entryId: string }) => item.entryId),
    [loose.id],
    "entries under a disabled ancestor folder are not stale",
  );

  const missing = await app.inject({ method: "GET", url: "/api/lorebooks/nope/stale-entries" });
  assert.equal(missing.statusCode, 404);
} finally {
  await app?.close();
  await closeStore?.();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dataDir, { recursive: true, force: true });
}

console.log("lorebook-backlinks regression passed");
