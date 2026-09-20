import assert from "node:assert/strict";
import { ensureSceneCharacterCards } from "../../packages/client/src/components/game/game-scene-character-cards";

const cards = ensureSceneCharacterCards(
  {},
  [{ id: "library:mentor", name: "Elowen", avatarUrl: "/mentor.png" }],
  [
    {
      id: "library:mentor",
      name: "Elowen",
      avatarUrl: "/mentor.png",
      libraryProfile: {
        description: "Elowen library description",
        appearance: "Elowen library appearance",
        level: 12,
        rpgStats: {
          attributes: [{ name: "WIS", value: 18 }],
          hp: { value: 120, max: 120 },
          pools: [],
        },
      },
    },
  ],
  [
    {
      name: "Elowen",
      shortDescription: "Saved game sheet",
      class: "Oracle",
      abilities: ["Read omens"],
      strengths: [],
      weaknesses: [],
      extra: { faction: "The Glass Court" },
    },
  ],
  1,
);

assert.equal(cards["library:mentor"]?.title, "Elowen");
assert.equal(cards["library:mentor"]?.libraryProfile?.description, "Elowen library description");
assert.equal(cards["library:mentor"]?.level, 12);
assert.equal(cards["library:mentor"]?.gameCard?.class, "Oracle");
assert.equal(cards["library:mentor"]?.gameCard?.extra.faction, "The Glass Court");
console.log("game-scene-character-cards regression passed");
