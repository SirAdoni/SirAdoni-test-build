import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileNativeDB } from "../../packages/server/src/db/file-backed-store.js";
import { chats, memoryChunks } from "../../packages/server/src/db/schema/index.js";
import {
  buildMemoryRecallBlock,
  buildMemoryRecallQuery,
  GAME_MEMORY_TRANSCRIPT_PREFIX,
  injectMemoryRecallContext,
  resolveGameMemoryRecallCutoff,
} from "../../packages/server/src/services/generation/memory-recall-context.js";

const retainedHistory = [
  { id: "old", createdAt: "2026-09-01T00:00:00.000Z" },
  { id: "visible", createdAt: "2026-09-03T00:00:00.000Z" },
  { id: "latest", createdAt: "2026-09-04T00:00:00.000Z" },
];

const finalMessages = [
  { role: "system" as const, content: "GM rules" },
  {
    role: "assistant" as const,
    content: "The current scene is in the grove.",
    id: "visible",
    contextKind: "history" as const,
  },
  {
    role: "user" as const,
    content: "Please ask Corvina to bring you to Wynne.",
    id: "latest",
    contextKind: "history" as const,
  },
];

assert.equal(
  resolveGameMemoryRecallCutoff(finalMessages, retainedHistory),
  "2026-09-03T00:00:00.000Z",
  "the oldest retained prompt history becomes the recall cutoff, excluding already-visible chunks while keeping older memory available",
);
assert.equal(
  resolveGameMemoryRecallCutoff(finalMessages, retainedHistory, "2026-09-02T00:00:00.000Z"),
  "2026-09-02T00:00:00.000Z",
  "an earlier regeneration cutoff wins over the retained-history cutoff",
);
assert.equal(
  resolveGameMemoryRecallCutoff(
    [{ role: "assistant", content: "No stable identity", contextKind: "history" }],
    retainedHistory,
  ),
  null,
  "missing history identity cannot invent a timestamp",
);

const gameQuery = buildMemoryRecallQuery(
  [
    { role: "assistant", content: "Corvina waits beside the old grove gate." },
    { role: "user", content: "Please ask Corvina to bring you to Wynne." },
  ],
  true,
);
assert.match(gameQuery ?? "", /Recent assistant scene context:/u);
assert.match(gameQuery ?? "", /Current user input:\nPlease ask Corvina to bring you to Wynne\./u);
assert.ok(
  (gameQuery ?? "").indexOf("Current user input:") < (gameQuery ?? "").indexOf("Recent assistant scene context:"),
);
const boundedGameQuery = buildMemoryRecallQuery(
  [
    { role: "assistant", content: "x".repeat(2_000) },
    { role: "user", content: "Now." },
  ],
  true,
);
assert.ok(
  (boundedGameQuery ?? "").length <= "Current user input:\nNow.\n\nRecent assistant scene context:\n".length + 603,
  "Game query bounds assistant context while keeping the full current input first",
);

const nonGameQuery = buildMemoryRecallQuery(
  [
    { role: "assistant", content: "Earlier assistant context." },
    { role: "user", content: "Current request." },
  ],
  false,
);
assert.equal(nonGameQuery, "Current request.", "non-game recall keeps the legacy user-only query");

const gameBlock = buildMemoryRecallBlock(["Wynne was met in an earlier scene."], "xml", undefined, true);
assert.match(gameBlock, /historical game transcript/u);
assert.match(gameBlock, /do not establish the current location/u);
assert.match(gameBlock, /Preserve the user's current agency/u);

const tempStorage = mkdtempSync(join(tmpdir(), "marinara-memory-recall-context-"));
process.env.FILE_STORAGE_DIR = tempStorage;
const db = await createFileNativeDB();
try {
  await db.insert(chats).values({ id: "recall-context", name: "Recall context", mode: "game" });
  const vectorSpace = "test:recall-context:v1";
  const rows = [
    ...Array.from({ length: 8 }, (_, index) => ({
      id: `visible-${index}`,
      firstMessageAt: `2026-09-03T00:0${index}:00.000Z`,
      lastMessageAt: `2026-09-03T00:0${index}:30.000Z`,
      score: 1 - index * 0.05,
      content: `Visible historical scene ${index}`,
    })),
    {
      id: "older-9th",
      firstMessageAt: "2026-09-01T00:00:00.000Z",
      lastMessageAt: "2026-09-01T00:00:30.000Z",
      score: 0.55,
      content: "Older historical scene that must remain available to the GM",
    },
    {
      id: "invalid-date",
      firstMessageAt: "not-a-date",
      lastMessageAt: "2026-09-02T00:00:30.000Z",
      score: 0.99,
      content: "Invalid timestamp candidate",
    },
    {
      id: "reversed-date",
      firstMessageAt: "2026-09-04T00:00:30.000Z",
      lastMessageAt: "2026-09-04T00:00:00.000Z",
      score: 0.98,
      content: "Reversed timestamp candidate",
    },
  ];
  for (const row of rows) {
    const angle = Math.sqrt(Math.max(0, 1 - row.score * row.score));
    await db.insert(memoryChunks).values({
      id: row.id,
      chatId: "recall-context",
      content: `${GAME_MEMORY_TRANSCRIPT_PREFIX}\n${row.content}`,
      embedding: JSON.stringify([row.score, angle]),
      embeddingSpaceId: vectorSpace,
      messageCount: 5,
      sourceChatId: null,
      firstMessageAt: row.firstMessageAt,
      lastMessageAt: row.lastMessageAt,
      createdAt: "2026-09-05T00:00:00.000Z",
    });
  }

  let embeddingCalls = 0;
  const embeddingSource = {
    spaceId: vectorSpace,
    label: "test recall context",
    async embed(texts: string[]) {
      embeddingCalls += 1;
      assert.equal(texts.length, 1, "one recall query embedding is generated");
      return [[1, 0]];
    },
  };
  const currentInputMessages = [
    { role: "assistant" as const, content: "A".repeat(2_000) },
    { role: "user" as const, content: "Please ask Corvina to bring you to Wynne." },
  ];
  const injected: Array<{ role: "system"; content: string }> = [];
  const agentLines = await injectMemoryRecallContext({
    db,
    messages: injected,
    currentInputMessages,
    chatId: "recall-context",
    embeddingSource,
    excludeFromMessageAt: null,
    injectionExcludeFromMessageAt: "2026-09-03T00:00:00.000Z",
    contextLimit: 100_000,
    sendProgress: () => undefined,
    wrapFormat: "none",
    gameMode: true,
  });
  assert.equal(embeddingCalls, 1, "Game recall retrieves candidates with exactly one embedding call");
  assert.equal(agentLines.length, 8, "agent return receives the first eight globally ranked valid candidates");
  assert.equal(
    agentLines.some((line) => line.includes("older-9th")),
    false,
  );
  assert.equal(injected.length, 1);
  assert.match(
    injected[0]!.content,
    new RegExp(GAME_MEMORY_TRANSCRIPT_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"),
  );
  assert.match(injected[0]!.content, /Older historical scene that must remain available/u);
  assert.match(injected[0]!.content, /recorded chat time: 2026-09-01/u);
  assert.doesNotMatch(injected[0]!.content, /Visible historical scene 0/u);
  assert.doesNotMatch(injected[0]!.content, /Invalid timestamp candidate|Reversed timestamp candidate/u);

  const noGmInjection: Array<{ role: "system"; content: string }> = [];
  const agentOnly = await injectMemoryRecallContext({
    db,
    messages: noGmInjection,
    currentInputMessages: [{ role: "user", content: "Current request" }],
    chatId: "recall-context",
    embeddingSource,
    excludeFromMessageAt: null,
    injectionExcludeFromMessageAt: "2026-08-01T00:00:00.000Z",
    contextLimit: 100_000,
    sendProgress: () => undefined,
    wrapFormat: "none",
    gameMode: true,
  });
  assert.equal(agentOnly.length, 8);
  assert.equal(noGmInjection.length, 0, "empty GM candidate set does not erase agent recall");

  const regenerationExcluded: Array<{ role: "system"; content: string }> = [];
  const regenerationLines = await injectMemoryRecallContext({
    db,
    messages: regenerationExcluded,
    currentInputMessages: [{ role: "user", content: "Current request" }],
    chatId: "recall-context",
    embeddingSource,
    excludeFromMessageAt: "2026-09-01T00:00:00.000Z",
    injectionExcludeFromMessageAt: "2026-09-01T00:00:00.000Z",
    contextLimit: 100_000,
    sendProgress: () => undefined,
    wrapFormat: "none",
    gameMode: true,
  });
  assert.equal(regenerationLines.length, 0, "regeneration cutoff excludes both agent and GM candidates");
  assert.equal(regenerationExcluded.length, 0);
} finally {
  await db._fileStore.close();
  rmSync(tempStorage, { recursive: true, force: true });
}

console.log("Memory recall context regression checks passed.");
