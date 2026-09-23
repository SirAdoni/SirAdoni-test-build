import assert from "node:assert/strict";
import { createCharacterMatcher } from "../../packages/client/src/lib/character-references.ts";

const parts = (text: string, characters: Parameters<typeof createCharacterMatcher>[0]) =>
  createCharacterMatcher(characters)(text).filter((part) => part.character);

const gwenllian = { id: "gwenllian", name: "Lady Gwenllian Galloway" };
const ismene = { id: "ismene", name: "Lady Ismene Varrow" };
const selene = { id: "selene", name: "Lady Selene Arden" };
assert.deepEqual(
  parts("Gwenllian Galloway, Ismene Varrow, Selene Arden", [gwenllian, ismene, selene]).map(
    (part) => part.character?.id,
  ),
  ["gwenllian", "ismene", "selene"],
);

const plain = { id: "plain", name: "Rose Galloway" };
const titled = { id: "titled", name: "Lady Rose Galloway" };
assert.equal(parts("Rose Galloway", [plain, titled])[0]?.character?.id, "plain");
assert.equal(parts("Rose Galloway", [titled, { id: "other", name: "Lord Rose Galloway" }]).length, 0);
assert.deepEqual(parts("Lady Gwenllian Galloway met at Galloway Harbor", [gwenllian]).map((part) => part.character?.id), [
  "gwenllian",
]);
const hyphenated = { id: "soraya", name: "Soraya al-Tamar" };
const apostrophe = { id: "oneil", name: "O'Neil" };
assert.deepEqual(parts("Soraya al-Tamar spoke with O'Neil.", [hyphenated, apostrophe]).map((part) => part.character?.id), [
  "soraya",
  "oneil",
]);
const exactName = { id: "exact", name: "Rose Galloway" };
const aliasOwner = { id: "alias", name: "Lady Gwenllian Galloway", aliases: ["Rose Galloway"] };
assert.equal(parts("Rose Galloway", [aliasOwner, exactName])[0]?.character?.id, "exact");
assert.equal(parts("Rose Galloway", [exactName, aliasOwner])[0]?.character?.id, "exact");

console.info("Character reference matcher regression passed.");
