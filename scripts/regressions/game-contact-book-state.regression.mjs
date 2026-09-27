import assert from "node:assert/strict";
import {
  contactCategoryId,
  displayOpinion,
  hasCategory,
  migrateContactState,
  removeCategoryAssignments,
  relationshipStatusKey,
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
assert.equal(displayOpinion(-100), -100, "the minimum opinion is included");
assert.equal(displayOpinion(100), 100, "the maximum opinion is included");
assert.equal(displayOpinion(-25), -25, "negative opinions remain numeric");
assert.equal(displayOpinion(undefined), null, "missing opinion remains missing for the UI to render Unknown");
assert.equal(displayOpinion(Number.NaN), null, "non-finite opinions are treated as missing");
assert.equal(displayOpinion("42"), 42, "legacy numeric strings display as numbers");
assert.equal(displayOpinion("friendly"), null, "relationship labels are not numeric opinions");
assert.equal(displayOpinion(-101), null, "opinions below the scale are missing");
assert.equal(displayOpinion(101), null, "opinions above the scale are missing");
assert.equal(displayOpinion("101"), null, "out-of-range numeric strings are missing");
assert.equal(relationshipStatusKey("friend-of"), "friendOf", "relationship predicates map to display keys");
assert.equal(relationshipStatusKey("ETERNAL-ALLY-OF"), "eternalAllyOf", "predicate matching ignores case");
assert.equal(relationshipStatusKey("current ally"), null, "unknown relationship predicates stay unknown");
console.log("game contact book state regression passed");
