import assert from "node:assert/strict";
import {
  createGamePromptDirectEdits,
  previewGamePromptDirectEdits,
} from "../../packages/client/src/features/chat-settings/game-prompt-direct-edits.js";
import {
  applyGamePromptDirectEdits,
  parseGamePromptDirectEdits,
} from "../../packages/server/src/services/game/game-prompt-direct-edits.js";
import { runIsolatedGameTurnWithProvider } from "../../packages/server/src/routes/generate/game-isolated-turn-adapter.js";

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

let sentPlannerMessages: Array<{ role: string; content: string }> = [];
await runIsolatedGameTurnWithProvider({
  plannerMessages: [{ role: "system", content: "Keep the scene coherent." }],
  actors: [],
  playerAction: "Continue.",
  promptDirectEdits: [
    {
      role: "user",
      find: "Return only one JSON object with keys publicScene, actorRequests, and optional spatialDirective.",
      replace: "Return exactly one JSON object with publicScene, actorRequests, and optional spatialDirective.",
    },
  ],
  provider: {
    chatComplete: async (messages: Array<{ role: string; content: string }>) => {
      sentPlannerMessages = messages;
      return {
        content: JSON.stringify({
          publicScene: [{ beat: 0, text: "The scene continues.", perceivedBy: [] }],
          actorRequests: [],
        }),
        finishReason: "stop",
      };
    },
  } as any,
  providerOptions: { model: "test", maxContext: 20_000, maxTokens: 512 },
  signal: new AbortController().signal,
});
assert.ok(
  sentPlannerMessages.some((message) => message.content.includes("Return exactly one JSON object")),
  "edits to instructions appended by isolated mode must reach its provider request",
);
assert.ok(
  sentPlannerMessages.every(
    (message) => !message.content.includes("Return only one JSON object with keys publicScene"),
  ),
);

console.log("Game prompt direct edits regression passed.");
