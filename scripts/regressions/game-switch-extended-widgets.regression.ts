// Per-game "Extended HUD widgets" switch (chat metadata gameExtendedWidgetsEnabled; absent = ON).
//  1. ON keeps today's <gm_only_hud_widgets> block (extra types catalog plus create/delete) byte for byte.
//     (Checked against the pre-switch build when the switch landed: identical SHA-256 for these fixtures.)
//  2. OFF renders upstream's HUD WIDGETS block verbatim with upstream widget types only; everything else in
//     the reminder is byte-identical to ON. With only extended widgets there is no widget block at all.
//  3. OFF ignores widget create/delete on branch replay; existing extended widgets are hidden, not deleted.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isGameExtendedWidgetsEnabled, upstreamHudWidgets, type HudWidget } from "../../packages/shared/src/index.js";
import { buildGmFormatReminder, buildGmSystemPrompt } from "../../packages/server/src/services/game/gm-prompts.js";
import { restoreBranchHudLists } from "../../packages/server/src/services/game/branch-state.js";

assert.equal(isGameExtendedWidgetsEnabled({}), true, "absent key is ON");
assert.equal(isGameExtendedWidgetsEnabled({ gameExtendedWidgetsEnabled: false }), false);

const widgets: HudWidget[] = [
  { id: "supplies", type: "counter", label: "Supplies", position: "hud_left", config: { count: 3 } },
  { id: "morale", type: "progress_bar", label: "Morale", position: "hud_left", config: { value: 40, max: 100 } },
  { id: "leads", type: "list", label: "Leads", position: "hud_right", config: { items: ["Mill", "Ferry"] } },
  {
    id: "errands",
    type: "checklist",
    label: "Errands",
    position: "hud_right",
    config: { tasks: [{ text: "Buy rope", done: false }] } as HudWidget["config"],
  },
];
assert.deepEqual(
  upstreamHudWidgets(widgets).map((widget) => widget.id),
  ["supplies", "morale", "leads"],
);

// Upstream Marinara Engine's widget block for the same three upstream widgets, copied verbatim.
const UPSTREAM_BLOCK = [
  ``,
  `HUD WIDGETS:`,
  `- supplies (counter): 3`,
  `- morale (progress_bar): 40`,
  `- leads (list): Mill; Ferry`,
  `- Widget usage: emit widget commands for every real change to these visible HUD widgets. Do not skip a changed widget just because another system tracks related player or party stats.`,
  `- HUD widgets are visual UI state only. Player stats, inventory, party member HP, party relationships, and other durable game facts remain in their own canonical systems; use [widget:] only to mirror a visible widget when that widget's displayed value should change.`,
  `- Command mapping: value = bars/gauges, count = counters, stat = one stat_block entry, add/remove = rotating list items, running/seconds = timers.`,
  `- Widget commands: [widget: id, value: n] [widget: id, stat: "Name", value: x] [widget: id, count: n] [widget: id, add: "Item"] [widget: id, remove: "Item"] [widget: id, running: true, seconds: 60]`,
  `- List widgets: keep at most 5 short entries visible; remove stale items freely.`,
].join("\n");

const base = {
  gameActiveState: "exploration" as const,
  sessionNumber: 2,
  turnNumber: 7,
  map: null,
  partyNames: ["Tamsin"],
  playerName: "Player",
  enableCustomWidgets: true,
  playerInventory: [{ name: "Lantern", quantity: 1 }],
  hudWidgets: widgets,
};
const forkBlock = /\n\n<gm_only_hud_widgets>[\s\S]*?<\/gm_only_hud_widgets>/;

const on = buildGmFormatReminder(base);
assert.equal(buildGmFormatReminder({ ...base, enableExtendedWidgets: true }), on, "explicit ON equals absent");
assert.match(on, forkBlock);
assert(on.includes("action: create") && on.includes("- Extra types.") && on.includes("- errands (checklist)"));

const off = buildGmFormatReminder({ ...base, enableExtendedWidgets: false });
// The fork block regex also takes the line separator in front of it, so the replacement adds it back.
assert.equal(off, on.replace(forkBlock, "\n" + UPSTREAM_BLOCK), "OFF swaps only the widget block for upstream's");
assert(!off.includes("action: create") && !off.includes("Extra types") && !off.includes("errands"));

const onlyExtended = { ...base, hudWidgets: widgets.slice(3) };
assert.equal(
  buildGmFormatReminder({ ...onlyExtended, enableExtendedWidgets: false }),
  buildGmFormatReminder(onlyExtended).replace(forkBlock, ""),
  "no upstream widgets: no block, like upstream",
);
const customOff = { ...base, enableCustomWidgets: false };
assert.equal(buildGmFormatReminder({ ...customOff, enableExtendedWidgets: false }), buildGmFormatReminder(customOff));

// The stable system prompt never reads the switch.
const systemContext = {
  ...base,
  genre: "fantasy",
  setting: "original",
  tone: "balanced",
  storyArc: null,
  plotTwists: [],
} as unknown as Parameters<typeof buildGmSystemPrompt>[0];
assert.equal(
  buildGmSystemPrompt({ ...systemContext, enableExtendedWidgets: false }),
  buildGmSystemPrompt(systemContext),
);

// The runtime and the generate route pass the chat's switch through.
const root = new URL("../../packages/server/src/", import.meta.url);
assert.match(
  readFileSync(new URL("services/generation/game-gm-prompt-runtime.ts", root), "utf8"),
  /enableExtendedWidgets: isGameExtendedWidgetsEnabled\(args\.chatMetadata\)/,
);
assert.match(
  readFileSync(new URL("routes/generate.routes.ts", root), "utf8"),
  /enableExtendedWidgets: gmCtx\.enableExtendedWidgets/,
);

// Branch replay: OFF ignores create/delete (upstream has neither), ON keeps today's lifecycle.
const create = '[widget: rope, action: create, type: counter, label: "Rope", count: 2]';
const replay = (metadata: Record<string, unknown>) =>
  restoreBranchHudLists({ gameBlueprint: { hudWidgets: [widgets[0]] }, ...metadata }, [
    { content: create },
    { content: "[widget: supplies, action: delete]" },
    { content: "[widget: supplies, count: 5]" },
  ]).map((widget) => `${widget.id}:${widget.config.count}`);
assert.deepEqual(replay({}), ["rope:2"]);
assert.deepEqual(replay({ gameExtendedWidgetsEnabled: false }), ["supplies:5"]);

console.log("game-switch-extended-widgets regression passed");
