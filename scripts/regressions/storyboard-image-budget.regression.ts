import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildSceneIllustrationProviderPrompt } from "../../packages/server/src/services/game/game-asset-generation.js";
import { chatGPTImagePromptText } from "../../packages/server/src/services/image/openai-chatgpt-image.js";
import { formatSpatialLocationVisualContext } from "../../packages/server/src/services/image/spatial-location-reference.js";

const base = {
  chatId: "offline-proof",
  prompt: "Panel 1: Ada sits ON the table repairing a brass clock. Panel 2: Ben says, 'It works.' Ada remains seated.",
  characters: ["Ada", "Ben"],
  characterDescriptions: ["Ada: brown eyes, blue dress.", "Ben: grey hair, green coat."],
  artStyle: "Soft watercolor.",
  imagePromptInstructions: "Preserve the campaign's established appearances.",
  locationVisualContext: "A small workshop with a round oak table.",
  locationReferenceImageAttached: true,
  useGamePromptTemplate: false,
  maxPromptCharacters: 8000,
  imgModel: "gpt-image-2.5-sunburst",
  imgBaseUrl: "http://invalid",
  imgApiKey: "",
  size: { width: 1280, height: 720 },
};
// Older callers cannot reintroduce the former 25k evidence attachment at runtime.
const compiled = await buildSceneIllustrationProviderPrompt({
  ...base,
  ...{ physicalSceneContext: "PRIVATE TRANSCRIPT EVIDENCE ".repeat(1000) },
});
const final = chatGPTImagePromptText({ ...compiled, ...base.size, model: base.imgModel });
assert.match(final, /sits ON the table/);
assert.match(final, /'It works.'/);
assert.match(final, /Soft watercolor/);
assert.match(final, /campaign's established appearances/);
assert.match(final, /round oak table/);
assert.match(final, /Reference image 1/);
assert.equal(final.split("Ada: brown eyes").length - 1, 1, "Appearance occurs once");
assert.doesNotMatch(final, /PRIVATE TRANSCRIPT EVIDENCE/);
assert.ok(final.length < 2000);

const room = {
  breadcrumb: [{ name: "Workshop" }],
  description: "The oak table has carved legs. ".repeat(60),
} as Parameters<typeof formatSpatialLocationVisualContext>[0];
const photographedRoom = formatSpatialLocationVisualContext(room, true);
assert.match(photographedRoom, /Workshop/);
assert.doesNotMatch(photographedRoom, /carved legs/);
assert.match(formatSpatialLocationVisualContext(room, false), /carved legs/);

const crowded = {
  ...base,
  preserveFullScenePrompt: true,
  prompt: `${base.prompt} ${"A visible action happens. ".repeat(45)}`,
  characterDescriptions: Array.from(
    { length: 16 },
    (_, index) => `Person${index}: bronze automaton with blue eyes. ${"tiny ".repeat(160)}`,
  ),
};
const withoutWordBudget = await buildSceneIllustrationProviderPrompt(crowded);
assert.ok(
  chatGPTImagePromptText({ ...withoutWordBudget, ...base.size, model: base.imgModel }).split(/\s+/u).length > 1000,
);
const fitted = await buildSceneIllustrationProviderPrompt({ ...crowded, maxPromptWords: 1000 });
const fittedText = chatGPTImagePromptText({ ...fitted, ...base.size, model: base.imgModel });
assert.ok(fittedText.trim().split(/\s+/u).length <= 1000);
assert.ok(fittedText.length <= 8000);
assert.ok(fittedText.includes(crowded.prompt.trim()));
assert.ok(fittedText.includes(base.imagePromptInstructions));
assert.ok(fittedText.includes(base.locationVisualContext));
for (let index = 0; index < 16; index++)
  assert.ok(fittedText.includes(`Person${index}: bronze automaton with blue eyes.`));

for (const extra of [
  { promptOverride: "word ".repeat(1001), maxPromptWords: 1000 },
  { promptOverride: "x".repeat(8001) },
  { prompt: "x".repeat(7900) },
  { locationVisualContext: "x".repeat(8000) },
  { promptOverride: "short", negativePromptOverride: "x".repeat(8000) },
]) {
  await assert.rejects(buildSceneIllustrationProviderPrompt({ ...base, ...extra }), /No image request was sent/);
}
const route = readFileSync(new URL("../../packages/server/src/routes/game.routes.ts", import.meta.url), "utf8");
const expandedBudget = { ...base, maxPromptWords: 2000, maxPromptCharacters: 16000 };
const longerReviewedPrompt = "visible detail ".repeat(750).trim();
const expanded = await buildSceneIllustrationProviderPrompt({
  ...expandedBudget,
  promptOverride: longerReviewedPrompt,
});
assert.ok(
  expanded.prompt.includes(longerReviewedPrompt),
  "The increased budget preserves a reviewed prompt over 1000 words",
);
await assert.rejects(
  buildSceneIllustrationProviderPrompt({ ...expandedBudget, promptOverride: "word ".repeat(2001) }),
  /2000 words/,
);
assert.equal((route.match(/maxPromptCharacters: 16000/g) ?? []).length, 2);
assert.equal((route.match(/maxPromptWords: 2000/g) ?? []).length, 2);
assert.match(route, /context: physicalSceneContext/);
assert.match(route, /visualSceneState: JSON.stringify\(visualSceneState\)/);
console.info(
  "Storyboard image budget: evidence isolation, scene/canon retention, single appearance copy and final suffix budget passed.",
);
