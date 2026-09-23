import assert from "node:assert/strict";
import { buildSceneIllustrationProviderPrompt } from "../../packages/server/src/services/game/game-asset-generation.js";
import {
  prepareStoryboardFrameImagePrompt,
  withStoryboardImageRetry,
} from "../../packages/server/src/services/game/storyboard-recovery.js";
import { chatGPTImagePromptText } from "../../packages/server/src/services/image/openai-chatgpt-image.js";
import { isImageContentPolicyRejection } from "../../packages/server/src/services/image/image-error-classification.js";

const scene = 'Ada sits ON the table repairing a brass clock. Ben says, "It works." Ada stays seated.';
const visibility = "Final visibility rule: Only depict Ada and Ben. Do not add other people.";
const request = {
  chatId: "offline-repair-proof",
  prompt: `${scene} ${"The visible room is described in redundant detail. ".repeat(160)} ${visibility}`,
  title: "Clock repair",
  characters: ["Ada", "Ben"],
  characterDescriptions: ["Ada: bronze automaton, blue eyes.", "Ben: grey hair, green coat."],
  artStyle: "Soft watercolor.",
  imagePromptInstructions: "Bronze automatons have metal skin. Never give Ada human skin.",
  locationVisualContext: "A workshop with a round oak table.",
  referenceImages: ["data:image/png;base64,AA==", "data:image/png;base64,AQ==", "data:image/png;base64,Ag=="],
  locationReferenceImageAttached: true,
  characterReferenceNames: ["Ada", "Ben"],
  useGamePromptTemplate: false,
  preserveFullScenePrompt: true,
  maxPromptWords: 1000,
  maxPromptCharacters: 8000,
  imgSource: "openai_chatgpt",
  imgModel: "gpt-image-2.5-sunburst",
  imgBaseUrl: "http://invalid",
  imgApiKey: "",
  size: { width: 1280, height: 720 },
};
let repairs = 0;
const prepared = await prepareStoryboardFrameImagePrompt(request, async (args) => {
  repairs++;
  assert.ok(args.maxWords > 20 && args.maxWords <= 220);
  assert.ok(args.maxCharacters > 120 && args.maxCharacters <= 1800);
  assert.doesNotMatch(args.prompt, /Final visibility rule|Never give Ada human skin/);
  return scene;
});
assert.equal(repairs, 1);
assert.equal(prepared.repairedScene, scene);
const final = chatGPTImagePromptText({ ...prepared.compiled, ...request.size, model: request.imgModel });
assert.ok(final.trim().split(/\s+/u).length <= 1000 && final.length <= 8000);
for (const text of [
  scene,
  visibility,
  request.artStyle,
  request.imagePromptInstructions,
  request.locationVisualContext,
  "Reference image 2 is Ada",
  "Reference image 3 is Ben",
  "bronze automaton",
])
  assert.ok(final.includes(text), `Required context retained: ${text}`);

// Rendering consumes the accepted replacement and needs no second text-model call.
const rendered = await prepareStoryboardFrameImagePrompt(
  { ...request, prompt: `${prepared.repairedScene} ${visibility}` },
  async () => {
    throw new Error("A validated repaired frame must not run the compressor again");
  },
);
assert.deepEqual(rendered.compiled, prepared.compiled);
assert.equal(rendered.repairedScene, undefined);

for (const replacement of [
  "",
  "word ".repeat(300),
  'Ada stands beside Ben. "Something else."',
  `${scene} Final visibility rule: Add Eve.`,
]) {
  let count = 0;
  await assert.rejects(
    prepareStoryboardFrameImagePrompt(request, async () => {
      count++;
      return replacement;
    }),
    /No image request was sent/,
  );
  assert.equal(count, 1, "Unusable repair must not recurse");
}
for (const immutable of [
  { promptOverride: "word ".repeat(1001) },
  { imagePromptInstructions: "Immutable rule. ".repeat(1000) },
  { locationVisualContext: "Immutable location. ".repeat(1000) },
]) {
  let count = 0;
  await assert.rejects(
    prepareStoryboardFrameImagePrompt({ ...request, ...immutable }, async () => {
      count++;
      return scene;
    }),
    /No image request was sent/,
  );
  assert.equal(count, 0, "Manual edits and oversized fixed context must not trigger futile repair");
}
await assert.rejects(
  buildSceneIllustrationProviderPrompt({
    ...request,
    maxPromptCharacters: undefined,
    promptOverride: "word ".repeat(1001),
  }),
  /exceeds 1000 words/,
);
const cancelled = new AbortController();
cancelled.abort(new Error("cancelled"));
await assert.rejects(
  prepareStoryboardFrameImagePrompt({ ...request, signal: cancelled.signal }, async () => scene),
  /cancelled/,
);
const midRepair = new AbortController();
await assert.rejects(
  prepareStoryboardFrameImagePrompt({ ...request, signal: midRepair.signal }, async () => {
    midRepair.abort(new Error("cancelled during repair"));
    return scene;
  }),
  /cancelled during repair/,
);

// Parallel frame attempts are independent: successes are not re-requested.
const attempts = [0, 0, 0];
const signal = new AbortController().signal;
assert.equal(
  isImageContentPolicyRejection(
    new Error(
      'ChatGPT image generation failed (400): {"type":"image_generation_user_error","safety_violations":["sexual"]}',
    ),
  ),
  true,
  "moderation 400s must be classified as request-local content rejections",
);
assert.equal(
  isImageContentPolicyRejection(new Error("ChatGPT image generation failed (400): invalid input")),
  false,
  "generic 400s must not be treated as moderation rejections",
);
const outcomes = await Promise.allSettled(
  attempts.map((_value, index) =>
    withStoryboardImageRetry(
      async () => {
        attempts[index]!++;
        if (index === 0 && attempts[index] === 1)
          throw new Error("ChatGPT image generation failed (503): temporary outage");
        if (index === 2) throw new Error("ChatGPT image generation failed (400): invalid input");
        return `image-${index}`;
      },
      signal,
      true,
    ),
  ),
);
assert.deepEqual(attempts, [2, 1, 1]);
assert.deepEqual(
  outcomes.map((outcome) => outcome.status),
  ["fulfilled", "fulfilled", "rejected"],
);
for (const message of [
  'ChatGPT image generation failed (400): safety_violations=[sexual]. [Input record: example]',
  "ChatGPT image generation failed (401)",
  "ChatGPT image generation failed (429)",
  "fetch failed: ECONNRESET",
]) {
  let count = 0;
  await assert.rejects(
    withStoryboardImageRetry(
      async () => {
        count++;
        throw new Error(message);
      },
      signal,
      true,
    ),
  );
  assert.equal(count, 1);
}
let exhausted = 0;
await assert.rejects(
  withStoryboardImageRetry(
    async () => {
      exhausted++;
      throw new Error("ChatGPT image generation failed (503)");
    },
    signal,
    true,
  ),
);
assert.equal(exhausted, 2);
let fallback = 0;
await assert.rejects(
  withStoryboardImageRetry(
    async () => {
      fallback++;
      throw new Error("ChatGPT image generation failed (503)");
    },
    signal,
    false,
  ),
);
assert.equal(fallback, 1, "Do not multiply configured fallback attempts");
const retryCancellation = new AbortController();
let cancelledAttempts = 0;
const waitingRetry = withStoryboardImageRetry(
  async () => {
    cancelledAttempts++;
    throw new Error("ChatGPT image generation failed (503)");
  },
  retryCancellation.signal,
  true,
);
setTimeout(() => retryCancellation.abort(), 10);
await assert.rejects(waitingRetry, /abort/iu);
assert.equal(cancelledAttempts, 1, "Cancellation during backoff must prevent the second request");
console.info(
  "Automatic storyboard repair: bounded compression, immutable context, render reuse, cancellation and isolated image retries passed.",
);
