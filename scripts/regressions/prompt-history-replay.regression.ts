import assert from "node:assert/strict";
import {
  createPromptHistoryReplayDescriptor,
  PROMPT_HISTORY_REPLAY_TAIL_PREAMBLE,
  seedPromptHistoryReplaySnapshot,
  shouldReplayPromptHistory,
  tryReplayPromptHistory,
  type PromptHistoryReplayScope,
} from "../../packages/server/src/services/generation/prompt-history-replay.js";
import type { ChatMessage } from "../../packages/server/src/services/llm/base-provider.js";

assert.equal(shouldReplayPromptHistory({ promptTokens: 354496, cachedTokens: 150528 }), true);
assert.equal(shouldReplayPromptHistory({ promptTokens: 260992, cachedTokens: 235264 }), false);
assert.equal(shouldReplayPromptHistory({ promptTokens: 260992, cachedTokens: 235264, replayed: true }), true);
assert.equal(shouldReplayPromptHistory({ promptTokens: 14177, cachedTokens: 13952 }), false);
assert.equal(shouldReplayPromptHistory({ promptTokens: 300000, cachedTokens: 0, replayed: true }), false);
assert.equal(shouldReplayPromptHistory({ promptTokens: 300000 }), false);
assert.equal(shouldReplayPromptHistory({ promptTokens: Infinity, cachedTokens: 150528 }), false);
assert.equal(shouldReplayPromptHistory({ promptTokens: 300000, cachedTokens: 300001 }), false);

const scope: PromptHistoryReplayScope = { provider: "openai_chatgpt", model: "gpt-5.6-sol", scope: "chat-1" };
const lore: ChatMessage = {
  role: "system",
  content: `Stable canon ${"x".repeat(2000)}`,
  contextKind: "prompt",
  providerMetadata: { marinaraFullLoreContext: true },
};
const historyUserA: ChatMessage = { role: "user", content: "Question A", contextKind: "history" };
const historyAssistantA: ChatMessage = { role: "assistant", content: "Answer A", contextKind: "history" };
const historyUserB: ChatMessage = { role: "user", content: "Question B", contextKind: "history" };
const historyAssistantB: ChatMessage = { role: "assistant", content: "Answer B", contextKind: "history" };
const historyUserC: ChatMessage = { role: "user", content: "Question C", contextKind: "history" };
const stateOld: ChatMessage = { role: "user", content: "STATE_OLD", contextKind: "injection" };
const stateNew: ChatMessage = { role: "user", content: "STATE_NEW", contextKind: "injection" };

const oldCanonical = seedPromptHistoryReplaySnapshot([lore, historyUserA, historyAssistantA, stateOld, historyUserB]);
const currentCanonical = seedPromptHistoryReplaySnapshot([
  lore,
  historyUserA,
  historyAssistantA,
  historyUserB,
  historyAssistantB,
  stateNew,
  historyUserC,
]);
const descriptor = createPromptHistoryReplayDescriptor(oldCanonical, oldCanonical, scope);
assert.ok(descriptor);
const originalCurrent = structuredClone(currentCanonical);
const originalPrompt = structuredClone(oldCanonical);

const replay = tryReplayPromptHistory({
  currentMessages: currentCanonical,
  previousPrompt: oldCanonical,
  previousDescriptor: descriptor,
  scope,
});
assert.ok(replay);
assert.deepEqual(replay.prompt.slice(0, oldCanonical.length), oldCanonical);
assert.deepEqual(
  replay.prompt.slice(oldCanonical.length).map((m) => m.content),
  ["Answer B", PROMPT_HISTORY_REPLAY_TAIL_PREAMBLE, "STATE_NEW", "Question C"],
);
assert.equal(replay.prompt.at(-1)?.content, historyUserC.content);
assert.deepEqual(currentCanonical, originalCurrent);
assert.deepEqual(oldCanonical, originalPrompt);

const nextCanonical = seedPromptHistoryReplaySnapshot([
  ...currentCanonical.slice(0, 5),
  historyUserC,
  { ...historyAssistantB, content: "Answer C" },
  stateOld,
  { role: "user", content: "Question D", contextKind: "history" as const },
]);
const recursive = tryReplayPromptHistory({
  currentMessages: nextCanonical,
  previousPrompt: replay.prompt,
  previousDescriptor: replay.descriptor,
  scope,
});
assert.ok(recursive);
assert.equal(recursive.prompt.at(-1)?.content, "Question D");

for (const mutate of [
  () => ({ ...historyUserA, content: "Edited A" }),
  () => ({ ...historyAssistantA, role: "user" as const }),
  () => ({ ...historyAssistantA, images: ["data:image/png;base64,AAAA"] }),
]) {
  assert.equal(
    tryReplayPromptHistory({
      currentMessages: seedPromptHistoryReplaySnapshot([
        lore,
        mutate(),
        historyAssistantA,
        historyUserB,
        historyAssistantB,
        stateNew,
        historyUserC,
      ]),
      previousPrompt: oldCanonical,
      previousDescriptor: descriptor,
      scope,
    }),
    null,
  );
}

assert.equal(
  tryReplayPromptHistory({
    currentMessages: currentCanonical,
    previousPrompt: [...oldCanonical, { role: "user", content: "tampered" }],
    previousDescriptor: descriptor,
    scope,
  }),
  null,
);
assert.equal(
  tryReplayPromptHistory({
    currentMessages: currentCanonical,
    previousPrompt: oldCanonical,
    previousDescriptor: descriptor,
    scope: { ...scope, model: "other-model" },
  }),
  null,
);
assert.equal(
  tryReplayPromptHistory({
    currentMessages: [lore, historyUserA, historyAssistantA, historyUserB, historyAssistantB, historyUserC],
    previousPrompt: oldCanonical,
    previousDescriptor: descriptor,
    scope,
  }),
  null,
);
assert.equal(
  tryReplayPromptHistory({
    currentMessages: [
      lore,
      historyUserA,
      historyAssistantA,
      historyUserB,
      historyAssistantB,
      { ...stateNew, role: "system" },
      historyUserC,
    ],
    previousPrompt: oldCanonical,
    previousDescriptor: descriptor,
    scope,
  }),
  null,
);
assert.equal(
  tryReplayPromptHistory({
    currentMessages: [...currentCanonical, { ...historyAssistantB, content: "X".repeat(2000) }],
    previousPrompt: oldCanonical,
    previousDescriptor: descriptor,
    scope,
  }),
  null,
);
const compactLore: ChatMessage = { ...lore, content: "Lore" };
const hugeStateOld: ChatMessage = { ...stateOld, content: `STATE_OLD ${"x".repeat(3000)}` };
const hugeOld = seedPromptHistoryReplaySnapshot([
  compactLore,
  historyUserA,
  historyAssistantA,
  hugeStateOld,
  historyUserB,
]);
const hugeDescriptor = createPromptHistoryReplayDescriptor(hugeOld, hugeOld, scope);
assert.ok(hugeDescriptor);
const compactCurrent = seedPromptHistoryReplaySnapshot(
  currentCanonical.map((message) => (message === lore ? compactLore : message)),
);
assert.equal(
  tryReplayPromptHistory({
    currentMessages: compactCurrent,
    previousPrompt: hugeOld,
    previousDescriptor: hugeDescriptor,
    scope,
  }),
  null,
);
assert.equal(
  tryReplayPromptHistory({
    currentMessages: compactCurrent,
    previousPrompt: hugeOld,
    previousDescriptor: hugeDescriptor,
    scope,
    maxContext: 512,
    maxTokens: 32,
  }),
  null,
);
assert.equal(
  createPromptHistoryReplayDescriptor([historyUserA, historyAssistantA, stateOld, historyUserB], [historyUserA], scope),
  null,
);
for (const malformed of [null, undefined, {}]) {
  assert.doesNotThrow(() =>
    tryReplayPromptHistory({
      currentMessages: currentCanonical,
      previousPrompt: oldCanonical,
      previousDescriptor: malformed as never,
      scope,
    }),
  );
}
assert.doesNotThrow(() =>
  tryReplayPromptHistory({
    currentMessages: currentCanonical,
    previousPrompt: [null as never],
    previousDescriptor: { ...descriptor, descriptorVersion: 99 } as never,
    scope,
  }),
);

process.stdout.write("Prompt history replay regression passed.\n");
