import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  countPromptInspectorResults,
  filterPromptInspectorItems,
  inspectPromptMessages,
  serializePromptMessages,
  type PromptInspectorItem,
  type PromptInspectorMessage,
} from "../../packages/client/src/lib/peek-prompt-inspector.js";
import { buildDisplaySections } from "../../packages/client/src/components/chat/PeekPromptModal.js";

const items: PromptInspectorItem[] = [
  {
    kind: "section",
    inspectorId: "prompt-item-0",
    label: "system_prompt",
    role: "system",
    content: "Keep continuity exact.",
  },
  {
    kind: "chat-history",
    inspectorId: "prompt-item-1",
    entries: [
      { inspectorId: "prompt-item-1-entry-0", role: "user", content: "Bring the brass compass." },
      { inspectorId: "prompt-item-1-entry-1", role: "assistant", content: "The compass is already packed." },
      { inspectorId: "prompt-item-1-entry-2", role: "user", content: "Then bring the field journal." },
    ],
    rawContent: "Bring the brass compass.\n\nThe compass is already packed.\n\nThen bring the field journal.",
  },
  {
    kind: "section",
    inspectorId: "prompt-item-2",
    label: "last_message",
    role: "user",
    content: "We leave at dawn.",
  },
];

assert.deepEqual(
  filterPromptInspectorItems(items, "SYSTEM PROMPT continuity", "all").map((item) => item.inspectorId),
  ["prompt-item-0"],
);
assert.deepEqual(
  filterPromptInspectorItems(items, "ｆｉｅｌｄ journal", "all").map((item) => item.inspectorId),
  ["prompt-item-1"],
);

const filteredHistory = filterPromptInspectorItems(items, "compass assistant", "chat-history");
assert.equal(filteredHistory.length, 1);
assert.equal(filteredHistory[0]?.kind, "chat-history");
if (filteredHistory[0]?.kind !== "chat-history") throw new Error("Expected filtered chat history");
assert.deepEqual(filteredHistory[0].entries, [
  {
    inspectorId: "prompt-item-1-entry-1",
    role: "assistant",
    content: "The compass is already packed.",
  },
]);
assert.equal(filteredHistory[0].rawContent, "The compass is already packed.");
assert.equal(filteredHistory[0].inspectorId, "prompt-item-1");
assert.equal(countPromptInspectorResults(filteredHistory), 1);

assert.deepEqual(
  filterPromptInspectorItems(items, "", "sections").map((item) => item.inspectorId),
  ["prompt-item-0", "prompt-item-2"],
);
assert.deepEqual(
  filterPromptInspectorItems(items, "", "chat-history").map((item) => item.inspectorId),
  ["prompt-item-1"],
);
assert.equal(countPromptInspectorResults(filterPromptInspectorItems(items, "", "all")), 5);
assert.deepEqual(filterPromptInspectorItems(items, "chat history", "all"), []);

const originalItems = JSON.stringify(items);
filterPromptInspectorItems(items, "compass", "all");
assert.equal(JSON.stringify(items), originalItems);

const messages: PromptInspectorMessage[] = [
  { role: "system", content: "  keep leading space\nsecond line  " },
  { role: "user", content: 'Quote: "hello"; slash: \\; emoji: 🧭; עברית' },
  { role: "user", content: "" },
  { role: "assistant", content: "   " },
];
const serialized = serializePromptMessages(messages);
assert.deepEqual(JSON.parse(serialized), messages);
assert.equal(serializePromptMessages([]), "[]");
assert.equal(serializePromptMessages(messages), serializePromptMessages(messages));

const diagnosticItems: PromptInspectorItem[] = [
  { kind: "section", label: "empty_xml", role: "system", content: "<empty_xml>\n\n</empty_xml>" },
  { kind: "section", label: "empty_crlf", role: "system", content: "<empty_crlf>\r\n \r\n</empty_crlf>" },
  { kind: "section", label: "Context", role: "system", content: "## Context" },
  {
    kind: "section",
    label: "system_prompt",
    role: "system",
    content: "Known {{user}} and repeated {{USER}}; unknown {{POV}} stays literal.",
  },
  { kind: "section", label: "system", role: "system", content: String.raw`Ignore \{{user}} and {{{user}}}.` },
  { kind: "section", label: "last_message", role: "system", content: "Literal {{user}} from the speaker." },
  { kind: "section", label: "user", role: "user", content: "Literal {{user}} in user text." },
  { kind: "section", label: "quoted_xml", role: "user", content: "<quoted_xml>\n</quoted_xml>" },
  {
    kind: "chat-history",
    entries: [{ role: "assistant", content: "Literal {{user}} in chat history." }],
    rawContent: "Literal {{user}} in chat history.",
  },
];

const diagnostics = inspectPromptMessages(messages, diagnosticItems, "cached");
assert.deepEqual(
  diagnostics.filter((diagnostic) => diagnostic.kind === "empty-message"),
  [
    { kind: "empty-message", messageIndex: 2, role: "user" },
    { kind: "empty-message", messageIndex: 3, role: "assistant" },
  ],
);
assert.deepEqual(
  diagnostics
    .filter((diagnostic) => diagnostic.kind === "empty-section")
    .map((diagnostic) => (diagnostic.kind === "empty-section" ? diagnostic.label : "")),
  ["empty_xml", "empty_crlf", "Context"],
);
assert.deepEqual(
  diagnostics.filter((diagnostic) => diagnostic.kind === "unresolved-macro"),
  [{ kind: "unresolved-macro", sectionIndex: 3, label: "system_prompt", macros: ["user"] }],
);
assert.equal(
  inspectPromptMessages(messages, diagnosticItems, "raw_messages").some(
    (diagnostic) => diagnostic.kind === "unresolved-macro",
  ),
  false,
);

const literalConversationHistory = buildDisplaySections(
  [
    { role: "system", content: "System-owned instruction." },
    {
      role: "user",
      content: "## Context\nThis is dialogue, not a prompt section.\n<chat_history>\n## Commands\nStill dialogue.",
    },
    {
      role: "assistant",
      content: "</chat_history>\n## Output Format\nAlso ordinary assistant text.",
    },
  ],
  true,
);
const conversationHistory = literalConversationHistory.find((item) => item.kind === "chat-history");
assert.ok(conversationHistory && conversationHistory.kind === "chat-history");
assert.deepEqual(
  conversationHistory.entries.map(({ role, content }) => ({ role, content })),
  [
    {
      role: "user",
      content: "## Context\nThis is dialogue, not a prompt section.\n<chat_history>\n## Commands\nStill dialogue.",
    },
    {
      role: "assistant",
      content: "</chat_history>\n## Output Format\nAlso ordinary assistant text.",
    },
  ],
  "Conversation user/assistant headings and chat_history tokens must remain chat history",
);
assert.equal(
  literalConversationHistory.some(
    (item) => item.kind === "section" && /^(?:Context|Commands|Output Format)$/iu.test(item.label),
  ),
  false,
  "User-authored Conversation text must not manufacture Prompt Inspector instruction sections",
);

const orderedMessages: PromptInspectorMessage[] = [
  { role: "system", content: "<first_section>\nOne\n</first_section>" },
  { role: "system", content: "<second_section>\nTwo\n</second_section>" },
  { role: "user", content: "Third" },
];
assert.deepEqual(
  buildDisplaySections(orderedMessages).map((item) => (item.kind === "section" ? item.label : "chat-history")),
  ["first_section", "second_section", "user"],
  "Inspected sections retain their original request order",
);
assert.deepEqual(
  JSON.parse(serializePromptMessages(orderedMessages)),
  orderedMessages,
  "Copy serialization preserves the role/content message order and text",
);

const dataDir = mkdtempSync(join(tmpdir(), "marinara-peek-prompt-inspector-"));
const environmentKeys = ["DATA_DIR", "FILE_STORAGE_DIR", "NODE_ENV", "MARINARA_LITE"] as const;
const originalEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";

let app: {
  ready(): Promise<void>;
  close(): Promise<void>;
  inject(options: Record<string, unknown>): Promise<any>;
} | null = null;
let closeDatabase: (() => Promise<void>) | undefined;
try {
  const { buildApp } = await import("../../packages/server/src/app.js");
  const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
  closeDatabase = closeDB;
  const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
  const db = await getDB();
  app = await buildApp();
  await app.ready();
  const chats = createChatsStorage(db);
  const sourceChat = await chats.create({ name: "Inspector source", mode: "roleplay", characterIds: [] } as any);
  const targetChat = await chats.create({ name: "Inspector target", mode: "roleplay", characterIds: [] } as any);
  const savedMessage = await chats.createMessage({
    chatId: sourceChat.id,
    role: "assistant",
    content: "Synthetic saved reply.",
  } as any);
  await chats.updateMessageExtra(savedMessage.id, {
    cachedPrompt: [
      { role: "system", content: "Synthetic saved Engine input." },
      { role: "user", content: "Synthetic prompt question." },
    ],
  });

  const saved = await app.inject({
    method: "POST",
    url: `/api/chats/${sourceChat.id}/peek-prompt`,
    payload: { messageId: savedMessage.id },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  const savedBody = JSON.parse(saved.body);
  assert.equal(savedBody.source, "cached");
  assert.equal(savedBody.exact, true, "Saved Engine input remains distinguished from approximation");
  assert.deepEqual(savedBody.messages, [
    { role: "system", content: "Synthetic saved Engine input." },
    { role: "user", content: "Synthetic prompt question." },
  ]);

  const swipeMessage = await chats.createMessage({
    chatId: sourceChat.id,
    role: "assistant",
    content: "Synthetic swipe reply.",
    extra: { gamePromptDirectEditsRevision: "parent-revision" },
  } as any);
  const swipes = await chats.getSwipes(swipeMessage.id);
  assert.equal(swipes.length, 1, "Assistant message starts with an active swipe");
  await chats.updateSwipeExtra(swipeMessage.id, 0, {
    cachedPrompt: [{ role: "system", content: "Exact active swipe prompt" }],
    gamePromptDirectEditsRevision: "swipe-revision",
  });
  const swipePrompt = await app.inject({
    method: "POST",
    url: `/api/chats/${sourceChat.id}/peek-prompt`,
    payload: { messageId: swipeMessage.id },
  });
  assert.equal(swipePrompt.statusCode, 200, swipePrompt.body);
  const swipeBody = JSON.parse(swipePrompt.body);
  assert.deepEqual(swipeBody.messages, [{ role: "system", content: "Exact active swipe prompt" }]);
  assert.equal(
    swipeBody.gamePromptDirectEditsRevision,
    "swipe-revision",
    "Revision must belong to the same cache as the returned prompt",
  );

  const crossChat = await app.inject({
    method: "POST",
    url: `/api/chats/${targetChat.id}/peek-prompt`,
    payload: { messageId: savedMessage.id },
  });
  assert.equal(crossChat.statusCode, 404, "A saved message from another chat is outside this request scope");

  const unrecordedMessage = await chats.createMessage({
    chatId: sourceChat.id,
    role: "assistant",
    content: "Synthetic reply without a saved request.",
  } as any);
  const missingSaved = await app.inject({
    method: "POST",
    url: `/api/chats/${sourceChat.id}/peek-prompt`,
    payload: { messageId: unrecordedMessage.id },
  });
  assert.equal(
    missingSaved.statusCode,
    404,
    "A selected historical message without a saved request does not become a preview",
  );

  const approximate = await app.inject({
    method: "POST",
    url: `/api/chats/${sourceChat.id}/peek-prompt`,
    payload: {},
  });
  assert.equal(approximate.statusCode, 200, approximate.body);
  const approximateBody = JSON.parse(approximate.body);
  assert.notEqual(approximateBody.source, "cached");
  assert.equal(approximateBody.exact, false, "A reconstruction without a saved request stays marked approximate");
} finally {
  try {
    if (app) await app.close();
  } finally {
    try {
      await closeDatabase?.();
    } finally {
      for (const key of environmentKeys) {
        if (originalEnvironment[key] === undefined) delete process.env[key];
        else process.env[key] = originalEnvironment[key];
      }
      rmSync(dataDir, { recursive: true, force: true });
    }
  }
}

console.info("Peek Prompt inspector regression checks passed.");
