import assert from "node:assert/strict";
import { applyHudWidgetLifecycle, type HudWidget } from "../../packages/shared/src/index.js";
import { parseGmTags } from "../../packages/client/src/lib/game-tag-parser.js";
import { restoreBranchHudLists } from "../../packages/server/src/services/game/branch-state.js";
import { useGameModeStore } from "../../packages/client/src/stores/game-mode.store.js";
import { normalizeGameHudWidgets } from "../../packages/client/src/components/game/GameWidgetSetupEditor.js";
import { buildGmFormatReminder } from "../../packages/server/src/services/game/gm-prompts.js";

const create = '[widget: supplies, action: create, type: counter, label: "Supplies, remaining", count: 3]';
const command = parseGmTags(create).widgetUpdates[0]!;
let widgets = applyHudWidgetLifecycle([], command);
assert.equal(widgets[0]?.label, "Supplies, remaining");
assert.equal(widgets[0]?.config.count, 3);
assert.deepEqual(applyHudWidgetLifecycle(widgets, command), widgets, "replayed create preserves values");
assert.equal(
  applyHudWidgetLifecycle([], { ...command, changes: { ...command.changes, type: "bad" as never } }).length,
  0,
);
assert.equal(applyHudWidgetLifecycle([], { ...command, changes: { ...command.changes, label: "" } }).length, 0);
assert.equal(applyHudWidgetLifecycle(widgets, { widgetId: "missing", changes: { action: "delete" } }).length, 1);

useGameModeStore.getState().reset();
for (const content of [create, "[widget: supplies, count: 7]"]) {
  for (const update of parseGmTags(content).widgetUpdates) useGameModeStore.getState().applyWidgetUpdate(update);
}
assert.equal(useGameModeStore.getState().hudWidgets[0]?.config.count, 7);
const branch = restoreBranchHudLists({ gameBlueprint: { hudWidgets: [] } }, [
  { content: create },
  { content: "[widget: supplies, count: 7]" },
]);
assert.deepEqual(branch, useGameModeStore.getState().hudWidgets);
const checklist: HudWidget = {
  id: "tasks",
  type: "checklist",
  label: "Tasks",
  position: "hud_left",
  config: { tasks: [{ text: "Pack supplies", done: false }] },
};
const checklistUpdate = '[widget: tasks, check: "Pack supplies"]';
assert.equal(
  restoreBranchHudLists({ gameWidgetInitialState: [checklist], gameExtendedWidgetsEnabled: false }, [
    { content: checklistUpdate },
  ])[0]?.config.tasks?.[0]?.done,
  false,
  "extended widget history is not replayed when that chat's switch was off",
);
assert.equal(
  restoreBranchHudLists({ gameWidgetInitialState: [checklist], gameExtendedWidgetsEnabled: true }, [
    { content: checklistUpdate },
  ])[0]?.config.tasks?.[0]?.done,
  true,
  "extended widget history is replayed when that chat's switch was on",
);
const remove = parseGmTags("[widget: supplies, action: delete]").widgetUpdates[0]!;
useGameModeStore.getState().applyWidgetUpdate(remove);
assert.equal(useGameModeStore.getState().hudWidgets.length, 0);
assert.equal(
  restoreBranchHudLists({ gameBlueprint: { hudWidgets: [] } }, [
    { content: create },
    { content: "[widget: supplies, action: delete]" },
  ]).length,
  0,
);

widgets = Array.from({ length: 150 }, (_, i): HudWidget => ({
  id: `widget_${i}`,
  type: "counter",
  label: `Widget ${i}`,
  position: "hud_left",
  config: { count: i },
}));
assert.equal(normalizeGameHudWidgets(widgets).length, 150, "setup must not silently truncate at four");
assert.equal(applyHudWidgetLifecycle(widgets, command).length, 151, "no lifecycle count cap");
assert.equal(JSON.parse(JSON.stringify(widgets)).length, 150);
const promptContext = {
  hudWidgets: [],
  gameActiveState: "exploration" as const,
  sessionNumber: 1,
  map: null,
  partyNames: [],
  playerName: "Player",
  enableCustomWidgets: true,
  enableExtendedWidgets: true,
};
assert(
  buildGmFormatReminder(promptContext).includes("action: create"),
  "an empty HUD must still allow its first widget",
);
assert(!buildGmFormatReminder({ ...promptContext, enableCustomWidgets: false }).includes("action: create"));
assert(!buildGmFormatReminder({ ...promptContext, enableExtendedWidgets: false }).includes("action: create"));

useGameModeStore.getState().reset();
console.log("HUD widget create/update/delete, branch replay, validation, and uncapped setup regressions passed.");
