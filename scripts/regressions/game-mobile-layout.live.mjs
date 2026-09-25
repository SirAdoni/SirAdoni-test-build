// Game mode on phones, against a running client: node scripts/regressions/game-mobile-layout.live.mjs URL CHAT_ID...
// Read-only: every non-GET API request is aborted. Set GAME_MOBILE_SHOTS to a folder to keep screenshots,
// and GAME_MOBILE_SIZES (for example "390x844,844x390") to narrow the viewports.
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const [url, ...chatIds] = process.argv.slice(2);
if (!url || chatIds.length === 0) throw new Error("Usage: node game-mobile-layout.live.mjs URL CHAT_ID [CHAT_ID...]");
const sizes = (process.env.GAME_MOBILE_SIZES || "360x740,390x844,412x915,844x390,915x412")
  .split(",")
  .map((size) => size.split("x").map(Number));
const shots = process.env.GAME_MOBILE_SHOTS;
const health = await fetch(new URL("/api/health", url))
  .then((response) => response.json())
  .catch(() => ({}));

async function newGameContext(browser, chatId) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
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
  return { context, page };
}

async function openGame(page, width, height) {
  await page.setViewportSize({ width, height });
  // One context per chat keeps the dev server's module cache warm; a cold load can stall, so retry once.
  for (let attempt = 0; ; attempt++) {
    try {
      await page.goto(url, { waitUntil: "commit", timeout: 240_000 });
      await page.locator('[data-component="GameNarration.ActivePanel"]').first().waitFor({ timeout: 180_000 });
      break;
    } catch (error) {
      if (attempt > 0) {
        if (shots) await page.screenshot({ path: `${shots}/live-load-failure-${width}x${height}.png` }).catch(() => {});
        throw error;
      }
    }
  }
  await page.waitForTimeout(4000);
  // App-level prompts and toasts are not part of the Game layout under test.
  for (const name of ["Got it", "Not now", "Skip Tutorial"]) {
    const button = page.getByRole("button", { name });
    if (await button.count())
      await button
        .first()
        .click({ timeout: 5000 })
        .catch(() => {});
  }
  await page.addStyleTag({ content: "[data-sonner-toaster]{display:none!important}" });
}

/** Tabs are either fully inside the tray's scroll window or fully outside it, never cut mid-button. */
function clippedTabs() {
  const tray = document.querySelector('[data-component="GameSurface.MobileWidgetTray"]');
  if (!tray) return [];
  const scroller = tray.querySelector("[data-mobile-tray-scroller]") ?? tray;
  const box = scroller.getBoundingClientRect();
  const clipped = [];
  for (const button of tray.querySelectorAll("button")) {
    const rect = button.getBoundingClientRect();
    const left = Math.max(rect.left, box.left, 0);
    const right = Math.min(rect.right, box.right, window.innerWidth);
    const visible = right - left;
    if (visible > 1 && visible < rect.width - 1)
      clipped.push(`${button.getAttribute("aria-label")} ${Math.round(visible)}/${Math.round(rect.width)}`);
  }
  return clipped;
}

function measure() {
  const vh = window.innerHeight;
  const presence = document.querySelector('[data-component="GameSurface.ScenePresence"]');
  const cut = [];
  if (presence) {
    for (const el of presence.querySelectorAll("*")) {
      const style = getComputedStyle(el);
      // Screen-reader-only labels are clipped on purpose.
      if (style.position === "absolute" && el.clientWidth <= 1) continue;
      if (el.children.length > 0 || !el.textContent.trim() || el.clientWidth === 0) continue;
      if (el.scrollWidth > el.clientWidth + 1) cut.push(el.textContent.trim());
    }
  }
  const presenceBox = presence?.getBoundingClientRect();
  const tray = document.querySelector('[data-component="GameSurface.MobileWidgetTray"]')?.getBoundingClientRect();
  const panel = document.querySelector('[data-component="GameNarration.ActivePanel"]')?.getBoundingClientRect();
  // The fixed top rows plus the widget tray: what the stack takes before narration and the composer.
  // Measured by size rather than by the tray's position, which follows the narration's content height.
  const controls = document.querySelector('[data-tour="game-controls"]')?.getBoundingClientRect();
  const topChrome = Math.max(presenceBox?.bottom ?? 0, controls?.bottom ?? 0) + (tray ? tray.height + 8 : 0);
  return {
    vw: window.innerWidth,
    vh,
    scrollWidth: document.scrollingElement.scrollWidth,
    cut,
    presenceHeight: presenceBox?.height ?? 0,
    topChrome,
    trayBottom: tray?.bottom ?? 0,
    panelTop: panel?.top ?? null,
    panelBottom: panel?.bottom ?? null,
  };
}

const browser = await chromium.launch({ headless: true });
let checks = 0;
try {
  for (const chatId of chatIds) {
    const { context, page } = await newGameContext(browser, chatId);
    try {
      for (const [width, height] of sizes) {
        const tag = `${chatId} ${width}x${height}`;
        await openGame(page, width, height);
        // The storyboard's own height is out of scope here: hide it so the stack above narration is measured.
        await page.evaluate(() => {
          const close = document.querySelector('[aria-label="Close storyboard viewer"]');
          const root = close?.closest("[data-game-skip-bg-nav]");
          if (root) root.style.display = "none";
        });
        await page.waitForTimeout(500);
        const result = await page.evaluate(measure);
        if (shots) await page.screenshot({ path: `${shots}/live-${chatId}-${width}x${height}.png` });

        assert.equal(result.scrollWidth, result.vw, `${tag}: no page-level horizontal overflow`);
        assert.deepEqual(await page.evaluate(clippedTabs), [], `${tag}: no tray tab is clipped mid-button`);
        assert.deepEqual(result.cut, [], `${tag}: Currently present labels are fully readable`);
        assert.ok(
          result.presenceHeight <= 72,
          `${tag}: Currently present stays one compact row (${result.presenceHeight}px)`,
        );
        assert.ok(
          result.vh - result.topChrome >= result.vh * 0.5,
          `${tag}: narration and composer keep at least half the height (chrome ends at ${Math.round(result.topChrome)}px)`,
        );
        assert.ok(
          result.panelTop !== null && result.panelTop >= result.trayBottom - 1 && result.panelBottom <= result.vh + 1,
          `${tag}: the narration panel sits below the tray and inside the viewport`,
        );

        // Paging through the tray keeps whole tabs and reaches the Arrange button.
        const pager = page.locator('[data-component="GameSurface.MobileWidgetTray"] [data-mobile-tray-scroll]');
        if (await pager.count()) {
          for (let step = 0; step < 6 && (await pager.getAttribute("aria-label")) === "Show more widgets"; step++) {
            await pager.click();
            await page.waitForTimeout(700);
            assert.deepEqual(await page.evaluate(clippedTabs), [], `${tag}: no clipped tab after paging`);
          }
        }
        const arrange = page.locator('[data-component="GameSurface.MobileWidgetTray"] [data-mobile-arrange-button]');
        if (await arrange.count()) {
          const box = await arrange.boundingBox();
          assert.ok(box && box.x >= 0 && box.x + box.width <= width, `${tag}: Arrange stays on screen`);
        }
        if (shots) await page.screenshot({ path: `${shots}/live-${chatId}-${width}x${height}-paged.png` });
        checks++;
        console.log(`ok ${tag}`, JSON.stringify(result));
      }
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
console.log(`game mobile layout: ${checks} viewport checks passed`);
