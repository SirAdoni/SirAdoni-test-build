import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

// Read-only live fixture: URL, browser storage state, and affected campaign ID.
const [url, storageState, chatId] = process.argv.slice(2);
if (!url || !chatId) throw new Error("Usage: node game-panel-viewport.browser.mjs URL STORAGE_STATE CHAT_ID");
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const context = await browser.newContext({ storageState, serviceWorkers: "block" });
  await context.addInitScript((id) => localStorage.setItem("marinara-active-chat-id", id), chatId);
  const page = await context.newPage();
  await page.route("**/api/**", (route) => (route.request().method() === "GET" ? route.continue() : route.abort()));
  await page.goto(url);
  await page.locator('[data-game-floating-panel="narration"]').waitFor();
  for (const viewport of [
    { width: 2560, height: 1348 },
    { width: 2048, height: 1078 },
    { width: 1280, height: 720 },
  ]) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(700);
    const inspect = async () =>
      page.evaluate(() => {
        const elements = [...document.querySelectorAll("[data-game-floating-panel]")];
        const host = elements[0].parentElement;
        const bounds = host.getBoundingClientRect();
        const panels = elements.map((e) => {
          const r = e.getBoundingClientRect();
          return { id: e.dataset.gameFloatingPanel, x: r.x, y: r.y, right: r.right, bottom: r.bottom };
        });
        const overlaps = panels.flatMap((a, i) =>
          panels
            .slice(i + 1)
            .filter((b) => a.x < b.right - 1 && a.right > b.x + 1 && a.y < b.bottom - 1 && a.bottom > b.y + 1)
            .map((b) => [a.id, b.id]),
        );
        host.scrollTop = 200;
        return {
          scrollTop: host.scrollTop,
          overlaps,
          outside: panels.filter(
            (r) =>
              r.x < bounds.x - 1 || r.y < bounds.y - 1 || r.right > bounds.right + 1 || r.bottom > bounds.bottom + 1,
          ),
          panels,
        };
      });
    const first = await inspect();
    assert.equal(first.scrollTop, 0, "game surface cannot scroll headers out of view");
    assert.deepEqual(first.overlaps, [], `${viewport.width}: panels do not overlap`);
    assert.deepEqual(first.outside, [], `${viewport.width}: panels stay in viewport`);
    await page.waitForTimeout(700);
    assert.deepEqual((await inspect()).panels, first.panels, "layout settles without oscillation");
    console.info(`Viewport ${viewport.width}x${viewport.height}: bounded, stable, no overlaps`);
  }
  const internalScroll = await page.locator("[data-game-panel-content]").evaluateAll((elements) => {
    const scrollable = elements.find((e) => e.scrollHeight > e.clientHeight + 5);
    if (!scrollable) return null;
    scrollable.scrollTop = 30;
    return scrollable.scrollTop;
  });
  assert.ok(internalScroll > 0, "crowded content remains internally scrollable");
} finally {
  await browser.close();
}
