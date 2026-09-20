import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const [url, storageState, chatId] = process.argv.slice(2);
if (!url || !chatId) {
  throw new Error("Usage: node session-popover-layer.browser.mjs URL STORAGE_STATE CHAT_ID");
}

const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const context = await browser.newContext({ storageState, serviceWorkers: "block" });
  await context.addInitScript((id) => localStorage.setItem("marinara-active-chat-id", id), chatId);
  const page = await context.newPage();
  await page.route("**/api/**", (route) => (route.request().method() === "GET" ? route.continue() : route.abort()));
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(url);

  const sessionButton = page.locator('[data-chat-help="session"]');
  await sessionButton.waitFor();
  await sessionButton.click();
  const sessionPanel = page
    .locator("[data-chat-floating-panel]")
    .filter({ hasText: /session/i })
    .last();
  await sessionPanel.waitFor();

  const inspectLayer = () =>
    sessionPanel.evaluate((panel) => {
      const toolbar = panel.closest('[data-game-floating-panel="toolbar"]');
      if (!toolbar) throw new Error("Session popover is not inside the toolbar panel");
      const hud = [...document.querySelectorAll("[data-game-floating-panel]")].filter(
        (element) =>
          element !== toolbar && element !== panel && element.getAttribute("data-game-floating-panel") !== "toolbar",
      );
      const popover = panel.getBoundingClientRect();
      const overlaps = hud
        .map((element) => ({ element, rect: element.getBoundingClientRect() }))
        .filter(
          ({ rect }) =>
            popover.left < rect.right &&
            popover.right > rect.left &&
            popover.top < rect.bottom &&
            popover.bottom > rect.top,
        );
      const target = overlaps[0];
      if (!target) return { overlaps: 0, toolbarZ: getComputedStyle(toolbar).zIndex, hit: null };
      const x = Math.max(popover.left, target.rect.left) + 4;
      const y = Math.max(popover.top, target.rect.top) + 4;
      return {
        overlaps: overlaps.length,
        toolbarZ: getComputedStyle(toolbar).zIndex,
        hit: document.elementFromPoint(x, y)?.closest("[data-chat-floating-panel]")?.isSameNode(panel) ?? false,
      };
    });
  const layerState = await inspectLayer();
  assert.equal(layerState.toolbarZ, "40", "toolbar keeps its interactive layer when the popover is open");
  assert.ok(layerState.overlaps > 0, "fixture contains a HUD overlap point for the popover check");
  assert.equal(layerState.hit, true, "popover wins hit testing over the overlapping HUD panel");

  // Clicking plain header/body content must not trigger outside-dismiss.
  await sessionPanel.click({ position: { x: 20, y: 20 } });
  await sessionPanel.waitFor();
  const afterBodyClick = await inspectLayer();
  assert.equal(afterBodyClick.toolbarZ, "40", "toolbar layer stays elevated after body focus changes");
  assert.ok(afterBodyClick.overlaps > 0, "the overlap remains present after body click");
  assert.equal(afterBodyClick.hit, true, "popover still wins hit testing after body click");

  await page.locator('[data-chat-help="campaign-wiki"]').click();
  await page.getByRole("dialog", { name: /campaign wiki/i }).waitFor();
  console.info("Session popover layer and Campaign Wiki toolbar regression passed");
} finally {
  await browser.close();
}
