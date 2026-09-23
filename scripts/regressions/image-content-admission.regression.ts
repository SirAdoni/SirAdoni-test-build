import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { withStoryboardImageRetry } from "../../packages/server/src/services/game/storyboard-recovery.js";
import { isImageContentPolicyRejection } from "../../packages/server/src/services/image/image-error-classification.js";
import { generateImage } from "../../packages/server/src/services/image/image-generation.js";
import {
  BACKGROUND_CONNECTION_FAILURE_THRESHOLD,
  resetConnectionAdmissionForTests,
  tryBackgroundConnection,
  withConnectionAdmission,
} from "../../packages/server/src/services/generation/connection-admission.js";

const imageGenerationSource = readFileSync(
  new URL("../../packages/server/src/services/image/image-generation.ts", import.meta.url),
  "utf8",
);
assert.match(
  imageGenerationSource,
  /withConnectionAdmission\([\s\S]{0,1200}isImageContentPolicyRejection\(error\)\s*\?\s*"ignored"/u,
  "image provider admission must classify moderation failures before releasing the circuit slot",
);

const moderation400 = new Error(
  'ChatGPT image generation failed (400): {"type":"image_generation_user_error","safety_violations":["sexual"]}',
);
const moderationSse = new Error("ChatGPT image generation failed: safety system rejected the image request");

assert.equal(isImageContentPolicyRejection(moderation400), true);
assert.equal(isImageContentPolicyRejection(moderationSse), true);
assert.equal(
  isImageContentPolicyRejection(new Error("ChatGPT image generation failed (400): image_generation_user_error")),
  false,
  "the generic image user-error code alone must not imply moderation",
);
assert.equal(isImageContentPolicyRejection(new Error("ChatGPT image generation failed (400): invalid input")), false);
assert.equal(isImageContentPolicyRejection(new Error("ChatGPT image generation failed (401): unauthorized")), false);
assert.equal(isImageContentPolicyRejection(new Error("ChatGPT image generation failed (503): overloaded")), false);
assert.equal(
  isImageContentPolicyRejection(new Error("ChatGPT image generation failed (503): safety system unavailable")),
  false,
);
assert.equal(
  isImageContentPolicyRejection(new Error("ChatGPT image generation failed (401): moderation rejected token")),
  false,
);

let moderationAttempts = 0;
await assert.rejects(
  withStoryboardImageRetry(
    async () => {
      moderationAttempts++;
      throw moderation400;
    },
    new AbortController().signal,
    true,
  ),
);
assert.equal(moderationAttempts, 1, "moderation rejections must not enter storyboard retry");

let temporaryAttempts = 0;
await assert.rejects(
  withStoryboardImageRetry(
    async () => {
      temporaryAttempts++;
      throw new Error("ChatGPT image generation failed (503): overloaded");
    },
    new AbortController().signal,
    true,
  ),
);
assert.equal(temporaryAttempts, 2, "temporary 503 failures retain one bounded retry");

resetConnectionAdmissionForTests();
for (let attempt = 0; attempt < BACKGROUND_CONNECTION_FAILURE_THRESHOLD; attempt++) {
  await assert.rejects(
    withConnectionAdmission(
      "wired-moderation-endpoint",
      { kind: "background", groupId: `storyboard:${attempt}` },
      async () => {
        throw moderation400;
      },
      (error) => (isImageContentPolicyRejection(error) ? "ignored" : "failed"),
    ),
  );
}
const wiredNextBatch = tryBackgroundConnection("wired-moderation-endpoint", new Date(), "storyboard:next");
assert.equal(wiredNextBatch.acquired, true, "wired moderation failures must not quarantine the endpoint");
if (wiredNextBatch.acquired) wiredNextBatch.release("completed");

resetConnectionAdmissionForTests();
for (let attempt = 0; attempt < BACKGROUND_CONNECTION_FAILURE_THRESHOLD; attempt++) {
  const admission = tryBackgroundConnection("moderation-endpoint", new Date(), `storyboard:${attempt}`);
  assert.equal(admission.acquired, true);
  if (admission.acquired) admission.release("ignored");
}
const nextBatch = tryBackgroundConnection("moderation-endpoint", new Date(), "storyboard:next");
assert.equal(nextBatch.acquired, true, "ignored moderation failures must not quarantine the endpoint");
if (nextBatch.acquired) nextBatch.release("completed");

const originalFetch = globalThis.fetch;
let providerRequests = 0;
let fallbackNotices = 0;
globalThis.fetch = (async () => {
  providerRequests++;
  return new Response(
    JSON.stringify({ error: { message: "safety_violations=[sexual]", type: "image_generation_user_error" } }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}) as typeof fetch;
try {
  resetConnectionAdmissionForTests();
  for (let attempt = 0; attempt < BACKGROUND_CONNECTION_FAILURE_THRESHOLD; attempt++) {
    await assert.rejects(
      generateImage("openai", "http://127.0.0.1:9876/v1", "", "openai", {
        prompt: "grounded test image",
        model: "gpt-image-1",
        allowLocalUrls: true,
        admissionMode: { kind: "background", groupId: `actual:${attempt}` },
        fallback: {
          connectionId: "fallback",
          connectionName: "fallback",
          provider: "openai",
          source: "openai",
          baseUrl: "http://127.0.0.1:9877/v1",
          apiKey: "",
          serviceHint: "openai",
          model: "gpt-image-1",
        },
        onFallback: async () => {
          fallbackNotices++;
        },
      }),
    );
  }
  assert.equal(
    providerRequests,
    BACKGROUND_CONNECTION_FAILURE_THRESHOLD,
    "each moderation request reached the provider once",
  );
  assert.equal(fallbackNotices, 0, "moderation rejection must not activate image fallback");
  const afterActualRequests = tryBackgroundConnection(
    "http://127.0.0.1:9876/v1/images/generations",
    new Date(),
    "actual:next",
  );
  assert.equal(afterActualRequests.acquired, true, "actual moderation requests must not quarantine the image endpoint");
  if (afterActualRequests.acquired) afterActualRequests.release("completed");
} finally {
  globalThis.fetch = originalFetch;
}

resetConnectionAdmissionForTests();
for (let attempt = 0; attempt < BACKGROUND_CONNECTION_FAILURE_THRESHOLD; attempt++) {
  const admission = tryBackgroundConnection("server-endpoint", new Date(), `storyboard:${attempt}`);
  assert.equal(admission.acquired, true);
  if (admission.acquired) admission.release("failed");
}
const quarantined = tryBackgroundConnection("server-endpoint", new Date(), "storyboard:next");
assert.equal(quarantined.acquired, false, "ordinary provider failures must still quarantine after the threshold");

console.log("image content rejection classification and admission regression passed");
