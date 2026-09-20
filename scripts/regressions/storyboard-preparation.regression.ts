import assert from "node:assert/strict";
import {
  resolveStoryboardVisualState,
  formatStoryboardVisualContext,
} from "../../packages/server/src/services/game/storyboard-visual-context.js";
import {
  startStoryboardProgress,
  storyboardProgress,
} from "../../packages/server/src/services/game/storyboard-progress.js";

const history = [
  { id: "u0", role: "user", content: "Ada sits on the table repairing a brass clock." },
  { id: "a0", role: "assistant", content: "Ben asks about the clock." },
];
const fact = {
  subject: "Ada",
  kind: "activity" as const,
  fact: history[0]!.content,
  quote: "sits on the table repairing a brass clock",
  messageId: "u0",
};
const initial = await resolveStoryboardVisualState({
  history,
  messageId: "a0",
  locationContext: "workshop",
  checkpoints: [],
  complete: async () => ({ openingFacts: [fact], closingFacts: [fact], uncertainties: [] }),
});
const nextHistory = [
  ...history,
  {
    id: "u1",
    role: "user",
    content: "I put the clock down and leave the room.",
    extra: { privatePayload: "DO_NOT_SEND_METADATA" },
  },
  { id: "a1", role: "assistant", content: "Ben stands alone in the workshop." },
];
let calls = 0;
const updated = await resolveStoryboardVisualState({
  history: nextHistory,
  messageId: "a1",
  locationContext: "workshop",
  checkpoints: [JSON.stringify(initial)],
  complete: async (system, input) => {
    calls++;
    assert.match(system, /openingChanges/);
    assert.doesNotMatch(input, /DO_NOT_SEND_METADATA/);
    assert.deepEqual(JSON.parse(input).previousFacts, [fact]);
    return {
      openingChanges: { remove: [0], upsert: [] },
      closingChanges: { remove: [], upsert: [] },
      uncertainties: [],
    };
  },
});
assert.equal(calls, 1);
assert.deepEqual(updated.openingFacts, []);
assert.deepEqual(updated.closingFacts, [], "departed person is not carried forward");
const retained = await resolveStoryboardVisualState({
  history: [...history, { id: "a1", role: "assistant", content: "Ben waits for an answer." }],
  messageId: "a1",
  locationContext: "workshop",
  checkpoints: [JSON.stringify(initial)],
  complete: async () => ({
    openingChanges: { remove: [], upsert: [] },
    closingChanges: { remove: [], upsert: [] },
    uncertainties: [],
  }),
});
assert.deepEqual(retained.openingFacts, [fact]);
assert.deepEqual(
  retained.closingFacts,
  [fact],
  "unchanged fact and original citation survive without model repetition",
);
await assert.rejects(
  resolveStoryboardVisualState({
    history: nextHistory,
    messageId: "a1",
    locationContext: "workshop",
    checkpoints: [JSON.stringify(initial)],
    complete: async () => ({
      openingChanges: { remove: [9], upsert: [] },
      closingChanges: { remove: [], upsert: [] },
      uncertainties: [],
    }),
  }),
  /invalid model output/,
);
await assert.rejects(
  resolveStoryboardVisualState({
    history: nextHistory,
    messageId: "a1",
    locationContext: "workshop",
    checkpoints: [JSON.stringify(initial)],
    complete: async () => ({
      openingChanges: { remove: [], upsert: [{ ...fact, quote: "Invented source" }] },
      closingChanges: { remove: [], upsert: [] },
      uncertainties: [],
    }),
  }),
  /source quote/,
);
const brief = formatStoryboardVisualContext(initial, "DO_NOT_REPEAT_NARRATION");
assert.match(brief, /sits on the table/);
assert.doesNotMatch(brief, /DO_NOT_REPEAT_NARRATION|messageId|quote/);
assert.equal(initial.openingFacts[0]!.quote, fact.quote, "stored evidence remains intact");

const progress = startStoryboardProgress("test");
await progress.time("planner", async () => assert.equal(storyboardProgress("test")?.active, true));
await assert.rejects(
  progress.time("review", async () => {
    throw new Error("proof failure");
  }),
  /proof failure/,
);
progress.finish();
const status = storyboardProgress("test")!;
assert.equal(status.active, false);
assert.equal(status.steps[0]?.failed, undefined);
assert.equal(status.steps[1]?.failed, true);
assert.ok(status.steps.every((step) => typeof step.durationMs === "number"));
console.info(
  "Storyboard preparation: incremental carry/removal, citation validation, compact planner data and stage timing passed.",
);
