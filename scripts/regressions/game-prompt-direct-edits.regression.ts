import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGamePromptDirectEdits,
  previewGamePromptDirectEdits,
  previewGamePromptDirectEditsWithIssues,
} from "../../packages/client/src/features/chat-settings/game-prompt-direct-edits.js";
import {
  assertGamePromptRequestFits,
  applyGamePromptDirectEdits,
  applyGamePromptDirectEditsWithIssues,
  dispatchWithGameGenerationFeatures,
  disabledGameFeatureMetadataWriteError,
  assertGameFeatureMetadataWriteAllowed,
  gamePromptDirectEditsForMode,
  parseGamePromptDirectEdits,
} from "../../packages/server/src/services/game/game-prompt-direct-edits.js";

const original = [
  { role: "system", content: "<role>Game Master</role>\nKeep a coherent scene." },
  {
    role: "user",
    content:
      "<output_format>\n- Narration: text - 1-4 sentences per beat, blank line between beats.\n- Dialogue: use clear speaker names.\n</output_format>",
  },
  { role: "user", content: "The player enters the garden." },
];
const changed = original.map((message) => ({ ...message }));
changed[1]!.content = changed[1]!.content.replace(
  "1-4 sentences per beat, blank line between beats.",
  "as many sentences as the scene needs.",
);
changed[0]!.content = changed[0]!.content.replace("coherent", "immersive");
const edits = createGamePromptDirectEdits(original, changed);
assert.ok(edits.length >= 2);
assert.deepEqual(applyGamePromptDirectEdits(original, edits), changed);
assert.deepEqual(applyGamePromptDirectEdits(original, []), original, "no-edit requests preserve their assembled text");
let providerDispatches = 0;
const appliedFeatureSnapshot = {
  promptEditsApplied: true,
  gmReasoningApplied: true,
  promptEditingEnabled: false,
  gmReasoningEnabled: true,
};
await assert.rejects(
  () => dispatchWithGameGenerationFeatures(appliedFeatureSnapshot, () => (providerDispatches += 1)),
  /Game prompt editing was disabled during generation/,
);
assert.equal(providerDispatches, 0, "a feature disabled after prep cancels before any provider dispatch");
await assert.rejects(
  () =>
    dispatchWithGameGenerationFeatures(
      { ...appliedFeatureSnapshot, promptEditsApplied: false, gmReasoningEnabled: false },
      () => (providerDispatches += 1),
    ),
  /GM narration reasoning was disabled during generation/,
);
assert.equal(providerDispatches, 0, "a disabled GM reasoning contribution also cancels before redispatch");
await dispatchWithGameGenerationFeatures(
  { ...appliedFeatureSnapshot, promptEditingEnabled: true, gmReasoningEnabled: true },
  () => (providerDispatches += 1),
);
assert.equal(providerDispatches, 1, "enabled optional contributions can dispatch normally");
assert.equal(
  disabledGameFeatureMetadataWriteError({ gamePromptDirectEdits: null }, false, false),
  "Game prompt editing is disabled",
  "resetting saved edits is blocked while the opt-in is off",
);
assert.equal(
  disabledGameFeatureMetadataWriteError({ gamePromptDirectEditsRevision: null }, false, false),
  "Game prompt editing is disabled",
  "revision-only resets are blocked while the opt-in is off",
);
assert.equal(
  disabledGameFeatureMetadataWriteError({ gameGmReasoningEffort: null }, true, false),
  "Game GM reasoning is disabled",
  "clearing a saved GM override is blocked while its opt-in is off",
);
assert.equal(disabledGameFeatureMetadataWriteError({ title: "Unrelated metadata" }, false, false), null);
assert.deepEqual(
  previewGamePromptDirectEdits(original, edits),
  changed,
  "reopening shows saved edits before another turn",
);

const editedAgain = changed.map((message) => ({ ...message }));
editedAgain[1]!.content = editedAgain[1]!.content.replace("clear speaker names", "speaker names and actions");
const appendedEdits = [...edits, ...createGamePromptDirectEdits(changed, editedAgain)];
assert.deepEqual(applyGamePromptDirectEdits(original, appendedEdits), editedAgain);
assert.deepEqual(previewGamePromptDirectEdits(original, appendedEdits), editedAgain);

const nextTurn = original.map((message) => ({ ...message }));
nextTurn[2]!.content = "The player leaves the garden and meets a knight.";
const nextPrompt = applyGamePromptDirectEdits(nextTurn, edits);
assert.equal(nextPrompt[0]!.content, changed[0]!.content);
assert.equal(nextPrompt[1]!.content, changed[1]!.content);
assert.equal(nextPrompt[2]!.content, nextTurn[2]!.content, "live history remains current");
const duplicatedFuture = [...nextTurn, { role: "user", content: nextTurn[1]!.content }];
assert.deepEqual(
  applyGamePromptDirectEdits(duplicatedFuture, edits).map((message) => message.content),
  [changed[0]!.content, nextTurn[1]!.content, nextTurn[2]!.content, nextTurn[1]!.content],
  "a newly ambiguous match is skipped rather than changing the wrong message",
);
const ambiguous = applyGamePromptDirectEditsWithIssues(duplicatedFuture, edits);
assert.ok(ambiguous.issues.some((issue) => issue.reason === "ambiguous"));
assert.deepEqual(previewGamePromptDirectEditsWithIssues(duplicatedFuture, edits).issues, ambiguous.issues);
const missing = applyGamePromptDirectEditsWithIssues(original, [
  { role: "system", find: "text absent from the request", replace: "replacement" },
]);
assert.deepEqual(missing.issues, [{ editIndex: 0, reason: "missing" }]);

const twoEditsOriginal = [{ role: "system", content: "Alpha line\nA unique unchanged separator.\nBeta line\n" }];
const twoEditsChanged = [{ role: "system", content: "Gamma line\nA unique unchanged separator.\nDelta line\n" }];
const twoEdits = createGamePromptDirectEdits(twoEditsOriginal, twoEditsChanged);
assert.deepEqual(applyGamePromptDirectEdits(twoEditsOriginal, twoEdits), twoEditsChanged);

const insertionOriginal = [{ role: "system", content: "Before and after" }];
const insertionChanged = [{ role: "system", content: "Before, during, and after" }];
assert.deepEqual(
  applyGamePromptDirectEdits(insertionOriginal, createGamePromptDirectEdits(insertionOriginal, insertionChanged)),
  insertionChanged,
);

const longOriginal = [{ role: "system", content: `Header\n${"x".repeat(8_000)}\nFooter` }];
const longChanged = [{ role: "system", content: `Header\n${"y".repeat(8_000)}\nFooter` }];
assert.deepEqual(
  applyGamePromptDirectEdits(longOriginal, createGamePromptDirectEdits(longOriginal, longChanged)),
  longChanged,
  "a large instruction paragraph can be edited directly",
);

assert.deepEqual(parseGamePromptDirectEdits(edits), edits);
assert.equal(parseGamePromptDirectEdits([{ role: "system", find: "ab", replace: "x" }]), null);
assert.equal(parseGamePromptDirectEdits([{ role: "system", find: "valid", replace: 7 }]), null);
assert.deepEqual(gamePromptDirectEditsForMode("game", edits), edits);
assert.deepEqual(gamePromptDirectEditsForMode("conversation", edits), []);
assert.deepEqual(gamePromptDirectEditsForMode("roleplay", [{ role: "system", find: "malformed", replace: 7 }]), []);

const budgetOptions = { maxContext: 700, maxTokens: 100 };
const budgetBase = [{ role: "system", content: "Keep the request concise." }];
assert.doesNotThrow(() => assertGamePromptRequestFits(budgetBase, budgetOptions));
const budgetExpansion = applyGamePromptDirectEdits(budgetBase, [
  { role: "system", find: "concise", replace: "expanded".repeat(300) },
]);
assert.throws(
  () => assertGamePromptRequestFits(budgetExpansion, budgetOptions),
  { message: "GAME_PROMPT_EDITS_EXCEED_CONTEXT" },
  "an edit that pushes a previously fitting request over budget is rejected instead of truncated",
);
assert.throws(
  () =>
    createGamePromptDirectEdits(
      [
        { role: "user", content: "same phrase" },
        { role: "user", content: "same phrase" },
      ],
      [
        { role: "user", content: "new phrase" },
        { role: "user", content: "same phrase" },
      ],
    ),
  /GAME_PROMPT_EDIT_AMBIGUOUS/,
);

const scratch = mkdtempSync(join(tmpdir(), "marinara-game-feature-write-"));
const previousEnvironment = {
  DATA_DIR: process.env.DATA_DIR,
  FILE_STORAGE_DIR: process.env.FILE_STORAGE_DIR,
  NODE_ENV: process.env.NODE_ENV,
  LOG_LEVEL: process.env.LOG_LEVEL,
};
process.env.DATA_DIR = scratch;
process.env.FILE_STORAGE_DIR = join(scratch, "storage");
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const db = await createFileNativeDB();
try {
  const chats = createChatsStorage(db);
  const chat = await chats.create({ name: "Game feature write guard", mode: "game", characterIds: [] });
  assert.ok(chat);

  let releaseQueuedWrite!: () => void;
  let markQueuedWriteStarted!: () => void;
  const queuedWriteGate = new Promise<void>((resolve) => {
    releaseQueuedWrite = resolve;
  });
  const queuedWriteStarted = new Promise<void>((resolve) => {
    markQueuedWriteStarted = resolve;
  });
  const firstWrite = chats.patchMetadata(chat.id, async () => {
    markQueuedWriteStarted();
    await queuedWriteGate;
    return { queueGuardFixture: true };
  });
  await queuedWriteStarted;

  const lateIncoming = { gamePromptDirectEdits: edits };
  let promptEditingEnabled = true;
  let gmReasoningEnabled = true;
  assert.equal(disabledGameFeatureMetadataWriteError(lateIncoming, true, true), null);
  const queuedFeatureWrite = chats.patchMetadata(chat.id, lateIncoming, {
    beforeWrite: () => assertGameFeatureMetadataWriteAllowed(lateIncoming, promptEditingEnabled, gmReasoningEnabled),
  });

  // The second patch is waiting behind the first per-chat write. Simulate the
  // setting changing after route admission but before storage's final update.
  promptEditingEnabled = false;
  releaseQueuedWrite();
  await firstWrite;
  await assert.rejects(queuedFeatureWrite, {
    message: "Game prompt editing is disabled",
    statusCode: 403,
  });

  const persisted = JSON.parse((await chats.getById(chat.id))!.metadata);
  assert.equal(persisted.queueGuardFixture, true, "the earlier queued write finishes");
  assert.equal(Object.hasOwn(persisted, "gamePromptDirectEdits"), false, "late-OFF patch never reaches the database");
} finally {
  await db._fileStore.close();
  for (const [name, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
}

console.log("Game prompt direct edits regression passed.");
