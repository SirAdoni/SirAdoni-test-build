import assert from "node:assert/strict";

// Settings > Features "Cache-friendly prompt layout" (cacheFriendlyPromptLayout) plus the chat opt-in
// `gameCacheStableFinalChecks`. Anything after the last completed exchange is written to the prompt cache again on
// the next turn, because the new exchange lands in front of it. The Game player-canon and prose checks never change
// within a chat, so an opted-in chat keeps their full text in the cached prefix (just before the history) and leaves
// a short pointer at the final boundary. This replays a fixture sequence of Game turns with realistic block sizes,
// measures the characters each turn rewrites (length minus the prefix it shares with the previous turn's prompt),
// and checks that turns without the check, chats that did not opt in, and the switch turned off are unchanged.
const { resetFeatureSettingsForTests } =
  await import("../../packages/server/src/services/features/feature-settings.js");
const { normalizePromptCacheLayout } =
  await import("../../packages/server/src/services/generation/prompt-cache-layout.js");
const { buildGameRecencySeal, buildGameRecencySealPointer } =
  await import("../../packages/server/src/services/game/gm-prompts.js");
const { selectHistoryBreakpointIndex } =
  await import("../../packages/server/src/services/llm/providers/claude-subscription/jsonl-entries.js");
type Message = import("../../packages/server/src/services/generation/prompt-cache-layout.js").PromptCacheLayoutMessage;
type ChatMessage = import("../../packages/server/src/services/llm/base-provider.js").ChatMessage;

const filler = (label: string, size: number): string => {
  const words = ["amber", "lantern", "ferry", "reed", "marsh", "tollgate", "ledger", "quiet", "harbour", "cinder"];
  let text = `${label}:`;
  for (let index = 0; text.length < size; index += 1) text += ` ${words[(index * 7 + label.length) % words.length]}`;
  return text.slice(0, size);
};

const seal = buildGameRecencySeal("Tamsin");
const pointer = buildGameRecencySealPointer();
const checks = [{ content: seal, pointer }];

// Exchange sizes and tail block sizes follow a saved subscription Game request (lore 60k, rules 34k characters).
const exchanges = [
  [47, 5653],
  [126, 4458],
  [161, 8959],
  [153, 6870],
  [1062, 9644],
  [507, 5526],
  [199, 13825],
  [254, 7200],
  [310, 6100],
  [88, 9900],
  [420, 5200],
  [140, 7700],
] as const;
// Which tail block content changes on each turn: weather every turn, the map now and then, memory rarely.
const mapVersion = [0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 3];
const memoryVersion = [0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 2];

function gameTurn(turn: number, options: { tail: boolean; seal: boolean }): Message[] {
  const history: Message[] = [];
  for (let index = 0; index < turn; index += 1) {
    history.push({ role: "user", content: filler(`player ${index}`, exchanges[index]![0]), contextKind: "history" });
    history.push({
      role: "assistant",
      content: filler(`narrator ${index}`, exchanges[index]![1]),
      contextKind: "history",
    });
  }
  const runtime = (content: string, role: Message["role"] = "system"): Message => ({
    role,
    content,
    contextKind: "injection",
    providerMetadata: { marinaraRuntimeContext: true },
  });
  const messages: Message[] = [
    {
      role: "system",
      content: filler("lore", 60_000),
      contextKind: "prompt",
      providerMetadata: { marinaraFullLoreContext: true },
    },
    {
      role: "system",
      content: filler("gm rules", 34_000),
      contextKind: "prompt",
      providerMetadata: { marinaraGmStable: true },
    },
  ];
  if (options.tail) {
    messages.push(
      runtime(`<weather_update>turn ${turn}: rain, ${10 + turn} C</weather_update>\n${filler("arc plans", 4_400)}`),
    );
    messages.push(runtime(`<spatial_context>map ${mapVersion[turn]}\n${filler(`places ${mapVersion[turn]}`, 9_500)}`));
  }
  messages.push(...history);
  messages.push({ role: "user", content: filler(`player ${turn}`, exchanges[turn]![0]), contextKind: "history" });
  if (options.tail) {
    messages.push(runtime(`<campaign_memory>${filler(`records ${memoryVersion[turn]}`, 940)}`));
    messages.push(
      runtime(`<gm_only_runtime_state>turn ${turn}</gm_only_runtime_state>\n${filler("format", 15_300)}`, "user"),
    );
  }
  if (options.seal) messages.push({ role: "system", content: seal, contextKind: "injection" });
  return messages;
}

/** What postProcessMessages does before the provider: later system blocks become user messages in place. */
function toWire(messages: readonly Message[]): ChatMessage[] {
  let leading = true;
  return messages.map((message) => {
    if (message.role !== "system") leading = false;
    return { ...message, role: !leading && message.role === "system" ? "user" : message.role } as ChatMessage;
  });
}
const serialize = (messages: readonly Message[]) =>
  messages.map((message) => `${message.role}\n${message.content}`).join("\u0000");
const sharedPrefix = (a: string, b: string) => {
  let index = 0;
  while (index < a.length && index < b.length && a.charCodeAt(index) === b.charCodeAt(index)) index += 1;
  return index;
};

function replay(layout: (messages: Message[]) => Message[], options: { tail: boolean; seal: boolean }) {
  const perTurn: number[] = [];
  const shared: number[] = [];
  let previous: string | null = null;
  for (let turn = 0; turn < exchanges.length; turn += 1) {
    const wire = toWire(layout(gameTurn(turn, options)));
    const text = serialize(wire);
    if (turn > 0)
      assert.notEqual(selectHistoryBreakpointIndex(wire), null, `turn ${turn}: the history cache marker is kept`);
    if (previous !== null) {
      const common = sharedPrefix(previous, text);
      shared.push(common);
      perTurn.push(text.length - common);
    }
    previous = text;
  }
  return { perTurn, shared, total: perTurn.reduce((sum, value) => sum + value, 0) };
}

try {
  resetFeatureSettingsForTests();
  const plain = (messages: Message[]) => normalizePromptCacheLayout(messages);
  const opted = (messages: Message[]) => normalizePromptCacheLayout(messages, { stableFinalChecks: checks });

  // Layout of one opted-in turn: the full check sits just before the history, the pointer stays last.
  const sample = opted(gameTurn(3, { tail: true, seal: true }));
  const firstHistory = sample.findIndex((message) => message.contextKind === "history");
  assert.equal(sample[firstHistory - 1]?.content, seal, "the full check moves just before the history");
  assert.equal(sample.at(-1)?.content, pointer, "the pointer takes the check's place at the final boundary");
  assert.equal(sample.filter((message) => message.content === seal).length, 1, "the check is sent once");
  assert.ok(pointer.length < 400 && seal.length > 4_000, "the pointer is a small fraction of the check");

  // Fixture sequence with tail blocks on every turn (the costly turns).
  const before = replay(plain, { tail: true, seal: true });
  const after = replay(opted, { tail: true, seal: true });
  for (let index = 0; index < before.perTurn.length; index += 1) {
    assert.ok(after.shared[index]! >= before.shared[index]!, `turn ${index + 1}: the shared prefix never shrinks`);
    assert.equal(
      before.perTurn[index]! - after.perTurn[index]!,
      seal.length - pointer.length,
      `turn ${index + 1}: each turn rewrites the check's size minus the pointer less`,
    );
  }
  const saved = before.total - after.total;
  console.log(
    `stable-final-checks: rewritten chars per turn before=${Math.round(before.total / before.perTurn.length)} after=${Math.round(
      after.total / after.perTurn.length,
    )} saved=${Math.round(saved / after.perTurn.length)} (${((saved / before.total) * 100).toFixed(1)}%)`,
  );

  // Turns that carry none of these blocks (no tail, no check) are byte-identical with or without the opt-in.
  for (let turn = 0; turn < exchanges.length; turn += 1) {
    const bare = gameTurn(turn, { tail: false, seal: false });
    assert.equal(serialize(opted(bare)), serialize(plain(bare)), `turn ${turn}: a turn without the check is unchanged`);
  }
  assert.deepEqual(replay(opted, { tail: false, seal: false }), replay(plain, { tail: false, seal: false }));

  // A chat that did not opt in (no checks passed) gets exactly today's layout.
  const today = gameTurn(5, { tail: true, seal: true });
  assert.equal(serialize(normalizePromptCacheLayout(today, {})), serialize(plain(today)));

  // A first turn with no earlier history still keeps the check ahead of the player's message.
  const first = opted(gameTurn(0, { tail: true, seal: true }));
  assert.equal(first[2]?.content, seal, "first turn: the check follows the rules, ahead of the moved runtime blocks");

  // Switch off: upstream order, byte-identical to the assembled prompt, with or without the opt-in.
  resetFeatureSettingsForTests({ cacheFriendlyPromptLayout: false });
  assert.equal(serialize(opted(today)), serialize(today), "OFF: nothing moves");
} finally {
  resetFeatureSettingsForTests();
}

console.log("stable-final-checks-cache regression passed");
