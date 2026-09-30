/**
 * 0.3.5 (player report): the character's name never reached a picture prompt, so a known character
 * came out as a stranger with the same hair. The card name now leads the prompt when the Creator's
 * "The image model knows this character" switch is on and the identity is open, and the enhancer
 * learns who the character is. See packages/slurp2/docs/IMAGE-PROMPTS.md.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  slurpApplyImageSubject,
  slurpImageSubjectName,
  slurpImageIdentityContext,
} from "../packages/slurp2/src/engine/packages/server/src/slp/base/media/slp-image-prompt.ts";

const root = join(import.meta.dirname, "../packages/slurp2/src/engine/packages");
const read = (path: string) => readFileSync(join(root, path), "utf8");

// The name leads, once; no name, no change.
assert.equal(
  slurpApplyImageSubject("Red hair.\nSitting at a café.", "Asuka Langley Soryu"),
  "Asuka Langley Soryu\nRed hair.\nSitting at a café.",
);
assert.equal(
  slurpApplyImageSubject("asuka langley soryu, red hair", "Asuka Langley Soryu"),
  "asuka langley soryu, red hair",
);
assert.equal(slurpApplyImageSubject("A café.", "  "), "A café.");

// Tag models (player report): the name is a lowercase tag, and a Danbooru tag already in the
// Appearance ("asuka_langley_soryu", escaped brackets) counts as present, so it never goes in twice.
assert.equal(
  slurpApplyImageSubject("1girl, red hair", "Asuka Langley Soryu", "tags"),
  "asuka langley soryu, 1girl, red hair",
);
assert.equal(
  slurpApplyImageSubject("1girl, asuka_langley_soryu, red_hair", "Asuka Langley Soryu", "tags"),
  "1girl, asuka_langley_soryu, red_hair",
);
assert.equal(
  slurpApplyImageSubject("makima \\(chainsaw man\\), 1girl", "Makima (Chainsaw Man)", "tags"),
  "makima \\(chainsaw man\\), 1girl",
);

// The post writer may tag the name with its series (NovelAI style); only for the same character.
assert.equal(slurpImageSubjectName("fubuki (one punch man)", ["Fubuki", "Blizzard"]), "fubuki (one punch man)");
assert.equal(
  slurpImageSubjectName("tatsumaki (one punch man)", ["Fubuki", "Blizzard"]),
  "Fubuki",
  "never somebody else",
);
assert.equal(slurpImageSubjectName(null, ["Fubuki"]), "Fubuki");
assert.equal(slurpImageSubjectName("", ["Fubuki"]), "Fubuki");

// The enhancer's identity context: the name and the start of the card, marked as context.
const context = slurpImageIdentityContext("Makima", `A devil hunter.  ${"Calm and in control. ".repeat(40)}`);
assert.match(context, /^Who this is: Makima\nFrom their card \(context, do not copy\): A devil hunter\./u);
assert.ok(context.length < 480, "a short part of the card, not the whole description");
assert.equal(slurpImageIdentityContext("", ""), "");

// Wiring: one place for every picture, only for an open identity and the Creator's switch.
const service = read("server/src/slp/features/media/slp-images-service.ts");
assert.match(
  service,
  /input\.disclosureMode === "open" &&\s+input\.settings\.creatorImageNames\?\.\[input\.account\.id\] !== false/u,
);
assert.match(service, /slurpApplyImageSubject\(finalPromptLook, subjectName, promptFamily\)/u);
assert.match(service, /\[\s+identityContext,/u);
assert.match(
  service,
  /slurpImageSubjectName\(input\.visualBrief\?\.knownAs, \[sourceName, input\.account\.displayName\]\)/u,
);
// The writer's name never enters the brief's text (which reaches the enhancer ungated).
assert.doesNotMatch(read("server/src/slp/base/media/slp-visual-brief.ts"), /knownAs\}/u);
assert.match(
  read("server/src/slp/modules/settings/slp-settings.ts"),
  /creatorImageNames: z\.record\(z\.string\(\), z\.boolean\(\)\)/u,
);

console.log("slurp2 image subject: ok");
