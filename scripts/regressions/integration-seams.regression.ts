import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Cross-feature seams between message trash, bookmarks, pins and private notes and the
// read-only views built beside them (global search, chat stats, character usage), Game
// Mode segment edits in search, plus chat deletion reaching the new per-chat tables.
// The trash and chat delete go through their storage (what the chat routes call); only the
// insight routes are mounted, since importing the chat routes alone takes most of the 30 s cap.
const dataDir = mkdtempSync(join(tmpdir(), "marinara-integration-seams-"));
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
  const { chatInsightsRoutes } = await import("../../packages/server/src/routes/chat-insights.routes.js");
  const { characterUsageRoutes } = await import("../../packages/server/src/routes/character-usage.routes.js");
  const { getDB } = await import("../../packages/server/src/db/connection.js");
  const { eq } = await import("../../packages/server/src/db/file-query.js");
  const { characters, chats, gameDiceRolls, messageTrash } =
    await import("../../packages/server/src/db/schema/index.js");
  const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
  const { createMessageTrashStorage } =
    await import("../../packages/server/src/services/storage/message-trash.storage.js");

  const db = await getDB();
  const fastify = Fastify();
  fastify.decorate("db", db);
  await fastify.register(chatInsightsRoutes, { prefix: "/api/chat-insights" });
  await fastify.register(characterUsageRoutes, { prefix: "/api/character-usage" });
  app = fastify as unknown as TestApp;
  await app.ready();
  const storage = createChatsStorage(db);
  const trash = createMessageTrashStorage(db);

  const stamp = "2026-09-01T00:00:00.000Z";
  await db.insert(characters).values({
    id: "char-seam",
    data: JSON.stringify({ name: "Tamsin" }),
    createdAt: stamp,
    updatedAt: stamp,
  } as never);
  await db.insert(chats).values({
    id: "chat-seam",
    name: "Seam chat",
    mode: "roleplay",
    characterIds: JSON.stringify(["char-seam"]),
    createdAt: stamp,
    updatedAt: stamp,
  });
  const base = Date.parse(stamp);
  const ids: string[] = [];
  for (let index = 0; index < 4; index++) {
    const created = await storage.createMessage(
      {
        chatId: "chat-seam",
        role: index % 2 === 0 ? "user" : "assistant",
        characterId: index % 2 === 0 ? null : "char-seam",
        content: index === 1 ? "The ZEPHYRQUILL gleams" : `plain line ${index}`,
      } as never,
      { createdAt: new Date(base + index * 60_000).toISOString() },
    );
    ids.push(created!.id);
  }
  const middle = ids[1]!;
  await storage.updateMessageExtra(middle, {
    bookmark: { label: "quill", createdAt: stamp },
    privateNote: "secret MOONWHISPER note",
    pinnedToContext: true,
  });

  const search = async (q: string) =>
    (await app!.inject({ method: "GET", url: `/api/chat-insights/search?q=${encodeURIComponent(q)}` })).json();
  const hitCount = (response: any) => (response.results ?? []).length;
  const stats = async () =>
    (await app!.inject({ method: "GET", url: "/api/chat-insights/chats/chat-seam/stats" })).json();
  const usageCount = async () =>
    (await app!.inject({ method: "GET", url: "/api/character-usage/char-seam?counts=1" })).json().messageCounts?.[
      "chat-seam"
    ];

  // Private notes are reader-only: global search must not match or quote them.
  const noteSearch = await search("MOONWHISPER");
  assert.equal(hitCount(noteSearch), 0, "private notes never match search");
  assert.ok(!JSON.stringify(noteSearch.results).includes("MOONWHISPER"));

  assert.equal(hitCount(await search("ZEPHYRQUILL")), 1, "the live message is found");
  const statsBefore = await stats();
  assert.equal(await usageCount(), 4, "character usage counts every message");

  // Trash the middle message: every view stops counting it.
  assert.deepEqual(await trash.trashMessages("chat-seam", [middle]), [middle]);
  assert.equal(hitCount(await search("ZEPHYRQUILL")), 0, "a trashed message is not a search hit");
  assert.equal((await stats()).totalMessages, statsBefore.totalMessages - 1, "chat stats drop a trashed message");
  assert.equal(await usageCount(), 3, "character usage message counts drop a trashed message");

  // Restore it: the views count it again and its marks came back with it.
  const [entry] = await trash.list("chat-seam");
  assert.deepEqual((await trash.restore("chat-seam", [entry!.id])).restoredMessageIds, [middle]);
  assert.equal(hitCount(await search("ZEPHYRQUILL")), 1, "a restored message is a search hit again");
  assert.equal((await stats()).totalMessages, statsBefore.totalMessages, "chat stats count it again");
  assert.equal(await usageCount(), 4, "character usage counts a restored message again");
  const extra = JSON.parse((await storage.getMessage(middle))!.extra);
  assert.equal(extra.bookmark?.label, "quill");
  assert.equal(extra.privateNote, "secret MOONWHISPER note");
  assert.equal(extra.pinnedToContext, true);

  // Game Mode segment edits and deletions: search reads the text the campaign log shows.
  {
    await db.insert(chats).values({
      id: "chat-game",
      name: "Seam game",
      mode: "game",
      characterIds: "[]",
      createdAt: stamp,
      updatedAt: stamp,
    });
    const narration = await storage.createMessage({
      chatId: "chat-game",
      role: "narrator",
      content: "The GRIMSTONE gate opens.\n\nOld ZORBLAX mutters a curse.\n\nThe torch gutters.",
    } as never);
    assert.equal(hitCount(await search("ZORBLAX")), 1, "unedited narration is found");
    await db
      .update(chats)
      .set({
        metadata: JSON.stringify({
          [`segmentDelete:${narration!.id}:1`]: true,
          [`segmentEdit:${narration!.id}:2`]: { content: "The QUENCHLIGHT lantern gutters." },
        }),
      })
      .where(eq(chats.id, "chat-game"));
    assert.equal(hitCount(await search("ZORBLAX")), 0, "a deleted segment is not a search hit");
    assert.equal(hitCount(await search("torch")), 0, "replaced segment text is not a search hit");
    const edited = await search("QUENCHLIGHT");
    assert.equal(hitCount(edited), 1, "edited segment text is a search hit");
    assert.equal(edited.results[0].messageId, narration!.id);
    assert.ok(!edited.results[0].snippet.includes("ZORBLAX"), "snippets quote the edited text");
    assert.equal(hitCount(await search("GRIMSTONE")), 1, "untouched segments still match");
    const gameStats = (await app.inject({ method: "GET", url: "/api/chat-insights/chats/chat-game/stats" })).json();
    assert.ok(!gameStats.longestMessage.preview.includes("ZORBLAX"), "chat stats quote the edited text");
    assert.ok(gameStats.longestMessage.preview.includes("QUENCHLIGHT"));
  }

  // Deleting the chat takes its trash and dice log with it.
  await trash.trashMessages("chat-seam", [ids[3]!]);
  await db.insert(gameDiceRolls).values({
    id: "roll-seam",
    chatId: "chat-seam",
    source: "player",
    notation: "1d20",
    rolls: "[7]",
    total: 7,
    createdAt: stamp,
  } as never);
  assert.equal((await db.select().from(messageTrash).where(eq(messageTrash.chatId, "chat-seam"))).length, 1);
  await storage.remove("chat-seam");
  assert.equal((await db.select().from(messageTrash).where(eq(messageTrash.chatId, "chat-seam"))).length, 0);
  assert.equal((await db.select().from(gameDiceRolls).where(eq(gameDiceRolls.chatId, "chat-seam"))).length, 0);
  assert.equal(await usageCount(), undefined, "a deleted chat leaves character usage");

  console.log("integration-seams regression passed");
} finally {
  await app?.close().catch(() => undefined);
  rmSync(dataDir, { recursive: true, force: true });
}
