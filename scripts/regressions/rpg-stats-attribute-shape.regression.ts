import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizePersonaStats } from "../../packages/shared/src/utils/persona-normalization.js";
import {
  formatRpgStatsForPrompt,
  normalizeRpgStatAttributes,
  normalizeRpgStatPools,
} from "../../packages/shared/src/utils/rpg-stats.js";
import { mapSheetAttributesToRPG } from "../../packages/server/src/services/game/skill-check.service.js";
import { normalizeCharacterRpgStats } from "../../packages/server/src/services/generation/character-prompt-context.js";

// Imported character cards and model output store rpgStats.attributes as a
// plain map ({ "STR": 18 }) instead of the canonical [{ name, value }] array.
// Iterating that shape with for...of / spread crashed Game Mode with
// "object is not iterable" (#Beggining-Adventure setup). Every consumer must
// go through normalizeRpgStatAttributes, which accepts both shapes.

// ── Map shape → canonical array ──
assert.deepEqual(normalizeRpgStatAttributes({ STR: 18, DEX: 10, CHA: "15" }), [
  { name: "STR", value: 18 },
  { name: "DEX", value: 10 },
  { name: "CHA", value: 15 },
]);

// ── Canonical array passes through, dropping unusable entries ──
assert.deepEqual(
  normalizeRpgStatAttributes([
    { name: "WIS", value: 16 },
    { name: " ", value: 3 },
    { name: "INT", value: "13" },
    { name: "LUK", value: "unknown" },
    null,
    "garbage",
  ]),
  [
    { name: "WIS", value: 16 },
    { name: "INT", value: 13 },
  ],
);

// ── Non-iterable garbage never throws ──
assert.deepEqual(normalizeRpgStatAttributes(null), []);
assert.deepEqual(normalizeRpgStatAttributes(undefined), []);
assert.deepEqual(normalizeRpgStatAttributes("STR 18"), []);
assert.deepEqual(normalizeRpgStatAttributes(42), []);
assert.deepEqual(normalizeRpgStatAttributes({ STR: { nested: true } }), []);

assert.deepEqual(
  normalizeRpgStatPools({
    hp: { current: 72, max: 90 },
    pools: [{ name: "Composure", current: "60", max: 100, color: "#22c55e" }],
  } as never),
  [{ name: "Composure", value: 60, max: 100, color: "#22c55e" }],
  "legacy current-valued pools must retain their actual value and canonicalize the key",
);
assert.deepEqual(
  normalizeRpgStatPools({ hp: { current: "72", max: 90 } } as never),
  [{ name: "HP", value: 72, max: 90, color: "#ef4444" }],
  "legacy current-valued HP must seed the fallback HP pool",
);

// ── Prompt formatting includes map-shaped attributes instead of dropping them ──
const prompt = formatRpgStatsForPrompt({
  enabled: true,
  attributes: { STR: 18, WIS: 16 } as never,
  hp: { value: 150, max: 150 },
});
assert.match(prompt, /STR: 18/);
assert.match(prompt, /WIS: 16/);

// ── Skill checks resolve attribute modifiers from the map shape ──
assert.deepEqual(mapSheetAttributesToRPG({ STR: 18, DEX: 10 }), { str: 18, dex: 10 });
assert.deepEqual(mapSheetAttributesToRPG([{ name: "Charisma", value: 15 }]), { cha: 15 });
assert.deepEqual(mapSheetAttributesToRPG(null), {});

// ── Character prompt context keeps map-shaped attributes ──
const normalized = normalizeCharacterRpgStats({
  enabled: true,
  attributes: { STR: 18 },
  hp: { value: 100, max: 100 },
});
assert.deepEqual(normalized?.attributes, [{ name: "STR", value: 18 }]);

const normalizedPersonaStats = normalizePersonaStats({
  enabled: true,
  bars: [],
  rpgStats: {
    enabled: true,
    attributes: { DEX: 14 },
    hp: { value: 100, max: 100 },
  },
});
assert.deepEqual(normalizedPersonaStats?.rpgStats?.attributes, [{ name: "DEX", value: 14 }]);

const currentValuedPersonaStats = normalizePersonaStats({
  enabled: true,
  bars: [],
  rpgStats: {
    enabled: true,
    attributes: { CON: 12 },
    hp: { current: "45", max: "80" },
    pools: [{ name: "Resolve", current: 30, max: 50, color: "#a78bfa" }],
  },
});
assert.deepEqual(currentValuedPersonaStats?.rpgStats?.hp, { value: 45, max: 80 });
assert.deepEqual(currentValuedPersonaStats?.rpgStats?.pools, [
  { name: "Resolve", value: 30, max: 50, color: "#a78bfa" },
]);

const gameSurfaceSource = readFileSync(
  new URL("../../packages/client/src/components/game/GameSurface.tsx", import.meta.url),
  "utf8",
);
assert.match(gameSurfaceSource, /pool\?\.value \?\? pool\?\.current/u);
assert.match(gameSurfaceSource, /cardHp\?\.value \?\? cardHp\?\.current/u);
assert.match(gameSurfaceSource, /cardRpgStats\?\.hp\?\.value \?\? cardRpgStats\?\.hp\?\.current/u);

const gameCharacterSheetSource = readFileSync(
  new URL("../../packages/client/src/components/game/GameCharacterSheet.tsx", import.meta.url),
  "utf8",
);
assert.match(gameCharacterSheetSource, /rawHp\?\.value \?\? rawHp\?\.current/u);

console.log("rpg-stats attribute shape regression passed");
