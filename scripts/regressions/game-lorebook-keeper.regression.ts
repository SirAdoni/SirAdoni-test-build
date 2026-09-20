import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  batchLorebookKeeperTranscript,
  hashLorebookKeeperSource,
  planLorebookKeeperBatches,
  processLorebookKeeperBatches,
  type LorebookKeeperSourceMessage,
} from "../../packages/server/src/services/game/lorebook-keeper-batches.js";
import {
  buildGameLorebookKeeperSourceMessages,
  createGameLorebookKeeperEntries,
  normalizeGameLorebookKeeperEntries,
  validateGameLorebookKeeperEntryEnvelope,
} from "../../packages/server/src/routes/game.routes.js";

const routeSource = readFileSync(new URL("../../packages/server/src/routes/game.routes.ts", import.meta.url), "utf8");

const editedAndDeleted = buildGameLorebookKeeperSourceMessages(
  [
    { id: "kept-user", role: "user", content: "The player asks about the gate.", extra: null },
    { id: "edited-assistant", role: "assistant", content: "The draft answer.\n\nThe old answer.", extra: null },
    { id: "deleted-assistant", role: "assistant", content: "A deleted answer.", extra: null },
  ] as never,
  {
    "segmentEdit:edited-assistant:0": "The corrected answer.",
    "segmentDelete:deleted-assistant:0": true,
  },
);
assert.deepEqual(
  editedAndDeleted,
  [
    { id: "kept-user", role: "user", content: "The player asks about the gate." },
    { id: "edited-assistant", role: "assistant", content: "The corrected answer.\n\nThe old answer." },
  ],
  "Keeper source preparation must apply edited segments and remove deleted segments before batching",
);

// A completed run must account for the complete, post-edit transcript. This fixture
// deliberately includes enough entries to catch an accidental fixed 40/46-entry cap.
const messages: LorebookKeeperSourceMessage[] = Array.from({ length: 52 }, (_, index) => ({
  id: `message-${index + 1}`,
  role: index % 3 === 0 ? "user" : "assistant",
  content: `message-${index + 1} edited=${index % 2 === 0} ${"x".repeat(index === 17 ? 2_500 : 45)}`,
}));
messages[7] = { id: "edited-message", role: "user", content: "The corrected canon replaces the deleted draft." };
messages.splice(8, 1); // the deleted draft must not reappear in a later batch

const batches = batchLorebookKeeperTranscript(messages, 512);
assert.ok(batches.length > 1, "the fixture must exercise multiple Keeper batches");
assert.equal(hashLorebookKeeperSource(messages), hashLorebookKeeperSource(messages), "source hashing is stable");

const refsByMessage = new Map<string, Array<{ start: number; end: number }>>();
for (const batch of batches) {
  assert.ok(batch.transcriptText.length <= 512, "each transcript batch must respect its character budget");
  for (const ref of batch.sourceRefs) {
    const refs = refsByMessage.get(ref.messageId) ?? [];
    refs.push({ start: ref.start, end: ref.end });
    refsByMessage.set(ref.messageId, refs);
  }
}
assert.equal(refsByMessage.size, messages.length, "every current message must be represented in a batch");
assert.equal(refsByMessage.has("message-9"), false, "deleted messages must not be resurrected by batching");
for (const message of messages) {
  const refs = [...(refsByMessage.get(message.id) ?? [])].sort((a, b) => a.start - b.start);
  assert.ok(refs.length > 0, `message ${message.id} must have source refs`);
  assert.equal(refs[0]!.start, 0, `message ${message.id} must start at offset zero`);
  assert.equal(refs.at(-1)!.end, message.content.length, `message ${message.id} must end at its full length`);
  for (let index = 1; index < refs.length; index += 1) {
    assert.equal(refs[index - 1]!.end, refs[index]!.start, `message ${message.id} chunks must be contiguous`);
  }
}
assert.ok(
  (refsByMessage.get("message-18")?.length ?? 0) > 1,
  "an oversized message must be split into multiple bounded chunks",
);

const progress: Array<{ completedBatches: number; processedMessages: number }> = [];
const processed = await processLorebookKeeperBatches({
  messages,
  maxChars: 512,
  complete: async (batch) =>
    Array.from(new Set(batch.sourceRefs.map((ref) => ref.messageId))).map((messageId) => ({ messageId })),
  onProgress: (value) => progress.push(value),
});
assert.equal(
  new Set(processed.outputs.flat().map((entry) => entry.messageId)).size,
  messages.length,
  "successful extraction output must cover every unique source message",
);
assert.ok(processed.outputs.flat().length >= messages.length, "all oversized source fragments must be represented");
assert.equal(progress.at(-1)?.processedMessages, messages.length);

const manyEntries = normalizeGameLorebookKeeperEntries({
  entries: Array.from({ length: 52 }, (_, index) => ({
    entryName: `Durable Fact ${index + 1}`,
    content: `Fact ${index + 1} remains true.`,
    keys: [`fact-${index + 1}`],
  })),
});
assert.equal(manyEntries.length, 52, "Keeper output must not cap valid entries at 40 or 46");

const unicodeMessages: LorebookKeeperSourceMessage[] = [
  { id: "unicode", role: "assistant", content: "😀".repeat(200) },
];
const unicodeBatches = batchLorebookKeeperTranscript(unicodeMessages, 256);
assert.ok(unicodeBatches.every((batch) => batch.transcriptText.length <= 256));
assert.equal(
  unicodeBatches.flatMap((batch) => batch.sourceRefs).at(-1)?.end,
  Array.from(unicodeMessages[0]!.content).length,
  "unicode chunk offsets must use code points and retain the full message",
);

const planned = planLorebookKeeperBatches(messages, (batch) => batch.transcriptText.length <= 400, 1_024);
assert.ok(planned.every((batch) => batch.transcriptText.length <= 400), "planner must adapt batch size to prompt overhead");
assert.throws(
  () => planLorebookKeeperBatches([{ id: "too-large", role: "assistant", content: "z".repeat(10_000) }], () => false),
  /KEEPER_CONTEXT_OVERFLOW/u,
  "planner must reject a message that cannot fit even at the minimum batch size",
);

let stagedWrites = 0;
await assert.rejects(
  processLorebookKeeperBatches({
    messages,
    maxChars: 512,
    complete: async (_batch, index) => {
      if (index === 2) throw new Error("provider failed on later batch");
      return { index };
    },
  }).then((result) => {
    stagedWrites = result.outputs.length;
    throw new Error("commit must not be reached after a failed batch");
  }),
  /provider failed on later batch/u,
);
assert.equal(stagedWrites, 0, "a later batch failure must leave staged output uncommitted");

// Malformed provider JSON must be rejected before persistence. The route-level
// validator is intentionally checked as source because it remains private to the route.
assert.match(routeSource, /validateGameLorebookKeeperEntryEnvelope\(parsed\)/u);
assert.match(routeSource, /KEEPER_INVALID_ENVELOPE/u);
assert.throws(
  () => validateGameLorebookKeeperEntryEnvelope({ entries: [{ entryName: "", content: "bad" }] }),
  /KEEPER_INVALID_ENTRY/u,
);
assert.throws(
  () => validateGameLorebookKeeperEntryEnvelope({ unexpected: [] }),
  /KEEPER_INVALID_ENVELOPE/u,
);
assert.deepEqual(normalizeGameLorebookKeeperEntries({ entries: [{ entryName: "", content: "bad" }] }), []);
assert.deepEqual(normalizeGameLorebookKeeperEntries({ entries: [{ entryName: "valid", content: "" }] }), []);
assert.deepEqual(normalizeGameLorebookKeeperEntries({ unexpected: [] }), []);

const keeperEntries: Parameters<typeof createGameLorebookKeeperEntries>[0]["entries"] = [
  {
    entryName: "World Lore - Session 4",
    tag: "world_lore",
    keys: ["world", "session-4"],
    description: "A durable fact.",
    content: "The sealed gate answers only to the river oath.",
  },
];
const stored: Array<Record<string, unknown>> = [];
const store = {
  listEntries: async () => stored,
  createEntry: async (entry: Record<string, unknown>) => {
    stored.push({ id: `entry-${stored.length + 1}`, ...entry });
  },
};
assert.equal(
  await createGameLorebookKeeperEntries({
    lorebooksStore: store as never,
    lorebookId: "game-book",
    sessionNumber: 4,
    entries: keeperEntries,
  }),
  1,
);
assert.equal(
  await createGameLorebookKeeperEntries({
    lorebooksStore: store as never,
    lorebookId: "game-book",
    sessionNumber: 4,
    entries: keeperEntries,
  }),
  0,
  "rerunning the same saved Keeper output must deduplicate by content hash",
);
assert.equal(stored.length, 1);

const retryEntries = [
  ...keeperEntries,
  {
    ...keeperEntries[0]!,
    entryName: "Location - Session 4",
    content: "The river oath is kept beneath the eastern bridge.",
  },
];
let failAfterFirstCreate = true;
const preExisting = { id: "manual-old", name: "Manual entry", content: "Preserve me", dynamicState: {} };
const partialStore = {
  listEntries: async () => [preExisting, ...partialStore.created] as Array<Record<string, unknown>>,
  created: [] as Array<Record<string, unknown>>,
  createEntry: async (entry: Record<string, unknown>) => {
    if (failAfterFirstCreate && partialStore.created.length === 1) throw new Error("simulated storage failure");
    partialStore.created.push({ id: `generated-${partialStore.created.length + 1}`, ...entry });
  },
};
await assert.rejects(
  createGameLorebookKeeperEntries({
    lorebooksStore: partialStore as never,
    lorebookId: "game-book",
    sessionNumber: 4,
    entries: retryEntries,
  }),
  /simulated storage failure/u,
);
assert.equal(partialStore.created.length, 1, "a partial save failure may leave the first new entry persisted");
assert.equal(preExisting.content, "Preserve me", "a partial save failure must preserve pre-existing manual content");
failAfterFirstCreate = false;
assert.equal(
  await createGameLorebookKeeperEntries({
    lorebooksStore: partialStore as never,
    lorebookId: "game-book",
    sessionNumber: 4,
    entries: retryEntries,
  }),
  1,
  "a retry after a failed save must deduplicate the first entry and write only the remaining one",
);
assert.equal(partialStore.created.length, 2);

// These guards keep the regression from becoming green while context fitting silently
// drops source messages. The batched path must be wired into the route and use explicit
// staged persistence before a successful final commit.
assert.match(routeSource, /planLorebookKeeperBatches\(/u);
assert.match(routeSource, /sourceRefs/u);
assert.match(routeSource, /KEEPER_OUTPUT_INCOMPLETE/u);
assert.match(routeSource, /KEEPER_CONTEXT_OVERFLOW/u);
assert.match(routeSource, /KEEPER_STALE_SOURCE/u);
assert.match(routeSource, /KEEPER_BUSY/u);
assert.match(routeSource, /KEEPER_MANUAL_SAVE_FAILED/u);
assert.match(routeSource, /phase:\s*"manual"[\s\S]*coverageVerified:\s*false/u);
const performStart = routeSource.indexOf("async function performGameLorebookKeeperAfterConclusion");
const performEnd = routeSource.indexOf("async function runGameLorebookKeeperAfterConclusion", performStart);
assert.ok(performStart >= 0 && performEnd > performStart, "the automatic Keeper runner remains discoverable");
assert.doesNotMatch(
  routeSource.slice(performStart, performEnd),
  /removeEntry\(/u,
  "automatic Keeper failures must never delete existing lorebook entries",
);

process.stdout.write("Game Lorebook Keeper regression passed.\n");
