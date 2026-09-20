import assert from "node:assert/strict";
import { createCharacterMatcher } from "../../packages/client/src/lib/character-references.ts";

const parts = (text: string, characters: Parameters<typeof createCharacterMatcher>[0]) =>
  createCharacterMatcher(characters)(text).filter((part) => part.character);

const rosamund = { id: "rosamund", name: "Lady Rosamund Vaux" };
const elsevere = { id: "elsevere", name: "Lady Elsevere Aldareth" };
const selene = { id: "selene", name: "Lady Selene Arden" };
assert.deepEqual(
  parts("Rosamund Vaux, Elsevere Aldareth, Selene Arden", [rosamund, elsevere, selene]).map(
    (part) => part.character?.id,
  ),
  ["rosamund", "elsevere", "selene"],
);

const plain = { id: "plain", name: "Rose Vaux" };
const titled = { id: "titled", name: "Lady Rose Vaux" };
assert.equal(parts("Rose Vaux", [plain, titled])[0]?.character?.id, "plain");
assert.equal(parts("Rose Vaux", [titled, { id: "other", name: "Lord Rose Vaux" }]).length, 0);
assert.deepEqual(parts("Lady Rosamund Vaux met at Vaux Harbor", [rosamund]).map((part) => part.character?.id), [
  "rosamund",
]);
const hyphenated = { id: "yasmine", name: "Yasmine hai-Maram" };
const apostrophe = { id: "oneil", name: "O'Neil" };
assert.deepEqual(parts("Yasmine hai-Maram spoke with O'Neil.", [hyphenated, apostrophe]).map((part) => part.character?.id), [
  "yasmine",
  "oneil",
]);
const exactName = { id: "exact", name: "Rose Vaux" };
const aliasOwner = { id: "alias", name: "Lady Rosamund Vaux", aliases: ["Rose Vaux"] };
assert.equal(parts("Rose Vaux", [aliasOwner, exactName])[0]?.character?.id, "exact");
assert.equal(parts("Rose Vaux", [exactName, aliasOwner])[0]?.character?.id, "exact");

console.info("Character reference matcher regression passed.");
