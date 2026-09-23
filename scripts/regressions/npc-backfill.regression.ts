import assert from "node:assert/strict";
import { runNpcBackfillBatches } from "../../packages/server/src/services/game/npc-backfill.js";
import {
  NpcAppearanceReviewError,
  validateNpcAppearance,
} from "../../packages/server/src/services/game/npc-visual-review.js";

const checkpoints: Array<{ status: string; pass: number }> = [];
let calls = 0;
const queue = ["rejected-1", "rejected-2", "rejected-3", "rejected-4", "confirmed-5"];
const result = await runNpcBackfillBatches({
  runBatch: async () => {
    calls += 1;
    return { changed: Boolean(queue.shift()) };
  },
  saveCheckpoint: async (status, pass) => checkpoints.push({ status, pass }),
});
assert.equal(result.passes, 6, "backfill continues after rejected batches to reach later candidates");
assert.deepEqual(
  checkpoints.map(({ status, pass }) => [status, pass]),
  [
    ["running", 0],
    ["running", 1],
    ["running", 2],
    ["running", 3],
    ["running", 4],
    ["running", 5],
    ["completed", 6],
  ],
);
assert.equal(calls, 6);

const partialStates: string[] = [];
let partialPass = 0;
await runNpcBackfillBatches({
  runBatch: async () => (++partialPass === 1 ? { changed: true, issues: 1 } : { changed: false }),
  saveCheckpoint: async (status) => {
    partialStates.push(status);
  },
});
assert.equal(partialPass, 2, "a review-needed target does not stop later batches");
assert.equal(
  partialStates.at(-1),
  "completed_with_issues",
  "an earlier review failure is retained after a clean final batch",
);

let failedCalls = 0;
let reviewCalls = 0;
await assert.rejects(
  runNpcBackfillBatches({
    runBatch: async () => {
      failedCalls += 1;
      if (failedCalls === 2) throw new Error("simulated disconnect");
      return { changed: true };
    },
    saveCheckpoint: async (status, pass) => checkpoints.push({ status, pass }),
  }),
  /simulated disconnect/u,
);
assert.equal(checkpoints.at(-1)?.status, "failed", "failed batch leaves a resumable checkpoint");
await assert.rejects(
  validateNpcAppearance({
    name: "Review Needed",
    appearance: "A generic appearance that is long enough for the schema to accept as input.",
    context: "historical evidence",
    complete: async () => {
      reviewCalls += 1;
      return reviewCalls === 2
        ? JSON.stringify({ appearance: "A concrete reviewed appearance with enough descriptive detail." })
        : JSON.stringify({ accepted: false, observed: "generic unknown appearance", issues: ["needs review"] });
    },
  }),
  (error: unknown) => error instanceof NpcAppearanceReviewError,
);
console.log("npc backfill regression passed");
