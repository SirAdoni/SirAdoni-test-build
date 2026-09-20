import assert from "node:assert/strict";
import {
  resolveStoryboardVisualStateAndPlan,
  reviewAndCorrectStoryboardVisualPlan,
} from "../../packages/server/src/services/game/storyboard-visual-context.js";

const history = [
  { id: "opening", role: "assistant", content: "Ada sits beside a brass clock in the workshop." },
  { id: "current", role: "assistant", content: "Ben enters and asks about the clock." },
];
const fact = {
  subject: "Ada",
  kind: "activity" as const,
  fact: "Ada sits beside a brass clock.",
  messageId: "opening",
  quote: "sits beside a brass clock",
};
const plannedStoryboard = {
  title: "Workshop exchange",
  keyframes: [
    { imagePrompt: "Ada sits beside the brass clock as Ben enters.", characters: ["Ada", "Ben"] },
    { imagePrompt: "Ben asks about the clock while Ada looks up.", characters: ["Ada", "Ben"] },
  ],
};

let calls = 0;
const first = await resolveStoryboardVisualStateAndPlan({
  history,
  messageId: "current",
  locationContext: "A warm workshop with wooden benches.",
  checkpoints: [],
  planner: { system: "Plan the storyboard.", input: "Use two chronological keyframes." },
  complete: async (system, input) => {
    calls++;
    assert.match(system, /visualState and plannedStoryboard/);
    const request = JSON.parse(input) as { continuityEvidence: { messages: unknown[] }; storyboardRequest: string };
    assert.equal(request.continuityEvidence.messages.length, 2);
    assert.equal(request.storyboardRequest, "Use two chronological keyframes.");
    return { visualState: { openingFacts: [fact], closingFacts: [fact], uncertainties: [] }, plannedStoryboard };
  },
});
assert.equal(calls, 1, "uncached preparation combines extraction and planning in one call");
assert.deepEqual(first.plannedStoryboard, plannedStoryboard);

let repairCalls = 0;
const repaired = await resolveStoryboardVisualStateAndPlan({
  history,
  messageId: "current",
  locationContext: "A warm workshop with wooden benches.",
  checkpoints: [],
  planner: { system: "Plan the storyboard.", input: "Repair the envelope." },
  complete: async () => {
    repairCalls++;
    if (repairCalls === 1) return { visualState: { openingFacts: [], closingFacts: [], uncertainties: [] } };
    return { visualState: { openingFacts: [fact], closingFacts: [fact], uncertainties: [] }, plannedStoryboard };
  },
});
assert.equal(repairCalls, 2, "malformed combined envelopes receive one bounded repair");
assert.deepEqual(repaired.visualState.openingFacts, [fact]);

let invalidQuoteCalls = 0;
const correctedQuote = await resolveStoryboardVisualStateAndPlan({
  history,
  messageId: "current",
  locationContext: "A warm workshop with wooden benches.",
  checkpoints: [],
  planner: { system: "Plan the storyboard.", input: "Correct the physical evidence." },
  complete: async () => {
    invalidQuoteCalls++;
    return invalidQuoteCalls === 1
      ? {
          visualState: {
            openingFacts: [{ ...fact, quote: "invented source" }],
            closingFacts: [fact],
            uncertainties: [],
          },
          plannedStoryboard,
        }
      : { visualState: { openingFacts: [fact], closingFacts: [fact], uncertainties: [] }, plannedStoryboard };
  },
});
assert.equal(invalidQuoteCalls, 2, "invalid source quotes receive one bounded correction");
assert.deepEqual(correctedQuote.visualState.openingFacts, [fact]);

let invalidEnvelopeCalls = 0;
await assert.rejects(
  resolveStoryboardVisualStateAndPlan({
    history,
    messageId: "current",
    locationContext: "A warm workshop with wooden benches.",
    checkpoints: [],
    planner: { system: "Plan the storyboard.", input: "Reject repeated invalid envelopes." },
    complete: async () => {
      invalidEnvelopeCalls++;
      return { visualState: { openingFacts: [], closingFacts: [], uncertainties: [] } };
    },
  }),
  /invalid model output after one repair/,
);
assert.equal(invalidEnvelopeCalls, 2, "two invalid envelopes stop after the bounded repair");

let providerFailureCalls = 0;
await assert.rejects(
  resolveStoryboardVisualStateAndPlan({
    history,
    messageId: "current",
    locationContext: "A warm workshop with wooden benches.",
    checkpoints: [],
    planner: { system: "Plan the storyboard.", input: "Provider failure." },
    complete: async () => {
      providerFailureCalls++;
      throw new Error("provider transport failure");
    },
  }),
  /provider transport failure/,
);
assert.equal(providerFailureCalls, 1, "provider failures are not treated as output repair");

let abortCalls = 0;
await assert.rejects(
  resolveStoryboardVisualStateAndPlan({
    history,
    messageId: "current",
    locationContext: "A warm workshop with wooden benches.",
    checkpoints: [],
    planner: { system: "Plan the storyboard.", input: "Abort." },
    complete: async () => {
      abortCalls++;
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    },
  }),
  /aborted/,
);
assert.equal(abortCalls, 1, "abort errors are not treated as output repair");

let reviewCalls = 0;
const reviewedFrames = await reviewAndCorrectStoryboardVisualPlan({
  context: "Ada sits beside a brass clock.",
  locationContext: "A warm workshop with wooden benches.",
  frames: plannedStoryboard.keyframes,
  complete: async () => {
    reviewCalls++;
    return { consistent: true, reason: "", corrections: [] };
  },
});
assert.equal(reviewCalls, 1);
assert.equal(reviewedFrames.length, plannedStoryboard.keyframes.length, "review preserves frame count");
assert.deepEqual(
  reviewedFrames.map((frame) => frame.imagePrompt),
  plannedStoryboard.keyframes.map((frame) => frame.imagePrompt),
  "review preserves frame ordering",
);

const omittedCorrections = await reviewAndCorrectStoryboardVisualPlan({
  context: "Ada sits beside a brass clock.",
  locationContext: "A warm workshop with wooden benches.",
  frames: plannedStoryboard.keyframes,
  complete: async () => ({ consistent: true, reason: "" }),
});
assert.deepEqual(omittedCorrections, plannedStoryboard.keyframes, "omitted corrections mean no changes");

await assert.rejects(
  reviewAndCorrectStoryboardVisualPlan({
    context: "Ada sits beside a brass clock.",
    locationContext: "A warm workshop with wooden benches.",
    frames: plannedStoryboard.keyframes,
    complete: async () => ({ consistent: false, reason: "The plan conflicts with the scene." }),
  }),
  /stopped image generation/,
  "an inconsistent plan without a repair remains fail-closed",
);

let repairedReviewCalls = 0;
const correctedFramesOnly = await reviewAndCorrectStoryboardVisualPlan({
  context: "Ada sits beside a brass clock.",
  locationContext: "A warm workshop with wooden benches.",
  frames: plannedStoryboard.keyframes,
  complete: async () => {
    repairedReviewCalls++;
    return repairedReviewCalls === 1
      ? { consistent: false, reason: "Repair supplied.", correctedFrames: plannedStoryboard.keyframes }
      : { consistent: true, reason: "Verified." };
  },
});
assert.equal(repairedReviewCalls, 2, "corrected frames without corrections receive verification");
assert.deepEqual(correctedFramesOnly, plannedStoryboard.keyframes);

const cached = await resolveStoryboardVisualStateAndPlan({
  history,
  messageId: "current",
  locationContext: "A warm workshop with wooden benches.",
  checkpoints: [JSON.stringify(first.visualState)],
  planner: { system: "Plan the storyboard.", input: "This must not be called." },
  complete: async () => {
    throw new Error("cached checkpoint unexpectedly called the model");
  },
});
assert.deepEqual(cached.visualState, first.visualState);
assert.equal(cached.plannedStoryboard, undefined, "cached preparation skips the planner call");

console.info(
  "Combined storyboard preparation: one uncached extraction/planner call and cached checkpoint reuse passed.",
);
