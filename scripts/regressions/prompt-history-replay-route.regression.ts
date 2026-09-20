import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import {
  isPromptHistoryReplayEligible,
  matchesPromptHistoryReplaySourceGuard,
} from "../../packages/server/src/routes/generate.routes.js";
import {
  createPromptHistoryReplayDescriptor,
  seedPromptHistoryReplaySnapshot,
  tryReplayPromptHistory,
  type PromptHistoryReplayScope,
} from "../../packages/server/src/services/generation/prompt-history-replay.js";
import type { ChatMessage } from "../../packages/server/src/services/llm/base-provider.js";

const generateRoutePath = fileURLToPath(
  new URL("../../packages/server/src/routes/generate.routes.ts", import.meta.url),
);
const generateRouteSource = fs.readFileSync(generateRoutePath, "utf8");
const generateRouteAst = ts.createSourceFile(
  generateRoutePath,
  generateRouteSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const replayToolCountInitializers: string[] = [];
function collectReplayEligibilityCalls(node: ts.Node): void {
  if (ts.isCallExpression(node) && node.expression.getText(generateRouteAst) === "isPromptHistoryReplayEligible") {
    const options = node.arguments[0];
    if (options && ts.isObjectLiteralExpression(options)) {
      const toolCount = options.properties.find(
        (property): property is ts.PropertyAssignment =>
          ts.isPropertyAssignment(property) && property.name.getText(generateRouteAst) === "toolCount",
      );
      if (toolCount) replayToolCountInitializers.push(toolCount.initializer.getText(generateRouteAst));
    }
  }
  ts.forEachChild(node, collectReplayEligibilityCalls);
}
collectReplayEligibilityCalls(generateRouteAst);
assert.ok(
  replayToolCountInitializers.length > 0,
  "route must pass a production tool-count expression to replay eligibility",
);
// Source checks cover caller wiring that a helper-only fixture cannot prove.
assert.ok(
  generateRouteSource.includes("tools: gameToolConnection ? undefined : responderToolDefs"),
  "route must omit responder tools when a separate game-tool connection owns tool calls",
);
assert.ok(
  generateRouteSource.includes('conn.provider === "openai_chatgpt"'),
  "route must account for ChatGPT Responses transport omitting native tool schemas",
);
const seedIndex = generateRouteSource.indexOf("seedPromptHistoryReplaySnapshot(canonicalProviderMessages)");
const fitIndex = generateRouteSource.lastIndexOf("await fitPromptForSend(", seedIndex);
const initialDescriptorIndex = generateRouteSource.indexOf(
  "createPromptHistoryReplayDescriptor(\n              initialProviderMessages,",
);
const finalDescriptorIndex = generateRouteSource.indexOf(
  "createPromptHistoryReplayDescriptor(\n                    canonicalProviderMessages,\n                    finalPromptSent,",
);
assert.ok(
  fitIndex >= 0 && fitIndex < seedIndex && seedIndex < initialDescriptorIndex,
  "eligible canonical messages are seeded inside fitting before descriptor creation",
);
assert.ok(finalDescriptorIndex > fitIndex, "final replay persistence recomputes from the seeded canonical messages");
assert.ok(
  generateRouteSource.includes("[prompt-history-replay] eligibility mode=%s provider=%s"),
  "route emits privacy-safe replay eligibility diagnostics",
);
assert.ok(
  generateRouteSource.includes("[prompt-history-replay] persistence finalDescriptor=%s"),
  "route emits privacy-safe replay persistence diagnostics",
);

const scope: PromptHistoryReplayScope = {
  provider: "openai_chatgpt",
  model: "gpt-5.6",
  scope: "chat:conn:chars:gm:v1",
};

function evaluateProductionToolCount(
  initializer: string,
  gameToolConnection: unknown,
  responderToolDefs: unknown[] | undefined,
  provider: string,
): number {
  const transpiled = ts.transpileModule(`return (${initializer});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return Function(
    "gameToolConnection",
    "responderToolDefs",
    "conn",
    transpiled,
  )(gameToolConnection, responderToolDefs, { provider }) as number;
}

function runEligibility(toolCount: number): boolean {
  return isPromptHistoryReplayEligible({
    chatMode: "game",
    usesIndividualGroupGeneration: false,
    provider: scope.provider,
    followUpIteration: 0,
    currentTurnUserMessageId: "current",
    userMessage: "Next turn",
    toolCount,
  });
}

for (const initializer of replayToolCountInitializers) {
  for (const scenario of [
    {
      name: "separate game-tool connection",
      connection: { id: "game-tools" },
      responderToolDefs: [{ name: "responder" }],
      provider: "openai_chatgpt",
      expectedCount: 0,
      expectedEligible: true,
    },
    {
      name: "ChatGPT configured tools omitted from wire",
      connection: null,
      responderToolDefs: [{ name: "responder" }],
      provider: "openai_chatgpt",
      expectedCount: 0,
      expectedEligible: true,
    },
    {
      name: "ordinary OpenAI inline responder tools",
      connection: null,
      responderToolDefs: [{ name: "responder" }],
      provider: "openai",
      expectedCount: 1,
      expectedEligible: false,
    },
    {
      name: "no responder tools",
      connection: null,
      responderToolDefs: undefined,
      provider: "openai_chatgpt",
      expectedCount: 0,
      expectedEligible: true,
    },
  ]) {
    const actualCount = evaluateProductionToolCount(
      initializer,
      scenario.connection,
      scenario.responderToolDefs,
      scenario.provider,
    );
    assert.equal(actualCount, scenario.expectedCount, `${scenario.name}: production tool-count expression`);
    assert.equal(
      runEligibility(actualCount),
      scenario.expectedEligible,
      `${scenario.name}: real replay eligibility gate`,
    );
  }
}
const lore: ChatMessage = {
  role: "system",
  // Keep this multi-turn persistence fixture below the unchanged overhead cap.
  content: "Stable lore. ".repeat(2_000),
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

const canonical = seedPromptHistoryReplaySnapshot([
  lore,
  oldUser,
  oldAssistant,
  { ...turnInjection, content: "Previous turn state" },
  currentUser,
]);
const nextCanonical = seedPromptHistoryReplaySnapshot([
  lore,
  oldUser,
  oldAssistant,
  currentUser,
  response,
  turnInjection,
  nextUser,
]);
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
const thirdCanonical: ChatMessage[] = seedPromptHistoryReplaySnapshot([
  ...nextCanonical.slice(0, 5),
  nextUser,
  { role: "assistant", content: "Second response", contextKind: "history" },
  { ...turnInjection, content: "Third turn state" },
  { role: "user", content: "Third turn", contextKind: "history" },
]);
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

const mixedSystemTail: ChatMessage[] = [
  lore,
  oldUser,
  oldAssistant,
  currentUser,
  response,
  { role: "system", content: "trusted-looking runtime snapshot", contextKind: "injection" },
  { ...turnInjection, role: "user", content: "latest user snapshot" },
  nextUser,
];
assert.equal(
  createPromptHistoryReplayDescriptor(mixedSystemTail, mixedSystemTail, scope),
  null,
  "unmarked system snapshots, including mixed system/user tails, must remain fail-closed",
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
