import assert from "node:assert/strict";
import { normalizeRpgStatAttributes } from "../../packages/shared/src/utils/rpg-stats.js";
import { overlayGameSceneCharacterCard } from "../../packages/client/src/components/game/game-scene-character-cards.js";
import {
  findSavedGameCharacterProfile,
  normalizeSavedGameCharacterProfile,
} from "../../packages/client/src/lib/game-character-profile.js";

const savedCards = [
  { id: "elodie-1", name: "Élodie", description: "First profile" },
  { id: "elodie-2", name: "Elodie", description: "Second profile" },
  { id: "yamada", name: "山田 太郎", backstory: "京都で生まれた。" },
];

assert.equal(
  findSavedGameCharacterProfile(savedCards, "elodie-2", "Élodie")?.id,
  "elodie-2",
  "a stable ID selects its saved profile even when another card has the same normalized name",
);
assert.equal(
  findSavedGameCharacterProfile(savedCards, "missing-id", "Élodie"),
  undefined,
  "a missing stable ID must not fall back to a same-name card",
);
assert.equal(
  findSavedGameCharacterProfile([{ name: "Élodie" }], undefined, "Elodie")?.name,
  "Élodie",
  "legacy name-only cards match accents through the existing Unicode-aware name helper",
);
assert.equal(
  findSavedGameCharacterProfile([{ name: "山田 太郎" }], undefined, "山田 太郎")?.name,
  "山田 太郎",
  "legacy name-only cards retain non-Latin character matching",
);
assert.equal(
  findSavedGameCharacterProfile([{ name: "Élodie" }, { name: "Elodie" }], undefined, "Elodie"),
  undefined,
  "ambiguous name-only matches remain unresolved",
);

const originalSceneCard = {
  title: "Old scene title",
  subtitle: "Old outfit",
  status: "Old scene status",
  avatarUrl: "/saved-avatar.png",
  stats: [{ name: "Courage", value: 1 }],
  inventory: [{ name: "Key", quantity: 1 }],
};
const originalSceneSnapshot = {
  name: "Current scene name",
  outfit: "Current outfit",
  thoughts: "Current thoughts",
  avatarPath: null,
  stats: [{ name: "Courage", value: 8 }],
};
const clearedCard = overlayGameSceneCharacterCard(originalSceneCard, originalSceneSnapshot, null);
assert.equal(clearedCard.avatarUrl, null, "an explicit scene avatar clear takes precedence over a saved default");
assert.equal(clearedCard.title, "Current scene name", "the current scene title stays authoritative");
assert.equal(clearedCard.subtitle, "Current outfit", "the current scene outfit stays authoritative");
assert.equal(clearedCard.status, "Current thoughts", "the current scene status stays authoritative");
assert.equal(clearedCard.stats?.[0]?.value, 8, "current scene stats stay authoritative");
assert.equal(clearedCard.inventory, originalSceneCard.inventory, "unrelated current game fields are preserved");
assert.equal(originalSceneCard.avatarUrl, "/saved-avatar.png", "scene enrichment does not mutate its input");
assert.equal(originalSceneSnapshot.avatarPath, null, "scene snapshot data is not mutated");

const legacyCard = overlayGameSceneCharacterCard(
  { title: "Scene-only card", avatarUrl: "/safe-saved-default.png" },
  { name: "Scene-only card" },
  undefined,
);
assert.equal(
  legacyCard.avatarUrl,
  "/safe-saved-default.png",
  "a missing avatar field may use its existing saved default",
);

assert.deepEqual(
  normalizeSavedGameCharacterProfile({
    id: "yamada",
    name: "山田 太郎",
    description: "  Scholar  ",
    tags: ["  mage ", "", "archivist"],
  }),
  { description: "Scholar", tags: ["mage", "archivist"] },
  "profile normalization trims usable values without changing the source card",
);
assert.deepEqual(
  normalizeRpgStatAttributes([{ name: " Strength ", value: "-2" }, { name: "", value: 3 }, null]),
  [{ name: "Strength", value: -2 }],
  "RPG profile attribute normalization keeps valid signed numbers and removes malformed entries",
);

console.info("Game scene character card regressions passed.");
