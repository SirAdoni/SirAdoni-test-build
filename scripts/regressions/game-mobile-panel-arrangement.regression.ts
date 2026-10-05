import assert from "node:assert/strict";
import type { FeatureSettingsResponse } from "@marinara-engine/shared";
import {
  canWriteGameHudPreference,
  resolveGameHudListVisible,
  resolveGameHudScope,
  writeGameHudListHidden,
} from "../../packages/client/src/hooks/use-game-hud-lists.ts";
import {
  mobileArrangementKey,
  moveMobileItem,
  moveMobileItemTo,
  orderMobileIds,
  parseMobileArrangement,
  resolveMobileArrangement,
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
const retained = JSON.stringify({ order: ["c", "a"], hidden: ["b"], expanded: ["c"] });
assert.deepEqual(resolveMobileArrangement(retained, false), { order: [], hidden: [], expanded: [] });
assert.deepEqual(resolveMobileArrangement(retained, true), { order: ["c", "a"], hidden: ["b"], expanded: ["c"] });
assert.deepEqual(parseMobileArrangement("not json"), { order: [], hidden: [], expanded: [] });
assert.deepEqual(parseMobileArrangement('{"order":"x","hidden":[1,"a","a"]}'), {
  order: [],
  hidden: ["a"],
  expanded: [],
});

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

const featureData = {
  settings: { mobileHudArrangement: true, hudListVisibility: true },
  effective: { mobileHudArrangement: true, hudListVisibility: true },
} as FeatureSettingsResponse;
const chat = { id: "chat-a", metadata: { gameId: "game-a" }, groupId: "group-a" };
const permission = {
  featureStatus: "success",
  featureData,
  chatStatus: "success",
  chat,
  activeChatId: "chat-a",
  expectedChatId: "chat-a",
  expectedScopeId: "game-a",
  name: "mobileHudArrangement",
} as const;
assert.equal(resolveGameHudScope(chat.metadata.gameId, chat.groupId, chat.id), "game-a");
assert.equal(canWriteGameHudPreference(permission), true);
assert.equal(canWriteGameHudPreference({ ...permission, featureStatus: "error" }), false);
assert.equal(canWriteGameHudPreference({ ...permission, featureStatus: "pending" }), false);
assert.equal(canWriteGameHudPreference({ ...permission, featureData: undefined }), false);
assert.equal(
  canWriteGameHudPreference({
    ...permission,
    featureData: { ...featureData, effective: { mobileHudArrangement: false } },
  }),
  false,
);
assert.equal(canWriteGameHudPreference({ ...permission, chatStatus: "error" }), false);
assert.equal(canWriteGameHudPreference({ ...permission, chat: undefined }), false);
assert.equal(canWriteGameHudPreference({ ...permission, activeChatId: "chat-b" }), false);
assert.equal(canWriteGameHudPreference({ ...permission, chat: { ...chat, metadata: { gameId: "game-b" } } }), false);
assert.equal(
  resolveGameHudListVisible(true, false),
  true,
  "off restores the visible baseline without clearing the stored choice",
);
assert.equal(resolveGameHudListVisible(true, true), false, "on applies the retained per-game choice");
writeGameHudListHidden("game-a", "partyBar", true, () => false);

console.log("game-mobile-panel-arrangement regression passed");
