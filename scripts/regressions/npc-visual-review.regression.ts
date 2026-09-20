import assert from "node:assert/strict";
import { validateNpcAppearance, reviewNpcPortrait } from "../../packages/server/src/services/game/npc-visual-review.js";

const accepted = JSON.stringify({
  accepted: true,
  observed: "Soft rounded adult features and the specified merchant clothing.",
  issues: [],
});
const rejected = JSON.stringify({
  accepted: false,
  observed: "Angular features contradict the supplied campaign description.",
  issues: ["Replace the angular jaw with the canonical rounded jaw."],
});
const args = {
  name: "Merchant",
  appearance: "An angular adult woman in a green merchant gown.",
  context: "Women have soft rounded features. Preserve green merchant clothing.",
};
let calls = 0;
const repaired = await validateNpcAppearance({
  ...args,
  complete: async () => {
    calls++;
    return calls === 1
      ? rejected
      : calls === 2
        ? JSON.stringify({ appearance: "A softly rounded adult woman in a green merchant gown." })
        : accepted;
  },
});
assert.match(repaired, /softly rounded/);
assert.equal(calls, 3, "A repaired description requires independent re-review");
await assert.rejects(validateNpcAppearance({ ...args, complete: async () => "{}" }));
calls = 0;
await assert.rejects(
  validateNpcAppearance({
    ...args,
    complete: async () => (++calls === 2 ? JSON.stringify({ appearance: args.appearance }) : rejected),
  }),
  /needs review/,
);
assert.equal(calls, 3, "Description repairs are bounded");
const exception = "An explicitly graceless adult woman with plain features, established by the user.";
assert.equal(
  await validateNpcAppearance({
    ...args,
    appearance: exception,
    context: exception,
    complete: async (system, content) => {
      assert.match(system, /Preserve explicitly established exceptions/);
      assert.match(content, /explicitly graceless/);
      return accepted;
    },
  }),
  exception,
);
const image = "data:image/png;base64,CANDIDATE";
const styleReference = "data:image/png;base64,STYLE";
const review = await reviewNpcPortrait({
  ...args,
  image,
  styleReference,
  complete: async (system, content, images) => {
    assert.deepEqual(images, [image, styleReference]);
    assert.match(system, /Judge what is visible/);
    assert.match(content, /requiredAppearance/);
    return rejected;
  },
});
assert.equal(review.accepted, false);
await assert.rejects(
  reviewNpcPortrait({
    ...args,
    image,
    complete: async () =>
      JSON.stringify({
        accepted: true,
        observed: "This result contradicts itself and cannot be accepted.",
        issues: ["wrong face"],
      }),
  }),
  /Contradictory/,
);
console.log("NPC visual review: re-review, bounded rejection, explicit exceptions and actual image attachment passed.");
