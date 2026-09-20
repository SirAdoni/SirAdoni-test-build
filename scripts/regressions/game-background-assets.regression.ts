import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../../packages/client/src/components/game/GameSurface.tsx", import.meta.url),
  "utf8",
);
const start = source.indexOf("        const markSceneReady = () => {");
const returnEndMarker = "        return;";
const returnEnd = source.indexOf(returnEndMarker, start);
assert.ok(start >= 0 && returnEnd > start);
// Keep the extracted branch self-contained while following the current source through its early return.
const branchBody = source.slice(start, returnEnd + returnEndMarker.length);
const branch = `if (true) {\n${branchBody}\n}`;

for (const fails of [false, true]) {
  const events: string[] = [];
  let finish!: (value: object) => void;
  let fail!: (error: Error) => void;
  const job = new Promise<object>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  const ready = { current: null as string | null };
  const run = new Function(
    "sceneReadyMsgIdRef",
    "msg",
    "setSceneReadyTick",
    "setPendingAssetGeneration",
    "assetPayload",
    "blocksScene",
    "setAssetGenerationBlocksScene",
    "setAssetGenerationFailed",
    "runGameAssetGeneration",
    "applyGeneratedAssets",
    branch,
  );
  run(
    ready,
    { id: "turn" },
    () => events.push("ready"),
    () => {},
    {},
    false,
    (blocked: boolean) => assert.equal(blocked, false),
    () => {},
    () => job,
    async () => {
      events.push("installed");
    },
  );
  assert.equal(ready.current, "turn", "Narration must be ready before image generation resolves");
  assert.deepEqual(events, ["ready"]);
  if (fails) fail(new Error("provider failure"));
  else finish({ generatedNpcAvatars: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, fails ? ["ready"] : ["ready", "installed"]);
}
console.log("Background assets release narration immediately and install late results.");
