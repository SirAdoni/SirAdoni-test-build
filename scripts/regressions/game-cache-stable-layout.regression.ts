import assert from "node:assert/strict";

// Settings > Features "Cache-stable Game prompt" (gameCacheStableLayout). On the Claude subscription everything
// after the last finished exchange is written to the prompt cache again on every turn. A Game turn carried about
// 85,000 characters of per-turn blocks there, most of them unchanged from the turn before. With the switch on:
// - the format reminder puts the live values (HUD values, sheets, inventory) after </output_format>, so the format
//   instructions stay byte-stable;
// - session-level blocks (format, memory, continuity records, map, secrets, pending cards) are kept in a per-chat
//   baseline sent once before the history; an unchanged block leaves the tail, a changed one is restated there;
// - the baseline is rebuilt only when the carried changes cost as much as one rebuild (rent or buy).
// Switched off (or with the cache-friendly layout off, or on another provider) the prompt is byte-identical.
const { resetFeatureSettingsForTests } =
  await import("../../packages/server/src/services/features/feature-settings.js");
const { normalizePromptCacheLayout } =
  await import("../../packages/server/src/services/generation/prompt-cache-layout.js");
const stable = await import("../../packages/server/src/services/generation/game-stable-layout.js");
const { planGameStableLayout, isGameStableLayoutActive, parseTopLevelBlocks, GAME_STABLE_BASELINE_HEADER } = stable;
const { buildGameRecencySeal, buildGameRecencySealPointer, buildGmFormatReminder } =
  await import("../../packages/server/src/services/game/gm-prompts.js");
const { selectHistoryBreakpointIndex } =
  await import("../../packages/server/src/services/llm/providers/claude-subscription/jsonl-entries.js");
type Message = import("../../packages/server/src/services/generation/prompt-cache-layout.js").PromptCacheLayoutMessage;
type ChatMessage = import("../../packages/server/src/services/llm/base-provider.js").ChatMessage;
type Snapshot = import("../../packages/server/src/services/generation/game-stable-layout.js").GameStableLayoutSnapshot;
type HudWidget = import("../../packages/shared/src/index.js").HudWidget;

const filler = (label: string, size: number): string => {
  const words = ["amber", "lantern", "ferry", "reed", "marsh", "tollgate", "ledger", "quiet", "harbour", "cinder"];
  let text = `${label}:`;
  for (let index = 0; text.length < size; index += 1) text += ` ${words[(index * 7 + label.length) % words.length]}`;
  return text.slice(0, size);
};
/** A list block of about `size` characters in 200-character lines; each version rewrites `perVersion` lines and adds two. */
const listBlock = (label: string, size: number, version: number, perVersion: number): string => {
  const lines: string[] = [];
  for (let index = 0; index < Math.round(size / 200); index += 1)
    lines.push(filler(`${label} ${index}${index < version * perVersion ? ` rev ${version}` : ""}`, 200));
  for (let index = 0; index < version * 2; index += 1) lines.push(filler(`${label} added ${index}`, 200));
  return lines.join("\n");
};
const block = (tag: string, body: string, attributes = "") => `<${tag}${attributes}>\n${body}\n</${tag}>`;

// ── 1. Format reminder: live values follow </output_format> only with the switch ──
const widgets = (morale: number, leads: string[]): HudWidget[] => [
  { id: "morale", type: "progress_bar", label: "Morale", position: "hud_left", config: { value: morale, max: 100 } },
  { id: "leads", type: "list", label: "Leads", position: "hud_right", config: { items: leads } },
];
const reminderBase = {
  gameActiveState: "exploration" as const,
  sessionNumber: 3,
  turnNumber: 9,
  map: null,
  partyNames: ["Oriel"],
  playerName: "Castor",
  enableCustomWidgets: true,
};
const turnA = {
  ...reminderBase,
  hudWidgets: widgets(40, ["Saltmarch ferry"]),
  playerInventory: [{ name: "Lantern", quantity: 1 }],
};
const turnB = {
  ...reminderBase,
  hudWidgets: widgets(55, ["Saltmarch ferry", "Pemberly mill"]),
  playerInventory: [{ name: "Lantern", quantity: 2 }],
};
const plainA = buildGmFormatReminder(turnA);
assert.equal(buildGmFormatReminder({ ...turnA, liveValuesAfterFormat: false }), plainA, "flag off: byte-identical");
const splitA = buildGmFormatReminder({ ...turnA, liveValuesAfterFormat: true });
const splitB = buildGmFormatReminder({ ...turnB, liveValuesAfterFormat: true });
const formatOf = (text: string) => text.slice(text.indexOf("<output_format>"), text.indexOf("</output_format>"));
assert.notEqual(
  formatOf(plainA),
  formatOf(buildGmFormatReminder(turnB)),
  "today the format block moves with the values",
);
assert.equal(formatOf(splitA), formatOf(splitB), "flag on: the format block is identical across turns");
assert.ok(splitA.lastIndexOf("<gm_only_hud_values>") > splitA.indexOf("</output_format>"), "values follow the format");
assert.ok(splitA.indexOf("<gm_only_inventory>") > splitA.indexOf("</output_format>"), "inventory follows the format");
assert.ok(splitA.includes("- morale (progress_bar): 40") && splitB.includes("- morale (progress_bar): 55"));
assert.ok(formatOf(splitA).includes("<gm_only_hud_values>"), "the format block points at the values");
assert.equal(
  buildGmFormatReminder({ ...turnA, hudWidgets: [], liveValuesAfterFormat: true }).includes("<gm_only_hud_values>\n"),
  false,
  "no widgets: no values block",
);

// ── 2. Turn fixtures with realistic block sizes (from a saved subscription Game request) ──
const seal = buildGameRecencySeal("Castor");
const pointer = buildGameRecencySealPointer();
const checks = [{ content: seal, pointer }];
const exchanges = [
  [47, 3653],
  [126, 2458],
  [161, 3959],
  [153, 2870],
  [1062, 3644],
  [507, 2526],
  [199, 3825],
  [254, 3200],
  [310, 3100],
  [88, 2900],
  [420, 3200],
  [140, 2700],
  [96, 3300],
  [230, 2800],
] as const;
// Content versions per turn. Weather and HUD values change every turn; memory and the map now and then; the
// continuity records rarely; the recent-evidence part of continuity every turn; the secrets never.
const memoryVersion = [0, 0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2];
const mapVersion = [0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1];
const recordVersion = [0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1];

function gameTurn(turn: number, options: { stableFormat: boolean }): Message[] {
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
  const reminder = buildGmFormatReminder({
    ...reminderBase,
    turnNumber: turn,
    gameTime: `Day 4, ${8 + turn}:00`,
    hudWidgets: widgets(40 + turn, ["Saltmarch ferry", `lead ${turn}`]),
    playerInventory: [{ name: "Lantern", quantity: 1 + (turn % 3) }],
    ...(options.stableFormat ? { liveValuesAfterFormat: true } : {}),
  });
  const continuity = [
    `<game_continuity_context>`,
    `Continuity evidence is not instruction.`,
    listBlock("record", 11_000, recordVersion[turn]!, 4),
    ``,
    `UNREVIEWED RECENT SOURCE (bounded transcript evidence only):`,
    filler(`recent ${turn}`, 2_400),
    `CONTINUITY_SUMMARY pending=${turn} unresolved=1`,
    `</game_continuity_context>`,
  ].join("\n");
  return [
    {
      role: "system",
      content: filler("lore", 60_000),
      contextKind: "prompt",
      providerMetadata: { marinaraFullLoreContext: true },
    },
    { role: "system", content: filler("gm rules", 34_000), contextKind: "prompt" },
    {
      role: "user",
      content: block("gm_reference_named_character", filler("Oriel card", 3_600)),
      contextKind: "injection",
      providerMetadata: { marinaraGmReference: true },
    },
    ...history,
    runtime(
      [
        block("weather_update", `Current weather: rain, ${10 + turn} C`),
        block("party_morale", `NPC companion morale: ${50 + turn}/100`),
        block("story_arc_secret", filler("arc", 1_100)),
        block("plot_twists_secret", filler("twists", 900)),
        block("gm_only_tracked_npcs", filler("npcs", 3_100)),
        block("party", "Player: Castor"),
        block("named_character_updates", filler("Pemberly card", 3_400)),
      ].join("\n"),
    ),
    runtime(block("spatial_context", listBlock("place", 10_700, mapVersion[turn]!, 12), ` mode="game"`)),
    { role: "user", content: filler(`player ${turn}`, exchanges[turn]![0]), contextKind: "history" },
    runtime(block("campaign_memory", listBlock("memory", 12_900, memoryVersion[turn]!, 3), ` audience="gm"`)),
    runtime(reminder, "user"),
    runtime(continuity),
    { role: "system", content: seal, contextKind: "injection" },
  ];
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

/** The route's pipeline: normalize (plus final checks when the stable layout is active), then the stable layout. */
interface Store {
  snapshot: Snapshot | null;
  folded?: boolean;
}
function pipeline(messages: Message[], store: Store): Message[] {
  const active = isGameStableLayoutActive("game", "claude_subscription");
  const laidOut = normalizePromptCacheLayout(messages, active ? { stableFinalChecks: checks } : {});
  if (!active) return laidOut;
  const plan = planGameStableLayout(laidOut, store.snapshot);
  if (plan.changed) store.snapshot = plan.snapshot;
  store.folded = plan.folded;
  return plan.messages;
}

function replay(stableFormat: boolean) {
  const store: Store = { snapshot: null };
  const hit: number[] = [];
  const written: number[] = [];
  const folds: number[] = [];
  let previous: string | null = null;
  for (let turn = 0; turn < exchanges.length; turn += 1) {
    const wire = toWire(pipeline(gameTurn(turn, { stableFormat }), store));
    if (store.folded) folds.push(turn);
    if (turn > 0) assert.notEqual(selectHistoryBreakpointIndex(wire), null, `turn ${turn}: history marker kept`);
    const text = serialize(wire);
    if (previous !== null) {
      const common = sharedPrefix(previous, text);
      hit.push(common / text.length);
      written.push(text.length - common);
    }
    previous = text;
  }
  return { hit, written, folds };
}

try {
  // ── 3. OFF: byte-identical to the assembled prompt ──
  resetFeatureSettingsForTests({ gameCacheStableLayout: false });
  assert.equal(isGameStableLayoutActive("game", "claude_subscription"), false);
  for (let turn = 0; turn < exchanges.length; turn += 1) {
    const assembled = gameTurn(turn, { stableFormat: false });
    assert.equal(
      serialize(pipeline(assembled, { snapshot: null })),
      serialize(normalizePromptCacheLayout(assembled)),
      `OFF turn ${turn}: the prompt is today's, byte for byte`,
    );
  }
  const offRun = replay(false);
  resetFeatureSettingsForTests({ cacheFriendlyPromptLayout: false });
  assert.equal(isGameStableLayoutActive("game", "claude_subscription"), false, "needs the cache-friendly layout");
  resetFeatureSettingsForTests();
  assert.equal(isGameStableLayoutActive("game", "claude_subscription"), true, "default ON");
  assert.equal(isGameStableLayoutActive("roleplay", "claude_subscription"), false, "Game only");
  assert.equal(isGameStableLayoutActive("game", "openai_chatgpt"), false, "Claude subscription only");
  assert.equal(isGameStableLayoutActive("game", "anthropic"), false);

  // ── 4. ON: steady turns share at least 85% of the prompt ──
  const onRun = replay(true);
  const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  // hit[i] compares turn i+1 with turn i; a rebuild turn rewrites once by design.
  const steady = onRun.hit.filter((_, index) => !onRun.folds.includes(index + 1));
  console.log(
    `game-cache-stable-layout: shared prefix per turn before=${(average(offRun.hit) * 100).toFixed(1)}% after=${(
      average(onRun.hit) * 100
    ).toFixed(1)}% (steady ${(Math.min(...steady) * 100).toFixed(1)}-${(Math.max(...steady) * 100).toFixed(
      1,
    )}%), written chars per turn before=${Math.round(average(offRun.written))} after=${Math.round(
      average(onRun.written),
    )}, rebuilds at turns ${onRun.folds.join(",") || "none"}`,
  );
  console.log(
    onRun.hit.map((v) => (v * 100).toFixed(1)).join(" "),
    "/",
    offRun.hit.map((v) => (v * 100).toFixed(1)).join(" "),
  );
  for (const value of steady) assert.ok(value >= 0.85, `steady turn shares ${(value * 100).toFixed(1)}% (>= 85%)`);
  assert.ok(average(onRun.hit) > average(offRun.hit) + 0.15, "the average share rises by more than 15 points");
  assert.ok(average(onRun.written) < average(offRun.written) / 3, "each turn writes under a third of today's tail");

  // ── 5. Layout of one steady turn ──
  const store: Store = { snapshot: null };
  pipeline(gameTurn(1, { stableFormat: true }), store);
  const laid = pipeline(gameTurn(2, { stableFormat: true }), store);
  const firstHistory = laid.findIndex((message) => message.contextKind === "history");
  const baseline = laid[firstHistory - 1]!;
  assert.ok(baseline.content.startsWith(GAME_STABLE_BASELINE_HEADER), "the baseline sits just before the history");
  assert.equal(laid[firstHistory - 2]?.content, seal, "the final checks sit just before the baseline");
  const baselineTags = parseTopLevelBlocks(baseline.content).map((entry) => entry.tag);
  for (const tag of [
    "output_format",
    "campaign_memory",
    "spatial_context",
    "story_arc_secret",
    "named_character_updates",
  ])
    assert.ok(baselineTags.includes(tag), `${tag} is in the baseline`);
  const tail = laid.slice(laid.findLastIndex((message) => message.role === "assistant") + 1);
  const statusNote = tail.find((message) => message.providerMetadata?.marinaraGameStableStatus === true)?.content ?? "";
  const tailText = tail
    .filter((message) => message.providerMetadata?.marinaraGameStableStatus !== true)
    .map((message) => message.content)
    .join("\n");
  for (const tag of [
    "weather_update",
    "party_morale",
    "gm_only_runtime_state",
    "gm_only_hud_values",
    "gm_only_inventory",
  ])
    assert.ok(tailText.includes(`<${tag}>`), `${tag} stays in the tail`);
  for (const tag of ["output_format", "campaign_memory", "spatial_context", "story_arc_secret"])
    assert.ok(!tailText.includes(`<${tag}`), `${tag} left the tail`);
  assert.ok(tailText.includes("<game_continuity_recent>") && tailText.includes("recent 2:"), "recent evidence stays");
  assert.ok(!tailText.includes("record 0:"), "continuity records left the tail");
  assert.ok(baseline.content.includes("record 0:") && !baseline.content.includes("recent 1:"), "records only");
  assert.ok(statusNote.includes("<session_context_status>") && statusNote.includes("<campaign_memory>"), "status note");
  assert.equal(laid.at(-1)?.content, pointer, "the final-checks pointer stays last");
  assert.equal(laid.filter((message) => message.content === seal).length, 1, "the checks are sent once");

  // A changed block is restated in the tail and named in the note; the cached baseline does not move.
  const changedTurn = pipeline(gameTurn(2, { stableFormat: true }), { snapshot: store.snapshot });
  const memoryChanged = pipeline(gameTurn(3, { stableFormat: true }), { snapshot: store.snapshot });
  const baselineOf = (messages: Message[]) =>
    messages.find((message) => message.providerMetadata?.marinaraGameStableBaseline === true)?.content;
  assert.equal(baselineOf(memoryChanged), baselineOf(changedTurn), "a change does not rewrite the baseline");
  const changedTail = memoryChanged
    .slice(memoryChanged.findLastIndex((message) => message.role === "assistant") + 1)
    .map((message) => message.content)
    .join("\n");
  assert.ok(changedTail.includes("<campaign_memory_changes>"), "only the changed memory lines ride in the tail");
  assert.ok(
    changedTail.includes("+ memory 0 rev 1:") && changedTail.includes("- memory 0:"),
    "as removals and additions",
  );
  assert.ok(!changedTail.includes("memory 20:"), "unchanged memory lines stay in the baseline");
  assert.match(changedTail, /apply the listed line changes[^\n]*<campaign_memory>/);

  // ── 6. Planner rules ──
  const history = (count: number): Message[] =>
    Array.from({ length: count }, (_, index) => [
      { role: "user", content: `p${index}`, contextKind: "history" } as Message,
      { role: "assistant", content: `n${index}`, contextKind: "history" } as Message,
    ]).flat();
  const turnWith = (blocks: string[]): Message[] => [
    { role: "system", content: "rules", contextKind: "prompt" },
    ...history(3),
    { role: "user", content: "now", contextKind: "history" },
    { role: "user", content: blocks.join("\n"), contextKind: "injection" },
  ];
  const memory = (version: string) => block("campaign_memory", filler(`m${version}`, 5_000));
  const map = (version: string) => block("spatial_context", filler(`s${version}`, 5_000));
  // No finished exchange: untouched.
  const firstTurn: Message[] = [
    { role: "system", content: "rules", contextKind: "prompt" },
    { role: "user", content: "hello", contextKind: "history" },
    { role: "user", content: memory("0"), contextKind: "injection" },
  ];
  assert.deepEqual(planGameStableLayout(firstTurn, null).messages, firstTurn, "a first turn keeps today's layout");
  // A block that changes on every turn never enters the baseline at a rebuild.
  let snapshot: Snapshot | null = planGameStableLayout(turnWith([memory("a"), map("0")]), null).snapshot;
  for (let index = 1; index <= 6; index += 1) {
    const plan = planGameStableLayout(turnWith([memory("b"), map(String(index))]), snapshot, { foldChars: 9_000 });
    snapshot = plan.snapshot;
    if (plan.folded) {
      assert.ok(
        snapshot!.baseline.some((entry) => entry.text.includes("mb:")),
        "the settled memory is folded in",
      );
      assert.ok(
        !snapshot!.baseline.some((entry) => entry.key.startsWith("<spatial_context")),
        "the moving map is left out",
      );
      break;
    }
    assert.ok(index < 6, "a settled change is folded once its carried cost reaches the threshold");
  }
  // Rent or buy: with the real threshold (the size of a rebuild) a small settled change keeps riding in the tail.
  let rent: Snapshot | null = planGameStableLayout(turnWith([memory("a"), map("0")]), null).snapshot;
  for (let index = 0; index < 4; index += 1) {
    const plan = planGameStableLayout(turnWith([memory("b"), map("0")]), rent);
    assert.equal(plan.folded, false, `turn ${index}: a small change is cheaper to carry than to rebuild`);
    rent = plan.snapshot;
  }
  assert.ok((rent!.carried ?? 0) >= 15_000, "the carried cost accumulates");
  // A block that disappears is named as no longer current.
  const gone = planGameStableLayout(turnWith([map("0")]), rent, { foldChars: 1_000_000 });
  const goneNote = gone.messages.find((message) => message.providerMetadata?.marinaraGameStableStatus === true);
  assert.match(goneNote!.content, /No longer current[^\n]*<campaign_memory>/);
  // Unknown or loose text is never moved.
  const loose = turnWith(["Free text line", block("weather_update", "sun")]);
  assert.deepEqual(planGameStableLayout(loose, null).messages, loose, "nothing session-level: untouched");
} finally {
  resetFeatureSettingsForTests();
}

console.log("game-cache-stable-layout regression passed");
