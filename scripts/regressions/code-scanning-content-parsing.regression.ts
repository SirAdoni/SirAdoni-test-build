import assert from "node:assert/strict";
import { normalizeCardAssetImageSyntax } from "../../packages/client/src/lib/card-asset-links.js";
import {
  decodeAstroPropsAttribute,
  extractJannyAstroCharacterProps,
} from "../../packages/server/src/routes/bot-browser-janny.routes.js";
import { parseLorebookWriteApprovalText } from "../../packages/server/src/routes/generate/agent-write-approval.js";
import { dedupeLastMessageWrappers } from "../../packages/server/src/routes/generate/generate-route-utils.js";
import { buildImpersonateInstruction } from "../../packages/server/src/services/conversation/impersonate-prompt.js";
import { applySegmentEdits, stripGmCommandTags } from "../../packages/server/src/services/game/segment-edits.js";
import { parseTrustedTimestamp } from "../../packages/server/src/services/import/import-timestamps.js";
import { extractSetvarAssignments } from "../../packages/server/src/services/import/st-prompt.importer.js";
import { stripGenerationGuideInstruction } from "../../packages/shared/src/utils/generation-guide.js";
import { resolveMacros, stripMacroComments } from "../../packages/shared/src/utils/macro-engine.js";
import { sanitizeFolderSegment } from "../../packages/shared/src/features/folder-packages/manifest-package.js";
import {
  decodeEncodedSpeakerTags,
  groupConsecutiveSegments,
  parseSpeakerTags,
} from "../../packages/shared/src/utils/speaker-segments.js";

assert.deepEqual(extractSetvarAssignments("{{setvar::mode::gm}} {{SETVAR::tone::warm}}"), [
  ["mode", "gm"],
  ["tone", "warm"],
]);
assert.deepEqual(extractSetvarAssignments("İ {{SETVAR::mode::gm}}"), [["mode", "gm"]]);
assert.equal(extractSetvarAssignments("{{setvar::0::".repeat(20_000) + "value}}").length, 1);
assert.deepEqual(extractSetvarAssignments("{{setvar::broken::{{setvar::mode::gm}}"), [["mode", "gm"]]);

assert.ok(parseTrustedTimestamp(`2024-01-02${" ".repeat(50_000)}@ 03h 04m 05s`));

assert.equal(
  normalizeCardAssetImageSyntax("(portrait)[card://self/gallery/a.png]"),
  "![portrait](card://self/gallery/a.png)",
);
assert.equal(
  normalizeCardAssetImageSyntax("(portrait\rvariant)[card://self/gallery/a.png]"),
  "![portrait variant](card://self/gallery/a.png)",
);
assert.equal(normalizeCardAssetImageSyntax("(portrait)[card://]"), "(portrait)[card://]");

assert.equal(
  extractJannyAstroCharacterProps(
    `${"<astro-island data-x=\"x\"></astro-island>".repeat(20_000)}<astro-island props=\"wanted\" component-export=\"CharacterButtons\"></astro-island>`,
  ),
  "wanted",
);
assert.equal(extractJannyAstroCharacterProps('<astro-island props="character fallback"></astro-island>'), "character fallback");
assert.equal(
  extractJannyAstroCharacterProps(
    '<astro-island data-props="stale" props="wanted" component-export="CharacterButtons"></astro-island>',
  ),
  "wanted",
);
assert.equal(decodeAstroPropsAttribute("&quot;x&amp;y&quot;"), '"x&y"');
assert.equal(decodeAstroPropsAttribute("&amp;quot;"), "&quot;");
const nestedAlt = "(".repeat(50_000) + "portrait)[card://self/gallery/a.png]";
assert.equal(normalizeCardAssetImageSyntax(nestedAlt).endsWith("portrait](card://self/gallery/a.png)"), true);

const approval = parseLorebookWriteApprovalText(
  `<!-- marinara:lorebook-entry:v1 -->\n### ${" ".repeat(50_000)}Entry\nKeys: one, two\nTag: lore\n\nBody`,
);
assert.equal(approval[0]?.name, "Entry");
assert.deepEqual(approval[0]?.keys, ["one", "two"]);
assert.deepEqual(parseLorebookWriteApprovalText("### Heading only\nBody text"), [
  { action: "append", name: "Heading only", content: "Body text", keys: [], tag: "" },
]);
assert.deepEqual(parseLorebookWriteApprovalText("### Keys only\nKeys: one, two\n\nBody text"), [
  { action: "append", name: "Keys only", content: "Body text", keys: ["one", "two"], tag: "" },
]);
assert.deepEqual(
  parseLorebookWriteApprovalText("### First\nFirst body\n\n### Second\nKeys: two\n\nSecond body"),
  [
    { action: "append", name: "First", content: "First body", keys: [], tag: "" },
    { action: "append", name: "Second", content: "Second body", keys: ["two"], tag: "" },
  ],
);

const wrappedMessages = [
  { content: `${"\n".repeat(50_000)}  ## Last Message  \nOld` },
  { content: "## Last Message\nCurrent" },
];
dedupeLastMessageWrappers(wrappedMessages);
assert.equal(wrappedMessages[0]?.content, "Old");
assert.equal(wrappedMessages[1]?.content, "## Last Message\nCurrent");
const standaloneHeading = [{ content: "## Last Message" }, { content: "<last_message>Current</last_message>" }];
dedupeLastMessageWrappers(standaloneHeading);
assert.equal(standaloneHeading[0]?.content, "");
const inlineWrapperText = [
  { content: "History\n</chat_history>" },
  { content: "Ordinary prose mentions <last_message> and a later line\n## Last Message" },
  { content: "<last_message>Current</last_message>" },
];
dedupeLastMessageWrappers(inlineWrapperText);
assert.equal(inlineWrapperText[0]?.content, "History\n</chat_history>");
assert.equal(inlineWrapperText[1]?.content, "Ordinary prose mentions <last_message> and a later line\n## Last Message");
const boundaryWhitespaceNoise = [
  { content: `${"\n".repeat(50_000)}x` },
  { content: "<last_message>Old</last_message>" },
  { content: "<last_message>Current</last_message>" },
];
dedupeLastMessageWrappers(boundaryWhitespaceNoise);
assert.equal(boundaryWhitespaceNoise[0]?.content.endsWith("x"), true);

const legacyDirection = `[Impersonation instruction — write {{user}}'s next response, steering it toward the following:${" ".repeat(50_000)}Go north]`;
assert.equal(
  buildImpersonateInstruction({ customPrompt: "Direction:", direction: legacyDirection }),
  "Direction: Go north.",
);
const whitespaceLegacyDirection =
  "[Impersonation instruction — write {{user}}'s next response, steering it toward the following:   ]";
assert.equal(
  buildImpersonateInstruction({ customPrompt: "Direction:", direction: whitespaceLegacyDirection }),
  `Direction: ${whitespaceLegacyDirection}`,
);

assert.equal(stripGmCommandTags(`[skill_check:${" ".repeat(50_000)}]Visible`), "Visible");
assert.equal(stripGmCommandTags(`İ [SKILL_CHECK:${" ".repeat(50_000)}]Visible`), "İ Visible");
assert.equal(stripGmCommandTags("[[music: x]]"), "[]");
assert.equal(stripGmCommandTags("[choices: [A] | [B]]Visible"), "Visible");
assert.equal(stripGmCommandTags("[choices: [A]\n[music: x]Visible"), "Visible");
assert.equal(stripGmCommandTags('[map_update: {"a": 1}\nVisible'), "Visible");
assert.equal(stripGmCommandTags("[map_update:x"), "");
assert.equal(stripGmCommandTags("[map_update:"), "");
assert.equal(stripGmCommandTags("[party-turn]A[party-chat]B"), "AB");
assert.equal(stripGmCommandTags("[note: remember the key]\n[book: chapter text]"), "[note: remember the key]\n[book: chapter text]");
assert.equal(
  applySegmentEdits('Narration before   [Miko] [main] [smile]: "Hello"   Narration after', {
    1: { content: "Edited" },
  }),
  'Narration before\n\n[Miko] [main] [smile]: "Edited"\n\nNarration after',
);
const malformedBracketNoise = "[".repeat(100_000) + ":]";
assert.equal(stripGmCommandTags(malformedBracketNoise), malformedBracketNoise);
assert.equal(
  stripGenerationGuideInstruction(
    `[Narrator instruction ${" ".repeat(50_000)} following:${" ".repeat(50_000)}Continue north]`,
  ),
  "Continue north",
);
assert.equal(
  stripGenerationGuideInstruction("[Narrator instruction — following: Choose [A] or [B]]"),
  "Choose [A] or [B]",
);
assert.equal(stripMacroComments("Before{{//".repeat(20_000) + "comment}}After"), "BeforeAfter");
assert.equal(stripMacroComments("Before{{// comment with } a lone brace }}After"), "BeforeAfter");
const groupMacroContext = {
  user: "Mari",
  char: "Miko",
  characters: ["Miko", "Dottore"],
  characterProfiles: [{ name: "Miko" }, { name: "Dottore" }],
  variables: {},
};
assert.equal(
  resolveMacros("[\n{{char}} greets Mari.\n]", groupMacroContext),
  "[\nMiko greets Mari.\n]\n[\nDottore greets Mari.\n]",
);
assert.equal(
  resolveMacros('[\n{{#if char == "Miko"}}Miko{{else}}Dottore{{/if}} greets Mari.\n]', groupMacroContext),
  "[\nMiko greets Mari.\n]\n[\nDottore greets Mari.\n]",
);
assert.equal(
  resolveMacros('[\n{{#if {{char}} == "Miko"}}Miko{{else}}Dottore{{/if}} greets Mari.\n]', groupMacroContext),
  "[\nMiko greets Mari.\n]\n[\nDottore greets Mari.\n]",
);
assert.equal(
  resolveMacros("[\n{{group}}\n]", groupMacroContext),
  "[\nDottore\n]\n[\nMiko\n]",
);
assert.equal(resolveMacros("[\n{{ char }}\n]", groupMacroContext), "[\nMiko\n]\n[\nDottore\n]");
assert.equal(
  resolveMacros(
    '[\n{{#if user == "Other"}}Other{{else if char == "Miko"}}Miko{{else}}Dottore{{/if}} greets Mari.\n]',
    groupMacroContext,
  ),
  "[\nMiko greets Mari.\n]\n[\nDottore greets Mari.\n]",
);
const nestedParenthesesConditional = `[\n{{#if ${"(".repeat(10_000)}unknown${")".repeat(10_000)}}}text\n]`;
const nestedParenthesesStartedAt = performance.now();
assert.equal(resolveMacros(nestedParenthesesConditional, groupMacroContext), nestedParenthesesConditional);
assert.ok(
  performance.now() - nestedParenthesesStartedAt < 1_000,
  "malformed nested conditional detection should complete within one second",
);
const nestedCharacterCondition = `[\n{{#if ${"(".repeat(8_000)}char == "Miko"${")".repeat(8_000)}}}Miko{{else}}Dottore{{/if}}\n]`;
const nestedCharacterStartedAt = performance.now();
assert.equal(
  resolveMacros(nestedCharacterCondition, groupMacroContext),
  "[\nMiko\n]\n[\nDottore\n]",
);
assert.ok(
  performance.now() - nestedCharacterStartedAt < 1_000,
  "deeply wrapped character conditions should complete within one second",
);
const nestedAndCondition = `${"char && (".repeat(50_000)}char${")".repeat(50_000)}`;
const nestedAndConditional = `[\n{{#if ${nestedAndCondition}}}{{char}}{{else}}missing{{/if}}\n]`;
const nestedAndStartedAt = performance.now();
assert.equal(resolveMacros(nestedAndConditional, groupMacroContext), "[\nMiko\n]\n[\nDottore\n]");
assert.ok(
  performance.now() - nestedAndStartedAt < 1_000,
  "deeply nested boolean conditions should complete within one second",
);
for (const condition of ["(char)) && false", "(char || false)) && false", "()char && false", "(char)() && false"]) {
  assert.equal(
    resolveMacros(`[\n{{#if ${condition}}}T{{else}}F{{/if}}\n]`, groupMacroContext),
    "[\nF\n]\n[\nF\n]",
    `malformed grouped condition should evaluate false per block: ${condition}`,
  );
}
assert.equal(
  resolveMacros("{{#if (char)() && false}}T{{else}}F{{/if}}", groupMacroContext, {
    deferCharacterMacros: "all",
    trimResult: false,
  }),
  "F",
  "malformed adjacent operands should not trigger character deferral",
);
for (const condition of ["(false))", "(false)))", "(false)) && true", "()false", "char && ()false", "false || ()false"]) {
  assert.equal(
    resolveMacros(`{{#if ${condition}}}T{{else}}F{{/if}}`, groupMacroContext),
    "T",
    `malformed condition should keep legacy truthy behavior: ${condition}`,
  );
}
const adjacentGroupCondition = `(char)${"()".repeat(16_000)} && false`;
const adjacentGroupStartedAt = performance.now();
assert.equal(
  resolveMacros(`[\n{{#if ${adjacentGroupCondition}}}T{{else}}F{{/if}}\n]`, groupMacroContext),
  "[\nF\n]\n[\nF\n]",
);
assert.ok(
  performance.now() - adjacentGroupStartedAt < 1_000,
  "adjacent malformed condition groups should complete within one second",
);
const malformedMacroPrefix = "{{".repeat(16_000);
const malformedMacroStartedAt = performance.now();
const recoveredConditional = resolveMacros(
  `[\n${malformedMacroPrefix}{{#if char == "Miko"}}M{{else}}D{{/if}}\n]`,
  groupMacroContext,
);
const unresolvedMalformedBlock = `${malformedMacroPrefix}{{#if char == "Miko"}}M{{else}}D{{/if}}`;
assert.equal(recoveredConditional, `[\n${unresolvedMalformedBlock}\n]\n[\n${unresolvedMalformedBlock}\n]`);
assert.ok(
  performance.now() - malformedMacroStartedAt < 1_000,
  "malformed macro prefixes should be scanned only once",
);
const unbalancedConditional = '[\n{{#if broken {{#if char == "Miko"}}M{{else}}D{{/if}}\n]';
assert.equal(resolveMacros(unbalancedConditional, groupMacroContext), `${unbalancedConditional}\n${unbalancedConditional}`);
assert.equal(
  resolveMacros("{{unknown::{{#if false}}A{{else}}B{{/if}}}}", groupMacroContext),
  "{{unknown::{{#if false}}A{{else}}B{{/if}}}}",
);
assert.equal(
  resolveMacros("{{setvar::nested::{{#if false}}A{{else}}B{{/if}}}}{{getvar::nested}}", groupMacroContext),
  "B",
);
assert.equal(sanitizeFolderSegment("-".repeat(50_000) + "package" + "-".repeat(50_000), "fallback"), "package");
assert.equal(sanitizeFolderSegment(`${"a".repeat(79)} rest`, "fallback"), "a".repeat(79));
const scopedParsingStartedAt = performance.now();
extractSetvarAssignments("{{setvar::broken::".repeat(20_000) + "{{setvar::mode::gm}}");
stripMacroComments("Before{{//".repeat(20_000) + "comment with } a lone brace }}After");
sanitizeFolderSegment("-".repeat(50_000) + "package" + "-".repeat(50_000), "fallback");
applySegmentEdits(`Narration${" ".repeat(100_000)}not-a-tag`, { 0: { content: "Edited" } });
applySegmentEdits(`Narration ${"x [".repeat(50_000)}not-a-tag`, { 0: { content: "Edited" } });
resolveMacros(`[\n{{#if ${" ".repeat(100_000)}unknown}}text{{/if}}\n]`, groupMacroContext);
assert.ok(performance.now() - scopedParsingStartedAt < 5_000, "adversarial parsing should complete within five seconds");
const encodedSpeakerNoise = "&lt;;".repeat(20_000);
assert.equal(decodeEncodedSpeakerTags(encodedSpeakerNoise), encodedSpeakerNoise);
assert.equal(decodeEncodedSpeakerTags("&lt;speaker=&quot;Luna&quot;&gt;"), '<speaker="Luna">');
assert.equal(decodeEncodedSpeakerTags("İ &LT;speaker=&quot;Luna&quot;&GT;"), 'İ <speaker="Luna">');
assert.equal(decodeEncodedSpeakerTags("&#X3C;speaker=&quot;Luna&quot;&#X3E;"), '<speaker="Luna">');
assert.deepEqual(parseSpeakerTags('Before <speaker="Luna">Hello</speaker> After', new Set(["luna"])), [
  { speaker: null, text: "Before", start: 0, end: 7 },
  { speaker: "Luna", text: "Hello", start: 7, end: 38 },
  { speaker: null, text: "After", start: 38, end: 44 },
]);
assert.equal(parseSpeakerTags('<speaker="a">'.repeat(50_000), new Set(["a"])), null);
assert.equal(
  groupConsecutiveSegments([
    { speaker: "Luna", text: "\n".repeat(50_000) + "Hello" + "\n".repeat(50_000), start: 0, end: 100_005 },
  ])[0]?.lines[0],
  "Hello",
);

process.stdout.write("Code-scanning content parsing regression passed.\n");
