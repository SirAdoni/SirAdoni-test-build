import assert from "node:assert/strict";
import { applyGameWidgetUpdate, parseGmTags, type HudWidget, type WidgetUpdate } from "../../packages/shared/src/index.js";

const parseUpdates = (
  widgets: HudWidget[],
  content: string,
  overflow?: (widget: HudWidget, capacity: number, dropped: number) => void,
) => {
  const parsed = parseGmTags(content);
  return parsed.widgetUpdates.reduce(
    (current, update) => applyGameWidgetUpdate(current, update, { onListOverflow: overflow }),
    widgets,
  );
};

let widgets: HudWidget[] = [];
widgets = parseUpdates(widgets, "[widget: clock, action: create, type: stat_block, label: Journey]");
assert.equal(widgets[0]?.type, "stat_block");
widgets = parseUpdates(widgets, '[widget: clock, stat: Travel time, value: "23 h 52 min"]');
assert.deepEqual(widgets[0]?.config.stats, [{ name: "Travel time", value: "23 h 52 min" }]);
const directStatUpdate: WidgetUpdate = { widgetId: "clock", changes: { statName: "Travel time", value: "42" } };
widgets = applyGameWidgetUpdate(widgets, directStatUpdate);
assert.deepEqual(widgets[0]?.config.stats, [{ name: "Travel time", value: 42 }]);
const duplicateCreate = parseUpdates(widgets, "[widget: clock, action: create, type: counter, label: Replacement]");
assert.strictEqual(duplicateCreate, widgets, "create never overwrites an existing widget");
const invalidCreate = parseUpdates(widgets, "[widget: invalid, action: create, type: unknown, label: Invalid]");
assert.strictEqual(invalidCreate, widgets, "invalid lifecycle creates are ignored");
widgets = parseUpdates(widgets, "[widget: clock, action: delete]");
assert.equal(widgets.length, 0);

widgets = [
  {
    id: "health",
    type: "progress_bar",
    label: "Health",
    position: "hud_left",
    config: { value: 0, max: 100 },
  },
];
widgets = parseUpdates(widgets, '[widget: health, value: "70 percent"]');
assert.equal(widgets[0]?.config.value, 70);

widgets = parseUpdates([], "[widget: tasks, action: create, type: checklist, label: Tasks]");
widgets = parseUpdates(widgets, "[widget: tasks, add: Find the key][widget: tasks, check: Find the key]");
assert.deepEqual(widgets[0]?.config.tasks, [{ text: "Find the key", done: true }]);
widgets = parseUpdates(widgets, "[widget: tasks, uncheck: Find the key]");
assert.deepEqual(widgets[0]?.config.tasks, [{ text: "Find the key", done: false }]);

const longRosterItems = ["A", "B", "C", "D", "E", "F"];
const defaultRosterConfig = { items: longRosterItems };
widgets = [{ id: "default-roster", type: "list", label: "Default", position: "hud_left", config: defaultRosterConfig }];
widgets = parseUpdates(widgets, "[widget: default-roster, add: G]");
assert.deepEqual(widgets[0]?.config.items, ["A", "B", "C", "D", "E", "F", "G"]);
assert.notStrictEqual(widgets[0]?.config, defaultRosterConfig, "updates return a fresh config object");
assert.notStrictEqual(widgets[0]?.config.items, longRosterItems, "updates return a fresh item array");
assert.strictEqual(defaultRosterConfig.items, longRosterItems, "updates preserve the source list reference");
assert.deepEqual(longRosterItems, ["A", "B", "C", "D", "E", "F"], "updates do not mutate source items");

const overflow: Array<{ capacity: number; dropped: number }> = [];
const cappedItems = ["A", "B", "C", "D", "E", "F"];
const cappedConfig = { items: cappedItems };
widgets = parseUpdates(
  [
    {
      id: "roster",
      type: "list",
      label: "Roster",
      position: "hud_left",
      config: cappedConfig,
    },
  ],
  "[widget: roster, max: 3, add: G]",
  (_widget, capacity, dropped) => overflow.push({ capacity, dropped }),
);
assert.deepEqual(widgets[0]?.config.items, ["E", "F", "G"]);
assert.equal(widgets[0]?.config.max, 3);
assert.deepEqual(overflow, [{ capacity: 3, dropped: 4 }]);
assert.notStrictEqual(widgets[0]?.config, cappedConfig, "max updates return a fresh config object");
assert.notStrictEqual(widgets[0]?.config.items, cappedItems, "max updates return a fresh item array");
assert.strictEqual(cappedConfig.items, cappedItems, "list max updates do not replace or mutate the source items");
assert.deepEqual(cappedItems, ["A", "B", "C", "D", "E", "F"]);

widgets = parseUpdates(
  [{ id: "bounded", type: "list", label: "Bounded", position: "hud_left", config: { items: [] } }],
  "[widget: bounded, max: 1000]",
);
assert.equal(widgets[0]?.config.max, 100, "list capacity is capped at the shared safety limit");

widgets = [
  {
    id: "leads",
    type: "list",
    label: "Leads",
    position: "hud_left",
    config: { items: ["Saltmarch ferry", "Pemberly mill"] },
  },
];
widgets = parseUpdates(widgets, "[widget: leads, remove: Saltmarch]");
assert.deepEqual(widgets[0]?.config.items, ["Pemberly mill"]);
widgets = [
  {
    id: "mills",
    type: "list",
    label: "Mills",
    position: "hud_left",
    config: { items: ["Old mill", "New mill"] },
  },
];
const unchanged = parseUpdates(widgets, "[widget: mills, remove: mill]");
assert.deepEqual(unchanged[0]?.config.items, ["Old mill", "New mill"]);

assert.strictEqual(parseUpdates(widgets, "[widget: missing, value: 1]"), widgets, "unknown widget updates are no-ops");
