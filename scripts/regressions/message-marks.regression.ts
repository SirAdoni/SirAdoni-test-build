import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_PINNED_CONTEXT_MESSAGES,
  PINNED_CONTEXT_MESSAGE_MARKER,
  applyContextMessageLimitWithPins,
  normalizeMessageMarkPatch,
  stripPrivateMessageNote,
} from "../../packages/shared/src/utils/message-marks.js";

// ── Pure: context message limit keeps pinned messages ──
type Row = { id: string; content: string; extra: string };
const row = (id: string, pinned = false): Row => ({
  id,
  content: `content ${id}`,
  extra: JSON.stringify(pinned ? { pinnedToContext: true } : {}),
});
const history = Array.from({ length: 12 }, (_, index) =>
  row(`m${index + 1}`, index === 1 || index === 4 || index === 9),
);

assert.deepEqual(
  applyContextMessageLimitWithPins(history, null).map((message) => message.id),
  history.map((message) => message.id),
  "no limit keeps everything",
);
assert.deepEqual(
  applyContextMessageLimitWithPins(history, 20).map((message) => message.id),
  history.map((message) => message.id),
  "a limit above the history length keeps everything",
);
const limited = applyContextMessageLimitWithPins(history, 4);
assert.deepEqual(
  limited.map((message) => message.id),
  ["m2", "m5", "m9", "m10", "m11", "m12"],
  "pinned rows the limit dropped come back first, in chronological order, before the kept window",
);
assert.equal(limited[0]!.content, `${PINNED_CONTEXT_MESSAGE_MARKER}\ncontent m2`, "restored pins are marked");
assert.equal(limited[2], history[8], "rows inside the window are returned untouched");
assert.equal(limited[3]!.content, "content m10", "a pin inside the window is not marked twice");
assert.equal(history[1]!.content, "content m2", "marking never mutates the stored row");
assert.deepEqual(
  applyContextMessageLimitWithPins(history, 4, 1).map((message) => message.id),
  ["m5", "m9", "m10", "m11", "m12"],
  "the pin cap keeps the newest trimmed pins",
);
const manyPins = Array.from({ length: 30 }, (_, index) => row(`p${index}`, true));
assert.equal(
  applyContextMessageLimitWithPins(manyPins, 5).length,
  5 + MAX_PINNED_CONTEXT_MESSAGES,
  "restored pins never exceed the default cap",
);

assert.deepEqual(applyContextMessageLimitWithPins(history, 0.5), history, "a positive fractional limit that floors to zero keeps the full history");
// ── Pure: mark patch validation and note stripping ──
const fixedNow = () => "2026-09-22T00:00:00.000Z";
assert.deepEqual(normalizeMessageMarkPatch({ bookmark: true }, fixedNow), {
  patch: { bookmark: { label: null, createdAt: "2026-09-22T00:00:00.000Z" } },
});
const longLabel = normalizeMessageMarkPatch({ bookmark: { label: `  ${"x".repeat(200)} ` } }, fixedNow);
assert.ok("patch" in longLabel && (longLabel.patch.bookmark as { label: string }).label.length === 80);
assert.deepEqual(normalizeMessageMarkPatch({ bookmark: null }), { patch: { bookmark: null } });
assert.ok("error" in normalizeMessageMarkPatch({ bookmark: "yes" }));
assert.ok("error" in normalizeMessageMarkPatch({ pinnedToContext: "true" }));
assert.ok("error" in normalizeMessageMarkPatch({ privateNote: "x".repeat(2001) }));
assert.deepEqual(normalizeMessageMarkPatch({ privateNote: "   " }), { patch: { privateNote: null } });
assert.deepEqual(normalizeMessageMarkPatch({ hiddenFromAI: true }), { patch: { hiddenFromAI: true } });
assert.deepEqual(stripPrivateMessageNote({ a: 1, privateNote: "secret" }), { a: 1 });

// ── App: pins survive the history limit in Peek Prompt; private notes never reach prompts or exports ──
const dataDir = mkdtempSync(join(tmpdir(), "marinara-message-marks-"));
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
  const { characters, chats } = await import("../../packages/server/src/db/schema/index.js");
  const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");

  const db = await getDB();
  const fastify = Fastify();
  fastify.decorate("db", db);
  await fastify.register(chatsRoutes, { prefix: "/api/chats" });
  app = fastify as unknown as TestApp;
  await app.ready();
  const storage = createChatsStorage(db);
  const timestamp = "2026-09-01T00:00:00.000Z";
  await db.insert(characters).values({
    id: "char-marks",
    data: JSON.stringify({ name: "Pima" }),
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  await db.insert(chats).values({
    id: "chat-marks",
    name: "Marks",
    mode: "roleplay",
    characterIds: JSON.stringify(["char-marks"]),
    metadata: JSON.stringify({ contextMessageLimit: 4 }),
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const ids: string[] = [];
  for (let index = 0; index < 12; index++) {
    const created = await storage.createMessage(
      {
        chatId: "chat-marks",
        role: index % 2 === 0 ? "user" : "assistant",
        characterId: index % 2 === 0 ? null : "char-marks",
        content: `LINE_${index + 1}_TEXT`,
      } as never,
      { createdAt: new Date(Date.parse(timestamp) + index * 60_000).toISOString() },
    );
    ids.push(created!.id);
  }
  const patchExtra = (messageId: string, body: Record<string, unknown>) =>
    app!.inject({ method: "PATCH", url: `/api/chats/chat-marks/messages/${messageId}/extra`, payload: body });

  const NOTE_SENTINEL = "PRIVATE_MESSAGE_NOTE_SENTINEL_5519";
  assert.equal((await patchExtra(ids[1]!, { pinnedToContext: true })).statusCode, 200);
  assert.equal(
    (await patchExtra(ids[2]!, { privateNote: NOTE_SENTINEL, bookmark: { label: "Oath" } })).statusCode,
    200,
  );
  assert.equal((await patchExtra(ids[3]!, { pinnedToContext: "yes" })).statusCode, 400, "bad pin payloads fail");

  // Marks are message-level: they survive swipe changes.
  await storage.addSwipe(ids[1]!, "LINE_2_ALT");
  await storage.setActiveSwipe(ids[1]!, 1);
  await storage.setActiveSwipe(ids[1]!, 0);
  const pinnedAfterSwipes = JSON.parse((await storage.getMessage(ids[1]!))!.extra);
  assert.equal(pinnedAfterSwipes.pinnedToContext, true, "pin survives switching swipes");

  const peek = await app.inject({ method: "POST", url: "/api/chats/chat-marks/peek-prompt", payload: {} });
  assert.equal(peek.statusCode, 200, peek.body);
  const peekText = peek.body;
  assert.match(peekText, /LINE_2_TEXT/u, "Peek Prompt includes the pinned message past the history limit");
  assert.ok(
    peekText.includes(JSON.stringify(PINNED_CONTEXT_MESSAGE_MARKER).slice(1, -1)),
    "the restored pin is marked in the prompt",
  );
  assert.doesNotMatch(peekText, /LINE_4_TEXT/u, "unpinned messages past the limit stay trimmed");
  assert.doesNotMatch(peekText, new RegExp(NOTE_SENTINEL, "u"), "private notes never enter the prompt");

  // Pin cap: the (MAX + 1)th pin is refused.
  for (let index = 3; index < 3 + MAX_PINNED_CONTEXT_MESSAGES - 1; index++) {
    assert.equal((await patchExtra(ids[index]!, { pinnedToContext: true })).statusCode, 200);
  }
  assert.equal((await patchExtra(ids[0]!, { pinnedToContext: true })).statusCode, 409, "pin cap is enforced");
  assert.equal((await patchExtra(ids[1]!, { pinnedToContext: true })).statusCode, 200, "re-pinning is allowed");

  // Exports leave private notes out unless asked.
  const plainExport = await app.inject({ method: "GET", url: "/api/chats/chat-marks/export?format=jsonl" });
  assert.equal(plainExport.statusCode, 200);
  assert.doesNotMatch(plainExport.body, new RegExp(NOTE_SENTINEL, "u"), "JSONL export omits notes by default");
  const textExport = await app.inject({ method: "GET", url: "/api/chats/chat-marks/export?format=text" });
  assert.doesNotMatch(textExport.body, new RegExp(NOTE_SENTINEL, "u"), "text export omits notes by default");
  const noteExport = await app.inject({
    method: "GET",
    url: "/api/chats/chat-marks/export?format=text&includePrivateNotes=true",
  });
  assert.match(noteExport.body, new RegExp(NOTE_SENTINEL, "u"), "notes export when the user opts in");
} finally {
  await app?.close();
  rmSync(dataDir, { recursive: true, force: true });
}

process.stdout.write("Message marks regression passed.\n");
