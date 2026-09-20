import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  isPromptHistoryReplayEligible,
  matchesPromptHistoryReplaySourceGuard,
} from "../../packages/server/src/routes/generate.routes.js";
import {
  createPromptHistoryReplayDescriptor,
  tryReplayPromptHistory,
  type PromptHistoryReplayScope,
} from "../../packages/server/src/services/generation/prompt-history-replay.js";
import type { ChatMessage } from "../../packages/server/src/services/llm/base-provider.js";

const scope: PromptHistoryReplayScope = {
  provider: "openai_chatgpt",
  model: "gpt-5.6",
  scope: "chat:conn:chars:gm:v1",
};
const lore: ChatMessage = {
  role: "system",
  content: "Stable lore. ".repeat(100),
  providerMetadata: { marinaraFullLoreContext: true },
};
const oldUser: ChatMessage = { role: "user", content: "Old turn", contextKind: "history" };
const oldAssistant: ChatMessage = { role: "assistant", content: "Old answer", contextKind: "history" };
const currentUser: ChatMessage = { role: "user", content: "Current turn", contextKind: "history" };
const turnInjection: ChatMessage = { role: "user", content: "Turn state", contextKind: "injection" };
const response: ChatMessage = { role: "assistant", content: "Generated answer", contextKind: "history" };
const nextUser: ChatMessage = { role: "user", content: "Next turn", contextKind: "history" };

assert.equal(
  isPromptHistoryReplayEligible({
    chatMode: "game",
    usesIndividualGroupGeneration: false,
    provider: "claude_subscription",
    followUpIteration: 0,
    currentTurnUserMessageId: "current",
    userMessage: "Next turn",
    toolCount: 0,
  }),
  false,
  "Claude bypasses replay because live measurements showed additional uncached input",
);

assert.equal(
  isPromptHistoryReplayEligible({
    chatMode: "game",
    usesIndividualGroupGeneration: false,
    provider: scope.provider,
    followUpIteration: 0,
    currentTurnUserMessageId: "current",
    userMessage: "Next turn",
    toolCount: 0,
  }),
  true,
  "merged multi-character Game Mode remains eligible",
);
assert.equal(
  isPromptHistoryReplayEligible({
    chatMode: "game",
    usesIndividualGroupGeneration: false,
    provider: scope.provider,
    followUpIteration: 0,
    currentTurnUserMessageId: "current",
    userMessage: "Next turn",
    toolCount: 0,
    regenerateMessageId: "old",
  }),
  false,
  "regeneration bypasses replay",
);
assert.equal(
  isPromptHistoryReplayEligible({
    chatMode: "game",
    usesIndividualGroupGeneration: false,
    provider: scope.provider,
    followUpIteration: 0,
    currentTurnUserMessageId: "current",
    userMessage: "Next turn",
    toolCount: 0,
    continueMessageId: "old",
  }),
  false,
  "continuation bypasses replay",
);
assert.equal(
  matchesPromptHistoryReplaySourceGuard([], undefined, "current"),
  false,
  "first turn without a descriptor is a safe miss",
);

const sourcePrefix = [
  { id: "old-user", role: "user", content: oldUser.content, characterId: null, activeSwipeIndex: null },
  { id: "old-assistant", role: "assistant", content: oldAssistant.content, characterId: "char", activeSwipeIndex: 0 },
  { id: "current", role: "user", content: currentUser.content, characterId: null, activeSwipeIndex: null },
];
const sourceHash = createHash("sha256")
  .update(JSON.stringify(sourcePrefix.map((message) => ({ ...message }))), "utf8")
  .digest("hex");
const responseHash = createHash("sha256").update(response.content, "utf8").digest("hex");
const sourceDescriptor = {
  sourceCount: sourcePrefix.length,
  sourceHash,
  responseId: "response",
  responseSwipeIndex: 0,
  responseContentHash: responseHash,
};
const nextSource = [
  ...sourcePrefix,
  { id: "response", role: "assistant", content: response.content, characterId: "char", activeSwipeIndex: 0 },
  { id: "next", role: "user", content: nextUser.content, characterId: null, activeSwipeIndex: null },
];
assert.equal(matchesPromptHistoryReplaySourceGuard(nextSource, sourceDescriptor, "next"), true);
assert.equal(
  matchesPromptHistoryReplaySourceGuard(
    nextSource.map((message) => (message.id === "response" ? { ...message, content: "edited" } : message)),
    sourceDescriptor,
    "next",
  ),
  false,
  "edited prior response invalidates the source guard",
);
assert.equal(
  matchesPromptHistoryReplaySourceGuard(
    nextSource.map((message) => (message.id === "response" ? { ...message, activeSwipeIndex: 1 } : message)),
    sourceDescriptor,
    "next",
  ),
  false,
  "swipe changes invalidate the source guard",
);
assert.equal(matchesPromptHistoryReplaySourceGuard(nextSource, sourceDescriptor, "wrong-user"), false);

const canonical = [lore, oldUser, oldAssistant, { ...turnInjection, content: "Previous turn state" }, currentUser];
const nextCanonical = [lore, oldUser, oldAssistant, currentUser, response, turnInjection, nextUser];
const previousPromptDescriptor = createPromptHistoryReplayDescriptor(canonical, canonical, scope);
assert.ok(previousPromptDescriptor);
const replay = tryReplayPromptHistory({
  currentMessages: nextCanonical,
  previousPrompt: canonical,
  previousDescriptor: previousPromptDescriptor,
  scope,
});
assert.ok(replay, "the exact canonical prefix supports replay");
assert.equal(replay.prompt.at(-1)?.content, nextUser.content);
assert.equal(
  replay.descriptor.promptSha256,
  createPromptHistoryReplayDescriptor(nextCanonical, replay.prompt, scope)?.promptSha256,
);

const persistedDescriptor = createPromptHistoryReplayDescriptor(nextCanonical, replay.prompt, scope);
assert.ok(persistedDescriptor);
const thirdCanonical: ChatMessage[] = [
  ...nextCanonical.slice(0, 5),
  nextUser,
  { role: "assistant", content: "Second response", contextKind: "history" },
  { ...turnInjection, content: "Third turn state" },
  { role: "user", content: "Third turn", contextKind: "history" },
];
assert.ok(
  tryReplayPromptHistory({
    currentMessages: thirdCanonical,
    previousPrompt: replay.prompt,
    previousDescriptor: persistedDescriptor,
    scope,
  }),
  "persist canonical fingerprints separately from expanded prompt to support the third turn",
);
assert.equal(
  tryReplayPromptHistory({
    currentMessages: nextCanonical,
    previousPrompt: canonical,
    previousDescriptor: previousPromptDescriptor,
    scope: { ...scope, scope: "different-connection" },
  }),
  null,
);

const cachedPrompt = replay.prompt.map((message) => ({
  role: message.role,
  content: message.content,
  ...(message.contextKind ? { contextKind: message.contextKind } : {}),
}));
assert.equal(
  cachedPrompt.some((message) => message.contextKind === "injection"),
  true,
);

process.stdout.write("Prompt history replay route regression passed.\n");
