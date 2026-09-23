import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_CHAPTER_SUMMARY_LENGTH,
  MAX_CHAPTER_TITLE_LENGTH,
  MESSAGE_MARK_EXTRA_KEYS,
  listMessageChapters,
  normalizeMessageMarkPatch,
  readMessageChapter,
} from "../../packages/shared/src/utils/message-marks.js";

// ── Pure: chapter patch validation and reading ──
const fixedNow = () => "2026-09-23T00:00:00.000Z";
assert.ok(MESSAGE_MARK_EXTRA_KEYS.includes("chapter"), "chapters are message-level marks, mirrored to every swipe");
assert.deepEqual(normalizeMessageMarkPatch({ chapter: { title: "  The   Long Road ", summary: "  " } }, fixedNow), {
  patch: { chapter: { title: "The Long Road", summary: null, createdAt: "2026-09-23T00:00:00.000Z" } },
});
const kept = normalizeMessageMarkPatch(
  { chapter: { title: "A", summary: "Short.", createdAt: "2026-01-01" } },
  fixedNow,
);
assert.ok("patch" in kept && (kept.patch.chapter as { createdAt: string }).createdAt === "2026-01-01");
const longTitle = normalizeMessageMarkPatch({ chapter: { title: "x".repeat(400) } }, fixedNow);
assert.ok(
  "patch" in longTitle && (longTitle.patch.chapter as { title: string }).title.length === MAX_CHAPTER_TITLE_LENGTH,
);
assert.ok("error" in normalizeMessageMarkPatch({ chapter: { title: "   " } }), "a chapter needs a title");
assert.ok("error" in normalizeMessageMarkPatch({ chapter: { summary: "no title" } }));
assert.ok("error" in normalizeMessageMarkPatch({ chapter: { title: "A", summary: 3 } }));
assert.ok(
  "error" in
    normalizeMessageMarkPatch({ chapter: { title: "A", summary: "x".repeat(MAX_CHAPTER_SUMMARY_LENGTH + 1) } }),
);
assert.ok("error" in normalizeMessageMarkPatch({ chapter: "Chapter 1" }));
assert.deepEqual(normalizeMessageMarkPatch({ chapter: null }), { patch: { chapter: null } });
assert.deepEqual(normalizeMessageMarkPatch({ chapter: false }), { patch: { chapter: null } });
assert.equal(readMessageChapter(JSON.stringify({ chapter: { title: " " } })), null, "a blank title is no chapter");
assert.equal(readMessageChapter("not json"), null);
assert.deepEqual(readMessageChapter({ chapter: { title: "One", summary: "Sum" } }), {
  title: "One",
  summary: "Sum",
  createdAt: "",
});
assert.deepEqual(
  listMessageChapters([
    { id: "a", extra: "{}" },
    { id: "b", extra: JSON.stringify({ chapter: { title: "Two" } }) },
    { id: "c", extra: { chapter: null } },
  ]).map((item) => [item.message.id, item.messageNumber, item.chapter.title]),
  [["b", 2, "Two"]],
);

// ── Pure: story exports use chapters as headings, with a table of contents in HTML ──
const { renderTranscriptHtml, renderTranscriptMarkdown, listTranscriptChapters } =
  await import("../../packages/server/src/services/chat-insights/transcript-document.js");
const storyEntries = [
  {
    speakerKey: "user",
    speaker: "Player",
    role: "user",
    content: "Hello.",
    chapter: { title: "Arrival", summary: "We meet." },
  },
  { speakerKey: "character:a", speaker: "Tamsin", role: "assistant", content: "Welcome." },
  {
    speakerKey: "character:a",
    speaker: "Tamsin",
    role: "assistant",
    content: "Later.",
    chapter: { title: "The <Storm>" },
  },
];
assert.deepEqual(
  listTranscriptChapters(storyEntries).map((item) => [item.id, item.index]),
  [
    ["chapter-1", 0],
    ["chapter-2", 2],
  ],
);
const markdown = renderTranscriptMarkdown({ title: "Tale", entries: storyEntries });
assert.match(
  markdown,
  /## Arrival\n\n_We meet\._\n\n### Player/u,
  "Markdown opens a chapter with a heading and its summary",
);
assert.match(markdown, /## The \\<Storm\\>\n\n### Tamsin/u, "chapter titles are escaped");
assert.ok(markdown.indexOf("## Arrival") < markdown.indexOf("Welcome."));
const html = renderTranscriptHtml({ title: "Tale", entries: storyEntries });
assert.match(html, /<nav class="toc"[^>]*><h2 id="toc-title">Contents<\/h2><ol><li><a href="#chapter-1">Arrival<\/a>/u);
assert.match(html, /<a href="#chapter-2">The &lt;Storm&gt;<\/a>/u, "TOC entries are escaped");
assert.match(html, /<h2 class="chapter lead" id="chapter-1">Arrival<\/h2><p class="chapter-summary">We meet\.<\/p>/u);
assert.match(html, /<h2 class="chapter" id="chapter-2">/u);
assert.doesNotMatch(
  renderTranscriptHtml({ title: "Plain", entries: [storyEntries[1]!] }),
  /class="toc"/u,
  "no chapters, no TOC",
);

// ── Pure: the campaign log carries chapters and lists them ──
const log = await import("../../packages/client/src/lib/game-log.js");
const parse = (message: { content: string }) => [{ type: "narration" as const, content: message.content }];
const logEntries = log.buildGameLogEntries(
  {
    sessions: [
      {
        chatId: "s1",
        number: 1,
        name: "",
        playerName: null,
        segmentEdits: {},
        segmentDeletes: ["m2:0"],
        messages: [
          {
            id: "m1",
            number: 1,
            role: "assistant",
            content: "Dawn.",
            createdAt: "a",
            chapter: { title: "One", summary: null, messageId: "m1" },
          },
          // Every segment of m2 is deleted: its chapter starts at the next readable turn.
          {
            id: "m2",
            number: 2,
            role: "assistant",
            content: "Gone.",
            createdAt: "b",
            chapter: { title: "Two", summary: "S", messageId: "m2" },
          },
          { id: "m3", number: 3, role: "assistant", content: "Dusk.", createdAt: "c" },
        ],
      },
    ],
  },
  parse,
  { player: "You" },
);
assert.deepEqual(
  log
    .listLogChapters(logEntries)
    .map((item) => [item.entryIndex, item.entry.messageId, item.chapter.title, item.chapter.messageId]),
  [
    [0, "m1", "One", "m1"],
    [1, "m3", "Two", "m2"],
  ],
  "a chapter on a turn with nothing to read moves to the next turn but still edits its own message",
);
assert.deepEqual(
  log.findLogTarget(logEntries, { chatId: "s1", messageId: "m2", messageNumber: 2 }),
  { index: 1, exact: true },
  "jumping to a chapter stored on a hidden turn lands exactly on the turn that shows it",
);

// ── App: chapters survive edits, swipes, trash and branching; stay out of prompts; export ──
const dataDir = mkdtempSync(join(tmpdir(), "marinara-message-chapters-"));
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
  // Only the chat routes are mounted to stay well under the 30 s runner cap.
  const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
  const Fastify = requireServer("fastify") as typeof import("fastify").default;
  const { chatsRoutes } = await import("../../packages/server/src/routes/chats.routes.js");
  const { getDB } = await import("../../packages/server/src/db/connection.js");
  const { characters, chats } = await import("../../packages/server/src/db/schema/index.js");
  const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
  const { loadCampaignLog } = await import("../../packages/server/src/services/game/campaign-log.js");

  const db = await getDB();
  const fastify = Fastify();
  fastify.decorate("db", db);
  await fastify.register(chatsRoutes, { prefix: "/api/chats" });
  app = fastify as unknown as TestApp;
  await app.ready();
  const storage = createChatsStorage(db);
  const timestamp = "2026-09-01T00:00:00.000Z";
  await db.insert(characters).values({
    id: "char-ch",
    data: JSON.stringify({ name: "Ysolde" }),
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  for (const [id, mode] of [
    ["chat-ch", "roleplay"],
    ["game-ch", "game"],
  ] as const) {
    await db.insert(chats).values({
      id,
      name: id === "chat-ch" ? "Chapters" : "Chapter Game",
      mode,
      characterIds: JSON.stringify(["char-ch"]),
      metadata: JSON.stringify(mode === "game" ? { gameId: "game-ch", gameSessionNumber: 1 } : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }
  const createMessages = async (chatId: string, count: number) => {
    const ids: string[] = [];
    for (let index = 0; index < count; index++) {
      const created = await storage.createMessage(
        {
          chatId,
          role: index % 2 === 0 ? "user" : "assistant",
          characterId: index % 2 === 0 ? null : "char-ch",
          content: `LINE_${index + 1}_TEXT`,
        } as never,
        { createdAt: new Date(Date.parse(timestamp) + index * 60_000).toISOString() },
      );
      ids.push(created!.id);
    }
    return ids;
  };
  const ids = await createMessages("chat-ch", 6);
  const patchExtra = (chatId: string, messageId: string, body: Record<string, unknown>) =>
    app!.inject({ method: "PATCH", url: `/api/chats/${chatId}/messages/${messageId}/extra`, payload: body });
  const chapterOf = async (messageId: string) => readMessageChapter((await storage.getMessage(messageId))!.extra);

  const TITLE = "ChapterTitleSentinel7141";
  const SUMMARY = "ChapterSummarySentinel7142";
  assert.equal((await patchExtra("chat-ch", ids[1]!, { chapter: { title: TITLE, summary: SUMMARY } })).statusCode, 200);
  assert.equal((await patchExtra("chat-ch", ids[4]!, { chapter: { title: "Second" } })).statusCode, 200);
  assert.equal((await patchExtra("chat-ch", ids[2]!, { chapter: { title: "" } })).statusCode, 400, "bad chapters fail");

  const listed = await app.inject({ method: "GET", url: "/api/chats/chat-ch/chapters" });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.deepEqual(listed.json(), [
    { messageId: ids[1], messageNumber: 2, title: TITLE, summary: SUMMARY },
    { messageId: ids[4], messageNumber: 5, title: "Second", summary: null },
  ]);
  assert.equal((await app.inject({ method: "GET", url: "/api/chats/missing/chapters" })).statusCode, 404);

  // Edits and swipes keep the chapter: it belongs to the message, not one swipe.
  const edited = await app.inject({
    method: "PATCH",
    url: `/api/chats/chat-ch/messages/${ids[1]}`,
    payload: { content: "LINE_2_EDITED" },
  });
  assert.equal(edited.statusCode, 200, edited.body);
  assert.equal((await chapterOf(ids[1]!))?.title, TITLE, "chapter survives a message edit");
  await storage.addSwipe(ids[1]!, "LINE_2_ALT");
  await storage.setActiveSwipe(ids[1]!, 1);
  assert.equal((await chapterOf(ids[1]!))?.title, TITLE, "chapter survives switching to a new swipe");
  await storage.setActiveSwipe(ids[1]!, 0);
  assert.equal((await chapterOf(ids[1]!))?.title, TITLE, "chapter survives switching back");

  // Chapters never reach the prompt.
  const peek = await app.inject({ method: "POST", url: "/api/chats/chat-ch/peek-prompt", payload: {} });
  assert.equal(peek.statusCode, 200, peek.body);
  assert.match(peek.body, /LINE_2_EDITED/u, "the marked message itself is in the prompt");
  assert.doesNotMatch(peek.body, new RegExp(TITLE, "u"), "chapter titles never enter the prompt");
  assert.doesNotMatch(peek.body, new RegExp(SUMMARY, "u"), "chapter summaries never enter the prompt");

  // Story exports use the chapters.
  const markdownExport = await app.inject({ method: "GET", url: "/api/chats/chat-ch/export?format=markdown" });
  assert.equal(markdownExport.statusCode, 200, markdownExport.body);
  assert.match(markdownExport.body, new RegExp(`## ${TITLE}\\n\\n_${SUMMARY}_`, "u"));
  const htmlExport = await app.inject({ method: "GET", url: "/api/chats/chat-ch/export?format=html" });
  assert.equal(htmlExport.statusCode, 200);
  assert.match(htmlExport.body, new RegExp(`<a href="#chapter-1">${TITLE}</a>`, "u"), "HTML export has a TOC");
  assert.match(htmlExport.body, /<h2 class="chapter" id="chapter-2">Second<\/h2>/u);

  // Branching copies the chapter with the message extra.
  const branch = await app.inject({
    method: "POST",
    url: "/api/chats/chat-ch/branch",
    payload: { upToMessageId: ids[3] },
  });
  assert.equal(branch.statusCode, 200, branch.body);
  const branchId = (branch.json() as { id: string }).id;
  const branchChapters = (await app.inject({ method: "GET", url: `/api/chats/${branchId}/chapters` })).json();
  assert.deepEqual(
    branchChapters.map((item: { title: string; messageNumber: number }) => [item.title, item.messageNumber]),
    [[TITLE, 2]],
    "a branch keeps the chapters of the messages it copies",
  );

  // Trash and restore move the chapter with the message.
  assert.equal((await app.inject({ method: "DELETE", url: `/api/chats/chat-ch/messages/${ids[1]}` })).statusCode, 204);
  assert.deepEqual(
    (await app.inject({ method: "GET", url: "/api/chats/chat-ch/chapters" }))
      .json()
      .map((item: { title: string }) => item.title),
    ["Second"],
    "a trashed message's chapter leaves the list",
  );
  const trash = (await app.inject({ method: "GET", url: "/api/chats/chat-ch/trash" })).json() as Array<{ id: string }>;
  const restored = await app.inject({
    method: "POST",
    url: "/api/chats/chat-ch/trash/restore",
    payload: { entryIds: trash.map((entry) => entry.id) },
  });
  assert.equal(restored.statusCode, 200, restored.body);
  assert.deepEqual(
    (await app.inject({ method: "GET", url: "/api/chats/chat-ch/chapters" }))
      .json()
      .map((item: { title: string }) => item.title),
    [TITLE, "Second"],
    "restoring the message brings its chapter back",
  );

  // Removing a chapter.
  assert.equal((await patchExtra("chat-ch", ids[4]!, { chapter: null })).statusCode, 200);
  assert.equal(await chapterOf(ids[4]!), null);

  // Game mode: chapters marked on a session turn appear in the campaign log.
  const gameIds = await createMessages("game-ch", 3);
  assert.equal((await patchExtra("game-ch", gameIds[1]!, { chapter: { title: "Into the Dark" } })).statusCode, 200);
  const campaign = await loadCampaignLog(db, "game-ch");
  assert.ok(campaign);
  const marked = campaign.sessions[0]!.messages.find((message) => message.id === gameIds[1]);
  assert.deepEqual(marked?.chapter, { title: "Into the Dark", summary: null, messageId: gameIds[1] });
  assert.equal(
    campaign.sessions[0]!.messages.filter((message) => message.chapter).length,
    1,
    "only the marked turn carries a chapter",
  );
} finally {
  await app?.close();
  rmSync(dataDir, { recursive: true, force: true });
}

process.stdout.write("Message chapters regression passed.\n");
