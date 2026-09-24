import assert from "node:assert/strict";
import {
  GAME_WIDGET_AUTO_EXPAND_KEY,
  isGameWidgetAutoExpandEnabled,
  resolveWidgetAutoExpand,
  widgetAutoExpandMode,
} from "../../packages/shared/src/index.js";

// Game default: chat metadata gameWidgetAutoExpand, absent = on.
assert.equal(GAME_WIDGET_AUTO_EXPAND_KEY, "gameWidgetAutoExpand");
assert.equal(isGameWidgetAutoExpandEnabled({}), true);
assert.equal(isGameWidgetAutoExpandEnabled(undefined), true);
assert.equal(isGameWidgetAutoExpandEnabled({ gameWidgetAutoExpand: false }), false);
assert.equal(isGameWidgetAutoExpandEnabled({ gameWidgetAutoExpand: true }), true);

// Per widget: config.autoExpand, absent or unknown = auto (follow the game).
const widget = (autoExpand?: unknown) => ({ config: autoExpand === undefined ? {} : { autoExpand } }) as never;
assert.equal(widgetAutoExpandMode(widget()), "auto");
assert.equal(widgetAutoExpandMode(widget("expand")), "expand");
assert.equal(widgetAutoExpandMode(widget("fixed")), "fixed");
assert.equal(widgetAutoExpandMode(widget("sideways")), "auto");

// Auto follows the game and never overrides a hand-set size; an explicit choice wins either way.
assert.deepEqual(resolveWidgetAutoExpand(widget(), true), { expand: true, explicit: false });
assert.deepEqual(resolveWidgetAutoExpand(widget(), false), { expand: false, explicit: false });
assert.deepEqual(resolveWidgetAutoExpand(widget("expand"), false), { expand: true, explicit: true });
assert.deepEqual(resolveWidgetAutoExpand(widget("fixed"), true), { expand: false, explicit: true });

console.log("Widget auto expand: game default on unless false, per-widget Auto / Always expand / Fixed size.");
