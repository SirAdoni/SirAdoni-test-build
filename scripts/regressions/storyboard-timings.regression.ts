import assert from "node:assert/strict";
import {
  startStoryboardProgress,
  storyboardProgress,
  storyboardProgressHistory,
  timeStoryboardStage,
} from "../../packages/server/src/services/game/storyboard-progress.js";
import { runMediaGenerationRequest } from "../../packages/server/src/services/image/image-generation-queue.js";

const run = startStoryboardProgress("timing-proof");
const release: Array<() => void> = [];
const jobs = [0, 1, 2].map((index) =>
  run.time(`Frame ${index}`, () =>
    runMediaGenerationRequest({
      connectionKey: "fixture",
      queue: false,
      permitProfile: "openai_chatgpt_image",
      task: () =>
        timeStoryboardStage(
          "Image request",
          () =>
            new Promise<void>((resolve) => {
              release[index] = resolve;
            }),
        ),
    }),
  ),
);
await new Promise<void>((resolve) => setImmediate(resolve));
const live = storyboardProgress("timing-proof")!;
assert.equal(live.active, true);
assert.equal(release.length, 3);
for (const index of [0, 1, 2]) {
  assert.ok(
    live.steps.some((step) => step.stage === `Frame ${index} / Provider slot wait` && step.durationMs !== undefined),
  );
  assert.ok(
    live.steps.some((step) => step.stage === `Frame ${index} / Image request` && step.durationMs === undefined),
  );
}
release[1]();
await jobs[1];
assert.ok(
  storyboardProgress("timing-proof")!.steps.find((step) => step.stage === "Frame 1 / Image request")!.durationMs !==
    undefined,
);
assert.equal(
  storyboardProgress("timing-proof")!.steps.find((step) => step.stage === "Frame 0 / Image request")!.durationMs,
  undefined,
);
release[0]();
release[2]();
await Promise.all(jobs);
await assert.rejects(
  run.time("Failure", async () => {
    throw new Error("fixture");
  }),
);
await run.finish();
const done = storyboardProgress("timing-proof")!;
assert.equal(done.active, false);
assert.ok(done.steps.every((step) => step.offsetMs >= 0 && step.durationMs !== undefined));
assert.equal(done.steps.at(-1)!.failed, true);
assert.equal(await timeStoryboardStage("Outside storyboard", async () => 42), 42);
const older = startStoryboardProgress("timing-proof-history", undefined, {
  messageId: "older",
  swipeIndex: 0,
  previewOnly: false,
});
const newer = startStoryboardProgress("timing-proof-history", undefined, {
  messageId: "newer",
  swipeIndex: 0,
  previewOnly: false,
});
await newer.finish();
await older.finish();
const history = await storyboardProgressHistory("timing-proof-history");
assert.deepEqual(
  history.slice(-2).map((entry) => entry.messageId),
  ["newer", "older"],
  "finishing an older concurrent run cannot overwrite or misidentify a newer run",
);
console.info("Timing scopes remain isolated across concurrent frames; waits, completion and failure are captured.");
