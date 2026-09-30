import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = "../packages/hierarchical-maps/src/engine/packages/client/src/";
const map = readFileSync(new URL(root + "components/game/GameWorldMap.tsx", import.meta.url), "utf8");
const icons = readFileSync(
  new URL(root + "features/spatial-context/components/SpatialLocationIcon.tsx", import.meta.url),
  "utf8",
);
const save = map.slice(map.indexOf("const savePlacement"), map.indexOf("const pending ="));
assert.match(save, /expectedRevision: definition.revision/);
assert.match(save, /expectedCurrentLocationId: spatial.currentLocationId/);
assert.match(save, /location.id === id \? \{ \.\.\.location, placement \}/);
assert.doesNotMatch(save, /replacementCurrentLocationId|setPendingSpatialTransition|queueDestination/);
assert.match(map, /setPointerCapture/);
assert.match(map, /onPointerCancel/);
assert.match(map, /snapMapCoordinate\(active.origin.x/);
assert.match(map, /snapMapCoordinate\(active.origin.y/);
assert.match(map, /onDoubleClick/);
assert.match(map, /ArrowLeft/);
assert.match(map, /clamp\(28px, 7cqw, 36px\)/);
assert.match(map, /name=\{location.name\}/);
for (const marker of map.matchAll(/<SpatialLocationIcon\b[\s\S]*?\/>/g))
  assert.match(marker[0], /name=\{/, "Every map/list/header/inspector icon must use the same semantic resolver");
assert.match(icons, /\? "tower"/);
assert.match(icons, /\? "garden"/);
assert.match(icons, /viewBox="0 0 24 24"/);
process.stdout.write("World map marker source contracts passed (not a browser interaction test).\n");
