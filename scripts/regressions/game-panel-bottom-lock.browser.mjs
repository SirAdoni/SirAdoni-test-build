import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const [url, storageState, chatId] = process.argv.slice(2);
if (!url || !chatId)
  throw new Error("Usage: node game-panel-bottom-lock.browser.mjs URL STORAGE_STATE CHAT_ID [LAYOUT_SCOPE]");
// Layout keys live under the game's panel layout scope, which differs from the chat id for
// later sessions (chat metadata gamePanelLayoutScopeId). Pass it as the 4th argument when it does.
const layoutScope = process.argv[5] || chatId;

const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const context = await browser.newContext({ storageState, serviceWorkers: "block" });
  await context.addInitScript(
    ({ id, lockKey }) => {
      localStorage.setItem("marinara-active-chat-id", id);
      if (!sessionStorage.getItem("game-panel-bottom-lock-fixture")) {
        localStorage.removeItem(lockKey);
        sessionStorage.setItem("game-panel-bottom-lock-fixture", "true");
      }
    },
    { id: chatId, lockKey: `marinara-game-panel:${layoutScope}:floating:narration:bottom-lock` },
  );
  const page = await context.newPage();
  await page.setViewportSize({ width: 2560, height: 1440 });
  await page.route("**/api/**", (route) => (route.request().method() === "GET" ? route.continue() : route.abort()));
  await page.goto(url);
  // Per-panel layout options live in the edit chip's options popover.
  const optionsDialog = () => page.getByRole("dialog", { name: /options for/i });
  const panelOptions = async (panelSelector) => {
    const button = page.locator(`${panelSelector} [data-panel-options-button]`).first();
    if ((await button.getAttribute("aria-expanded")) !== "true") await button.click();
    await optionsDialog().waitFor();
    return optionsDialog();
  };
  const closeOptions = async () => {
    if (!(await optionsDialog().count())) return;
    await page.keyboard.press("Escape");
    await optionsDialog().waitFor({ state: "detached" });
  };
  const narrationSelector = '[data-game-floating-panel="narration"]';
  const bottomLockStored = () =>
    page.evaluate(
      (key) => localStorage.getItem(key),
      `marinara-game-panel:${layoutScope}:floating:narration:bottom-lock`,
    );
  const narration = page.locator('[data-game-floating-panel="narration"]');
  await narration.waitFor({ timeout: 180000 });

  // Transient toasts (for example "update ready") and the all-locked hint must not intercept clicks.
  await page.addStyleTag({
    content: "[data-sonner-toaster],[data-sonner-toast],[data-layout-locked-hint]{display:none!important}",
  });
  const editButton = page.getByRole("button", { name: /edit layout|done editing/i }).first();
  if ((await editButton.getAttribute("aria-pressed")) !== "true") await editButton.click();
  const bottomLock = (await panelOptions(narrationSelector))
    .locator('button[aria-pressed][aria-label*="bottom" i]')
    .first();
  const initialPressed = await bottomLock.getAttribute("aria-pressed");
  assert.equal(initialPressed, "false", "fixture starts with bottom lock disabled");
  await bottomLock.click();
  await page.waitForTimeout(100);
  assert.equal(await bottomLock.getAttribute("aria-pressed"), initialPressed === "true" ? "false" : "true");
  await closeOptions();

  const measure = () =>
    page.evaluate(() => {
      const panel = document.querySelector('[data-game-floating-panel="narration"]');
      const host = document.querySelector("[data-chat-resource-drop-surface]");
      if (!panel || !host) throw new Error("narration host unavailable");
      const p = panel.getBoundingClientRect();
      const h = host.getBoundingClientRect();
      const panels = [...host.querySelectorAll("[data-game-floating-panel]")].map((element) => {
        const r = element.getBoundingClientRect();
        return {
          id: element.getAttribute("data-game-floating-panel"),
          x: r.x,
          y: r.y,
          right: r.right,
          bottom: r.bottom,
        };
      });
      return { gap: h.bottom - p.bottom, hostScrollTop: host.scrollTop, panels };
    });

  for (const viewport of [
    { width: 2560, height: 1440 },
    { width: 2048, height: 1078 },
  ]) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(700);
    const locked = await bottomLockStored();
    assert.equal(locked, "true", `${viewport.width}: bottom lock remains enabled`);
    const state = await measure();
    assert.ok(Math.abs(state.gap - 16) <= 2, `${viewport.width}: narration remains 16px from bottom`);
    assert.equal(state.hostScrollTop, 0, `${viewport.width}: game surface does not scroll`);
    const overlapState = await measure();
    const overlaps = overlapState.panels.flatMap((a, i) =>
      overlapState.panels
        .slice(i + 1)
        .filter((b) => a.x < b.right - 1 && a.right > b.x + 1 && a.y < b.bottom - 1 && a.bottom > b.y + 1)
        .map((b) => [a.id, b.id]),
    );
    assert.deepEqual(overlaps, [], `${viewport.width}: visible floating panels do not overlap`);
  }

  const beforeGrowth = await narration.boundingBox();
  const intrinsic = narration.locator('[data-game-panel-intrinsic="narration"]');
  await intrinsic.evaluate((element) => {
    const extra = document.createElement("div");
    extra.dataset.bottomLockGrowthProbe = "true";
    extra.style.height = "200px";
    element.append(extra);
  });
  await page.waitForTimeout(300);
  const grownByContent = await narration.boundingBox();
  assert.ok(
    grownByContent && beforeGrowth && grownByContent.height > beforeGrowth.height + 20,
    "content growth changes panel height",
  );
  assert.ok(Math.abs((await measure()).gap - 16) <= 2, "content growth preserves bottom gap");
  await intrinsic.locator('[data-bottom-lock-growth-probe="true"]').evaluate((element) => element.remove());
  await page.waitForTimeout(300);
  const shrunkByContent = await narration.boundingBox();
  assert.ok(
    shrunkByContent && grownByContent && shrunkByContent.height < grownByContent.height - 20,
    "content shrink restores panel height",
  );
  const growth = (await panelOptions(narrationSelector)).getByRole("radiogroup", { name: /growth/i });
  if (await growth.count()) {
    await growth.getByRole("radio", { name: /keep bottom edge/i }).click();
    await page.waitForTimeout(200);
    const grown = await narration.boundingBox();
    await growth.getByRole("radio", { name: /fixed height/i }).click();
    await page.waitForTimeout(200);
    const shrunk = await narration.boundingBox();
    await closeOptions();
    assert.ok(
      grown && beforeGrowth && grown.height >= beforeGrowth.height,
      "growth mode expands or preserves narration",
    );
    assert.ok(shrunk && grown && shrunk.height <= grown.height, "fixed mode shrinks narration after growth");
  }

  const storedState = await page.evaluate(
    (id) => localStorage.getItem(id),
    `marinara-game-panel:${layoutScope}:floating:narration:bottom-lock`,
  );
  assert.equal(storedState, "true", "bottom lock persists in local storage");
  await page.reload();
  await narration.waitFor();
  await page.waitForTimeout(700);
  const editAfterReload = page.getByRole("button", { name: /edit layout|done editing/i }).first();
  if ((await editAfterReload.getAttribute("aria-pressed")) !== "true") await editAfterReload.click();
  assert.equal(
    await (await panelOptions(narrationSelector))
      .locator('button[aria-pressed][aria-label*="bottom" i]')
      .first()
      .getAttribute("aria-pressed"),
    "true",
    "bottom lock survives reload",
  );
  assert.ok(Math.abs((await measure()).gap - 16) <= 2, "bottom gap survives reload");

  const bottomLockAfterReload = (await panelOptions(narrationSelector))
    .locator('button[aria-pressed][aria-label*="bottom" i]')
    .first();
  await bottomLockAfterReload.click();
  const panelLock = optionsDialog().locator('button[aria-label*="unlock" i]').first();
  if (await panelLock.count()) {
    const lockBox = await panelLock.boundingBox();
    assert.ok(lockBox, "narration unlock control is measurable");
    const hitPanel = await page.evaluate(
      ({ x, y }) => {
        const hit = document.elementFromPoint(x, y);
        return hit?.closest("[data-game-floating-panel]")?.getAttribute("data-game-floating-panel") ?? null;
      },
      { x: lockBox.x + lockBox.width / 2, y: lockBox.y + lockBox.height / 2 },
    );
    assert.equal(hitPanel, null, "narration unlock control sits in the topmost options popover");
    await panelLock.click();
  }
  await closeOptions();
  const storageKey = `marinara-game-panel:${layoutScope}:floating:narration`;
  const beforeDrag = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), storageKey);
  const moveHandle = narration.locator('[data-panel-layout-controls] button[aria-label*="move" i]').first();
  await moveHandle.waitFor();
  const handleBox = await moveHandle.boundingBox();
  const hostBox = await page.locator('[data-game-floating-panel="narration"]').evaluate((element) => {
    const host = document.querySelector("[data-chat-resource-drop-surface]");
    if (!host) throw new Error("narration host unavailable");
    const rect = host.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  if (!handleBox) throw new Error("narration move handle unavailable");
  const targetX = hostBox.x + Math.max(16, Math.round((hostBox.width - 896) / 2));
  const targetY = hostBox.y + 16;
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetX, targetY, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const afterDrag = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), storageKey);
  assert.ok(
    Number.isFinite(afterDrag?.x) && Number.isFinite(afterDrag?.y),
    "drag persists numeric narration coordinates",
  );
  assert.ok(
    beforeDrag?.x !== afterDrag.x || beforeDrag?.y !== afterDrag.y,
    "manual narration drag changes its saved anchor",
  );
  assert.ok(afterDrag.x >= 0 && afterDrag.y >= 0, "saved drag anchor remains inside the viewport");
  const draggedBox = await narration.boundingBox();
  // Drops snap to the grid, a surface edge or centre, or a neighbour's edge, and stay inside the surface.
  assert.ok(
    afterDrag.x <= hostBox.width - draggedBox.width + 1 && afterDrag.y <= hostBox.height - draggedBox.height + 1,
    "saved drag anchor stays inside the surface",
  );
  console.info(
    "Game bottom-lock regression passed: persistence, viewport gap, growth/shrink, bounded scroll, overlap, and drag-anchor checks.",
  );
} finally {
  await browser.close();
}
