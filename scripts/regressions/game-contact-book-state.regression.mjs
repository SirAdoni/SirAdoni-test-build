import assert from "node:assert/strict";
import {
  contactCategoryId,
  displayOpinion,
  hasCategory,
  migrateContactState,
  removeCategoryAssignments,
} from "../../packages/client/src/components/game/game-contact-book-state.ts";

const migrated = migrateContactState(
  { alice: ["Staff"], bob: ["friends-2"] },
  [
    { id: "staff", name: "Staff" },
    { id: "friends", name: "Friends" },
    { id: "friends-2", name: "Close friends", parentId: "friends" },
  ],
  { staff: "Staff", friends: "Friends", enemies: "Enemies" },
);
assert.equal(migrated.groups.alice?.[0], "staff", "legacy named assignments migrate to category ids");
assert.equal(migrated.groups.bob?.[0], "friends-2", "persisted renamed category ids remain stable on reload");
assert.equal(
  hasCategory("friends-2", "friends", migrated.categories),
  true,
  "nested category filtering includes descendants",
);
const deleted = removeCategoryAssignments("friends", migrated.categories, migrated.groups);
assert.equal(
  deleted.categories.some((category) => category.id === "friends-2"),
  false,
  "deleting a parent removes its child category",
);
assert.equal(deleted.groups.bob?.length, 0, "deleting a category unassigns contacts without deleting them");
assert.equal(contactCategoryId("Friends", new Set(["friends"])), "friends-2", "new names receive collision-safe ids");
assert.deepEqual(migrateContactState({}, [], {}).categories, [], "an intentionally empty category list stays empty");
assert.equal(displayOpinion(0), 0, "numeric zero is a valid opinion value");
assert.equal(displayOpinion(-25), -25, "negative opinions remain numeric");
assert.equal(displayOpinion(undefined), null, "missing opinion remains missing for the UI to render Unknown");
assert.equal(displayOpinion(Number.NaN), null, "non-finite opinions are treated as missing");
assert.equal(displayOpinion("42"), 42, "legacy numeric strings display as numbers");
assert.equal(displayOpinion("friendly"), null, "relationship labels are not numeric opinions");
console.log("game contact book state regression passed");
