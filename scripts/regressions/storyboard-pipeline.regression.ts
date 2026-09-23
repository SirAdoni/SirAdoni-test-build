import assert from "node:assert/strict";
import {
  claimStoryboardTurn,
  parseStoryboardCast,
} from "../../packages/server/src/services/game/storyboard-admission.js";
import { reviewAndCorrectStoryboardVisualPlan } from "../../packages/server/src/services/game/storyboard-visual-context.js";

const release = claimStoryboardTurn("chat", "turn-a", 0)!;
assert.ok(release);
assert.equal(claimStoryboardTurn("chat", "turn-a", 0), null);
const other = claimStoryboardTurn("chat", "turn-b", 0);
assert.ok(other, "another turn starts without waiting for old image jobs");
release();
release();
other();
const retried = claimStoryboardTurn("chat", "turn-a", 0);
assert.ok(retried);
retried();
assert.deepEqual(parseStoryboardCast('["Quenby","Rowan Mercer"]'), ["Quenby", "Rowan Mercer"]);
assert.deepEqual(parseStoryboardCast("Quenby, Rowan Mercer"), ["Quenby", "Rowan Mercer"]);
let calls = 0;
const args = {
  context: "Quenby has a bronze body and stands by the table.",
  locationContext: "Workshop",
  frames: [{ imagePrompt: "Quenby sits by the table.", characters: ["Quenby"] }],
  complete: async () => {
    calls++;
    return {
      consistent: true,
      reason: "Corrected posture",
      corrections: [{ index: 0, imagePrompt: "Quenby stands by the table.", characters: ["Quenby"] }],
    };
  },
};
const corrected = await reviewAndCorrectStoryboardVisualPlan(args);
assert.equal(calls, 1, "correction needs no full rewrite or second review call");
assert.equal(corrected[0]!.imagePrompt, "Quenby stands by the table.");
await assert.rejects(
  reviewAndCorrectStoryboardVisualPlan({
    ...args,
    complete: async () => ({ consistent: false, reason: "Missing evidence", corrections: [] }),
  }),
  /Missing evidence/,
);
await assert.rejects(
  reviewAndCorrectStoryboardVisualPlan({
    ...args,
    complete: async () => ({
      consistent: true,
      reason: "bad",
      corrections: [{ index: 8, imagePrompt: "Wrong frame", characters: [] }],
    }),
  }),
);
console.info("Storyboard admission, persisted cast decoding and one-pass corrective review passed.");
