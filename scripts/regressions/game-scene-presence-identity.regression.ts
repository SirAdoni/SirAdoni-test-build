import assert from "node:assert/strict";
import { ensureSceneCharacterCards } from "../../packages/client/src/components/game/game-scene-character-cards.js";
import { resolveScenePresence } from "../../packages/client/src/components/game/game-scene-presence.js";

const resolved = resolveScenePresence(
  ["Guide One", "Guide Two", "Unlisted Keeper", "Unknown Witness", "unlisted-keeper"],
  [{ id: "stable-guide-two", name: "Guide Two" }],
  [
    { id: "library-guide-one", name: "Guide One", avatarUrl: "/guide-one.png" },
    { id: "guide-two-a", name: "Guide Two" },
    { id: "guide-two-b", name: "Guide Two" },
    { id: "unrelated", name: "Unrelated Card" },
  ],
);

assert.deepEqual(
  resolved.sceneMembers.map(({ id }) => id),
  ["library-guide-one", "stable-guide-two"],
  "unique library identities resolve, while a stable existing identity survives duplicate library names",
);
assert.deepEqual(
  resolved.sceneExtras,
  ["Unlisted Keeper", "Unknown Witness"],
  "unmatched names stay distinct and repeated spellings do not duplicate an occupant",
);
assert.deepEqual(
  resolved.scopedLibraryCandidates.map(({ id }) => id),
  ["library-guide-one"],
  "only unambiguous, present library identities enter the scene scope",
);
assert.equal(resolved.libraryAvatarLookup.get("guide one"), "/guide-one.png");

const member = [{ id: "character:mara", name: "Mara" }];
const ambiguousSceneOnlySheet = ensureSceneCharacterCards(
  {},
  member,
  [],
  [
    { name: "Mara", shortDescription: "First duplicate" },
    { name: "Mara", shortDescription: "Second duplicate" },
  ],
  4,
);
assert.equal(
  ambiguousSceneOnlySheet["character:mara"]?.gameCard,
  undefined,
  "a new scene card does not adopt either of two duplicate unlinked metadata sheets",
);

const savedSheet = ensureSceneCharacterCards(
  {},
  member,
  [],
  [{ name: "Mara", shortDescription: "Previously saved sheet" }],
  4,
);
const ambiguousSheets = ensureSceneCharacterCards(
  savedSheet,
  member,
  [],
  [
    { name: "Mara", shortDescription: "First duplicate" },
    { name: "Mara", shortDescription: "Second duplicate" },
  ],
  4,
);
assert.equal(
  ambiguousSheets["character:mara"]?.gameCard?.shortDescription,
  "Previously saved sheet",
  "duplicate unlinked metadata names do not replace an established character sheet with the first match",
);

const identityLinkedSheet = ensureSceneCharacterCards(
  {},
  [{ id: "character:mara-2", name: "Mara" }],
  [],
  [
    { id: "character:mara-1", name: "Mara", shortDescription: "Other identity" },
    { id: "character:mara-2", name: "Mara", shortDescription: "Stable identity match" },
  ],
  4,
);
assert.equal(
  identityLinkedSheet["character:mara-2"]?.gameCard?.shortDescription,
  "Stable identity match",
  "an explicit stable character id wins over duplicate metadata names",
);
