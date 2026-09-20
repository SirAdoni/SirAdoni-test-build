import assert from "node:assert/strict";
import {
  spatialLocationPlacementSchema,
  spatialLocationSchema,
} from "../../packages/shared/dist/schemas/spatial-context.schema.js";
for (const placement of [
  { x: -150, y: 250 },
  { x: 100000, y: -100000 },
  { x: 32.5, y: 41 },
]) {
  assert.deepEqual(spatialLocationPlacementSchema.parse(placement), placement);
}
for (const x of [NaN, Infinity, -Infinity, Number.MAX_VALUE])
  assert.equal(spatialLocationPlacementSchema.safeParse({ x, y: 0 }).success, false);
const location = {
  id: "fixture",
  parentId: null,
  name: "Fixture",
  kind: "room",
  description: "",
  placement: { x: -150, y: 250 },
};
assert.equal(spatialLocationSchema.safeParse(location).success, true);
assert.equal(spatialLocationSchema.safeParse({ ...location, mapBackgroundPosition: { x: -1, y: 50 } }).success, false);
console.log(
  "Unbounded map placements preserve legacy decimals and reject invalid numbers; artwork focal points stay bounded.",
);
