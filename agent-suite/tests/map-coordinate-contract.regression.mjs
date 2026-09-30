import assert from "node:assert/strict";
import { spatialLocationPlacementSchema } from "../sources/engine/packages/shared/dist/schemas/spatial-context.schema.js";
// The package bundles this vendored contract, not the live Engine schema.
for (const position of [
  { x: -200, y: 250 },
  { x: 100000, y: -100000 },
])
  assert.deepEqual(spatialLocationPlacementSchema.parse(position), position);
for (const x of [NaN, Infinity, Number.MAX_VALUE])
  assert.equal(spatialLocationPlacementSchema.safeParse({ x, y: 0 }).success, false);
console.log("Vendored package coordinate contract accepts extended maps and rejects invalid numbers.");
