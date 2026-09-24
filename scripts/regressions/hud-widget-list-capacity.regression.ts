import assert from "node:assert/strict";
import {
  applyHudWidgetLifecycle,
  LIST_WIDGET_DEFAULT_MAX,
  listWidgetCapacity,
  type HudWidget,
} from "../../packages/shared/src/index.js";
import { restoreBranchHudLists } from "../../packages/server/src/services/game/branch-state.js";

// A GM turn that adds eighteen names to an "Expected Arrivals" list widget. With the old fixed cap of five,
// only the last five survived while the narration said all eighteen were added. Lists now keep everything
// up to a safety bound of 100; an explicit max still limits a list on purpose.
const names = Array.from({ length: 18 }, (_, i) => `Guest ${i + 1}`);
const addTags = names.map((name) => `[widget: arrivals, add: "${name}"]`).join("\n");
const list = (config: HudWidget["config"] = { items: [] }): HudWidget => ({
  id: "arrivals",
  type: "list",
  label: "Expected Arrivals",
  position: "hud_left",
  config,
});

assert.equal(LIST_WIDGET_DEFAULT_MAX, 100);
assert.equal(listWidgetCapacity(undefined), 100);
assert.equal(listWidgetCapacity({ max: 18 }), 18);
assert.equal(listWidgetCapacity({ max: 500 }), 100, "safety bound 100");
assert.equal(listWidgetCapacity({ max: "x" }), 100);

// Default list: all eighteen stay.
const defaultList = restoreBranchHudLists({ gameWidgetState: [list()] }, [{ content: addTags }]);
assert.deepEqual(defaultList[0]!.config.items, names);

// A list limited on purpose still drops its oldest entries.
const limited = restoreBranchHudLists({ gameWidgetState: [list({ items: [], max: 5 })] }, [{ content: addTags }]);
assert.deepEqual(limited[0]!.config.items, names.slice(-5));

// Raised with a max command first, the whole roster stays.
const raised = restoreBranchHudLists({ gameWidgetState: [list()] }, [
  { content: "[widget: arrivals, max: 20]\n" + addTags },
]);
assert.equal(raised[0]!.config.max, 20);
assert.deepEqual(raised[0]!.config.items, names);

// A list configured with a higher max keeps it through replay.
const configured = restoreBranchHudLists({ gameBlueprint: { hudWidgets: [list({ items: [], max: 25 })] } }, [
  { content: addTags },
]);
assert.deepEqual(configured[0]!.config.items, names);

// Created by the GM with max: N.
const created = applyHudWidgetLifecycle([], {
  widgetId: "suspects",
  changes: { action: "create", type: "list", label: "Suspects", max: 12 },
});
assert.deepEqual(created[0]!.config, { items: [], max: 12 });
const createdDefault = applyHudWidgetLifecycle([], {
  widgetId: "notes",
  changes: { action: "create", type: "list", label: "Notes" },
});
assert.deepEqual(createdDefault[0]!.config, { items: [] });

console.log("List widgets keep every entry (safety bound 100) unless limited on purpose, in live play and branch replay.");
