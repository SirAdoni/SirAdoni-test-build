import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const [url, storageState, chatId] = process.argv.slice(2);
if (!url || !chatId) throw new Error("Usage: node game-panel-autogrow.browser.mjs URL STORAGE_STATE CHAT_ID");

const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const context = await browser.newContext({ storageState, serviceWorkers: "block" });
  await context.addInitScript((id) => {
    localStorage.setItem("marinara-active-chat-id", id);
    if (!sessionStorage.getItem("game-panel-autogrow-fixture")) {
      localStorage.removeItem(`marinara-game-panel:${id}:floating:toolbar:top-center-lock`);
      sessionStorage.setItem("game-panel-autogrow-fixture", "true");
    }
  }, chatId);
  const page = await context.newPage();
  await page.route("**/api/**", (route) => (route.request().method() === "GET" ? route.continue() : route.abort()));
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(url);
  await page.locator('[data-game-floating-panel="map"]').waitFor();
  const editButton = page.getByRole("button", { name: /edit layout|done editing/i }).first();
  if ((await editButton.getAttribute("aria-pressed")) !== "true") await editButton.click();
  const toolbar = page.locator('[data-game-floating-panel="toolbar"]');
  const topCenterButton = toolbar.locator('button[aria-label*="top center" i]');
  await topCenterButton.waitFor();
  await topCenterButton.click();
  assert.equal(await topCenterButton.getAttribute("aria-pressed"), "true", "toolbar top-center pin toggles on");
  for (const width of [1920, 1440]) {
    await page.setViewportSize({ width, height: 1080 });
    await page.waitForTimeout(300);
    const toolbarBox = await toolbar.boundingBox();
    assert.ok(toolbarBox, "toolbar remains rendered while pinned");
    assert.ok(Math.abs(toolbarBox.x + toolbarBox.width / 2 - width / 2) <= 2, `${width}: toolbar stays centered`);
  }
  assert.ok(
    await toolbar.locator('[data-panel-layout-controls] button[aria-label*="move" i]').isDisabled(),
    "pinned toolbar disables dragging",
  );
  await page.reload();
  await page.locator('[data-game-floating-panel="toolbar"]').waitFor();
  const editAfterReload = page.getByRole("button", { name: /edit layout|done editing/i }).first();
  if ((await editAfterReload.getAttribute("aria-pressed")) !== "true") await editAfterReload.click();
  const pinnedAfterReload = page
    .locator('[data-game-floating-panel="toolbar"]')
    .locator('button[aria-label*="top center" i]');
  assert.equal(await pinnedAfterReload.getAttribute("aria-pressed"), "true", "toolbar pin survives reload");
  const reloadedBox = await page.locator('[data-game-floating-panel="toolbar"]').boundingBox();
  assert.ok(reloadedBox && Math.abs(reloadedBox.x + reloadedBox.width / 2 - 1440 / 2) <= 2, "pin restores centered");
  await pinnedAfterReload.click();
  assert.equal(await pinnedAfterReload.getAttribute("aria-pressed"), "false", "toolbar top-center pin toggles off");
  // Unpinning intentionally restores the saved position and reflows neighbours.
  // Measure jitter after that transition, not during the requested movement.
  await page.waitForTimeout(1000);

  const measure = () =>
    page.evaluate(() => {
      const host = document.querySelector("[data-game-floating-panel]")?.parentElement;
      const panels = [...document.querySelectorAll("[data-game-floating-panel]")].map((panel) => {
        const rect = panel.getBoundingClientRect();
        const content = panel.querySelector("[data-game-panel-content]");
        return {
          id: panel.getAttribute("data-game-floating-panel"),
          rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
          content: content
            ? {
                scrollHeight: content.scrollHeight,
                clientHeight: content.clientHeight,
                overflowY: getComputedStyle(content).overflowY,
              }
            : null,
        };
      });
      const overlaps = panels.flatMap((a, index) =>
        panels
          .slice(index + 1)
          .filter(
            (b) =>
              a.rect.left < b.rect.right - 1 &&
              a.rect.right > b.rect.left + 1 &&
              a.rect.top < b.rect.bottom - 1 &&
              a.rect.bottom > b.rect.top + 1,
          )
          .map((b) => [a.id, b.id]),
      );
      return {
        panels,
        overlaps,
        host: host?.getBoundingClientRect().toJSON() ?? null,
        viewport: { width: innerWidth, height: innerHeight },
      };
    });

  const first = await measure();
  const widgetPanels = first.panels.filter((panel) => panel.id?.startsWith("widget:") || panel.id === "map");
  assert.ok(widgetPanels.length > 0, "fixture renders map or widget panels");
  for (const panel of widgetPanels) {
    if (!panel.content) continue;
    const constrained = panel.content.scrollHeight > panel.content.clientHeight + 2;
    if (!constrained) assert.notEqual(panel.content.overflowY, "auto", `${panel.id}: fitting content has no scrollbar`);
  }
  assert.deepEqual(first.overlaps, [], "autogrowing panels remain non-overlapping");
  for (const panel of first.panels) {
    assert.ok(panel.rect.left >= -1 && panel.rect.top >= -1, `${panel.id}: panel stays inside the surface origin`);
    assert.ok(
      panel.rect.right <= first.viewport.width + 1 && panel.rect.bottom <= first.viewport.height + 1,
      `${panel.id}: panel stays in viewport`,
    );
  }

  await page.waitForTimeout(700);
  const settled = await measure();
  assert.deepEqual(settled.panels, first.panels, "autogrow layout settles without resize jitter");
  console.info("Game panel autogrow regression passed");
} finally {
  await browser.close();
}
