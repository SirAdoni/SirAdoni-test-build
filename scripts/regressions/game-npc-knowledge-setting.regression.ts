import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const drawerSource = readFileSync(
  join(repositoryRoot, "packages/client/src/components/chat/ChatSettingsDrawer.tsx"),
  "utf8",
);
const chatTypesSource = readFileSync(join(repositoryRoot, "packages/shared/src/types/chat.ts"), "utf8");
const englishCatalog = JSON.parse(
  readFileSync(join(repositoryRoot, "packages/client/src/localization/locales/en.json"), "utf8"),
) as Record<string, unknown>;

assert.match(chatTypesSource, /gameNpcKnowledgeMode\?: "legacy" \| "isolated"/u);
assert.match(drawerSource, /metadata\.gameNpcKnowledgeMode === "isolated" \? "isolated" : "legacy"/u);
assert.match(drawerSource, /gameNpcKnowledgeMode: event\.target\.value === "isolated" \? "isolated" : "legacy"/u);
assert.match(drawerSource, /ui\.chat\.chatsettingsdrawer\.characterKnowledge/u);
assert.match(
  drawerSource,
  /\{isGame && \([\s\S]*?characterKnowledge[\s\S]*?\)\}\s*\{availableAgents\.length === 0 \?/u,
  "Game knowledge setting must render before the available-agent empty state",
);

for (const key of [
  "ui.chat.chatsettingsdrawer.characterKnowledge",
  "ui.chat.chatsettingsdrawer.characterKnowledgeSeparateCharacterReplies",
  "ui.chat.chatsettingsdrawer.characterKnowledgeSeparateCharacterRepliesHelp",
  "ui.chat.chatsettingsdrawer.characterKnowledgeSharedGmDialogue",
]) {
  assert.equal(typeof englishCatalog[key], "string", `Missing English catalog entry: ${key}`);
}

console.info("Game NPC knowledge setting regression passed.");
