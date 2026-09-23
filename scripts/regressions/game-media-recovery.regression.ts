import assert from "node:assert/strict";
import {
  gameNpcCharacterSyncRecoveryDelay,
  isRetryableGameNpcCharacterSyncError,
} from "../../packages/client/src/lib/game-npc-character-sync-policy.js";
import {
  buildSceneIllustrationImagePrompt,
  sceneIllustrationBuiltInNegativePrompt,
} from "../../packages/server/src/services/game/game-asset-generation.js";
import { readChatGPTImageSse } from "../../packages/server/src/services/image/openai-chatgpt-image.js";

assert.deepEqual(
  [0, 1, 2, 3, 4, 100].map(gameNpcCharacterSyncRecoveryDelay),
  [15000, 30000, 60000, 120000, 120000, 120000],
);
assert.equal(isRetryableGameNpcCharacterSyncError(new TypeError("Failed to fetch")), true);
assert.equal(isRetryableGameNpcCharacterSyncError({ status: 400 }), false);
assert.equal(isRetryableGameNpcCharacterSyncError({ status: 503 }), true);
const comicNegative = sceneIllustrationBuiltInNegativePrompt(
  "A comic page with two panels. Include speech bubbles.",
).split(", ");
assert.ok(!comicNegative.includes("panel"));
assert.ok(!comicNegative.includes("speech bubble"));
assert.ok(comicNegative.includes("watermark"));
assert.ok(sceneIllustrationBuiltInNegativePrompt("A room at dawn").split(", ").includes("panel"));
const prompt = await buildSceneIllustrationImagePrompt({
  chatId: "fixture",
  prompt: "A room at dawn",
  artStyle: "inked comic",
  useGamePromptTemplate: false,
  imgModel: "fixture",
  imgBaseUrl: "",
  imgApiKey: "",
});
assert.ok(prompt.includes("Art direction: inked comic."));

// The provider leaves the stream open after delivering the completed image.
let cancelled = false;
const stream = new ReadableStream<Uint8Array>({
  start(controller) {
    const frame = `data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "image_generation_call", status: "completed", result: "QUJD", output_format: "png" } })}\n\n`;
    controller.enqueue(new TextEncoder().encode(frame.slice(0, 35)));
    controller.enqueue(new TextEncoder().encode(frame.slice(35)));
  },
  cancel() {
    cancelled = true;
  },
});
const image = await readChatGPTImageSse(new Response(stream), AbortSignal.timeout(1000));
assert.equal(image.base64, "QUJD");
assert.equal(cancelled, true);
console.info("Game media recovery regression passed");
