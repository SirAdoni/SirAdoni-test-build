import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { transformSync } from "esbuild";
import ts from "typescript";
import {
  markNewRuntimeContextMessages,
  keepGameDialogueAdjacent,
  normalizePromptCacheLayout,
  shouldUseFullLorebookContext,
  supportsFullLorebookContext,
  type PromptCacheLayoutMessage,
} from "../../packages/server/src/services/generation/prompt-cache-layout.js";
import {
  mergeAdjacentMessages,
  squashLeadingSystemMessages,
  isPromptCacheBoundary,
} from "../../packages/server/src/services/prompt/merger.js";
import { buildGameAuthorialContinuityPrompt } from "../../packages/server/src/services/game/gm-prompts.js";
import { appendToFirstSystemMessage } from "../../packages/server/src/routes/generate/conversation-prompt-formatting.js";
import {
  appendNonLeadingSystemMessagesToLastUser,
  hasProviderMessagePayload,
  parseStoredGenerationParameters,
  postProcessMessages,
} from "../../packages/server/src/routes/generate/generate-route-utils.js";

const lore = {
  role: "system" as const,
  content: "Stable lore",
  providerMetadata: { marinaraFullLoreContext: true, audience: "all" },
};
const dynamic = {
  role: "system" as const,
  content: "Changing memory",
  contextKind: "injection" as const,
  providerMetadata: { source: "app", revision: 2, marinaraRuntimeContext: true },
  images: ["data:image/png;base64,abc"],
};
const oldHistory = { role: "assistant" as const, content: "Old history", contextKind: "history" as const };
const currentUser = { role: "user" as const, content: "Current user", contextKind: "history" as const };
const prefill = { role: "assistant" as const, content: "Prefill" };
const input = [lore, dynamic, oldHistory, currentUser, prefill];
const output = normalizePromptCacheLayout(input);

assert.deepEqual(output[0], lore);
assert.deepEqual(output[1], oldHistory);
assert.deepEqual(output[2], dynamic);
assert.deepEqual(output[3], currentUser);
assert.deepEqual(output[4], prefill);
assert.notStrictEqual(output[0], lore);
assert.notStrictEqual(output[2], dynamic);
assert.deepEqual(output[2].providerMetadata, dynamic.providerMetadata);
assert.deepEqual(output[2].images, dynamic.images);
assert.deepEqual(input, [lore, dynamic, oldHistory, currentUser, prefill]);

const gmReference = {
  role: "system" as const,
  content: "Historical reference",
  contextKind: "injection" as const,
  providerMetadata: { marinaraGmReference: true },
};
const referenceLayout = normalizePromptCacheLayout([lore, gmReference, oldHistory, currentUser]);
for (const transform of [mergeAdjacentMessages, squashLeadingSystemMessages]) {
  const boundaryMessages = transform([
    lore,
    gmReference,
    { role: "system", content: "Later system rules" },
    currentUser,
  ]);
  assert.equal(
    boundaryMessages.find((message) => message.providerMetadata?.marinaraGmReference)?.content,
    gmReference.content,
  );
  assert.equal(
    boundaryMessages.some((message) => message.content === "Later system rules"),
    true,
  );
}
assert.equal(referenceLayout[0]?.role, "system");
assert.equal(referenceLayout[1]?.role, "user", "stable GM reference becomes user context");
assert.equal(referenceLayout[1]?.providerMetadata?.marinaraGmReference, true);
assert.deepEqual(referenceLayout[2], oldHistory);
assert.deepEqual(normalizePromptCacheLayout(referenceLayout), referenceLayout, "reference normalization is idempotent");
const macroReference = normalizePromptCacheLayout([
  lore,
  { ...gmReference, content: "Reference {{time}}" },
  oldHistory,
  currentUser,
]);
const macroReferenceMessage = macroReference.find((message) => message.content === "Reference {{time}}");
assert.equal(macroReferenceMessage?.role, "user", "macro-bearing reference remains a volatile user tail");
const expandedMacroReference = normalizePromptCacheLayout([
  lore,
  {
    ...gmReference,
    content: "Reference resolved at 12:34",
    providerMetadata: { marinaraGmReference: true, marinaraRuntimeContext: true },
  },
  oldHistory,
  currentUser,
]);
const expandedMacroReferenceMessage = expandedMacroReference.find(
  (message) => message.content === "Reference resolved at 12:34",
);
assert.equal(expandedMacroReferenceMessage?.role, "user", "expanded macro references remain user context");
assert.equal(expandedMacroReferenceMessage?.providerMetadata?.marinaraRuntimeContext, true);
assert.ok(
  expandedMacroReference.indexOf(expandedMacroReferenceMessage!) <
    expandedMacroReference.findIndex((message) => message.content === "Current user"),
);
const stableIdentityReference = normalizePromptCacheLayout([
  lore,
  {
    ...gmReference,
    content: "Biography for {{user}}",
  },
  oldHistory,
  currentUser,
]);
assert.equal(stableIdentityReference.find((message) => message.content === "Biography for {{user}}")?.role, "user");

const stableGameSystem = {
  role: "system" as const,
  content: "Stable GM instructions",
  contextKind: "prompt" as const,
};
const firstAuthorialHistory = [
  { role: "user", content: "[To the GM] Keep the established calendar." },
  { role: "assistant", content: "The scene continues." },
];
const secondAuthorialHistory = [
  ...firstAuthorialHistory,
  { role: "user", content: "[To the GM] The correction also applies to the current scene." },
];
// Exercise the production fragment without booting the server or opening its database.
const repoRoot = path.resolve(import.meta.dirname, "../..");
const routeSource = fs.readFileSync(
  process.env.MARINARA_CACHE_PROOF_ROUTE ?? path.join(repoRoot, "packages/server/src/routes/generate.routes.ts"),
  "utf8",
);
const extractVariableStatement = (source: string, fileName: string, name: string): string => {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  let extracted = "";
  const walk = (node: ts.Node) => {
    if (extracted) return;
    if (ts.isVariableStatement(node)) {
      const declaration = node.declarationList.declarations.find((item) => item.name.getText(sourceFile) === name);
      if (declaration) extracted = source.slice(node.getStart(sourceFile), node.getEnd());
    }
    if (!extracted) ts.forEachChild(node, walk);
  };
  walk(sourceFile);
  return extracted;
};
const fragmentStart = routeSource.indexOf("if (gameAuthorialContinuity) {");
const fragmentEnd = routeSource.indexOf("// LOG_LEVEL=debug", fragmentStart);
assert.ok(fragmentStart >= 0 && fragmentEnd > fragmentStart, "Authorial route fragment must exist");
const applyRouteAuthorial = new Function(
  "finalMessages",
  "gameAuthorialContinuity",
  "conn",
  "resolvePromptMacros",
  "supportsFullLorebookContext",
  "appendToFirstSystemMessage",
  transformSync(routeSource.slice(fragmentStart, fragmentEnd), { loader: "ts" }).code,
);
const buildCacheProviderMessages = (
  authorialHistory: ReadonlyArray<{ role: string; content: string }>,
  provider = "claude_subscription",
) => {
  const continuity = buildGameAuthorialContinuityPrompt(authorialHistory);
  const messages: PromptCacheLayoutMessage[] = [stableGameSystem, oldHistory, currentUser].map((m) => ({ ...m }));
  applyRouteAuthorial(
    messages,
    continuity,
    { provider },
    (text: string) => text,
    supportsFullLorebookContext,
    appendToFirstSystemMessage,
  );
  if (supportsFullLorebookContext(provider)) messages.unshift({ ...lore });
  const merged = mergeAdjacentMessages(squashLeadingSystemMessages(messages));
  return supportsFullLorebookContext(provider) ? normalizePromptCacheLayout(merged) : merged;
};
const firstAuthorialLayout = buildCacheProviderMessages(firstAuthorialHistory);
const secondAuthorialLayout = buildCacheProviderMessages(secondAuthorialHistory);
assert.deepEqual(firstAuthorialLayout.slice(0, 2), secondAuthorialLayout.slice(0, 2));
assert.deepEqual(firstAuthorialLayout[2], oldHistory);
assert.deepEqual(secondAuthorialLayout[2], oldHistory);
assert.equal(firstAuthorialLayout[3]?.providerMetadata?.marinaraRuntimeContext, true);
assert.equal(secondAuthorialLayout[3]?.providerMetadata?.marinaraRuntimeContext, true);
assert.match(firstAuthorialLayout[3]?.content ?? "", /Keep the established calendar/);
assert.doesNotMatch(firstAuthorialLayout[3]?.content ?? "", /current scene/);
assert.match(secondAuthorialLayout[3]?.content ?? "", /Keep the established calendar/);
assert.match(secondAuthorialLayout[3]?.content ?? "", /current scene/);
assert.deepEqual(firstAuthorialLayout[4], currentUser);
assert.deepEqual(secondAuthorialLayout[4], currentUser);

assert.equal(secondAuthorialLayout.filter((m) => m.content.includes("<authorial_continuity>")).length, 1);
assert.deepEqual(buildCacheProviderMessages(secondAuthorialHistory, "openai_chatgpt"), secondAuthorialLayout);
const ordinaryProviderLayout = buildCacheProviderMessages(secondAuthorialHistory, "anthropic");
assert.equal(ordinaryProviderLayout[0]?.role, "system");
assert.match(ordinaryProviderLayout[0]?.content ?? "", /Stable GM instructions[\s\S]*<authorial_continuity>/);
assert.match(ordinaryProviderLayout[0]?.content ?? "", /current scene/);
assert.deepEqual(ordinaryProviderLayout.at(-1), currentUser);

const extraStart = routeSource.indexOf("if (gameSpecialInstructionsPrompt) {");
const extraEnd = routeSource.indexOf("if (gameAuthorialContinuity)", extraStart);
assert.ok(extraStart >= 0 && extraEnd > extraStart, "Extra Instructions route fragment must exist");
const applyRouteExtraInstructions = new Function(
  "finalMessages",
  "gameSpecialInstructionsPrompt",
  "conn",
  "resolvePromptMacros",
  "supportsFullLorebookContext",
  "appendToFirstSystemMessage",
  transformSync(routeSource.slice(extraStart, extraEnd), { loader: "ts" }).code,
);
const fullExtraMessages: any[] = [
  { role: "system", content: "Stable GM", providerMetadata: { marinaraGmStable: true } },
  { role: "system", content: "GM dynamic", contextKind: "injection", providerMetadata: { marinaraGmDynamic: true } },
];
applyRouteExtraInstructions(
  fullExtraMessages,
  "<instructions>Keep the calendar</instructions>",
  { provider: "claude_subscription" },
  (text: string) => text,
  supportsFullLorebookContext,
  appendToFirstSystemMessage,
);
assert.equal(fullExtraMessages[0].content, "Stable GM", "full-lore Extra Instructions do not mutate stable GM content");
assert.equal(fullExtraMessages.filter((message) => message.content.includes("Keep the calendar")).length, 1);
assert.equal(fullExtraMessages[1]?.providerMetadata?.marinaraGameSpecialInstructions, true);
assert.equal(fullExtraMessages[1]?.providerMetadata?.marinaraGmDynamic, undefined);
assert.equal(fullExtraMessages[1]?.providerMetadata?.marinaraRuntimeContext, undefined);
const macroExtraMessages: any[] = [{ role: "system", content: "Stable GM" }];
applyRouteExtraInstructions(
  macroExtraMessages,
  "<instructions>The current date is {{date}}</instructions>",
  { provider: "claude_subscription" },
  (text: string) => text.replace("{{date}}", "Day 18"),
  supportsFullLorebookContext,
  appendToFirstSystemMessage,
);
assert.equal(macroExtraMessages[1]?.providerMetadata?.marinaraGmDynamic, true);
assert.equal(macroExtraMessages[1]?.providerMetadata?.marinaraRuntimeContext, true);
assert.equal(macroExtraMessages[1]?.role, "system");
assert.match(macroExtraMessages[1]?.content, /Day 18/u);
const normalizedExtra = appendNonLeadingSystemMessagesToLastUser(
  normalizePromptCacheLayout([{ ...lore }, ...fullExtraMessages, oldHistory, currentUser]),
);
assert.equal(
  normalizedExtra.find((message) => message.content.includes("Keep the calendar"))?.role,
  "system",
  "user-authored Extra Instructions retain system authority after final normalization",
);
const ordinaryExtraMessages: any[] = [{ role: "system", content: "Stable GM" }];
applyRouteExtraInstructions(
  ordinaryExtraMessages,
  "<instructions>Keep the calendar</instructions>",
  { provider: "anthropic" },
  (text: string) => text,
  supportsFullLorebookContext,
  appendToFirstSystemMessage,
);
assert.match(ordinaryExtraMessages[0].content, /Stable GM[\s\S]*Keep the calendar/u);
assert.equal(ordinaryExtraMessages.length, 1, "ordinary providers retain one system prompt");

const misplaced = normalizePromptCacheLayout([dynamic, lore, oldHistory, currentUser]);
assert.deepEqual(misplaced[0], lore);
assert.deepEqual(misplaced[2], dynamic);
assert.notStrictEqual(misplaced[0], lore);
assert.notStrictEqual(misplaced[2], dynamic);
const withoutLore = normalizePromptCacheLayout([
  { ...dynamic, content: "Runtime memory" },
  { role: "system" as const, content: "Stable GM", contextKind: "prompt" as const },
  currentUser,
]);
assert.equal(withoutLore[0].content, "Stable GM");
assert.equal(withoutLore[1].content, "Runtime memory");
const unmarkedInjection = {
  role: "system" as const,
  content: "User-authored injection",
  contextKind: "injection" as const,
  providerMetadata: { source: "user" },
};
const preserved = normalizePromptCacheLayout([lore, unmarkedInjection, oldHistory, currentUser]);
assert.deepEqual(
  preserved.map(({ content }) => content),
  ["Stable lore", "User-authored injection", "Old history", "Current user"],
);
assert.deepEqual(preserved[1]?.providerMetadata, unmarkedInjection.providerMetadata);
assert.notStrictEqual(preserved[1], unmarkedInjection);
const runtimeSummary = {
  role: "system" as const,
  content: "Automatic runtime summary",
  contextKind: "injection" as const,
  providerMetadata: { marinaraRuntimeContext: true },
};
const staticSystem = { role: "system" as const, content: "Static GM", contextKind: "prompt" as const };
const mergedBoundary = mergeAdjacentMessages([
  staticSystem,
  runtimeSummary,
  { ...staticSystem, content: "Tail rules" },
]);
assert.deepEqual(
  mergedBoundary.map(({ content }) => content),
  ["Static GM", "Automatic runtime summary", "Tail rules"],
);
assert.deepEqual(mergedBoundary[1]?.providerMetadata, runtimeSummary.providerMetadata);
const squashedBoundary = squashLeadingSystemMessages([
  staticSystem,
  runtimeSummary,
  { ...staticSystem, content: "Tail rules" },
  currentUser,
]);
assert.deepEqual(
  squashedBoundary.map(({ content }) => content),
  ["Static GM", "Automatic runtime summary", "Tail rules", "Current user"],
);
assert.deepEqual(squashedBoundary[1]?.providerMetadata, runtimeSummary.providerMetadata);
const dynamicLore = {
  role: "system" as const,
  content: "Dynamic lore",
  providerMetadata: { marinaraDynamicLoreContext: true, marinaraRuntimeContext: true },
};
const loreBoundary = mergeAdjacentMessages([lore, dynamicLore, currentUser]);
assert.deepEqual(
  loreBoundary.map(({ content }) => content),
  ["Stable lore", "Dynamic lore", "Current user"],
);
assert.deepEqual(loreBoundary[1]?.providerMetadata, dynamicLore.providerMetadata);
const spatialInput = [
  { ...staticSystem, content: "Stable GM" },
  { ...oldHistory, content: "History" },
];
const spatialOutput = markNewRuntimeContextMessages(spatialInput, (messages) => [
  ...messages.map((message) => ({ ...message, content: message.content })),
  { role: "system" as const, content: "Spatial state" },
]);
assert.equal(spatialOutput[0]?.providerMetadata, undefined);
assert.equal(spatialOutput[1]?.providerMetadata, undefined);
assert.equal(spatialOutput[2]?.providerMetadata?.marinaraRuntimeContext, true);
assert.equal(Object.getOwnPropertySymbols(spatialOutput[0]!).length, 0);
assert.deepEqual(spatialInput[0], { ...staticSystem, content: "Stable GM" });
assert.equal(supportsFullLorebookContext("openai_chatgpt"), true);
assert.equal(supportsFullLorebookContext("claude_subscription"), true);
assert.equal(supportsFullLorebookContext("anthropic"), false);
assert.equal(shouldUseFullLorebookContext("claude_subscription", false), true);
assert.equal(shouldUseFullLorebookContext("claude_subscription", true), false);

const gameAssistant = {
  role: "assistant" as const,
  content: "Corvina answers from the grove gate.",
  contextKind: "history" as const,
  providerMetadata: { id: "assistant-1" },
  images: ["data:image/png;base64,portrait"],
};
const gameUser = {
  role: "user" as const,
  content: "Please ask Corvina to bring you to Odrana.",
  contextKind: "history" as const,
  providerMetadata: { id: "user-1" },
};
const runtimeContext = {
  role: "user" as const,
  content: "Current runtime context",
  contextKind: "injection" as const,
  providerMetadata: { marinaraRuntimeContext: true },
};
const dynamicLoreContext = {
  role: "user" as const,
  content: "Current dynamic lore",
  providerMetadata: { marinaraDynamicLoreContext: true },
};
const staticLore = { role: "system" as const, content: "Static lore" };
const gameLayout = [staticLore, gameAssistant, runtimeContext, dynamicLoreContext, gameUser] as const;
const gameLayoutCopy = [...gameLayout];
const adjacentGameLayout = keepGameDialogueAdjacent(gameLayout);
assert.deepEqual(
  adjacentGameLayout.map((message) => message.content),
  [
    "Static lore",
    "Current runtime context",
    "Current dynamic lore",
    "Corvina answers from the grove gate.",
    "Please ask Corvina to bring you to Odrana.",
  ],
  "the preceding assistant moves across runtime and dynamic-lore blocks to the current user turn",
);
assert.strictEqual(
  adjacentGameLayout[3],
  gameAssistant,
  "the assistant object, including media and metadata, is preserved",
);
assert.deepEqual(gameLayout, gameLayoutCopy, "adjacency repair does not mutate the input array");
assert.strictEqual(adjacentGameLayout[2], dynamicLoreContext, "movable context objects remain intact");
assert.deepEqual(adjacentGameLayout[3].images, gameAssistant.images, "assistant media is preserved");
assert.deepEqual(
  keepGameDialogueAdjacent(adjacentGameLayout),
  adjacentGameLayout,
  "already-adjacent dialogue is idempotent",
);

const olderGameHistory = { role: "assistant" as const, content: "Older history", contextKind: "history" as const };

// A World Maps spatial block is inserted right after the system prompt and names the current location.
// On providers without the subscription layout it must travel to the current turn, so a move changes only
// the tail of the prompt and the system prompt plus older history stay a byte-identical cacheable prefix.
const gmPrompt = { role: "system" as const, content: "GM system prompt" };
const spatialAt = (place: string) => ({
  role: "system" as const,
  content: `<spatial_context mode="game" authority="application">Current path: ${place}</spatial_context>`,
  contextKind: "injection" as const,
  providerMetadata: { marinaraRuntimeContext: true },
});
const spatialLayout = (place: string) =>
  keepGameDialogueAdjacent([gmPrompt, spatialAt(place), olderGameHistory, gameAssistant, gameUser]);
const inHall = spatialLayout("Great Hall");
assert.deepEqual(
  inHall.map((message) => message.content),
  [
    "GM system prompt",
    "Older history",
    '<spatial_context mode="game" authority="application">Current path: Great Hall</spatial_context>',
    "Corvina answers from the grove gate.",
    "Please ask Corvina to bring you to Odrana.",
  ],
  "the spatial block moves from the system prefix to the current turn",
);
const inGarden = spatialLayout("Garden Room");
assert.deepEqual(
  inGarden.slice(0, 2).map((message) => message.content),
  inHall.slice(0, 2).map((message) => message.content),
  "changing location leaves the system prompt and older history identical",
);
assert.deepEqual(
  keepGameDialogueAdjacent([gmPrompt, { ...gmPrompt, content: "User prompt section" }, olderGameHistory, gameUser]).map(
    (message) => message.content,
  ),
  ["GM system prompt", "User prompt section", "Older history", "Please ask Corvina to bring you to Odrana."],
  "unmarked system sections keep their place",
);
assert.deepEqual(
  keepGameDialogueAdjacent([staticLore, olderGameHistory, gameAssistant, runtimeContext, gameUser]),
  [staticLore, olderGameHistory, runtimeContext, gameAssistant, gameUser],
  "older history remains in place while the latest assistant becomes adjacent",
);
assert.deepEqual(
  keepGameDialogueAdjacent([
    staticLore,
    gameAssistant,
    runtimeContext,
    { ...runtimeContext, content: "Second runtime" },
    gameUser,
  ]),
  [staticLore, runtimeContext, { ...runtimeContext, content: "Second runtime" }, gameAssistant, gameUser],
  "multiple runtime blocks can be crossed",
);

const unmarkedCustomPrompt = { role: "user" as const, content: "User-authored custom prompt" };
assert.deepEqual(
  keepGameDialogueAdjacent([staticLore, gameAssistant, unmarkedCustomPrompt, gameUser]),
  [staticLore, gameAssistant, unmarkedCustomPrompt, gameUser],
  "unmarked custom prompts block movement",
);
assert.deepEqual(
  keepGameDialogueAdjacent([staticLore, gameAssistant, { ...gameUser, content: "Another user turn" }, gameUser]),
  [staticLore, gameAssistant, { ...gameUser, content: "Another user turn" }, gameUser],
  "another history user turn blocks movement",
);
assert.deepEqual(
  keepGameDialogueAdjacent([
    staticLore,
    gameAssistant,
    { role: "assistant" as const, content: "Assistant prefill" },
    gameUser,
  ]),
  [staticLore, gameAssistant, { role: "assistant" as const, content: "Assistant prefill" }, gameUser],
  "assistant prefill without history status blocks movement",
);
assert.deepEqual(
  keepGameDialogueAdjacent([
    staticLore,
    gameAssistant,
    { role: "system" as const, content: "Custom system prompt" },
    gameUser,
  ]),
  [staticLore, gameAssistant, { role: "system" as const, content: "Custom system prompt" }, gameUser],
  "system prompts block movement",
);
assert.deepEqual(
  keepGameDialogueAdjacent([
    staticLore,
    gameAssistant,
    { role: "system" as const, content: "System injection", contextKind: "injection" as const },
    gameUser,
  ]),
  [
    staticLore,
    gameAssistant,
    { role: "system" as const, content: "System injection", contextKind: "injection" as const },
    gameUser,
  ],
  "system injection messages are not movable before role normalization",
);
const runtimeSystemContext = {
  role: "system" as const,
  content: "Marked runtime system context",
  contextKind: "injection" as const,
  providerMetadata: { marinaraRuntimeContext: true },
};
assert.deepEqual(
  keepGameDialogueAdjacent([staticLore, gameAssistant, runtimeSystemContext, gameUser]),
  [staticLore, runtimeSystemContext, gameAssistant, gameUser],
  "explicitly marked runtime system context moves with app-owned runtime blocks",
);
assert.deepEqual(
  keepGameDialogueAdjacent([
    staticLore,
    gameAssistant,
    { role: "assistant" as const, content: "Assistant runtime", contextKind: "injection" as const },
    gameUser,
  ]),
  [
    staticLore,
    gameAssistant,
    { role: "assistant" as const, content: "Assistant runtime", contextKind: "injection" as const },
    gameUser,
  ],
  "assistant injection messages are not movable",
);
assert.deepEqual(
  keepGameDialogueAdjacent([staticLore, gameAssistant, gameUser, { role: "assistant" as const, content: "Prefill" }]),
  [staticLore, gameAssistant, gameUser, { role: "assistant" as const, content: "Prefill" }],
  "non-user tails remain unchanged",
);

// Exercise the live regular-generation preparation fragment, including its
// provider merge and system-message normalization around the adjacency helper.
const routeMergeStart = routeSource.indexOf("const mergeProviderAdjacentMessages =");
const routeMergeDeclaration = extractVariableStatement(
  routeSource,
  "generate.routes.ts",
  "mergeProviderAdjacentMessages",
);
const routePrepareDeclaration = extractVariableStatement(routeSource, "generate.routes.ts", "prepareProviderMessages");
assert.ok(
  routeMergeStart >= 0 && routeMergeDeclaration && routePrepareDeclaration,
  "regular provider preparation fragment must exist",
);
const makeRoutePreparers = (provider: string, chatMode: string, impersonate: boolean) => {
  return new Function(
    "hasProviderMessagePayload",
    "isPromptCacheBoundary",
    "appendNonLeadingSystemMessagesToLastUser",
    "keepGameDialogueAdjacent",
    "supportsFullLorebookContext",
    "postProcessMessages",
    "parseStoredGenerationParameters",
    "conn",
    "chatMode",
    "input",
    "resolvedPreset",
    "providerRuntime",
    `${transformSync(`${routeMergeDeclaration}\n${routePrepareDeclaration}`, { loader: "ts" }).code}; return { mergeProviderAdjacentMessages, prepareProviderMessages };`,
  )(
    hasProviderMessagePayload,
    isPromptCacheBoundary,
    appendNonLeadingSystemMessagesToLastUser,
    keepGameDialogueAdjacent,
    supportsFullLorebookContext,
    postProcessMessages,
    parseStoredGenerationParameters,
    { provider },
    chatMode,
    { impersonate },
    { parameters: JSON.stringify({ strictRoleFormatting: false }) },
    { connectionParams: {}, chatParams: {} },
  ) as {
    mergeProviderAdjacentMessages: (messages: any[]) => any[];
    prepareProviderMessages: (messages: any[]) => any[];
  };
};
const routePreparers = makeRoutePreparers("anthropic", "game", false);
const routeFixture = [
  { ...lore },
  { ...gameAssistant },
  { ...runtimeContext },
  {
    role: "system" as const,
    content: "System runtime injection",
    contextKind: "injection" as const,
    providerMetadata: { marinaraRuntimeContext: true },
  },
  { ...gameUser },
];
const routeBaseline = routePreparers.mergeProviderAdjacentMessages(
  appendNonLeadingSystemMessagesToLastUser(routeFixture),
);
const routeGamePrepared = routePreparers.prepareProviderMessages(routeFixture);
const routeGameUserIndex = routeGamePrepared.length - 1;
assert.equal(routeGamePrepared[routeGameUserIndex]?.contextKind, "history");
assert.equal(routeGamePrepared[routeGameUserIndex - 1]?.content, gameAssistant.content);
assert.notDeepEqual(
  routeGamePrepared,
  routeBaseline,
  "regular Game preparation applies dialogue adjacency after normalization",
);

const routeNonGamePreparers = makeRoutePreparers("anthropic", "conversation", false);
assert.deepEqual(
  routeNonGamePreparers.prepareProviderMessages(routeFixture),
  routeBaseline,
  "non-game preparation does not apply adjacency",
);
const routeImpersonationPreparers = makeRoutePreparers("anthropic", "game", true);
assert.deepEqual(
  routeImpersonationPreparers.prepareProviderMessages(routeFixture),
  routeImpersonationPreparers.mergeProviderAdjacentMessages(appendNonLeadingSystemMessagesToLastUser(routeFixture)),
  "impersonation skips Game adjacency",
);
const routeSubscriptionPreparers = makeRoutePreparers("claude_subscription", "game", false);
assert.deepEqual(
  routeSubscriptionPreparers.prepareProviderMessages(routeFixture),
  routeBaseline,
  "subscription providers keep the cached history prefix instead of reordering the last GM reply",
);

// Exercise the dry-run preparation fragment as a separate production caller.
const dryRunRouteSource = fs.readFileSync(
  path.join(repoRoot, "packages/server/src/routes/generate/dry-run-route.ts"),
  "utf8",
);
const dryPrepareDeclaration = extractVariableStatement(
  dryRunRouteSource,
  "dry-run-route.ts",
  "prepareProviderMessages",
);
assert.ok(dryPrepareDeclaration, "dry-run provider preparation fragment must exist");
const dryPrepare = new Function(
  "mergeAdjacentMessages",
  "keepGameDialogueAdjacent",
  "supportsFullLorebookContext",
  "postProcessMessages",
  "parseStoredGenerationParameters",
  "conn",
  "chatMode",
  "impersonate",
  "effectivePreset",
  "connectionParams",
  "chatParams",
  `${transformSync(dryPrepareDeclaration, { loader: "ts" }).code}; return prepareProviderMessages;`,
)(
  mergeAdjacentMessages,
  keepGameDialogueAdjacent,
  supportsFullLorebookContext,
  postProcessMessages,
  parseStoredGenerationParameters,
  { provider: "anthropic" },
  "game",
  false,
  { parameters: JSON.stringify({ strictRoleFormatting: false }) },
  {},
  {},
) as (messages: any[]) => any[];
const dryGamePrepared = dryPrepare(routeFixture);
assert.equal(dryGamePrepared.at(-1)?.role, "user");
assert.equal(dryGamePrepared.at(-1)?.contextKind, "history");
assert.equal(dryGamePrepared.at(-2)?.content, gameAssistant.content, "dry-run preparation preserves Game adjacency");
const drySubscriptionPrepare = new Function(
  "mergeAdjacentMessages",
  "keepGameDialogueAdjacent",
  "supportsFullLorebookContext",
  "postProcessMessages",
  "parseStoredGenerationParameters",
  "conn",
  "chatMode",
  "impersonate",
  "effectivePreset",
  "connectionParams",
  "chatParams",
  `${transformSync(dryPrepareDeclaration, { loader: "ts" }).code}; return prepareProviderMessages;`,
)(
  mergeAdjacentMessages,
  keepGameDialogueAdjacent,
  supportsFullLorebookContext,
  postProcessMessages,
  parseStoredGenerationParameters,
  { provider: "claude_subscription" },
  "game",
  false,
  { parameters: JSON.stringify({ strictRoleFormatting: false }) },
  {},
  {},
) as (messages: any[]) => any[];
assert.deepEqual(
  drySubscriptionPrepare(routeFixture),
  mergeAdjacentMessages(appendNonLeadingSystemMessagesToLastUser(routeFixture)),
  "dry-run preparation skips adjacency for subscription providers",
);

console.log("Prompt cache layout regression passed.");
