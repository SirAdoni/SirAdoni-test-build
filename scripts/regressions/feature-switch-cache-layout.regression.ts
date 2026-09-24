import assert from "node:assert/strict";

// Settings > Features "Cache-friendly prompt layout" (cacheFriendlyPromptLayout). ON (default) is
// today's layout: runtime blocks such as World Maps move next to the current turn, the full-lore
// prefix leads, and subscription providers default to full lore. OFF is upstream: the assembled
// order is sent unchanged (byte-identical) and chats use the keyword lore scan unless they opted in.
const { resetFeatureSettingsForTests } =
  await import("../../packages/server/src/services/features/feature-settings.js");
const layout = await import("../../packages/server/src/services/generation/prompt-cache-layout.js");
const { keepGameDialogueAdjacent, normalizePromptCacheLayout, layoutAsNextTurn, shouldUseFullLorebookContext } = layout;
type Message = import("../../packages/server/src/services/generation/prompt-cache-layout.js").PromptCacheLayoutMessage;

const runtime = (content: string): Message => ({
  role: "system",
  content,
  contextKind: "injection",
  providerMetadata: { marinaraRuntimeContext: true },
});
const game: Message[] = [
  { role: "system", content: "GM rules", contextKind: "prompt" },
  runtime("World Maps: Tamsin stands at the east gate."),
  { role: "user", content: "Look around.", contextKind: "history" },
  { role: "assistant", content: "The gate is shut.", contextKind: "history" },
  runtime("Scene: dusk."),
  { role: "user", content: "Knock.", contextKind: "history" },
];
const subscription: Message[] = [
  { role: "system", content: "GM rules", contextKind: "prompt" },
  runtime("World Maps: Ysolde is in the hall."),
  { role: "system", content: "Full lore", providerMetadata: { marinaraFullLoreContext: true } },
  { role: "user", content: "Hello.", contextKind: "history" },
];
const order = (messages: readonly Message[]) => messages.map((message) => message.content);
const bytes = (messages: readonly Message[]) => JSON.stringify(messages);

try {
  // ON = today
  resetFeatureSettingsForTests();
  assert.deepEqual(order(keepGameDialogueAdjacent(game)), [
    "GM rules",
    "Look around.",
    "Scene: dusk.",
    "World Maps: Tamsin stands at the east gate.",
    "The gate is shut.",
    "Knock.",
  ]);
  assert.deepEqual(order(normalizePromptCacheLayout(subscription)), [
    "Full lore",
    "GM rules",
    "World Maps: Ysolde is in the hall.",
    "Hello.",
  ]);
  assert.deepEqual(order(layoutAsNextTurn(game.slice(0, 5), { chatMode: "game", provider: "openai" })), [
    "GM rules",
    "Look around.",
    "Scene: dusk.",
    "World Maps: Tamsin stands at the east gate.",
    "The gate is shut.",
  ]);
  assert.equal(shouldUseFullLorebookContext("claude_subscription", false), true, "ON: full lore is the default");
  assert.equal(shouldUseFullLorebookContext("claude_subscription", true), false, "a chat can still opt out");
  assert.equal(shouldUseFullLorebookContext("openai", false, true), false, "other providers never use it");
  const onGame = bytes(keepGameDialogueAdjacent(game));
  const onSubscription = bytes(normalizePromptCacheLayout(subscription));

  // OFF = upstream: nothing moves
  resetFeatureSettingsForTests({ cacheFriendlyPromptLayout: false });
  assert.equal(bytes(keepGameDialogueAdjacent(game)), bytes(game), "OFF: game order byte-identical to assembly");
  assert.equal(bytes(normalizePromptCacheLayout(subscription)), bytes(subscription), "OFF: subscription order kept");
  assert.equal(
    bytes(layoutAsNextTurn(game.slice(0, 5), { chatMode: "game", provider: "openai" })),
    bytes(game.slice(0, 5)),
    "OFF: the prompt preview matches",
  );
  assert.equal(shouldUseFullLorebookContext("openai_chatgpt", false), false, "OFF: keyword lore scan by default");
  assert.equal(shouldUseFullLorebookContext("openai_chatgpt", false, true), true, "OFF: an explicit chat opt-in stays");
  const copy = normalizePromptCacheLayout(subscription);
  assert.notEqual(copy[0], subscription[0], "OFF still returns fresh copies, never the caller's objects");

  // Back ON: byte-identical to the first ON run
  resetFeatureSettingsForTests({ cacheFriendlyPromptLayout: true });
  assert.equal(bytes(keepGameDialogueAdjacent(game)), onGame);
  assert.equal(bytes(normalizePromptCacheLayout(subscription)), onSubscription);
} finally {
  resetFeatureSettingsForTests();
}

console.log("feature-switch-cache-layout regression passed");
