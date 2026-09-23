import assert from "node:assert/strict";
import {
  buildChatGPTDirectImageRequest,
  fitChatGPTDirectImagePrompt,
} from "../../packages/server/src/services/image/openai-chatgpt-image.js";

const base = { model: "gpt-image-2.5-sunburst", prompt: "x".repeat(32_000) };
assert.equal(String(buildChatGPTDirectImageRequest(base).body.prompt).length, 32_000);
assert.throws(() => buildChatGPTDirectImageRequest({ ...base, negativePrompt: "extra people" }), /32,000/);
let calls = 0;
assert.equal(
  await fitChatGPTDirectImagePrompt(base, async () => {
    calls++;
    return "";
  }),
  base,
);
assert.equal(calls, 0);
const large = {
  ...base,
  prompt: "x".repeat(33_642),
  negativePrompt: "extra people",
  width: 1536,
  height: 1024,
  referenceDataUrls: ["data:image/png;base64,REF"],
};
const fitted = await fitChatGPTDirectImagePrompt(large, async (source) => {
  calls++;
  assert.match(source, /extra people/);
  assert.match(source, /landscape/);
  return calls === 1 ? "x".repeat(33_000) : "All named characters. Wide landscape. No extra people.";
});
const request = buildChatGPTDirectImageRequest(fitted);
assert.equal(calls, 2);
assert.equal(request.endpoint, "images/edits");
assert.deepEqual(request.body.images, [{ image_url: large.referenceDataUrls[0] }]);
assert.match(String(request.body.prompt), /No extra people/);
assert.ok(String(request.body.prompt).length <= 32_000);
await assert.rejects(
  () => fitChatGPTDirectImagePrompt(large, async () => "x".repeat(40_000)),
  /No image request was sent/,
);
console.info("ChatGPT image prompt limit: boundaries, suffix budget, retry, references and local rejection passed.");
