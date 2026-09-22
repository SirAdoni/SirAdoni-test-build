import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Memory settings block and continuity panel wiring: static checks for the client components and locale keys.
// The server contracts are proven by the continuity and campaign-memory regressions.
const read = (path: string) => readFileSync(new URL(`../../packages/client/src/${path}`, import.meta.url), "utf8");
const surface = read("components/game/GameSurface.tsx");
const history = read("components/game/GameSessionHistory.tsx");
const panel = read("components/game/GameContinuityPanel.tsx");
const settings = read("components/game/GameMemorySettings.tsx");
const locale = JSON.parse(read("localization/locales/en.json")) as Record<string, string>;

// The panel only renders when the session history knows its chat; without chatId it silently disappears.
assert.match(
  history,
  /\{chatId && <GameContinuityPanel chatId=\{chatId\} metadata=\{chatMetadata\} \/>\}/,
  "history hosts the panel",
);
assert.match(
  surface,
  /<GameSessionHistory\s+chatId=\{activeChatId\}\s+chatMetadata=\{/,
  "game surface passes chatId to history",
);

assert.match(
  panel,
  /<GameMemorySettings[\s\S]*ownership=\{status\.data\?\.config\?\.ownership \?\? null\}/,
  "panel renders the memory block",
);
assert.match(panel, /status\.data\?\.connectionAvailable === false/, "missing connection pauses the headline");

assert.match(
  settings,
  /api\.patch\(`\/game\/\$\{chatId\}\/continuity`, \{ ownership: next \}\)/,
  "Keeper switch patches continuity ownership",
);
assert.match(
  settings,
  /\{ lorebook: "continuity", fromSession: sessionNumber \}/,
  "hand-off starts at the current session",
);
assert.match(
  settings,
  /gamePromptRecentSessionLimit: event\.target\.value \? Number\(event\.target\.value\) : null/,
  "recap limit clears to all",
);
assert.match(settings, /patchMeta\(\{ gameCampaignMemoryScope: next \}\)/, "scope is chat metadata");
assert.match(settings, /gameCampaignMemoryMaxCharacters: null/, "empty budget clears to the default");
assert.match(settings, /Math\.min\(MAX_BUDGET, Math\.max\(MIN_BUDGET/, "budget is clamped");

for (const key of [
  "ui.game.memorySettings.title",
  "ui.game.memorySettings.keeperLabel",
  "ui.game.memorySettings.recapsLabel",
  "ui.game.memorySettings.recapsLast",
  "ui.game.memorySettings.scopeLabel",
  "ui.game.memorySettings.budgetLabel",
  "ui.game.memorySettings.saveFailed",
]) {
  assert.equal(typeof locale[key], "string", `${key} is localized`);
}

console.log("game-memory-settings-ui regression passed");
