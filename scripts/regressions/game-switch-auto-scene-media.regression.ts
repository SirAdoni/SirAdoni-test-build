// Per-game "Automatic scene media" switch (chat metadata gameAutoSceneMediaEnabled; absent = ON).
// ON keeps today's post-turn queueAutomaticGameMedia call; OFF queues nothing (upstream has no automatic
// scene media queue). The gate is the only call site, so a source check pins it to the chat's switch.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isGameAutoSceneMediaEnabled } from "../../packages/shared/src/index.js";

assert.equal(isGameAutoSceneMediaEnabled(undefined), true);
assert.equal(isGameAutoSceneMediaEnabled({}), true, "absent key is ON");
assert.equal(isGameAutoSceneMediaEnabled({ gameAutoSceneMediaEnabled: true }), true);
assert.equal(isGameAutoSceneMediaEnabled({ gameAutoSceneMediaEnabled: false }), false);

const serverSrc = new URL("../../packages/server/src/", import.meta.url);
const generate = readFileSync(new URL("routes/generate.routes.ts", serverSrc), "utf8");
const calls = generate.match(/queueAutomaticGameMedia\(/g) ?? [];
assert.equal(calls.length, 1, "one automatic media call site");
assert.match(generate, /if \(isGameAutoSceneMediaEnabled\(chatMeta\)\)\s+await queueAutomaticGameMedia\(app, \{/);

console.log("game-switch-auto-scene-media regression passed");
