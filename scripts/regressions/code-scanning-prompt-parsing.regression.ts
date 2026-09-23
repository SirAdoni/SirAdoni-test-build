import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import {
  unwrapConversationInstructions,
  wrapConversationInstructions,
} from "../../packages/shared/src/constants/conversation-prompt.js";
import { unwrapGameInstructions, wrapGameInstructions } from "../../packages/shared/src/constants/game-prompt.js";
import {
  mergeNegativePrompt,
  mergePromptPrefix,
} from "../../packages/shared/src/constants/image-generation-defaults.js";
import { filterPromptMessagesForCharacterAudience } from "../../packages/server/src/services/generation/prompt-message-scope.js";

assert.equal(
  unwrapConversationInstructions('  <InStructions mode="conversation">\n  Stay curious.  \n</INSTRUCTIONS>  '),
  "Stay curious.",
  "conversation instructions should preserve case-insensitive envelopes with attributes",
);
assert.equal(
  unwrapGameInstructions("<instructions\nmode=game>\nAdvance the scene.\n</instructions>"),
  "Advance the scene.",
  "game instructions should preserve multiline opening-tag attributes",
);
assert.equal(
  unwrapConversationInstructions("<instructionsx>Leave this untouched.</instructions>"),
  "<instructionsx>Leave this untouched.</instructions>",
  "instruction-like prefixes must not be mistaken for an envelope",
);
assert.equal(wrapConversationInstructions("<instructions></instructions>"), "<instructions></instructions>");
assert.equal(unwrapConversationInstructions("<instructions></instructions>"), "");
assert.equal(unwrapGameInstructions("<instructions></instructions>"), "");
assert.equal(wrapGameInstructions("<instructions></instructions>"), "<instructions></instructions>");
assert.equal(
  wrapGameInstructions("<instructions priority=high>Keep moving.</instructions>"),
  "<instructions>\nKeep moving.\n</instructions>",
);

const nestedHistory = [
  {
    role: "user" as const,
    content: "<chat_history>\n<last_message>\nVisible setup\n</last_message>\n</chat_history>",
    contextKind: "history" as const,
  },
  {
    role: "assistant" as const,
    content: "<last_message>\nPrivate clue\n</last_message>",
    contextKind: "history" as const,
    hiddenFromAICharacterIds: ["pantalone"],
  },
];
assert.deepEqual(
  filterPromptMessagesForCharacterAudience(nestedHistory, ["pantalone"]).map((message) => message.content),
  ["<last_message>\nVisible setup\n</last_message>"],
  "nested legacy history wrappers should still be stripped before wrapper repair",
);

assert.equal(mergePromptPrefix("cinematic\t\t,;. ", "portrait"), "cinematic, portrait");
assert.equal(mergeNegativePrompt("blurry\t\t,;. ", "noise"), "blurry, noise");
assert.equal(
  mergePromptPrefix("(cinematic: 1.2)", "cinematic, portrait"),
  "cinematic, portrait",
  "weighted bracketed prefixes should still be recognized as already present",
);
assert.equal(
  mergePromptPrefix("(line one\nline two: 1.2)", "line one line two"),
  "(line one\nline two: 1.2), line one line two",
  "multiline bracket fragments should preserve their legacy non-unwrapped behavior",
);

const repeatedWhitespace = " ".repeat(50_000);
const repeatedNewlines = "\n".repeat(50_000);
const startedAt = performance.now();
assert.equal(
  unwrapConversationInstructions(
    `<instructions>${repeatedWhitespace}Conversation body${repeatedWhitespace}</instructions>`,
  ),
  "Conversation body",
);
assert.equal(
  unwrapGameInstructions(
    `<instructions data-kind="game">${repeatedWhitespace}Game body${repeatedWhitespace}</instructions>`,
  ),
  "Game body",
);
assert.deepEqual(
  filterPromptMessagesForCharacterAudience(
    [
      {
        role: "user",
        content: `${repeatedNewlines}<CHAT_HISTORY>${repeatedNewlines}Visible${repeatedNewlines}</CHAT_HISTORY>${repeatedNewlines}`,
        contextKind: "history",
      },
      {
        role: "assistant",
        content: "<last_message>Hidden</last_message>",
        contextKind: "history",
        hiddenFromAICharacterIds: ["pantalone"],
      },
    ],
    ["pantalone"],
  ).map((message) => message.content),
  ["<last_message>\nVisible\n</last_message>"],
);
assert.equal(mergePromptPrefix(`cinematic${"\t".repeat(100_000)},;.`, "portrait"), "cinematic, portrait");
assert.equal(mergePromptPrefix(`(a${repeatedWhitespace})`, "a"), "a");
assert.ok(performance.now() - startedAt < 2_000, "large prompt wrappers and prefixes should be parsed in linear time");

process.stdout.write("Code-scanning prompt parsing regression passed.\n");
