import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourcePath = join(repositoryRoot, "packages/client/src/components/game/GameSurface.tsx");
const sourceText = readFileSync(sourcePath, "utf8");
const sourceFile = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let declaration;
function findCallbackDeclaration(node) {
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.name.text === "generateMissingCampaignPortraits"
  ) {
    declaration = node;
    return;
  }
  ts.forEachChild(node, findCallbackDeclaration);
}
findCallbackDeclaration(sourceFile);
assert.ok(declaration?.initializer && ts.isCallExpression(declaration.initializer));
const callbackNode = declaration.initializer.arguments[0];
assert.ok(
  callbackNode && ts.isArrowFunction(callbackNode),
  "Expected the real portrait callback to be an arrow function",
);

const compiled = ts.transpileModule(`const callback = ${callbackNode.getText(sourceFile)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const callbackFactory = new Function(
  "deps",
  `const { gameImageGenerationEnabled, activeChatId, queryClient, isCampaignFeatureEnabled, localizeUi, resolveGameSetupArtStylePrompt, chatMeta, buildCampaignPortraitBatches, DEFAULT_CAMPAIGN_PORTRAIT_STYLE_PROMPT, useChatStore, runGameAssetGeneration, applyGeneratedAssets } = deps;\n${compiled}\nreturn callback;`,
);

const contacts = ["npc-a", "npc-b"].map((id) => ({
  id,
  sourceChatId: "chat-a",
  name: id,
  portraitDescription: `Appearance for ${id}`,
  avatar: null,
}));

function createHarness({ onGenerate, onApply } = {}) {
  const state = { campaignPortraits: true };
  let activeStoreChatId = "chat-a";
  let generationCalls = 0;
  const applied = [];
  const callback = callbackFactory({
    gameImageGenerationEnabled: true,
    activeChatId: "chat-a",
    queryClient: {},
    isCampaignFeatureEnabled: (_client, feature) => state[feature] === true,
    localizeUi: (key) => key,
    resolveGameSetupArtStylePrompt: () => "campaign style",
    chatMeta: { gameSetupConfig: null },
    buildCampaignPortraitBatches: (candidates, _existing, stylePrompt) =>
      candidates.map((candidate) => ({ stylePrompt, candidates: [candidate] })),
    DEFAULT_CAMPAIGN_PORTRAIT_STYLE_PROMPT: "default style",
    useChatStore: { getState: () => ({ activeChatId: activeStoreChatId }) },
    runGameAssetGeneration: async (...args) => {
      generationCalls += 1;
      return onGenerate ? onGenerate(...args) : { generatedNpcAvatars: [{ npcId: "npc-a" }] };
    },
    applyGeneratedAssets: async (result) => {
      applied.push(result);
      await onApply?.(result);
    },
  });
  return {
    callback,
    state,
    applied,
    get generationCalls() {
      return generationCalls;
    },
    set activeStoreChatId(value) {
      activeStoreChatId = value;
    },
  };
}

function deferred() {
  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

const switchedGeneration = deferred();
let switchedStarted;
const switchedStart = new Promise((resolve) => {
  switchedStarted = resolve;
});
const switched = createHarness({
  onGenerate: () => {
    switchedStarted();
    return switchedGeneration.promise;
  },
});
const switchedWork = switched.callback(contacts.slice(0, 1));
await switchedStart;
switched.activeStoreChatId = "chat-b";
switchedGeneration.resolve({ generatedNpcAvatars: [{ npcId: "npc-a" }] });
await assert.rejects(switchedWork, /ui\.game\.contactBook\.portraitGeneration\.unavailable/u);
assert.equal(switched.applied.length, 0, "A result from a chat that is no longer active must not be applied");

const disabledGeneration = deferred();
let disabledStarted;
const disabledStart = new Promise((resolve) => {
  disabledStarted = resolve;
});
const disabled = createHarness({
  onGenerate: () => {
    disabledStarted();
    return disabledGeneration.promise;
  },
});
const disabledWork = disabled.callback(contacts.slice(0, 1));
await disabledStart;
disabled.state.campaignPortraits = false;
disabledGeneration.resolve({ generatedNpcAvatars: [{ npcId: "npc-a" }] });
await assert.rejects(disabledWork, /ui\.game\.contactBook\.portraitGeneration\.unavailable/u);
assert.equal(disabled.applied.length, 0, "Turning the opt-in off during generation must discard its result");

const stable = createHarness();
assert.deepEqual(await stable.callback(contacts.slice(0, 1)), { generated: 1, failed: 0 });
assert.equal(stable.applied.length, 1, "A stable opt-in generation should apply its result");

const cancelled = createHarness({ onGenerate: () => null });
assert.deepEqual(await cancelled.callback(contacts), { generated: 0, failed: 0 });
assert.equal(cancelled.generationCalls, 1, "Cancelling prompt review must stop subsequent portrait batches");
assert.equal(cancelled.applied.length, 0);

const laterBatch = createHarness({
  onApply: () => {
    laterBatch.state.campaignPortraits = false;
  },
});
await assert.rejects(laterBatch.callback(contacts), /ui\.game\.contactBook\.portraitGeneration\.unavailable/u);
assert.equal(laterBatch.generationCalls, 1, "A setting change between batches must prevent later requests");
assert.equal(laterBatch.applied.length, 1, "Only the first batch may apply before opt-out");

function nodesWhere(predicate) {
  const result = [];
  function visit(node) {
    if (predicate(node)) result.push(node);
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return result;
}
function executeClose(callback) {
  const calls = [];
  const names = [...new Set(callback.getText(sourceFile).match(/\b(?:set\w+|resetGalleryState)(?=\()/gu))];
  const run = new Function(...names, `return (${callback.getText(sourceFile)});`)(
    ...names.map((name) => (value) => calls.push([name, value])),
  );
  run();
  assert.ok(calls.some(([name, value]) => name === "setContactBookOpen" && value === false));
}
for (const name of ["closeLocalFloatingWindows", "closeGameFloatingPanels"]) {
  const declarations = nodesWhere((node) => ts.isVariableDeclaration(node) && node.name.getText(sourceFile) === name);
  assert.equal(declarations.length, 1);
  executeClose(declarations[0].initializer.arguments[0]);
}
const resetEffects = nodesWhere(
  (node) =>
    ts.isCallExpression(node) &&
    node.expression.getText(sourceFile) === "useEffect" &&
    node.arguments[1]?.getText(sourceFile) === "[activeChatId]" &&
    node.arguments[0].getText(sourceFile).includes("setChatHelpOpen(false)"),
);
assert.equal(resetEffects.length, 1);
executeClose(resetEffects[0].arguments[0]);
for (const name of ["narrationAutoPlayBlocked", "narrationVoicePlaybackBlocked"]) {
  const declarations = nodesWhere((node) => ts.isVariableDeclaration(node) && node.name.getText(sourceFile) === name);
  assert.equal(declarations.length, 1);
  const expression = declarations[0].initializer.getText(sourceFile);
  const names = [...new Set(expression.match(/\b[a-zA-Z]\w*/gu))];
  const evaluate = new Function(...names, `return ${expression};`);
  assert.equal(
    evaluate(...names.map((key) => key === "contactBookOpen" || key === "gameContactBookEnabled")),
    true,
    `${name} must include the Contact Book`,
  );
  assert.equal(evaluate(...names.map(() => false)), false);
  assert.equal(
    evaluate(...names.map((key) => key === "contactBookOpen")),
    false,
    "Disabled Contact Book must not block narration",
  );
}
