import assert from "node:assert/strict";
import type { HudWidget } from "../../packages/shared/src/index.js";
import { parseGmTags } from "../../packages/client/src/lib/game-tag-parser.js";
import { restoreBranchHudLists } from "../../packages/server/src/services/game/branch-state.js";
import { useGameModeStore } from "../../packages/client/src/stores/game-mode.store.js";

// Stat block values are text. The live store and branch restoration used to keep only a leading number, so
// "23 h 52 min" showed as 23 and "540 km circuit" as 540. Only a wholly numeric value becomes a number;
// numeric widgets (progress bars, gauges, counters) still read a leading number.
const stats: HudWidget = {
  id: "readings",
  type: "stat_block",
  label: "Local Readings",
  position: "hud_right",
  config: { stats: [{ name: "Day Length", value: 24 }] },
};
const bar: HudWidget = {
  id: "hull",
  type: "progress_bar",
  label: "Hull",
  position: "hud_left",
  config: { value: 50, max: 100 },
};
const turn = [
  '[widget: readings, stat: "Day Length", value: "23 h 52 min"]',
  '[widget: readings, stat: "Orbit", value: "540 km circuit"]',
  '[widget: readings, stat: "Gravity", value: "42"]',
  '[widget: readings, stat: "Drift", value: "-1.5"]',
  '[widget: hull, value: "70 percent"]',
].join("\n");
const expected = [
  { name: "Day Length", value: "23 h 52 min" },
  { name: "Orbit", value: "540 km circuit" },
  { name: "Gravity", value: 42 },
  { name: "Drift", value: -1.5 },
];

// Live play: the tag parser and the store.
useGameModeStore.getState().reset();
useGameModeStore.getState().setHudWidgets([structuredClone(stats), structuredClone(bar)]);
for (const update of parseGmTags(turn).widgetUpdates) useGameModeStore.getState().applyWidgetUpdate(update);
const live = useGameModeStore.getState().hudWidgets;
assert.deepEqual(live.find((widget) => widget.id === "readings")?.config.stats, expected);
assert.equal(live.find((widget) => widget.id === "hull")?.config.value, 70, "numeric widgets keep a leading number");

// Branch restoration replays the same turn to the same values.
const branch = restoreBranchHudLists({ gameBlueprint: { hudWidgets: [stats, bar] } }, [{ content: turn }]);
assert.deepEqual(branch.find((widget) => widget.id === "readings")?.config.stats, expected);
assert.equal(branch.find((widget) => widget.id === "hull")?.config.value, 70);

console.log("Stat block values keep their text (only wholly numeric values become numbers), live and on branches.");
