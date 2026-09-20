import assert from "node:assert/strict";
import { fitMessagesToContext, type ChatMessage } from "../../packages/server/src/services/llm/base-provider.js";
import {
  markNewRuntimeContextMessages,
  normalizePromptCacheLayout,
} from "../../packages/server/src/services/generation/prompt-cache-layout.js";
import {
  mergeAdjacentMessages,
  squashLeadingSystemMessages,
} from "../../packages/server/src/services/prompt/merger.js";
import { appendNonLeadingSystemMessagesToLastUser } from "../../packages/server/src/routes/generate/generate-route-utils.js";

/**
 * This is compositional coverage of the cache-layout helpers. It does not boot
 * the generation route, a provider, or a database, so it is not whole-feature
 * route coverage.
 */
type RuntimeVariant = {
  name: string;
  content: (state: string) => string;
  metadata: Record<string, unknown>;
};

const stableLore: ChatMessage = {
  role: "system",
  content: "Stable canon: the observatory remains open.",
  contextKind: "prompt",
  providerMetadata: { marinaraFullLoreContext: true },
};
const staticGm: ChatMessage = {
  role: "system",
  content: "Static GM rules: preserve established facts.",
  contextKind: "prompt",
};
const oldHistory: ChatMessage = {
  role: "assistant",
  content: "Old history: the party arrived yesterday.",
  contextKind: "history",
};
const currentUser: ChatMessage = {
  role: "user",
  content: "Continue from here.",
  contextKind: "history",
};
const prefill: ChatMessage = { role: "assistant", content: "" };

const variants: RuntimeVariant[] = [
  { name: "weather", content: (state) => `Weather: ${state}`, metadata: { source: "weather" } },
  { name: "time", content: (state) => `Time: ${state}`, metadata: { source: "time" } },
  { name: "scene+presence", content: (state) => `Scene and presence: ${state}`, metadata: { source: "scene" } },
  { name: "map", content: (state) => `Map position: ${state}`, metadata: { source: "map" } },
  { name: "inventory", content: (state) => `Inventory: ${state}`, metadata: { source: "inventory" } },
  { name: "authorial", content: (state) => `Authorial continuity: ${state}`, metadata: { source: "authorial" } },
  { name: "summary", content: (state) => `Summary: ${state}`, metadata: { source: "summary" } },
  { name: "capability", content: (state) => `Capability result: ${state}`, metadata: { source: "capability" } },
  {
    name: "dynamic-lore",
    content: (state) => `Dynamic lore: ${state}`,
    metadata: { marinaraDynamicLoreContext: true },
  },
];

function runtimeMessage(variant: RuntimeVariant, state: string): ChatMessage {
  return {
    role: "system",
    content: variant.content(state),
    contextKind: "injection",
    providerMetadata: { ...variant.metadata, marinaraRuntimeContext: true },
  };
}

function layoutFor(variant: RuntimeVariant, state: string, leading: boolean): ChatMessage[] {
  const messages = [
    { ...stableLore },
    { ...staticGm },
    ...(leading
      ? [runtimeMessage(variant, state), { ...oldHistory }]
      : [{ ...oldHistory }, runtimeMessage(variant, state)]),
    { ...currentUser },
    { ...prefill, content: "Prefill" },
  ];
  const normalized = normalizePromptCacheLayout(messages);
  const appended = appendNonLeadingSystemMessagesToLastUser(normalized);
  return mergeAdjacentMessages(squashLeadingSystemMessages(appended));
}

for (const { variant, leading } of variants.flatMap((variant) => [
  { variant, leading: true },
  { variant, leading: false },
])) {
  const first = layoutFor(variant, "state A", leading);
  const second = layoutFor(variant, "state B", leading);

  assert.equal(first[0]?.content, stableLore.content, `${variant.name}: stable lore must remain first`);
  assert.equal(second[0]?.content, stableLore.content, `${variant.name}: stable lore must remain first after change`);
  assert.equal(first[1]?.content, staticGm.content, `${variant.name}: static GM content changed`);
  assert.equal(second[1]?.content, staticGm.content, `${variant.name}: static GM content changed after state change`);
  assert.equal(first[2]?.content, oldHistory.content, `${variant.name}: old history moved or changed`);
  assert.equal(
    second[2]?.content,
    oldHistory.content,
    `${variant.name}: old history moved or changed after state change`,
  );
  assert.match(first.map((message) => message.content).join("\n"), /state A/u);
  assert.match(second.map((message) => message.content).join("\n"), /state B/u);
  assert.equal(first.at(-1)?.content, "Prefill", `${variant.name}: prefill lost its tail position`);
  assert.equal(second.at(-1)?.content, "Prefill", `${variant.name}: prefill moved after state change`);

  const runtimeIndex = second.findIndex((message) => message.content.includes("state B"));
  const currentIndex = second.findIndex((message) => message.content === currentUser.content);
  assert.ok(
    runtimeIndex >= 0 && runtimeIndex <= currentIndex,
    `${variant.name}: runtime value was not kept near current turn`,
  );
  assert.equal(second[runtimeIndex]?.providerMetadata?.marinaraRuntimeContext, true);
}

// Runtime markers survive the actual route-style marking transform and later
// merge/squash passes; the transform must not reclassify existing messages.
const marked = markNewRuntimeContextMessages([{ ...staticGm }], (messages) => [
  ...messages,
  { role: "system", content: "Scene state", contextKind: "injection" },
]);
const markedOutput = mergeAdjacentMessages(squashLeadingSystemMessages(marked));
assert.equal(markedOutput.at(-1)?.providerMetadata?.marinaraRuntimeContext, true);
assert.equal(markedOutput[0]?.providerMetadata, undefined);

// User-authored, unmarked prompt injections are deliberately not relocated by
// cache normalization. Their placement is preserved for the route to handle.
const userAuthored: ChatMessage = {
  role: "system",
  content: "User-authored placement",
  contextKind: "injection",
  providerMetadata: { source: "user" },
};
const preserved = normalizePromptCacheLayout([{ ...stableLore }, userAuthored, { ...oldHistory }, { ...currentUser }]);
assert.deepEqual(
  preserved.map((message) => message.content),
  [stableLore.content, userAuthored.content, oldHistory.content, currentUser.content],
);
assert.deepEqual(preserved[1]?.providerMetadata, userAuthored.providerMetadata);

// Context fitting may remove expendable history, but it must retain protected
// full lore byte-for-byte and must not mutate the input message object.
const protectedLore: ChatMessage = {
  ...stableLore,
  content: "Protected canon. ".repeat(180),
};
const fitted = fitMessagesToContext(
  [protectedLore, { ...oldHistory, content: "Old history. ".repeat(900) }, { ...currentUser }],
  { maxContext: 4096, maxTokens: 256 },
);
assert.equal(fitted.messages[0]?.content, protectedLore.content);
assert.equal(protectedLore.content, "Protected canon. ".repeat(180));
assert.ok(fitted.trimmed, "oversized history should be trimmed while protected lore remains");

process.stdout.write("Cache feature matrix regression passed.\n");
