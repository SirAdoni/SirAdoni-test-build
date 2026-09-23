import assert from "node:assert/strict";
import {
  mobileArrangementKey,
  moveMobileItem,
  moveMobileItemTo,
  orderMobileIds,
  parseMobileArrangement,
  setMobileItemExpanded,
  setMobileItemHidden,
  visibleMobileIds,
} from "../../packages/client/src/lib/game-mobile-panel-arrangement.ts";

const ids = ["a", "b", "c"];
let arrangement = parseMobileArrangement(null);
assert.deepEqual(orderMobileIds(ids, arrangement), ids);
assert.equal(mobileArrangementKey("s1"), "marinara-game-panel-mobile:s1:arrangement");
assert.ok(!mobileArrangementKey("s1").startsWith("marinara-game-panel:"));

arrangement = moveMobileItem(ids, arrangement, "c", -1);
assert.deepEqual(orderMobileIds(ids, arrangement), ["a", "c", "b"]);
assert.equal(moveMobileItem(ids, arrangement, "a", -1), arrangement, "moving past the start is a no-op");
assert.deepEqual(orderMobileIds(["d", ...ids], arrangement), ["a", "c", "b", "d"], "new ids append");
assert.deepEqual(orderMobileIds(["b", "a"], arrangement), ["a", "b"], "missing ids drop out");

arrangement = setMobileItemHidden(arrangement, "c", true);
assert.deepEqual(visibleMobileIds(ids, arrangement), ["a", "b"]);
arrangement = parseMobileArrangement(JSON.stringify(arrangement));
assert.deepEqual(visibleMobileIds(ids, arrangement), ["a", "b"], "hidden survives a round trip");
arrangement = setMobileItemHidden(arrangement, "c", false);
assert.deepEqual(visibleMobileIds(ids, arrangement), ["a", "c", "b"]);

arrangement = setMobileItemExpanded(arrangement, "b", true);
assert.deepEqual(arrangement.expanded, ["b"]);
assert.deepEqual(parseMobileArrangement(JSON.stringify(arrangement)).expanded, ["b"], "expanded survives a round trip");
arrangement = setMobileItemExpanded(arrangement, "b", false);
assert.deepEqual(arrangement.expanded, []);
assert.deepEqual(parseMobileArrangement("not json"), { order: [], hidden: [], expanded: [] });
assert.deepEqual(parseMobileArrangement('{"order":"x","hidden":[1,"a","a"]}'), { order: [], hidden: ["a"], expanded: [] });

// Left and right rails share one saved order; arranging one rail must not drop the other's order.
let rails = parseMobileArrangement(null);
rails = moveMobileItem(["r1", "r2"], rails, "r2", -1);
rails = moveMobileItem(["l1", "l2", "l3"], rails, "l3", -2);
assert.deepEqual(orderMobileIds(["r1", "r2"], rails), ["r2", "r1"], "right order survives a left move");
assert.deepEqual(orderMobileIds(["l1", "l2", "l3"], rails), ["l3", "l1", "l2"]);
// Drag drops to an absolute index, clamped to the list.
rails = moveMobileItemTo(["l1", "l2", "l3"], rails, "l3", 99);
assert.deepEqual(orderMobileIds(["l1", "l2", "l3"], rails), ["l1", "l2", "l3"]);
assert.deepEqual(orderMobileIds(["r1", "r2"], rails), ["r2", "r1"]);
assert.equal(moveMobileItemTo(["l1"], rails, "missing", 0), rails, "unknown id is a no-op");

console.log("game-mobile-panel-arrangement regression passed");
