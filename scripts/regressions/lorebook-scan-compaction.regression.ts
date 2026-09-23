import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every generated message stored the full text of every activated lorebook entry, in the message and again in
// each swipe: 184 MB of one 192 MB chat shard, kept resident and pushing the server to its heap limit. Only the
// newest generation's message row may keep entry text; every other stored scan keeps ids, keys and scores.
const directory = mkdtempSync(join(tmpdir(), "marinara-lorebook-scan-compaction-"));
process.env.DATA_DIR = directory;
process.env.LOG_LEVEL = "silent";
process.env.LOG_FILE_LEVEL = "silent";

const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { compactLorebookScan, lorebookScanHasContent } = await import(
  "../../packages/server/src/services/lorebook/lorebook-scan-compaction.js"
);

const scan = (label: string) => ({
  activatedEntries: [
    {
      id: "entry-1",
      name: "Harbour",
      content: `${label} `.repeat(2000),
      matchedKeys: ["harbour"],
      activationSources: ["keyword"],
      matchType: "keyword",
    },
    { id: "entry-2", content: "Short", matchedKeys: [], activationSources: ["semantic"], semanticScore: 0.8 },
  ],
  budgetSkippedEntries: [],
  totalTokensEstimate: 1234,
  totalEntries: 2,
});

const compact = compactLorebookScan(scan("x"));
assert.equal(lorebookScanHasContent(compact), false);
assert.deepEqual(
  compact.activatedEntries.map((entry) => ({ ...entry })),
  [
    { id: "entry-1", name: "Harbour", matchedKeys: ["harbour"], activationSources: ["keyword"], matchType: "keyword" },
    { id: "entry-2", matchedKeys: [], activationSources: ["semantic"], semanticScore: 0.8 },
  ],
  "compaction keeps ids, names, keys, sources and scores",
);
assert.equal(compact.totalTokensEstimate, 1234);

const db = await createFileNativeDB();
const chats = createChatsStorage(db);
const extraOf = (row: { extra?: unknown } | null | undefined) =>
  JSON.parse(typeof row?.extra === "string" ? row.extra : "{}") as Record<string, any>;
try {
  const chat = await chats.create({ name: "Scan proof", mode: "roleplay", characterIds: [] });
  assert(chat);
  const first = await chats.createMessage({ chatId: chat.id, role: "assistant", content: "One", characterId: null });
  assert(first);
  await chats.updateMessageExtra(first.id, { lorebookScan: scan("first") });

  let firstRow = await chats.getMessage(first.id);
  assert.equal(lorebookScanHasContent(extraOf(firstRow).lorebookScan), true, "the newest message keeps entry text");
  let firstSwipe = (await chats.getSwipes(first.id))[0];
  assert.equal(lorebookScanHasContent(extraOf(firstSwipe).lorebookScan), false, "its swipe keeps only the summary");
  assert.equal(extraOf(firstSwipe).lorebookScan.activatedEntries[0].id, "entry-1");

  // A regenerated swipe of the same message: the new swipe and the old swipe both stay compact.
  await chats.addSwipe(first.id, "One, again");
  const regenerated = await chats.getMessage(first.id);
  await chats.updateMessageExtraForSwipe(first.id, regenerated!.activeSwipeIndex, { lorebookScan: scan("regen") });
  for (const swipe of await chats.getSwipes(first.id))
    assert.equal(lorebookScanHasContent(extraOf(swipe).lorebookScan), false, `swipe ${swipe.index} is compact`);
  firstRow = await chats.getMessage(first.id);
  assert.match(extraOf(firstRow).lorebookScan.activatedEntries[0].content, /^regen /u);

  // The next generation takes over: the older message row is compacted as well.
  const second = await chats.createMessage({ chatId: chat.id, role: "assistant", content: "Two", characterId: null });
  assert(second);
  await chats.updateMessageExtra(second.id, { lorebookScan: scan("second"), other: 1 });
  firstRow = await chats.getMessage(first.id);
  assert.equal(lorebookScanHasContent(extraOf(firstRow).lorebookScan), false, "older message rows are compacted");
  assert.equal(extraOf(firstRow).lorebookScan.totalEntries, 2);
  const secondRow = await chats.getMessage(second.id);
  assert.equal(lorebookScanHasContent(extraOf(secondRow).lorebookScan), true);
  assert.equal(extraOf(secondRow).other, 1);
  firstSwipe = (await chats.getSwipes(first.id))[0];
  assert.equal(lorebookScanHasContent(extraOf(firstSwipe).lorebookScan), false);

  // Unrelated extra updates do not touch other messages.
  await chats.updateMessageExtra(first.id, { hiddenFromAI: true });
  assert.equal(lorebookScanHasContent(extraOf(await chats.getMessage(second.id)).lorebookScan), true);
} finally {
  await db._fileStore.close();
  rmSync(directory, { recursive: true, force: true });
}

// Readers fall back to the stored entry text when a scan has none.
const lorebooksRoute = readFileSync(
  new URL("../../packages/server/src/routes/lorebooks.routes.ts", import.meta.url),
  "utf8",
);
assert.match(lorebooksRoute, /\.\.\.\(typeof candidate\.content === "string" \? \{ content: candidate\.content \} : \{\}\)/u);
assert.match(lorebooksRoute, /resolvedContentById\.get\(String\(\(e as Record<string, unknown>\)\.id\)\) \?\?/u);
const retryRoute = readFileSync(
  new URL("../../packages/server/src/routes/generate/retry-agents-route.ts", import.meta.url),
  "utf8",
);
assert.match(retryRoute, /storedLoreContentById\.set\(id, stored\.content\)/u);

console.log("lorebook-scan-compaction regression passed");
