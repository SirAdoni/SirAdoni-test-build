import assert from "node:assert/strict";
import { rectsOverlap } from "../../packages/client/src/lib/game-layout-geometry";
import { alignPanels, tidyColumnOf, tidyLayout, type TidyItem } from "../../packages/client/src/lib/game-layout-tidy";
import { arrangePanels, writeArrangedSnapshot, type MeasuredPanel } from "../../packages/client/src/lib/game-layout-arrange";

const bounds = { width: 1440, height: 900 };
const messy: TidyItem[] = [
  { id: "a", rect: { x: 20, y: 300, width: 280, height: 200 }, locked: false },
  { id: "b", rect: { x: 40, y: 100, width: 300, height: 180 }, locked: false },
  { id: "c", rect: { x: 60, y: 120, width: 260, height: 400 }, locked: false },
  { id: "narration", rect: { x: 400, y: 200, width: 640, height: 500 }, locked: false },
  { id: "r1", rect: { x: 1100, y: 50, width: 300, height: 300 }, locked: false },
  { id: "r2", rect: { x: 1120, y: 70, width: 280, height: 700 }, locked: false },
  { id: "lock", rect: { x: 1150, y: 400, width: 250, height: 150 }, locked: true },
];

const out = tidyLayout(messy, bounds);
const rects = [...out.entries()];
for (const [id, rect] of rects) {
  assert.ok(rect.x >= 0 && rect.y >= 0, `${id} in bounds`);
  assert.ok(rect.x + rect.width <= bounds.width && rect.y + rect.height <= bounds.height, `${id} in bounds`);
}
for (let i = 0; i < rects.length; i += 1)
  for (let j = i + 1; j < rects.length; j += 1)
    assert.ok(!rectsOverlap(rects[i][1], rects[j][1]), `${rects[i][0]} and ${rects[j][0]} overlap`);
assert.deepEqual(out.get("lock"), messy[6].rect, "locked panel untouched");
// Vertical order within a column is kept.
assert.ok(out.get("b")!.y < out.get("c")!.y && out.get("c")!.y < out.get("a")!.y, "left column order kept");
assert.ok(out.get("r1")!.y < out.get("r2")!.y, "right column order kept");
// Column placement is kept and widths never change.
for (const item of messy) {
  assert.equal(tidyColumnOf(out.get(item.id)!, bounds), tidyColumnOf(item.rect, bounds), `${item.id} column`);
  assert.equal(out.get(item.id)!.width, item.rect.width, `${item.id} width`);
}
// Something too tall shrinks to fit, never below the readable minimum.
for (const [id, rect] of rects) assert.ok(rect.height >= 120 || rect.height === messy.find((m) => m.id === id)!.rect.height);

// Align and match width.
const pair: TidyItem[] = [
  { id: "p", rect: { x: 100, y: 100, width: 200, height: 100 }, locked: false },
  { id: "q", rect: { x: 180, y: 300, width: 260, height: 100 }, locked: false },
  { id: "z", rect: { x: 400, y: 50, width: 260, height: 100 }, locked: true },
];
assert.equal(alignPanels(pair, "left", bounds).get("q")!.x, 100);
assert.equal(alignPanels(pair, "right", bounds).get("p")!.x, 660 - 200);
assert.equal(alignPanels(pair, "top", bounds).get("q")!.y, 50);
assert.equal(alignPanels(pair, "matchWidth", bounds, "p").get("q")!.width, 200);
assert.equal(alignPanels(pair, "left", bounds).has("z"), false, "locked panel not aligned");
assert.equal(alignPanels(pair.slice(0, 1), "left", bounds).size, 0);

// Applying: stacks move as one block, locked stay, reading panels keep a third of the screen,
// and the snapshot gets position, fixed height and manual width keys.
const panels: MeasuredPanel[] = [
  { id: "narration", rect: { x: 400, y: 100, width: 600, height: 900 }, locked: false },
  { id: "widget:a", rect: { x: 30, y: 400, width: 260, height: 100 }, locked: false },
  { id: "widget:b", rect: { x: 30, y: 508, width: 260, height: 100 }, locked: false },
  { id: "widget:c", rect: { x: 50, y: 420, width: 300, height: 150 }, locked: false },
  { id: "lockd", rect: { x: 1100, y: 10, width: 300, height: 150 }, locked: true },
];
const stacks = { "widget:a": "g", "widget:b": "g" };
const tidied = arrangePanels("tidy", panels, { bounds, stacks });
assert.equal(tidied.has("lockd"), false, "locked panel not moved");
const moved = (id: string) => tidied.get(id) ?? panels.find((panel) => panel.id === id)!.rect;
assert.equal(moved("widget:b").y - moved("widget:a").y, 108, "stack keeps its spacing");
assert.equal(moved("widget:b").x, moved("widget:a").x, "stack moves together");
assert.ok(moved("narration").height >= 300, "narration keeps a third of the screen");
const all = panels.map((panel) => moved(panel.id));
for (let i = 0; i < all.length; i += 1)
  for (let j = i + 1; j < all.length; j += 1) assert.ok(!rectsOverlap(all[i]!, all[j]!), `tidy overlap ${i} ${j}`);
const snap = writeArrangedSnapshot(
  { entries: { "panel:floating:narration": JSON.stringify({ locked: false, x: 400, y: 100 }) } },
  panels,
  tidied,
  bounds,
);
const narr = JSON.parse(snap.entries["panel:floating:narration"]!);
assert.equal(narr.bottom, narr.y + moved("narration").height);
assert.equal(snap.entries["panel:floating:narration:size-v2:growth"], "fixed", "shortened panel is fixed height");
assert.equal(snap.entries["panel:floating:narration:size-v2:growth-explicit"], "true");
const matched = arrangePanels("matchWidth", panels, { bounds, selection: ["widget:c", "narration"] });
assert.equal(matched.get("narration")!.width, 300);
const matchedSnap = writeArrangedSnapshot({ entries: {} }, panels, matched, bounds);
assert.equal(JSON.parse(matchedSnap.entries["panel:floating:narration:size-v2"]!).manualWidth, true);
// Collisions on: an aligned panel that would land on another settles clear of it; off leaves the overlap.
const crowd: MeasuredPanel[] = [
  { id: "p", rect: { x: 100, y: 100, width: 200, height: 100 }, locked: false },
  { id: "q", rect: { x: 500, y: 300, width: 200, height: 100 }, locked: false },
  { id: "block", rect: { x: 100, y: 300, width: 200, height: 100 }, locked: false },
];
const on = arrangePanels("left", crowd, { bounds, selection: ["p", "q"], collisions: true });
assert.ok(!rectsOverlap(on.get("q")!, crowd[2]!.rect), "collisions on settles clear");
const off = arrangePanels("left", crowd, { bounds, selection: ["p", "q"], collisions: false });
assert.deepEqual(off.get("q"), { x: 100, y: 300, width: 200, height: 100 }, "collisions off keeps exact align");

console.log("game-layout-tidy regression passed");
