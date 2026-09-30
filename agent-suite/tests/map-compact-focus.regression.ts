import assert from "node:assert/strict";
import { getCompactMapLocations } from "../packages/hierarchical-maps/src/engine/packages/client/src/components/game/compact-map-layout.ts";

const ashlineCorridor = { id: "ashline", parentId: null, links: [] };
const mainHall = {
  id: "main-hall",
  parentId: null,
  links: [{ targetId: "principal-suite", bidirectional: true, state: "available" }],
};
const principalSuite = {
  id: "principal-suite",
  parentId: "orynath",
  links: [{ targetId: "main-hall", bidirectional: true, state: "available" }],
};
const roots = [ashlineCorridor, mainHall];
const activeLocations = [ashlineCorridor, mainHall, principalSuite];

assert.deepEqual(
  getCompactMapLocations(activeLocations, roots, "main-hall", null, false).map((location) => location.id),
  ["ashline", "main-hall"],
  "A cross-branch link must not leak Principal Suite into the World root view.",
);
assert.deepEqual(
  getCompactMapLocations(activeLocations, roots, "principal-suite", null, false).map((location) => location.id),
  ["ashline", "main-hall"],
  "World view must show roots even when the current story location is nested.",
);
assert.deepEqual(
  getCompactMapLocations(activeLocations, roots, "main-hall", null, true).map((location) => location.id),
  ["ashline", "main-hall"],
  "All must expose every location in the current view scope.",
);

const estateChildren = [principalSuite];
assert.deepEqual(
  getCompactMapLocations(activeLocations, estateChildren, "principal-suite", "orynath", false).map(
    (location) => location.id,
  ),
  ["principal-suite"],
  "A non-root compact view must retain its current location and scoped navigation.",
);
assert.deepEqual(
  getCompactMapLocations(activeLocations, estateChildren, "unrelated-current", "orynath", false).map(
    (location) => location.id,
  ),
  ["principal-suite"],
  "An unrelated current location must not be injected into the viewed branch.",
);
assert.deepEqual(
  getCompactMapLocations(
    [...activeLocations, { id: "orynath", parentId: null, links: [] }],
    estateChildren,
    "orynath",
    "orynath",
    false,
  ).map((location) => location.id),
  ["principal-suite", "orynath"],
  "Browsing a container keeps the viewed container and its visible children together.",
);

console.log("Compact World-map focus regression passed.");
