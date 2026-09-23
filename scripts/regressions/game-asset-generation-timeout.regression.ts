import assert from "node:assert/strict";
import { gameAssetGenerationTimeoutMs } from "../../packages/client/src/lib/game-asset-generation-timeout.js";

const MINUTE_MS = 60_000;

assert.equal(gameAssetGenerationTimeoutMs({}, 1), 4 * MINUTE_MS, "an empty batch keeps the base deadline");
assert.equal(
  gameAssetGenerationTimeoutMs({ backgroundTag: "backgrounds:market" }, 1),
  4 * MINUTE_MS,
  "one background keeps the existing single-image deadline",
);
assert.equal(
  gameAssetGenerationTimeoutMs({ illustration: {} }, 1),
  4 * MINUTE_MS,
  "one illustration keeps the existing single-image deadline",
);
assert.equal(
  gameAssetGenerationTimeoutMs({ illustration: {} }, 3),
  10 * MINUTE_MS,
  "one illustration request counts all three configured physical variants",
);
assert.equal(
  gameAssetGenerationTimeoutMs({ npcsNeedingAvatars: [{}, {}] }, 1),
  7 * MINUTE_MS,
  "each requested NPC portrait contributes one image job",
);
assert.equal(
  gameAssetGenerationTimeoutMs(
    {
      backgroundTag: "backgrounds:market",
      illustration: {},
      npcsNeedingAvatars: Array.from({ length: 10 }, () => ({})),
    },
    3,
  ),
  43 * MINUTE_MS,
  "the largest schema-valid queued batch keeps enough time for all fourteen serial renders",
);
assert.equal(
  gameAssetGenerationTimeoutMs(
    {
      backgroundTag: "backgrounds:market",
      illustration: {},
      npcsNeedingAvatars: Array.from({ length: 20 }, () => ({})),
    },
    3,
  ),
  45 * MINUTE_MS,
  "out-of-contract workloads remain bounded by the server request deadline",
);
assert.equal(
  gameAssetGenerationTimeoutMs({ backgroundTag: "   ", illustration: {} }, 99),
  13 * MINUTE_MS,
  "blank backgrounds are ignored and illustration variants use the shared maximum",
);
assert.equal(
  gameAssetGenerationTimeoutMs({ backgroundTag: "backgrounds:market" }, 4),
  4 * MINUTE_MS,
  "the variant setting has no effect when the batch requests no illustration",
);

console.log("game asset generation timeout regression passed");
