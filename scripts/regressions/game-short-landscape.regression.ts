// Landscape phone Game layout is chosen by the device's screen, not the keyboard-shrunk viewport:
// a landscape tablet with its on-screen keyboard up (1023x461 on a 1024x768 screen) keeps the tablet layout.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  classifyShortGameViewport,
  isShortLandscapeGameEnvironment,
  PHONE_SCREEN_SHORT_SIDE_MAX,
  SHORT_LANDSCAPE_ATTRIBUTE,
} from "../../packages/client/src/lib/game-short-landscape.ts";

/** Mirrors SHORT_LANDSCAPE_VIEWPORT_QUERY at the default 16px root size. */
const shortViewport = (width: number, height: number) => width <= 1023 && height <= 512;
const flag = (viewport: [number, number], screen: [number, number]) =>
  isShortLandscapeGameEnvironment({
    shortViewport: shortViewport(...viewport),
    screenWidth: screen[0],
    screenHeight: screen[1],
  });

// Landscape phones behave as before.
for (const size of [
  [844, 390],
  [915, 412],
  [740, 360],
] as [number, number][]) {
  assert.equal(flag(size, size), true, `${size.join("x")} landscape phone`);
  // iOS reports the portrait screen whatever the orientation.
  assert.equal(flag(size, [size[1], size[0]]), true, `${size.join("x")} landscape phone, portrait screen`);
  // The keyboard makes a landscape phone shorter still.
  assert.equal(
    flag([size[0], Math.round(size[1] * 0.5)], size),
    true,
    `${size.join("x")} landscape phone with keyboard`,
  );
}

// Tablets keep the tablet layout, with or without the keyboard.
assert.equal(flag([1024, 768], [1024, 768]), false, "1024x768 tablet");
assert.equal(flag([1023, 461], [1024, 768]), false, "1023x461 tablet with the keyboard up");
assert.equal(flag([1023, 461], [768, 1024]), false, "1023x461 tablet with the keyboard up, portrait screen report");
assert.equal(flag([1180, 492], [1180, 820]), false, "1180x820 tablet with the keyboard up");
assert.equal(flag([820, 1180], [820, 1180]), false, "820x1180 portrait tablet");
assert.equal(flag([1440, 900], [1440, 900]), false, "1440x900 desktop");
assert.equal(flag([390, 844], [390, 844]), false, "390x844 portrait phone");
assert.equal(flag([900, 450], [1920, 1080]), false, "short desktop window on a large screen");
assert.equal(flag([900, 450], [599, 960]), true, "just under the phone threshold");
assert.equal(flag([900, 450], [PHONE_SCREEN_SHORT_SIDE_MAX, 960]), false, "at the phone threshold");
// A short tablet keeps the tablet layout, flagged so the chrome that would squeeze the composer steps aside.
const state = (viewport: [number, number], screen: [number, number]) =>
  classifyShortGameViewport({
    shortViewport: shortViewport(...viewport),
    screenWidth: screen[0],
    screenHeight: screen[1],
  });
assert.equal(state([1023, 461], [1024, 768]), "tablet", "1023x461 on a 1024x768 screen is a short tablet");
assert.equal(state([844, 390], [844, 390]), "phone", "844x390 on a phone screen is a landscape phone");
assert.equal(state([1023, 768], [1024, 768]), null, "a tablet without the keyboard is not short");
assert.equal(state([1024, 461], [1024, 768]), null, "the floating layout (1024px and wider) is never short");
assert.equal(state([390, 844], [390, 844]), null, "a portrait phone is not short");

// No screen report: fall back to the viewport, as before.
assert.equal(flag([844, 390], [0, 0]), true, "unknown screen keeps the viewport answer");

// Every Game layout rule for landscape phones goes through the root attribute, not a raw max-height media query.
const repo = path.resolve(import.meta.dirname, "../..");
const gameDir = path.join(repo, "packages/client/src/components/game");
for (const file of fs.readdirSync(gameDir).filter((name) => name.endsWith(".tsx"))) {
  const source = fs.readFileSync(path.join(gameDir, file), "utf8");
  assert.ok(!source.includes("[@media(max-height:32rem)]"), `${file}: no max-height 32rem variant left`);
  assert.ok(!/matchMedia\([^)]*max-height:\s*32rem/.test(source), `${file}: no max-height 32rem media match left`);
}
const globals = fs.readFileSync(path.join(repo, "packages/client/src/styles/globals.css"), "utf8");
assert.ok(
  globals.includes(`@custom-variant game-short-landscape (&:where([${SHORT_LANDSCAPE_ATTRIBUTE}] *));`),
  "globals.css defines the game-short-landscape variant on the root attribute",
);
assert.ok(
  globals.includes("@custom-variant game-short-tablet (&:where([data-game-short-tablet] *));"),
  "globals.css defines the game-short-tablet variant",
);
assert.ok(!globals.includes("min-height: 32.0625rem"), "touch tablet targets follow the root attribute too");

console.log("game short landscape: phone and tablet detection passed");
