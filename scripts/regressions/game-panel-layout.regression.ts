import assert from "node:assert/strict";
import {
  constrainPanelDragPosition,
  resolveGamePanelLayout,
  snapPanelDragPosition,
} from "../../packages/client/src/lib/game-panel-layout.js";

assert.equal(snapPanelDragPosition(31, 400), 32, "interior drag positions snap to the 16px grid");
assert.equal(snapPanelDragPosition(7, 400), 0, "near-edge drag positions clamp to the usable edge");
assert.equal(snapPanelDragPosition(399, 400), 400, "positions snapping to the far edge remain usable");
assert.equal(snapPanelDragPosition(450, 400), 400, "drag positions clamp at the viewport edge");

const dragBounds = { width: 640, height: 420 };
const stationaryWidget = { x: 320, y: 120, width: 160, height: 120 };
const horizontalStop = constrainPanelDragPosition(
  { x: 100, y: 120 },
  { x: 420, y: 120 },
  { width: 160, height: 120 },
  [stationaryWidget],
  dragBounds,
);
assert.ok(
  Math.abs(horizontalStop.x - 160) < 0.01 && horizontalStop.y === 120,
  "manual drag stops at a stationary widget edge instead of moving the widget",
);
const diagonalStop = constrainPanelDragPosition(
  { x: 160, y: 120 },
  { x: 300, y: 220 },
  { width: 160, height: 120 },
  [stationaryWidget],
  dragBounds,
);
assert.ok(
  Math.abs(diagonalStop.x - 160) < 0.01 && Math.abs(diagonalStop.y - 120) < 0.01,
  "diagonal collision stops at the first swept impact",
);
assert.deepEqual(
  constrainPanelDragPosition(
    { x: 160, y: 120 },
    { x: 160, y: 120 },
    { width: 160, height: 120 },
    [stationaryWidget],
    dragBounds,
  ),
  { x: 160, y: 120 },
  "touching a stationary widget edge is permitted",
);
assert.deepEqual(
  constrainPanelDragPosition({ x: 100, y: 20 }, { x: 480, y: 20 }, { width: 160, height: 120 }, [], dragBounds),
  { x: 480, y: 20 },
  "a free manual drag does not jump back to the origin",
);
assert.deepEqual(
  constrainPanelDragPosition(
    { x: 20, y: 20 },
    { x: 380, y: 20 },
    { width: 120, height: 60 },
    [{ x: 180, y: 180, width: 120, height: 60 }],
    dragBounds,
  ),
  { x: 380, y: 20 },
  "an obstacle in a separate vertical lane does not block horizontal dragging",
);
const thinDiagonalStop = constrainPanelDragPosition(
  { x: 20, y: 20 },
  { x: 500, y: 300 },
  { width: 40, height: 40 },
  [{ x: 260, y: 145, width: 4, height: 4 }],
  dragBounds,
);
assert.ok(
  thinDiagonalStop.x < 500 && thinDiagonalStop.y < 300,
  "a fast diagonal drag cannot tunnel through a thin obstacle",
);
const pinned = {
  id: "narration",
  x: 0,
  y: 0,
  width: 896,
  height: 900,
  locked: true,
  fixed: true,
  bottomInset: 16,
  priority: 0,
  setPosition: (x: number, y: number) => {
    pinned.x = x;
    pinned.y = y;
  },
  setHeightLimit: (height: number) => {
    pinned.height = height;
  },
};
resolveGamePanelLayout([pinned], { width: 1280, height: 669 });
assert.equal(pinned.y + pinned.height, 653, "bottom lock keeps its inset when content exceeds the viewport");

const stackedPositions = new Map<string, { x: number; y: number }>();
const stacked = [
  ["stack-a", 20, 20, 120, 40],
  ["stack-b", 20, 68, 120, 60],
  ["outsider", 220, 20, 120, 120],
].map(([id, x, y, width, height], priority) => ({
  id: String(id),
  x: Number(x),
  y: Number(y),
  width: Number(width),
  height: Number(height),
  stackGroup: id === "outsider" ? null : "vertical-stack",
  locked: false,
  priority,
  setPosition: (nextX: number, nextY: number) => stackedPositions.set(String(id), { x: nextX, y: nextY }),
}));
resolveGamePanelLayout(stacked, { width: 420, height: 300 });
assert.deepEqual(
  stackedPositions.get("stack-a"),
  { x: 20, y: 20 },
  "a stack keeps its stable anchor when it already fits",
);
assert.deepEqual(stackedPositions.get("stack-b"), { x: 20, y: 68 }, "stack members retain their vertical order");
assert.deepEqual(stackedPositions.get("outsider"), undefined, "a stationary outsider is not moved by a fitting stack");

const positions = new Map<string, { x: number; y: number }>();
const item = (id: string, priority: number) => ({
  id,
  x: 20,
  y: 20,
  width: 180,
  height: 120,
  locked: true,
  priority,
  setPosition: (x: number, y: number) => positions.set(id, { x, y }),
});

resolveGamePanelLayout([item("map", 0), item("health", 1), item("strain", 2)], { width: 420, height: 420 });
assert.deepEqual(positions.get("map"), undefined, "the first saved panel keeps its position");
assert.notDeepEqual(positions.get("health"), positions.get("strain"), "colliding panels receive distinct positions");
assert.ok(
  [...positions.values()].every(({ x, y }) => x >= 0 && y >= 0),
  "resolved positions stay in bounds",
);

const crowded = [
  // The map's visible content can exceed its outer max-height when overflowVisible is enabled.
  { id: "map", x: 12, y: 99, width: 320, height: 504.09, locked: true, priority: 0 },
  { id: "narration", x: 192, y: 388, width: 896, height: 315, locked: true, priority: 1 },
  { id: "presence", x: 584, y: 579, width: 320, height: 125, locked: true, priority: 2 },
].map((entry) => ({ ...entry, setPosition: (x: number, y: number) => positions.set(entry.id, { x, y }) }));
resolveGamePanelLayout(crowded, { width: 1280, height: 669 });
const resolvedCrowded = crowded.map((entry) => ({ ...entry, ...(positions.get(entry.id) ?? {}) }));
for (let index = 0; index < resolvedCrowded.length; index += 1) {
  for (let other = index + 1; other < resolvedCrowded.length; other += 1) {
    const a = resolvedCrowded[index]!;
    const b = resolvedCrowded[other]!;
    assert.ok(
      a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y,
      `${a.id} and ${b.id} remain non-overlapping in the crowded viewport`,
    );
  }
}

const desktopPanels = [
  ["map", 320, 420],
  ["narration", 896, 315],
  ["presence", 320, 125],
  ["integrity", 176, 81],
  ["channel", 176, 81],
  ["case_file", 312, 134],
  ["systems", 330, 87],
].map(([id, width, height], priority) => ({
  id: String(id),
  x: 12,
  y: 99,
  width: Number(width),
  height: Number(height),
  locked: true,
  priority,
  setPosition: (x: number, y: number) => positions.set(String(id), { x, y }),
}));
resolveGamePanelLayout(desktopPanels, { width: 1920, height: 1080 });
const resolvedDesktop = desktopPanels.map((entry) => ({ ...entry, ...(positions.get(entry.id) ?? {}) }));
for (let index = 0; index < resolvedDesktop.length; index += 1) {
  for (let other = index + 1; other < resolvedDesktop.length; other += 1) {
    const a = resolvedDesktop[index]!;
    const b = resolvedDesktop[other]!;
    assert.ok(
      a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y,
      `${a.id} and ${b.id} remain non-overlapping in the full desktop panel set`,
    );
  }
}

console.info("Game panel layout regression passed: stable saved placement and deterministic sibling separation.");

// A collision pass must be repeatable from the same saved anchors. This guards
// the reload path where observer scheduling runs the resolver more than once.
const anchorItems = [item("map", 0), item("health", 1), item("strain", 2)].map((entry) => ({
  ...entry,
  preferredX: entry.x,
  preferredY: entry.y,
}));
const firstPass = new Map<string, { x: number; y: number }>();
for (const entry of anchorItems) {
  entry.setPosition = (x: number, y: number) => {
    entry.x = x;
    entry.y = y;
  };
}
resolveGamePanelLayout(anchorItems, { width: 420, height: 420 });
for (const entry of anchorItems) firstPass.set(entry.id, { x: entry.x, y: entry.y });
const secondPass = new Map<string, { x: number; y: number }>();
for (const entry of anchorItems) {
  entry.setPosition = (x: number, y: number) => {
    entry.x = x;
    entry.y = y;
  };
}
resolveGamePanelLayout(anchorItems, { width: 420, height: 420 });
for (const entry of anchorItems) secondPass.set(entry.id, { x: entry.x, y: entry.y });
assert.deepEqual(secondPass, firstPass, "repeated layout passes keep deterministic collision positions");

const anchorReturn = [item("blocker", 0), item("returning", 1)].map((entry) => ({
  ...entry,
  preferredX: entry.x,
  preferredY: entry.y,
}));
for (const entry of anchorReturn)
  entry.setPosition = (x: number, y: number) => {
    entry.x = x;
    entry.y = y;
  };
resolveGamePanelLayout(anchorReturn, { width: 420, height: 420 });
const displacedReturn = { x: anchorReturn[1]!.x, y: anchorReturn[1]!.y };
resolveGamePanelLayout([anchorReturn[1]!], { width: 420, height: 420 });
assert.notDeepEqual(displacedReturn, { x: anchorReturn[1]!.preferredX, y: anchorReturn[1]!.preferredY });
assert.deepEqual(
  { x: anchorReturn[1]!.x, y: anchorReturn[1]!.y },
  { x: anchorReturn[1]!.preferredX, y: anchorReturn[1]!.preferredY },
  "a panel returns to its preferred anchor when the blocker disappears",
);

const largePositions = new Map<string, { x: number; y: number }>();
const largePanels = [
  ["map", 320, 504],
  ["narration", 896, 315],
  ["presence", 320, 125],
  ["integrity", 176, 81],
  ["channel", 176, 81],
  ["case_file", 312, 134],
  ["systems", 330, 87],
].map(([id, width, height], priority) => ({
  id: String(id),
  x: 12,
  y: 99,
  preferredX: 12,
  preferredY: 99,
  width: Number(width),
  height: Number(height),
  locked: true,
  priority,
  setPosition: (x: number, y: number) => largePositions.set(String(id), { x, y }),
}));
const largePasses = Array.from({ length: 5 }, () => {
  resolveGamePanelLayout(largePanels, { width: 1280, height: 669 });
  for (const entry of largePanels) {
    const position = largePositions.get(entry.id);
    if (position) {
      entry.x = position.x;
      entry.y = position.y;
    }
  }
  return largePanels.map(({ id, x, y }) => `${id}:${Math.round(x)},${Math.round(y)}`);
});
for (const pass of largePasses.slice(1))
  assert.deepEqual(pass, largePasses[0], "large HUD layout converges without oscillation");

for (const bounds of [
  { width: 2560, height: 1297 },
  { width: 1920, height: 1029 },
  { width: 1280, height: 669 },
]) {
  const measured = new Map<string, { x: number; y: number; width: number; height: number }>();
  const incident = [
    ["toolbar", 620, 34],
    ["map", 320, 420],
    ["narration", 896, 200],
    ["notes", 384, 1200],
    ["bonds", 336, 217],
    ["concubines", 448, 143],
    ["candidates", 348, 87],
    ["arrivals", 384, 149],
    ["invitations", 727, 199],
    ["presence", 320, 108],
    ["storyboard", 368, 394],
  ].map(([id, width, height], priority) => {
    const key = String(id);
    const rect = { x: 10, y: 10, width: Number(width), height: Number(height) };
    measured.set(key, rect);
    return {
      id: key,
      ...rect,
      preferredX: 10,
      preferredY: 10,
      priority,
      locked: true,
      setPosition: (x: number, y: number) => {
        rect.x = x;
        rect.y = y;
      },
      setHeightLimit: (height: number) => {
        rect.height = height;
      },
    };
  });
  assert.equal(
    resolveGamePanelLayout(incident, bounds),
    false,
    "crowded incident can fit with internal panel scrolling",
  );
  const rectangles = [...measured.values()];
  for (let i = 0; i < rectangles.length; i++) {
    const a = rectangles[i]!;
    assert.ok(a.y >= 0 && a.y + a.height <= bounds.height && a.x + a.width <= bounds.width);
    for (const b of rectangles.slice(i + 1))
      assert.ok(
        a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y,
        "internal scrolling must not hide a neighboring panel",
      );
  }
}
