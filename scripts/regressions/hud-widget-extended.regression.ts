import assert from "node:assert/strict";
import {
  EXTENDED_HUD_WIDGET_TYPES,
  applyExtendedWidgetUpdate,
  applyHudWidgetLifecycle,
  calendarUpcoming,
  coerceWidgetValue,
  describeExtendedWidgetForPrompt,
  extendedWidgetConfigFromText,
  extendedWidgetConfigToText,
  normalizeExtendedWidgetConfig,
  type HudWidget,
  type WidgetUpdate,
} from "../../packages/shared/src/index.js";
import { restoreBranchHudLists } from "../../packages/server/src/services/game/branch-state.js";

const base = (type: HudWidget["type"], id = "w", config: HudWidget["config"] = {}): HudWidget => ({
  id,
  type,
  label: id,
  position: "hud_left",
  config,
});
const run = (widget: HudWidget, ...updates: Array<WidgetUpdate["changes"]>) =>
  updates.reduce((current, changes) => applyExtendedWidgetUpdate(current, changes), widget);
const say = (widget: HudWidget) => describeExtendedWidgetForPrompt(widget);

// Checklist: add, fuzzy check, auto-add on check, uncheck, done tasks evicted first over the cap.
let checklist = run(
  base("checklist"),
  { add: "Scout the gate" },
  { add: "Bribe the clerk" },
  { check: "scout the gate." },
  { check: "Burn the ledger" },
  { uncheck: "Burn the ledger" },
);
assert.equal(say(checklist), "[x] Scout the gate; [ ] Bribe the clerk; [ ] Burn the ledger");
for (let i = 0; i < 12; i += 1) checklist = run(checklist, { add: `Task ${i}` });
assert.equal(checklist.config.tasks?.length, 12);
assert.ok(!checklist.config.tasks?.some((task) => task.text === "Scout the gate"), "done task leaves first");

// Schedule: day order, re-adding an event moves it, undated entries go last, remove by text.
let schedule = run(
  base("schedule"),
  { add: "Day 23 | Ball" },
  { add: "Soon | Letter" },
  { add: "Day 21, dusk | Oriel strike" },
  { add: "Day 24, dawn | Oriel strike" },
);
assert.equal(say(schedule), "Day 23 | Ball; Day 24, dawn | Oriel strike; Soon | Letter");
schedule = run(schedule, { remove: "ball" });
assert.equal(schedule.config.entries?.length, 2);

// Note: created by the lifecycle with an empty text, replaced by text commands.
let widgets = applyHudWidgetLifecycle([], {
  widgetId: "status",
  changes: { action: "create", type: "note", label: "Status", position: "hud_right" },
});
assert.deepEqual(widgets[0]?.config, { text: "" });
assert.equal(say(run(widgets[0]!, { text: "Gate watch doubled" })), '"Gate watch doubled"');

// Clock / pips: create-time max, clamped values.
widgets = applyHudWidgetLifecycle([], {
  widgetId: "doom",
  changes: { action: "create", type: "clock", label: "Doom", max: 8, value: 2 },
});
assert.deepEqual([widgets[0]!.config.value, widgets[0]!.config.max], [2, 8]);
assert.equal(run(widgets[0]!, { value: 99 }).config.value, 8);
assert.equal(say(run(base("pips"), { max: 3 }, { value: 2 })), "2/3");

// Countdown and tug of war.
assert.equal(say(run(base("countdown"), { value: 3, text: "days until the ball" })), "3 days until the ball remaining");
const tug = run(base("tug_of_war"), { max: 4, text: "Pursuers | Party" }, { value: -9 });
assert.equal(tug.config.value, -4);
assert.equal(say(tug), "-4 on -4..+4 (- Pursuers, + Party)");

// Tier track and stages: ordered levels, name/number/step moves, remove keeps the cursor on the same level.
let tier = run(base("tier_track"), { add: "Calm" }, { add: "Suspicious" }, { add: "Alert" }, { add: "Lockdown" });
tier = run(tier, { value: "suspicious" }, { value: "up" });
assert.equal(say(tier), "Calm; Suspicious; [Alert]; Lockdown");
tier = run(tier, { remove: "Calm" }, { value: "down" });
assert.equal(say(tier), "[Suspicious]; Alert; Lockdown");
assert.equal(
  say(run(base("stages"), { add: "Find the map" }, { add: "Cross the pass" }, { value: 2 })),
  "Find the map; [Cross the pass]",
);

// Tags keep a small unique set.
let tags = run(base("tags"), { add: "Poisoned" }, { add: "poisoned" }, { add: "Hidden" }, { remove: "POISONED" });
assert.equal(say(tags), "Hidden");
for (let i = 0; i < 15; i += 1) tags = run(tags, { add: `State ${i}` });
assert.equal(tags.config.tags?.length, 10);

// Ledger: balance follows transactions; removing one reverses it.
let ledger = run(base("ledger"), { text: "gold", value: 100 }, { add: "+50 | Sold the ring" }, { add: "-20 | Bribe" });
assert.equal(ledger.config.value, 130);
ledger = run(ledger, { remove: "bribe" });
assert.equal(ledger.config.value, 150);
assert.equal(say(ledger), "balance 150 gold; recent: +50 Sold the ring");

// Log: newest first, capped, re-adding moves to the top.
let log = base("log");
for (let i = 0; i < 8; i += 1) log = run(log, { add: `Event ${i}` });
log = run(log, { add: "Event 4" });
assert.deepEqual(log.config.items, ["Event 4", "Event 7", "Event 6", "Event 5", "Event 3", "Event 2"]);

// Rumor board: check confirms, uncheck proves false, add never overwrites a status.
const rumors = run(
  base("rumor_board"),
  { add: "The duke is ill" },
  { add: "Oriel sold the keys" },
  { check: "oriel sold" },
  { uncheck: "The duke is ill" },
  { add: "The duke is ill" },
);
assert.equal(say(rumors), "[false] The duke is ill; [confirmed] Oriel sold the keys");

// Obligations reuse the checklist rules.
assert.equal(
  say(run(base("obligations"), { add: "Party owes Oriel | 200 gold" }, { check: "party owes oriel" })),
  "[x] Party owes Oriel | 200 gold",
);

// Turn order: next wraps; removing an earlier name keeps the same person current.
let turns = run(
  base("turn_order"),
  { add: "Brannoc" },
  { add: "Oriel" },
  { add: "Tom" },
  { value: "Tom" },
  { value: "next" },
);
assert.equal(say(turns), "[Brannoc]; Oriel; Tom");
turns = run(turns, { value: "Tom" }, { remove: "Brannoc" });
assert.equal(say(turns), "Oriel; [Tom]");

// Scoreboard: stat/value rows, fuzzy names.
assert.equal(
  say(
    run(
      base("scoreboard"),
      { statName: "Crows", value: 3 },
      { statName: "Wolves", value: 5 },
      { statName: "crows", value: 6 },
    ),
  ),
  "Crows=6; Wolves=5",
);

// Bars / charges: add rows, set by stat, clamp to max.
const charges = run(
  base("charges"),
  { add: "Fireball | 3" },
  { add: "Shield | 1 / 2" },
  { statName: "fireball", value: 1 },
  { statName: "Shield", value: 9 },
);
assert.equal(say(charges), "Fireball 1/3; Shield 2/2");
assert.equal(say(run(base("bars"), { add: "Hunger | 10" }, { statName: "Hunger", value: 4 })), "Hunger 4/10");

// Calendar: today, next, events, upcoming window.
const calendar = run(
  base("calendar"),
  { value: 18, text: "12 Frostfall 412" },
  { add: "Day 21 | Oriel strike" },
  { add: "Day 10 | Old fair" },
  { value: "next" },
);
assert.equal(calendar.config.value, 19);
assert.equal(
  say(calendar),
  "today Day 19 (12 Frostfall 412), 7-day weeks; events: Day 10 | Old fair; Day 21 | Oriel strike",
);
assert.deepEqual(
  calendarUpcoming(calendar.config).map((entry) => entry.inDays),
  [2],
);

// Every type: defaults are stable, prompt summary exists, and the editor text round-trips.
const samples: Record<string, HudWidget> = {
  checklist,
  schedule,
  clock: widgets[0]!,
  tug_of_war: tug,
  tier_track: tier,
  tags,
  ledger,
  log,
  rumor_board: rumors,
  turn_order: turns,
  charges,
  calendar,
};
for (const type of EXTENDED_HUD_WIDGET_TYPES) {
  const defaults = normalizeExtendedWidgetConfig(type, {});
  assert.deepEqual(normalizeExtendedWidgetConfig(type, defaults), defaults, `${type}: normalize is idempotent`);
  assert.ok(say(base(type)), `${type}: prompt summary`);
  const sample = samples[type] ?? base(type);
  const text = extendedWidgetConfigToText(type, sample.config);
  const back = extendedWidgetConfigFromText(type, text);
  assert.equal(extendedWidgetConfigToText(type, back), text, `${type}: editor text round-trips`);
}

// Branch restoration replays the same commands from message tags.
const restored = restoreBranchHudLists(
  {
    gameWidgetState: [
      base("checklist", "tasks"),
      base("schedule", "plan"),
      base("note", "status"),
      base("tier_track", "alert"),
      base("charges", "slots"),
      base("calendar", "days"),
    ],
  },
  [
    { content: '[widget: tasks, add: "Find the key"] [widget: tasks, add: "Open the vault"]' },
    { content: '[widget: tasks, check: "Find the key"] [widget: plan, add: "Day 3, noon | Meet Oriel"]' },
    {
      content:
        '[widget: status, text: "Hiding in the cellar"] [widget: alert, add: "Calm"] [widget: alert, add: "Alert"]',
    },
    {
      content:
        '[widget: alert, value: "up"] [widget: slots, add: "Fireball | 3"] [widget: slots, stat: "Fireball", value: 2]',
    },
    { content: '[widget: days, value: 4] [widget: days, max: 6] [widget: days, add: "Day 6 | Market"]' },
    { content: '[widget: brand_new, action: create, type: pips, label: "Hope", max: 3, value: 1]' },
  ],
);
const byId = Object.fromEntries(restored.map((widget) => [widget.id, widget]));
assert.equal(say(byId.tasks!), "[x] Find the key; [ ] Open the vault");
assert.equal(say(byId.plan!), "Day 3, noon | Meet Oriel");
assert.equal(byId.status!.config.text, "Hiding in the cellar");
assert.equal(say(byId.alert!), "Calm; [Alert]");
assert.equal(say(byId.slots!), "Fireball 2/3");
assert.deepEqual([byId.days!.config.value, byId.days!.config.max], [4, 6]);
assert.equal(say(byId.brand_new!), "1/3");

// ---- Review v1.0 findings (2026-09-22) ----

// 1/2/7: a prefix is not a duplicate; lookups stay one-way.
assert.equal(say(run(base("turn_order"), { add: "Goblin" }, { add: "Goblin Archer" })), "[Goblin]; Goblin Archer");
assert.equal(say(run(base("tags"), { add: "Poison" }, { add: "Poisoned" })), "Poison; Poisoned");
assert.equal(
  say(run(base("checklist"), { add: "Talk to Ann" }, { check: "Talk to Anna" })),
  "[ ] Talk to Ann; [x] Talk to Anna",
);
assert.equal(
  say(run(base("schedule"), { add: "Day 3 | Meet the duke" }, { add: "Day 9 | Meet the duke at the gate" })),
  "Day 3 | Meet the duke; Day 9 | Meet the duke at the gate",
);
assert.deepEqual(
  normalizeExtendedWidgetConfig("stages", { levels: Array.from({ length: 10 }, (_, i) => `Act ${i + 1}`) }).levels
    ?.length,
  10,
);
assert.equal(say(run(base("scoreboard"), { add: "Mana" }, { add: "Mana Crystal" })), "Mana=0; Mana Crystal=0");
assert.equal(
  say(run(base("rumor_board"), { add: "The duke" }, { add: "The duke is a vampire" })),
  "[unverified] The duke; [unverified] The duke is a vampire",
);
// 18: identical symbol-only names are one row, distinct symbols stay distinct.
assert.equal(
  normalizeExtendedWidgetConfig("scoreboard", {
    stats: [
      { name: "\u2694", value: 1 },
      { name: "\u2694", value: 2 },
      { name: "\u{1F6E1}", value: 3 },
    ],
  }).stats?.length,
  2,
);

// 3/8: the cursor follows its entry through dedupe and capping; apply and normalize keep the same end.
const turnText = "Goblin\nGoblin\n> Orc\nTroll";
assert.equal(
  say(base("turn_order", "t", extendedWidgetConfigFromText("turn_order", turnText))),
  "Goblin; [Orc]; Troll",
);
const twelve = Array.from({ length: 12 }, (_, i) => (i === 2 ? "> " : "") + `Level ${i + 1}`).join("\n");
const capped = extendedWidgetConfigFromText("tier_track", twelve);
assert.equal(capped.levels?.length, 10);
assert.equal(capped.levels?.[capped.current ?? -1], "Level 3");
let full = base("tier_track");
for (let i = 1; i <= 11; i += 1) full = run(full, { add: `L${i}` });
assert.deepEqual([full.config.levels?.[0], full.config.levels?.at(-1)], ["L1", "L10"]);
assert.equal(run(full, { value: "Unknown level" }).config.current, 0, "no append past the cap");

// 5: the schedule cap never drops the entry just added.
let busy = base("schedule");
for (let d = 5; d <= 14; d += 1) busy = run(busy, { add: `Day ${d} | Event ${d}` });
busy = run(busy, { add: "Day 3 | Oriel strike" });
assert.ok(busy.config.entries?.some((entry) => entry.text === "Oriel strike"));
assert.equal(busy.config.entries?.length, 10);

// 10: thousands separators.
assert.equal(
  run(base("ledger"), { add: "+1,000 | Reward" }, { add: "-2,500,000 | Ship" }, { add: "+1,5 | Tip" }).config.value,
  -2498998.5,
);

// 12: undated text containing "|" round-trips through the editor.
const piped = { entries: [{ when: "", text: "A | B" }] };
assert.deepEqual(
  extendedWidgetConfigFromText("schedule", extendedWidgetConfigToText("schedule", piped)).entries,
  piped.entries,
);

// 4/6/9/11/13/17: branch restore reads create text and values exactly like live playback.
const liveLike = applyHudWidgetLifecycle([], {
  widgetId: "purse",
  changes: { action: "create", type: "ledger", label: "Purse", text: "gold", value: coerceWidgetValue("100") },
});
const branchLike = restoreBranchHudLists({ gameBlueprint: { hudWidgets: [] } }, [
  { content: '[widget: purse, action: create, type: ledger, label: "Purse", text: "gold", value: 100]' },
  {
    content:
      '[widget: order, action: create, type: turn_order, label: "Order"] [widget: order, add: "3rd Legion"] [widget: order, add: "Orc"] [widget: order, value: "3rd Legion"]',
  },
  {
    content:
      '[widget: ball, action: create, type: countdown, label: "Ball", text: "days until the ball", value: 5] [widget: ball, value: 3 days]',
  },
]);
const branchById = Object.fromEntries(branchLike.map((widget) => [widget.id, widget]));
assert.deepEqual(branchById.purse!.config, liveLike[0]!.config);
assert.equal(say(branchById.order!), "[3rd Legion]; Orc");
assert.equal(say(branchById.ball!), "3 days until the ball remaining");
assert.equal(coerceWidgetValue("3rd Legion"), "3rd Legion");
assert.equal(coerceWidgetValue(" 42 "), 42);

// 19: without blueprint widgets, replay starts from cleared content, not the stored end state.
const fallback = restoreBranchHudLists(
  {
    gameWidgetState: [
      base("ledger", "purse", {
        value: 200,
        text: "gold",
        transactions: [
          { amount: 50, text: "A" },
          { amount: 50, text: "B" },
        ],
      }),
      base("checklist", "todo", { tasks: [{ text: "Later task", done: true }] }),
      base("tier_track", "alert", { levels: ["Calm", "Alert"], current: 1 }),
    ],
  },
  [{ content: '[widget: purse, add: "+50 | A"]' }],
);
const fallbackById = Object.fromEntries(fallback.map((widget) => [widget.id, widget]));
assert.equal(fallbackById.purse!.config.value, 150);
assert.deepEqual(fallbackById.todo!.config.tasks, []);
assert.deepEqual(fallbackById.alert!.config.levels, ["Calm", "Alert"], "structure survives the reset");

// Manual editor text: a bare value keeps the widget's size, a countdown can still drop its maximum,
// and a thousands comma in the ledger balance is part of the number.
assert.equal(extendedWidgetConfigFromText("clock", "4", { value: 1, max: 8 }).max, 8);
assert.equal(extendedWidgetConfigFromText("pips", "2", { value: 1, max: 10 }).max, 10);
assert.equal(extendedWidgetConfigFromText("calendar", "12", { value: 3, max: 10 }).max, 10);
assert.equal(extendedWidgetConfigFromText("countdown", "3 | days", { value: 5, max: 10 }).max, undefined);
const commaLedger = extendedWidgetConfigFromText("ledger", "1,500 gold\n+50 | Sold the ring");
assert.equal(commaLedger.value, 1500);
assert.equal(commaLedger.text, "gold");
assert.equal(extendedWidgetConfigFromText("ledger", "-20 gold").value, -20);
assert.equal(extendedWidgetConfigFromText("ledger", "gold").text, "gold");

console.log(
  `All ${EXTENDED_HUD_WIDGET_TYPES.length} extended widget types update identically in live play, editors and branch restoration.`,
);
