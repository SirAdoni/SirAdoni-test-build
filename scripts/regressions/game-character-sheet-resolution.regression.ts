import assert from "node:assert/strict";
import {
  ensureSceneCharacterCards,
  resolveCharacterSheetCard,
} from "../../packages/client/src/components/game/game-scene-character-cards";

const libraryProfile = { description: "Brina profile", personality: "Precise", level: 7 };

const card = resolveCharacterSheetCard(
  {},
  "character-brina",
  [{ id: "character-brina", name: "Brina Holt", avatarUrl: null, libraryProfile }],
  [],
  1,
);

assert.equal(card?.title, "Brina Holt", "off-scene library contacts still resolve a profile card");
assert.deepEqual(card?.libraryProfile, libraryProfile, "library profile fields are preserved");

const sceneCards = {
  "npc:brina-holt": { title: "Brina Holt" },
};
const before = structuredClone(sceneCards);
const duplicate = resolveCharacterSheetCard(
  sceneCards,
  "character-brina",
  [{ id: "character-brina", name: "Brina Holt", avatarUrl: null, libraryProfile }],
  [],
  1,
);
assert.equal(duplicate?.title, "Brina Holt", "same-name library IDs resolve through an NPC alias");
assert.deepEqual(duplicate?.libraryProfile, libraryProfile, "alias resolution keeps the library profile");
assert.deepEqual(sceneCards, before, "profile lookup does not mutate scene cards");

const bareExisting = {
  "npc:warden": { title: "Caden Vale", avatarUrl: "/legacy-warden.png" },
};
const bareBefore = structuredClone(bareExisting);
const cadenceProfile = { description: "Caden description", personality: "Caden personality", level: 9 };
const enriched = ensureSceneCharacterCards(
  bareExisting,
  [{ id: "npc:warden", name: "Caden Vale", avatarUrl: "/scene-warden.png" }],
  [
    {
      id: "fixture-caden-profile",
      name: "Caden Vale",
      avatarUrl: "/canonical-warden.png",
      libraryProfile: cadenceProfile,
    },
  ],
  [],
  1,
);
assert.equal(
  enriched["npc:warden"]?.libraryProfile?.description,
  "Caden description",
  "bare NPC cards gain the canonical profile",
);
assert.equal(enriched["npc:warden"]?.avatarUrl, "/legacy-warden.png", "existing portrait remains the first fallback");
assert.deepEqual(bareExisting, bareBefore, "enrichment does not mutate existing cards");

const dynamicExisting = {
  "npc:warden": {
    title: "Caden Vale",
    gameCard: {
      shortDescription: "Live scene state",
      class: "Warden",
      abilities: ["Parry"],
      strengths: [],
      weaknesses: [],
      extra: { wound: "shoulder" },
    },
  },
};
const dynamic = ensureSceneCharacterCards(
  dynamicExisting,
  [{ id: "npc:warden", name: "Caden Vale" }],
  [{ id: "fixture-caden-profile", name: "Caden Vale", libraryProfile: cadenceProfile }],
  [{ name: "Caden Vale", class: "Library class", abilities: ["Wrong overwrite"] }],
  1,
);
assert.equal(dynamic["npc:warden"]?.gameCard?.class, "Warden", "populated dynamic game data wins over library data");

const duplicateName = resolveCharacterSheetCard(
  { "npc:warden-a": { title: "Caden Vale" } },
  "npc:warden-b",
  [
    { id: "library:a", name: "Caden Vale", libraryProfile: { description: "A" } },
    { id: "library:b", name: "Caden Vale", libraryProfile: { description: "B" } },
  ],
  [],
  1,
);
assert.equal(duplicateName, undefined, "ambiguous duplicate full names do not guess a library actor");

const aliasCards = ensureSceneCharacterCards(
  { "library:existing": { title: "Elowen" } },
  [{ id: "npc:mentor", name: "Elowen" }],
  [{ id: "library:mentor", name: "Elowen", libraryProfile }],
  [],
  1,
);
assert.ok(aliasCards["npc:mentor"], "a requested ID is retained even when the title exists under another ID");

assert.equal(
  resolveCharacterSheetCard({}, "missing", [{ id: "character-brina", name: "Brina Holt" }], [], 1),
  undefined,
  "unknown IDs remain unresolved",
);

console.log("game-character-sheet-resolution regression passed");
