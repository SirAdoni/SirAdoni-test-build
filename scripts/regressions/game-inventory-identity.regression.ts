import assert from "node:assert/strict";
import {
  addInventoryQuantity,
  findInventoryIndex,
  renameInventoryIdentity,
  updateInventoryQuantity,
} from "../../packages/client/src/components/game/game-inventory-identity";

const items = [
  { itemId: "a", name: "Potion", quantity: 2 },
  { itemId: "b", name: "Potion", quantity: 4 },
];

assert.equal(findInventoryIndex(items, { itemId: "b", name: "Potion" }), 1);
assert.equal(findInventoryIndex(items, { name: "Potion" }), -1, "ambiguous legacy names must not select a row");
assert.deepEqual(updateInventoryQuantity(items, { itemId: "b", name: "Potion" }, -1), [
  items[0],
  { itemId: "b", name: "Potion", quantity: 3 },
]);
assert.deepEqual(renameInventoryIdentity(items, { itemId: "a", name: "Potion" }, "Elixir")?.items, [
  { itemId: "a", name: "Elixir", quantity: 2 },
  items[1],
]);
assert.deepEqual(addInventoryQuantity(items, "Potion", 1), [
  ...items,
  { name: "Potion", quantity: 1 },
], "ambiguous add must not merge distinct identified rows or mint an ID");
assert.deepEqual(addInventoryQuantity([items[0]!], "Potion", 1), [
  { itemId: "a", name: "Potion", quantity: 3 },
]);

const legacy = [
  { name: "Sword", quantity: 1 },
  { name: "Potion", quantity: 2 },
];
assert.deepEqual(
  renameInventoryIdentity(legacy, { name: "Sword" }, "Potion"),
  { items: [{ name: "Potion", quantity: 3 }], resolvedName: "Potion" },
  "renaming an id-less row onto an existing name merges like before",
);
assert.deepEqual(
  renameInventoryIdentity(
    [
      { name: "Sword", quantity: 1, description: "Rusty blade", location: "backpack" },
      { name: "Potion", quantity: 2, description: "", location: "belt" },
    ],
    { name: "Sword" },
    "Potion",
  ),
  {
    items: [{ name: "Potion", quantity: 3, description: "Rusty blade", location: "belt" }],
    resolvedName: "Potion",
  },
  "a merge keeps the source description and location when the target has none",
);
const legacyDuplicates = [
  { name: "Potion", quantity: 2 },
  { name: "Potion", quantity: 1 },
];
assert.equal(findInventoryIndex(legacyDuplicates, { name: "Potion" }), 0, "id-less duplicates use the first row");
assert.deepEqual(updateInventoryQuantity(legacyDuplicates, { name: "Potion" }, -1), [
  { name: "Potion", quantity: 1 },
  legacyDuplicates[1],
]);
assert.deepEqual(addInventoryQuantity(legacyDuplicates, "Potion", 1), [
  { name: "Potion", quantity: 3 },
  legacyDuplicates[1],
]);
console.log("game inventory identity regression: ok");
