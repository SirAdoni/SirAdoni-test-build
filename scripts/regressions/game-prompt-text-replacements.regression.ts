import assert from "node:assert/strict";
import {
  parseGamePromptTextReplacements,
  replaceGamePromptText,
} from "../../packages/server/src/services/game/game-prompt-text-replacements.js";
import { buildGameSpecialInstructionsPrompt } from "../../packages/server/src/services/game/gm-prompts.js";
import {
  appendGameGmCampaignMemory,
  GAME_GM_CAMPAIGN_MEMORY_PRECEDENCE,
} from "../../packages/server/src/services/generation/game-gm-prompt-runtime.js";

const original = "- Narration: text - 1-4 sentences per beat, blank line between beats.";
const changed = "- Narration: text - any length needed for this scene.";
const rules = parseGamePromptTextReplacements([{ find: original, replace: changed }]);
assert.deepEqual(rules, [{ find: original, replace: changed }]);
assert.ok(rules);

assert.equal(replaceGamePromptText(`GM rules\n${original}`, rules), `GM rules\n${changed}`);
assert.equal(replaceGamePromptText(original, rules), changed, "separately supplied cache seal uses the same edit");

assert.equal(
  replaceGamePromptText("A literal dollar stays literal", [{ find: "literal dollar", replace: "$&" }]),
  "A $& stays literal",
);
assert.equal(
  replaceGamePromptText(original, [{ find: original, replace: "" }]),
  "",
  "empty replacement removes a rule",
);
assert.equal(replaceGamePromptText("<roll>", [{ find: "<roll>", replace: "<check>" }]), "<check>");
assert.equal(
  replaceGamePromptText("original", [
    { find: "original", replace: "intermediate" },
    { find: "intermediate", replace: "final" },
  ]),
  "intermediate",
  "a replacement must not match another rule in the same pass",
);
assert.equal(parseGamePromptTextReplacements([{ find: "no", replace: "x" }]), null);
assert.equal(
  parseGamePromptTextReplacements([
    { find: original, replace: changed },
    { find: original, replace: "x" },
  ]),
  null,
);
assert.equal(parseGamePromptTextReplacements([{ find: original, replace: 1 }]), null);

const authorityPhrase = "authoritative for this game";
const specialText = `Keep the phrase ${authorityPhrase} in the player's own note.`;
const specialPrompt = buildGameSpecialInstructionsPrompt(specialText, [
  { find: authorityPhrase, replace: "configurable for this game" },
]);
assert.ok(specialPrompt.includes(specialText), "user-authored Extra Instructions must remain exact");
assert.ok(specialPrompt.includes("configurable for this game"), "the built-in authority wrapper is editable");

const memoryMessages: Parameters<typeof appendGameGmCampaignMemory>[0] = [];
appendGameGmCampaignMemory(
  memoryMessages,
  {
    text: `A recorded quotation: ${GAME_GM_CAMPAIGN_MEMORY_PRECEDENCE}`,
    includedIds: [],
    exclusions: [],
  },
  [{ find: GAME_GM_CAMPAIGN_MEMORY_PRECEDENCE, replace: "Use the revised campaign-memory precedence." }],
);
assert.ok(memoryMessages[0]?.content.includes("Use the revised campaign-memory precedence."));
assert.ok(
  memoryMessages[0]?.content.includes(`A recorded quotation: ${GAME_GM_CAMPAIGN_MEMORY_PRECEDENCE}`),
  "campaign records must not be rewritten while editing the surrounding instruction",
);

console.log("Game prompt text replacement regression passed.");
