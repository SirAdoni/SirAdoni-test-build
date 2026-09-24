// Landscape phone vs tablet in a real browser: lib/game-short-landscape.ts sets the root attribute from the
// emulated screen, and the compiled game-short-landscape: variant follows it. A 1024x768 tablet whose
// on-screen keyboard shrinks the viewport to 1023x461 keeps the tablet layout; landscape phones fold as before.
// Run from the repo root: node scripts/regressions/game-short-landscape.browser.mjs
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import { resolve } from "node:path";
import { buildClientCss } from "../ui-fixtures/lib/build-client-css.mjs";

const tempDirectory = await fs.mkdtemp(resolve(os.tmpdir(), "marinara-short-landscape-"));
const cssPath = resolve(tempDirectory, "client.css");
await buildClientCss(cssPath);
const css = await fs.readFile(cssPath, "utf8");
const moduleSource = resolve("packages/client/src/lib/game-short-landscape.ts").replaceAll("\\", "/");
const bundle = await build({
  stdin: {
    contents: `import { isShortLandscapeGame } from '${moduleSource}'; window.isShortLandscapeGame = isShortLandscapeGame;`,
    loader: "ts",
    resolveDir: process.cwd(),
  },
  nodePaths: [resolve("packages/client/node_modules")],
  bundle: true,
  write: false,
  format: "iife",
});
// Class strings copied from GameSurface.tsx: the tablet toolbar row and the phone actions button.
const html = `<style>${css}</style>
<div data-fixture="tablet-row" class="pointer-events-auto hidden items-center md:flex game-short-landscape:hidden">row</div>
<div data-fixture="phone-actions" class="pointer-events-auto md:hidden game-short-landscape:block">actions</div>
<div data-fixture="retry-line" class="max-lg:static game-short-landscape:hidden game-short-tablet:hidden">retry</div>`;

function state() {
  const display = (name) => getComputedStyle(document.querySelector(`[data-fixture="${name}"]`)).display;
  return {
    attribute: document.documentElement.hasAttribute("data-game-short-landscape"),
    tablet: document.documentElement.hasAttribute("data-game-short-tablet"),
    flag: window.isShortLandscapeGame(),
    tabletRow: display("tablet-row"),
    phoneActions: display("phone-actions"),
    retryLine: display("retry-line"),
    screen: `${screen.width}x${screen.height}`,
  };
}

/**
 * Playwright resets window.screen to the viewport on every setViewportSize, and a real device's screen
 * does not shrink with its keyboard, so the device screen is pinned with an init script instead.
 */
async function openFixture(browser, [width, height], [screenWidth, screenHeight]) {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: width < 1440 });
  await context.addInitScript(
    ([w, h]) => {
      Object.defineProperty(screen, "width", { get: () => w, configurable: true });
      Object.defineProperty(screen, "height", { get: () => h, configurable: true });
    },
    [screenWidth, screenHeight],
  );
  await context.route("http://short-landscape.fixture/", (route) =>
    route.fulfill({ contentType: "text/html", body: html }),
  );
  const page = await context.newPage();
  await page.goto("http://short-landscape.fixture/");
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  return page;
}

const PHONE = {
  attribute: true,
  tablet: false,
  flag: true,
  tabletRow: "none",
  phoneActions: "block",
  retryLine: "none",
};
const TABLET = {
  attribute: false,
  tablet: false,
  flag: false,
  tabletRow: "flex",
  phoneActions: "none",
  retryLine: "block",
};
// The keyboard is up on a tablet: tablet layout, with the column's secondary chrome stepping aside.
const SHORT_TABLET = { ...TABLET, tablet: true, retryLine: "none" };
const PORTRAIT_PHONE = {
  attribute: false,
  tablet: false,
  flag: false,
  tabletRow: "none",
  phoneActions: "block",
  retryLine: "block",
};
// [label, viewport, screen, expected, keyboard viewport height, expected with the keyboard up]
const cases = [
  ["390x844 phone", [390, 844], [390, 844], PORTRAIT_PHONE],
  ["820x1180 tablet", [820, 1180], [820, 1180], TABLET, 700, TABLET],
  ["1024x768 tablet", [1024, 768], [1024, 768], TABLET],
  ["1023x768 tablet", [1023, 768], [1024, 768], TABLET, 461, SHORT_TABLET],
  ["1023x461 tablet loaded with the keyboard up", [1023, 461], [1024, 768], SHORT_TABLET],
  ["844x390 landscape phone", [844, 390], [844, 390], PHONE, 200, PHONE],
  ["915x412 landscape phone", [915, 412], [915, 412], PHONE],
  ["740x360 landscape phone", [740, 360], [740, 360], PHONE],
  ["844x390 landscape phone, portrait screen report", [844, 390], [390, 844], PHONE],
  ["1440x900 desktop", [1440, 900], [1440, 900], TABLET],
];

const browser = await chromium.launch({ headless: true });
let checks = 0;
try {
  for (const [
    label,
    [width, height],
    [screenWidth, screenHeight],
    expected,
    keyboardHeight,
    keyboardExpected,
  ] of cases) {
    const page = await openFixture(browser, [width, height], [screenWidth, screenHeight]);
    const context = page.context();
    const loaded = await page.evaluate(state);
    assert.equal(loaded.screen, `${screenWidth}x${screenHeight}`, `${label}: screen emulated`);
    assert.deepEqual({ ...loaded, screen: undefined }, { ...expected, screen: undefined }, `${label}: layout`);
    checks++;
    if (keyboardHeight) {
      // The on-screen keyboard shrinks the viewport; the screen stays the device's.
      await page.setViewportSize({ width, height: keyboardHeight });
      await page.waitForFunction(() => window.innerHeight < 720);
      await page.waitForTimeout(100);
      const keyboard = await page.evaluate(state);
      assert.equal(keyboard.screen, `${screenWidth}x${screenHeight}`, `${label} keyboard: screen unchanged`);
      assert.deepEqual(
        { ...keyboard, screen: undefined },
        { ...keyboardExpected, screen: undefined },
        `${label} with the keyboard up (${width}x${keyboardHeight})`,
      );
      checks++;
    }
    await context.close();
  }
  // A phone rotating to landscape flips the attribute live, without a reload.
  const page = await openFixture(browser, [390, 844], [390, 844]);
  const context = page.context();
  assert.equal((await page.evaluate(state)).attribute, false, "portrait phone: no attribute");
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForFunction(() => document.documentElement.hasAttribute("data-game-short-landscape"));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => !document.documentElement.hasAttribute("data-game-short-landscape"));
  checks++;
  await context.close();
  console.log(`game short landscape browser: ${checks} checks passed`);
} finally {
  await browser.close();
  await fs.rm(tempDirectory, { recursive: true, force: true });
}
