// Game mode on landscape phones, against a running client:
//   node scripts/regressions/game-mobile-landscape.live.mjs URL CHAT_ID [CHAT_ID...]
// Read-only: every non-GET API request is aborted. Set GAME_MOBILE_SHOTS to a folder to keep screenshots.
// The Game chrome (presence, widgets, storyboard, retry) folds into one top row, the narration column keeps
// at least 60% of the viewport height, the composer is one line until focused, and it stays usable when focused.
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const [url, ...chatIds] = process.argv.slice(2);
if (!url || chatIds.length === 0)
  throw new Error("Usage: node game-mobile-landscape.live.mjs URL CHAT_ID [CHAT_ID...]");
const sizes = (process.env.GAME_MOBILE_SIZES || "844x390,915x412,740x360")
  .split(",")
  .map((size) => size.split("x").map(Number));
const shots = process.env.GAME_MOBILE_SHOTS;
const health = await fetch(new URL("/api/health", url))
  .then((response) => response.json())
  .catch(() => ({}));

function measure() {
  const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect() ?? null;
  const visible = (element) => element && element.getClientRects().length > 0;
  const topRow = [
    '[data-component="GameSurface.MobileWidgetTray"]',
    '[data-tour="game-controls"]',
    "[data-storyboard-phone-tab]",
  ]
    .map(rect)
    .filter((box) => box && box.height > 0);
  const column = rect('[data-tour="game-dialogue"]');
  const dock = [...document.querySelectorAll("[data-game-composer-dock]")].find(visible);
  const textarea = [...document.querySelectorAll("textarea")].find(visible);
  const box = textarea?.getBoundingClientRect();
  const hit = box ? document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) : null;
  const small = [
    ...document.querySelectorAll(
      '[data-component="GameSurface.MobileWidgetTray"] button, [data-storyboard-phone-tab], [data-tour="game-controls"] button',
    ),
  ]
    .filter(visible)
    .map((button) => ({ label: button.getAttribute("aria-label"), box: button.getBoundingClientRect() }))
    .filter(({ box }) => box.width > 0 && (box.width < 35.5 || box.height < 35.5))
    .map(({ label, box }) => `${label} ${Math.round(box.width)}x${Math.round(box.height)}`);
  return {
    vw: window.innerWidth,
    vh: window.innerHeight,
    screenShortSide: Math.min(screen.width, screen.height),
    shortLandscape: document.documentElement.hasAttribute("data-game-short-landscape"),
    scrollWidth: document.scrollingElement.scrollWidth,
    topRowTops: topRow.map((b) => Math.round(b.top)),
    topRowBottom: Math.max(0, ...topRow.map((b) => b.bottom)),
    columnTop: column?.top ?? null,
    columnHeight: column?.height ?? 0,
    presenceStrip: !!document.querySelector('[data-component="GameSurface.ScenePresence"]'),
    retryLine: [...document.querySelectorAll("[data-game-asset-retry-line]")].some(visible),
    dockHeight: dock?.getBoundingClientRect().height ?? null,
    textareaTop: box?.top ?? null,
    textareaBottom: box?.bottom ?? null,
    textareaHit: !!textarea && (hit === textarea || textarea.contains(hit)),
    smallTargets: small,
    // Every top-row control in view is the element a tap at its centre reaches.
    covered: [
      ...document.querySelectorAll(
        '[data-component="GameSurface.MobileWidgetTray"] button, [data-storyboard-phone-tab], [data-tour="game-controls"] button',
      ),
    ]
      .filter(visible)
      .filter((button) => {
        const b = button.getBoundingClientRect();
        const scroller = button.closest("[data-mobile-tray-scroller]")?.getBoundingClientRect();
        const x = b.left + b.width / 2;
        if (b.width === 0 || (scroller && (x < scroller.left || x > scroller.right))) return false;
        const hit = document.elementFromPoint(x, b.top + b.height / 2);
        return !button.contains(hit);
      })
      .map((button) => button.getAttribute("aria-label") ?? button.textContent.trim()),
  };
}

const browser = await chromium.launch({ headless: true });
let checks = 0;
try {
  for (const chatId of chatIds) {
    const context = await browser.newContext({
      viewport: { width: 844, height: 390 },
      isMobile: true,
      hasTouch: true,
      serviceWorkers: "block",
    });
    await context.addInitScript(
      ({ id, version }) => {
        localStorage.setItem("marinara-active-chat-id", id);
        if (version) localStorage.setItem("marinara:whats-new:seen-version", version);
      },
      { id: chatId, version: health.version },
    );
    const page = await context.newPage();
    await page.route("**/api/**", (route) => (route.request().method() === "GET" ? route.continue() : route.abort()));
    try {
      for (const [width, height] of sizes) {
        const tag = `${chatId} ${width}x${height}`;
        await page.setViewportSize({ width, height });
        for (let attempt = 0; ; attempt++) {
          try {
            await page.goto(url, { waitUntil: "commit", timeout: 240_000 });
            await page.locator('[data-component="GameNarration.ActivePanel"]').first().waitFor({ timeout: 180_000 });
            break;
          } catch (error) {
            if (attempt > 0) throw error;
          }
        }
        await page.waitForTimeout(4000);
        for (const name of ["Got it", "Not now", "Skip Tutorial"]) {
          const button = page.getByRole("button", { name });
          if (await button.count())
            await button
              .first()
              .click({ timeout: 3000 })
              .catch(() => {});
        }
        await page.addStyleTag({ content: "[data-sonner-toaster]{display:none!important}" });
        await page.waitForTimeout(500);

        const idle = await page.evaluate(measure);
        if (shots) await page.screenshot({ path: `${shots}/landscape-${chatId}-${width}x${height}.png` });
        // Playwright reports the viewport as the screen, so these report phone screens.
        assert.ok(idle.screenShortSide < 600, `${tag}: a phone screen (${idle.screenShortSide}px short side)`);
        assert.equal(idle.shortLandscape, true, `${tag}: the landscape phone layout is on`);
        assert.equal(idle.scrollWidth, idle.vw, `${tag}: no page-level horizontal overflow`);
        assert.ok(
          idle.topRowTops.every((top) => Math.abs(top - idle.topRowTops[0]) <= 2),
          `${tag}: tray, storyboard and actions share one top row ${JSON.stringify(idle.topRowTops)}`,
        );
        assert.equal(idle.presenceStrip, false, `${tag}: Currently present folds into the top row`);
        assert.equal(idle.retryLine, false, `${tag}: the image retry line folds into the top row`);
        assert.ok(
          idle.columnHeight >= idle.vh * 0.6,
          `${tag}: narration keeps at least 60% of the height (${Math.round(idle.columnHeight)}px of ${idle.vh})`,
        );
        assert.ok(idle.columnTop >= idle.topRowBottom - 1, `${tag}: narration starts below the top row`);
        assert.ok(
          idle.dockHeight !== null && idle.dockHeight <= 80,
          `${tag}: composer is one line (${idle.dockHeight}px)`,
        );
        assert.ok(idle.textareaHit && idle.textareaBottom <= idle.vh, `${tag}: composer is visible and on top`);
        assert.deepEqual(idle.smallTargets, [], `${tag}: top-row controls are at least 36px`);
        assert.deepEqual(idle.covered, [], `${tag}: top-row controls are reachable by tap`);
        const presence = page.locator("[data-mobile-presence-tab]");
        if (await presence.count()) {
          await presence.click();
          const sheet = page.getByRole("dialog", { name: "Currently present" });
          await sheet.waitFor();
          if (shots) await page.screenshot({ path: `${shots}/landscape-${chatId}-${width}x${height}-presence.png` });
          await page.keyboard.press("Escape");
          await sheet.waitFor({ state: "hidden" });
        }

        const textarea = page.locator("textarea:visible").first();
        await textarea.click();
        await page.waitForTimeout(400);
        const focused = await page.evaluate(measure);
        if (shots) await page.screenshot({ path: `${shots}/landscape-${chatId}-${width}x${height}-focused.png` });
        assert.ok(
          focused.textareaHit && focused.textareaTop >= 0 && focused.textareaBottom <= focused.vh,
          `${tag}: the focused composer stays usable (elementFromPoint hits the text box)`,
        );
        const before = await textarea.inputValue();
        await page.keyboard.type("x");
        assert.equal(await textarea.inputValue(), `${before}x`, `${tag}: typing reaches the composer`);
        await page.keyboard.press("Backspace");
        checks++;
        console.log(`ok ${tag}`, JSON.stringify({ idle, focused }));
      }
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
console.log(`game mobile landscape: ${checks} viewport checks passed`);
