import assert from "node:assert/strict";
import type { GameTurnStoryboardKeyframe } from "@marinara-engine/shared";
import { findVisibleStoryboardKeyframe } from "../../packages/client/src/lib/game-storyboard-keyframes.js";
import { runMediaGenerationRequest } from "../../packages/server/src/services/image/image-generation-queue.js";
import { shouldSerializeImageGenerationRequests } from "../../packages/server/src/services/image/image-generation.js";
import { resolveGameImageGenerationConcurrency } from "../../packages/server/src/services/game/game-asset-generation.js";

const frameIndices = Array.from({ length: 10 }, (_, index) => index);
const frames = frameIndices.map((index) => ({
  id: String(index),
  index,
  image: null,
  video: null,
})) as GameTurnStoryboardKeyframe[];
assert.equal(findVisibleStoryboardKeyframe(frames, frames[0], true), frames[0]);
const releases: Array<() => void> = [];
const started: number[] = [];
const finished: number[] = [];
assert.ok(resolveGameImageGenerationConcurrency({ imgSource: "openai_chatgpt" }, 4) >= frames.length);
const jobs = frames.map((frame, index) =>
  runMediaGenerationRequest({
    connectionKey: "same-storyboard-image-connection",
    queue: shouldSerializeImageGenerationRequests(
      "openai_chatgpt",
      "",
      "openai_chatgpt",
      "gpt-image-2.5-sunburst",
      true,
    ),
    permitProfile: "openai_chatgpt_image",
    task: async () => {
      started.push(index);
      await new Promise<void>((resolve) => {
        releases[index] = resolve;
      });
      frame.image = { id: `image-${index}`, url: `/${index}.png` } as NonNullable<GameTurnStoryboardKeyframe["image"]>;
      finished.push(index);
    },
  }),
);
await new Promise<void>((resolve) => setImmediate(resolve));
assert.deepEqual(started, frameIndices, "all ten physical requests start before any finishes");
releases[1]();
await jobs[1];
assert.deepEqual(finished, [1]);
assert.equal(
  findVisibleStoryboardKeyframe(frames, frames[0], true),
  frames[1],
  "second frame is visible while first and third remain blocked",
);
releases[2]();
await jobs[2];
assert.equal(findVisibleStoryboardKeyframe(frames, frames[2], true), frames[2], "ready user selection is preserved");
assert.equal(
  findVisibleStoryboardKeyframe(frames, frames[0], true, true),
  frames[0],
  "explicit selection keeps an unfinished frame visible even when other images are ready",
);
const failedFrame = { ...frames[0]!, status: "failed" as const, error: "Fixture failure" };
assert.equal(
  findVisibleStoryboardKeyframe([failedFrame, ...frames.slice(1)], failedFrame, true, true),
  failedFrame,
  "explicit selection exposes a failed frame instead of hiding its error behind another image",
);
releases[0]();
for (const index of frameIndices.slice(3)) releases[index]();
await Promise.all(jobs);
assert.equal(findVisibleStoryboardKeyframe(frames, frames[0], false), frames[0]);
assert.equal(
  findVisibleStoryboardKeyframe(frames, frames[0], false, true)?.image?.id,
  "image-0",
  "the selected pending frame displays its own image after completion",
);
assert.equal(findVisibleStoryboardKeyframe([], null, true), null);
console.info("Storyboard requests overlap and out-of-order completed frames are immediately selectable.");
