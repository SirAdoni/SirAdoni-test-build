import assert from "node:assert/strict";
import {
  buildSnapTargets,
  constrainResizeRect,
  findNearestFreePosition,
  needsSettling,
  overlapAreas,
  rectsOverlap,
  snapMoveRect,
  snapResizeRect,
} from "../../packages/client/src/lib/game-layout-geometry.js";
import {
  addSavedLayout,
  applyLayoutSnapshot,
  captureLayoutSnapshot,
  clearLayoutScope,
  createLayoutHistory,
  deleteSavedLayout,
  exportLayoutJson,
  parseLayoutJson,
  parseSavedLayouts,
  pushLayoutHistory,
  redoLayoutHistory,
  renameSavedLayout,
  serializeSavedLayouts,
  snapshotsEqual,
  undoLayoutHistory,
  type LayoutStorage,
} from "../../packages/client/src/lib/game-layout-snapshots.js";
import { resolveGamePanelLayout } from "../../packages/client/src/lib/game-panel-layout.js";

// ── Snapping ──
const bounds = { width: 1000, height: 600 };
const neighbour = { x: 400, y: 100, width: 200, height: 150 };
const targets = buildSnapTargets(bounds, [neighbour]);

const nearLeftEdge = snapMoveRect({ x: 6, y: 300, width: 120, height: 80 }, targets, { bounds, grid: 16 });
assert.equal(nearLeftEdge.x, 0, "a rect within 8px of the surface edge snaps to it");
assert.ok(
  nearLeftEdge.guides.some((guide) => guide.axis === "x" && guide.value === 0),
  "snapping to the surface edge draws a vertical guide",
);

const centred = snapMoveRect({ x: 437, y: 300, width: 120, height: 80 }, targets, { bounds, grid: 16 });
assert.equal(centred.x + 60, 500, "centre lines attract the moving rect's centre");

const alignedTop = snapMoveRect({ x: 700, y: 104, width: 120, height: 80 }, targets, { bounds, grid: 16 });
assert.equal(alignedTop.y, 100, "a neighbour's top edge attracts the moving top edge");
const guide = alignedTop.guides.find((item) => item.axis === "y");
assert.ok(guide && guide.start <= 400 && guide.end >= 820, "the guide spans both the neighbour and the moving rect");

const nextTo = snapMoveRect({ x: 612, y: 400, width: 120, height: 80 }, targets, { bounds, grid: 16 });
assert.equal(nextTo.x, 608, "the gap line one resolver gap right of a neighbour attracts the left edge");

const free = snapMoveRect({ x: 250, y: 470, width: 120, height: 80 }, targets, { bounds, grid: 16 });
assert.deepEqual({ x: free.x, y: free.y }, { x: 256, y: 464 }, "no nearby line falls back to the 16px grid");
assert.equal(free.guides.length, 0, "grid snapping draws no guides");

const unsnapped = snapMoveRect({ x: 251, y: 5, width: 120, height: 80 }, null, { bounds });
assert.deepEqual({ x: unsnapped.x, y: unsnapped.y }, { x: 251, y: 5 }, "snapping off (Alt) moves freely");
const clamped = snapMoveRect({ x: 980, y: -40, width: 120, height: 80 }, null, { bounds });
assert.deepEqual({ x: clamped.x, y: clamped.y }, { x: 880, y: 0 }, "moves stay inside the surface");

// Many panels: snap targets are built once and still resolve instantly.
const crowd = Array.from({ length: 24 }, (_, index) => ({
  x: (index % 6) * 160,
  y: Math.floor(index / 6) * 140,
  width: 150,
  height: 130,
}));
const crowdTargets = buildSnapTargets({ width: 1440, height: 900 }, crowd);
const started = performance.now();
for (let step = 0; step < 2000; step += 1)
  snapMoveRect({ x: step % 1300, y: (step * 7) % 800, width: 200, height: 120 }, crowdTargets, {
    bounds: { width: 1440, height: 900 },
    grid: 16,
  });
assert.ok(performance.now() - started < 400, "2000 snapped pointer moves over 24 panels stay fast");

// ── Resize snapping ──
const resized = snapResizeRect({ x: 100, y: 300, width: 294, height: 120 }, { right: true }, targets, {
  bounds,
  grid: 16,
  minWidth: 140,
  minHeight: 64,
});
assert.equal(
  resized.rect.x + resized.rect.width,
  392,
  "a resized right edge snaps to the gap line left of a neighbour",
);
assert.equal(resized.rect.x, 100, "the opposite edge stays put");
assert.equal(resized.guides.length, 1, "a snapped edge draws a guide");
const tiny = snapResizeRect({ x: 400, y: 300, width: 20, height: 10 }, { left: true, top: true }, null, {
  bounds,
  minWidth: 140,
  minHeight: 64,
});
assert.deepEqual(tiny.rect, { x: 280, y: 246, width: 140, height: 64 }, "minimum size wins from the dragged corner");
const atEdge = snapResizeRect({ x: -30, y: 300, width: 60, height: 100 }, { left: true }, null, {
  bounds,
  minWidth: 140,
  minHeight: 64,
});
assert.deepEqual(atEdge.rect, { x: 0, y: 300, width: 140, height: 100 }, "minimum size holds at the surface edge");
const bothAxes = snapResizeRect({ x: 40, y: 40, width: 333, height: 211 }, { right: true, bottom: true }, null, {
  bounds,
  minWidth: 140,
  minHeight: 64,
});
assert.deepEqual(
  bothAxes.rect,
  { x: 40, y: 40, width: 333, height: 211 },
  "a corner changes width and height together",
);

// Collision-aware resize stops before a neighbour, and phases through when collisions are off.
const origin = { x: 100, y: 120, width: 200, height: 100 };
const intoNeighbour = constrainResizeRect(
  { x: 100, y: 120, width: 400, height: 100 },
  origin,
  { right: true },
  [neighbour],
  { width: 140, height: 64 },
);
assert.deepEqual(intoNeighbour, { x: 100, y: 120, width: 292, height: 100 }, "a resized edge stops one gap short");
const impossible = constrainResizeRect(
  { x: 100, y: 120, width: 400, height: 100 },
  { x: 250, y: 120, width: 140, height: 100 },
  { right: true },
  [neighbour],
  { width: 300, height: 64 },
);
assert.equal(impossible, null, "a cut that breaks the minimum size keeps the last valid frame");

// ── Overlap and settling ──
assert.ok(rectsOverlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 }));
assert.ok(
  !rectsOverlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 10, height: 10 }),
  "touching is not overlap",
);
assert.deepEqual(
  overlapAreas({ x: 350, y: 150, width: 100, height: 50 }, [neighbour]),
  [{ x: 400, y: 150, width: 50, height: 50 }],
  "overlap areas are the intersections",
);
const dropped = { x: 450, y: 150, width: 120, height: 60 };
assert.ok(needsSettling(dropped, [neighbour]), "a drop on a neighbour needs settling");
const settled = findNearestFreePosition(dropped, [neighbour], bounds);
assert.ok(settled, "a free spot exists");
assert.ok(
  !rectsOverlap({ ...dropped, ...settled! }, neighbour, 7.5),
  "the settled spot keeps the resolver gap from the neighbour",
);
assert.deepEqual(settled, { x: 450, y: 258 }, "settling picks the nearest free spot (below the neighbour)");
const nearestFirst = findNearestFreePosition({ x: 590, y: 120, width: 100, height: 60 }, [neighbour], bounds);
assert.deepEqual(nearestFirst, { x: 608, y: 120 }, "a small overlap settles by the shortest move");
assert.equal(
  findNearestFreePosition({ x: 0, y: 0, width: 1000, height: 600 }, [neighbour], bounds),
  null,
  "no free spot reports null so the caller keeps the drop",
);
const settleStart = performance.now();
for (let run = 0; run < 50; run += 1)
  findNearestFreePosition({ x: 700, y: 400, width: 220, height: 160 }, crowd, { width: 1440, height: 900 });
assert.ok(performance.now() - settleStart < 500, "settling among 24 panels stays fast");

// Collisions off: the automatic resolver keeps intentionally overlapping panels in place.
const moved = new Map<string, { x: number; y: number }>();
const overlapping = ["a", "b"].map((id, priority) => ({
  id,
  x: 100 + priority * 40,
  y: 100,
  width: 200,
  height: 120,
  locked: false,
  priority,
  setPosition: (x: number, y: number) => moved.set(id, { x, y }),
}));
resolveGamePanelLayout(overlapping, { width: 1000, height: 600, allowOverlap: true });
assert.equal(moved.size, 0, "with collisions off, overlapping panels are not pushed apart");
resolveGamePanelLayout(overlapping, { width: 1000, height: 600 });
assert.ok(moved.has("b"), "with collisions on, the resolver still separates overlapping panels");

// Crowded layouts shrink automatic panels into scrolling windows but never undo a manual height.
const limits = new Map<string, number>();
const crowdedItems = [
  { id: "manual", firmHeight: true, height: 500 },
  { id: "auto-a", height: 500 },
  { id: "auto-b", height: 500 },
].map((item, priority) => ({
  ...item,
  x: 0,
  y: 0,
  width: 380,
  locked: false,
  priority,
  setPosition: () => undefined,
  setHeightLimit: (height: number) => limits.set(item.id, height),
}));
resolveGamePanelLayout(crowdedItems, { width: 800, height: 600 });
assert.equal(limits.get("manual"), 500, "a manual height survives a crowded reflow");
assert.ok(
  (limits.get("auto-a") ?? 500) < 500 || (limits.get("auto-b") ?? 500) < 500,
  "automatic panels shrink instead",
);

// ── Snapshots ──
class MemoryStorage implements LayoutStorage {
  map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
}
const storage = new MemoryStorage();
storage.setItem("marinara-game-panel:scope-a:floating:map", '{"x":10,"y":20,"locked":false}');
storage.setItem("marinara-game-panel:scope-a:floating:map:size-v2", '{"width":300}');
storage.setItem("marinara-game-panel:scope-a:floating:widget:hp:hidden", "true");
storage.setItem("marinara-game-panel-stacks:scope-a", '{"widget:hp":"stack:x"}');
storage.setItem("marinara-game-panel:scope-b:floating:map", '{"x":99}');
storage.setItem("marinara-game-panel-migration:v1:old:scope-a", "done");
storage.setItem("unrelated", "keep");

const snapshot = captureLayoutSnapshot(storage, "scope-a");
assert.deepEqual(Object.keys(snapshot.entries).sort(), [
  "panel:floating:map",
  "panel:floating:map:size-v2",
  "panel:floating:widget:hp:hidden",
  "stacks",
]);
assert.equal(snapshot.entries.stacks, '{"widget:hp":"stack:x"}', "the stack map is part of the snapshot");

// Applying to another scope writes relative keys there and removes that scope's other keys.
applyLayoutSnapshot(storage, "scope-b", snapshot);
assert.equal(storage.getItem("marinara-game-panel:scope-b:floating:map"), '{"x":10,"y":20,"locked":false}');
assert.equal(storage.getItem("marinara-game-panel-stacks:scope-b"), '{"widget:hp":"stack:x"}');
assert.equal(storage.getItem("marinara-game-panel:scope-a:floating:map"), '{"x":10,"y":20,"locked":false}');
storage.setItem("marinara-game-panel:scope-a:floating:storyboard", '{"x":1}');
applyLayoutSnapshot(storage, "scope-a", snapshot);
assert.equal(
  storage.getItem("marinara-game-panel:scope-a:floating:storyboard"),
  null,
  "keys absent from the snapshot are removed",
);
assert.equal(storage.getItem("unrelated"), "keep", "unrelated keys survive");
assert.equal(storage.getItem("marinara-game-panel-migration:v1:old:scope-a"), "done", "the migration marker survives");
assert.ok(snapshotsEqual(captureLayoutSnapshot(storage, "scope-a"), snapshot), "capture after apply round-trips");
clearLayoutScope(storage, "scope-a");
assert.deepEqual(captureLayoutSnapshot(storage, "scope-a").entries, {}, "reset all clears the scope");
assert.equal(storage.getItem("marinara-game-panel:scope-b:floating:map"), '{"x":10,"y":20,"locked":false}');

// ── Undo history ──
const s = (value: string) => ({ entries: { "panel:floating:map": value } });
let history = createLayoutHistory(s("0"));
assert.equal(pushLayoutHistory(history, s("0")), history, "an unchanged snapshot is not a step");
for (let step = 1; step <= 60; step += 1) history = pushLayoutHistory(history, s(String(step)));
assert.equal(history.past.length, 50, "undo keeps at most 50 steps");
history = undoLayoutHistory(history);
assert.equal(history.present.entries["panel:floating:map"], "59");
history = undoLayoutHistory(history);
history = redoLayoutHistory(history);
assert.equal(history.present.entries["panel:floating:map"], "59", "redo reapplies the undone step");
history = pushLayoutHistory(history, s("new"));
assert.equal(history.future.length, 0, "a new step clears redo");
let empty = createLayoutHistory(s("x"));
assert.equal(undoLayoutHistory(empty), empty, "undo with no past is a no-op");
empty = redoLayoutHistory(empty);
assert.equal(empty.present.entries["panel:floating:map"], "x");

// ── Saved layouts, export and import ──
let saved = addSavedLayout([], "  My   layout ", snapshot, 1000, "id-1");
saved = addSavedLayout(saved, "", snapshot, 1001, "id-2");
assert.deepEqual(
  saved.map((layout) => layout.name),
  ["My layout", "Layout 2"],
  "names are tidied and blank names get a default",
);
saved = renameSavedLayout(saved, "id-2", "Combat", 2000);
assert.equal(saved[1]!.name, "Combat");
assert.equal(saved[1]!.updatedAt, 2000);
assert.deepEqual(parseSavedLayouts(serializeSavedLayouts(saved)), saved, "saved layouts round-trip");
assert.deepEqual(parseSavedLayouts("not json"), [], "corrupt storage reads as empty");
assert.deepEqual(
  parseSavedLayouts('[{"id":"x","snapshot":{"entries":{"evil:key":"1"}}}]'),
  [],
  "foreign keys are rejected",
);
saved = deleteSavedLayout(saved, "id-1");
assert.deepEqual(
  saved.map((layout) => layout.id),
  ["id-2"],
);

const exported = exportLayoutJson("Combat", snapshot);
const imported = parseLayoutJson(exported);
assert.ok(imported && imported.length === 1 && imported[0]!.name === "Combat", "export re-imports");
assert.ok(snapshotsEqual(imported![0]!.snapshot, snapshot));
assert.equal(parseLayoutJson("{}"), null, "a non-layout object is rejected");
assert.equal(parseLayoutJson('{"format":"other","entries":{}}'), null, "another format is rejected");
assert.equal(parseLayoutJson("[1,2]"), null);
assert.equal(parseLayoutJson("nope"), null);

console.info(
  "Game layout editor regression passed: snapping, resize, settling, overlap mode, snapshots, undo, saved layouts.",
);
