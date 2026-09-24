import assert from "node:assert/strict";
import {
  clampFloatingWidgetPosition,
  placeFloatingWidget,
  type FloatingWidgetPlacementInput,
} from "../../packages/client/src/lib/floating-widget-avoid.js";

// A 390x844 portrait phone with the 48px collapsed music bubble.
const base: FloatingWidgetPlacementInput = {
  x: 334,
  y: 64,
  size: 48,
  viewportWidth: 390,
  viewportHeight: 844,
  padding: 8,
  bottomReserve: 88,
  gap: 4,
};

// No obstacles: the requested spot is kept as is.
assert.deepEqual(placeFloatingWidget(base), { x: 334, y: 64, moved: false });

// An obstacle elsewhere does not move a spot the user dragged into free space.
const farAway = { left: 12, top: 400, right: 200, bottom: 440 };
assert.deepEqual(placeFloatingWidget({ ...base, obstacles: [farAway] }), { x: 334, y: 64, moved: false });

// Overlap: a top-right control strip (like the game's Campaign Wiki pill) pushes the bubble
// to the nearest free spot on the right edge, just below the strip.
const wikiStrip = { left: 12, top: 64, right: 378, bottom: 104 };
const pushed = placeFloatingWidget({ ...base, obstacles: [wikiStrip] });
assert.equal(pushed.moved, true);
assert.equal(pushed.x, 334);
assert.equal(pushed.y, 108);

// The nearest free spot wins: sitting low on the obstacle moves the bubble below it,
// sitting high moves it above.
const tallRightStrip = { left: 300, top: 200, right: 390, bottom: 400 };
assert.equal(placeFloatingWidget({ ...base, y: 380, obstacles: [tallRightStrip] }).y, 404);
assert.equal(placeFloatingWidget({ ...base, y: 210, obstacles: [tallRightStrip] }).y, 148);

// Right edge fully blocked: fall back to the left edge.
const rightColumn = { left: 320, top: 0, right: 390, bottom: 844 };
const leftFallback = placeFloatingWidget({ ...base, obstacles: [rightColumn] });
assert.deepEqual(leftFallback, { x: 8, y: 64, moved: true });

// No free spot anywhere: keep the clamped position rather than jumping around.
const everything = { left: 0, top: 0, right: 390, bottom: 844 };
assert.deepEqual(placeFloatingWidget({ ...base, y: 5000, obstacles: [everything] }), {
  ...clampFloatingWidgetPosition({ ...base, y: 5000 }),
  moved: false,
});

// Clamping keeps the composer clearance at the bottom and the padding at the edges.
assert.deepEqual(clampFloatingWidgetPosition({ ...base, x: 9999, y: 9999 }), { x: 334, y: 844 - 48 - 88 });
assert.deepEqual(clampFloatingWidgetPosition({ ...base, x: -50, y: -50 }), { x: 8, y: 8 });

// Short landscape viewport with the keyboard up: a free spot above the composer is still found.
const landscape: FloatingWidgetPlacementInput = { ...base, x: 684, y: 60, viewportWidth: 740, viewportHeight: 198 };
const topRightRow = { left: 560, top: 64, right: 732, bottom: 104 };
const landscapePlaced = placeFloatingWidget({ ...landscape, obstacles: [topRightRow] });
assert.equal(landscapePlaced.moved, true);
assert.equal(landscapePlaced.x, 684);
assert.equal(landscapePlaced.y, 12); // just above the row, not jammed against the viewport edge

console.log("floating-widget-avoid regression passed");
