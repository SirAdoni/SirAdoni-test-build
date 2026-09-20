import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const [url, storageState, chatId] = process.argv.slice(2);
if (!url || !chatId) throw new Error("Usage: node game-widget-stack.browser.mjs URL STORAGE_STATE CHAT_ID");

const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const context = await browser.newContext({ storageState, serviceWorkers: "block" });
  await context.addInitScript((id) => localStorage.setItem("marinara-active-chat-id", id), chatId);
  const page = await context.newPage();
  await page.setViewportSize({ width: 2560, height: 1440 });
  await page.route("**/api/**", (route) => (route.request().method() === "GET" ? route.continue() : route.abort()));
  await page.goto(url);

  const widgets = page.locator('[data-game-floating-panel^="widget:"]');
  await widgets.nth(0).waitFor();
  assert.ok((await widgets.count()) >= 2, "fixture exposes at least two user widgets");
  const editButton = page.getByRole("button", { name: /edit layout|done editing/i }).first();
  if ((await editButton.getAttribute("aria-pressed")) !== "true") await editButton.click();

  const ids = await widgets.evaluateAll((elements) =>
    elements.slice(0, 3).map((element) => element.getAttribute("data-game-floating-panel")),
  );
  const first = page.locator(`[data-game-floating-panel="${ids[0]}"]`);
  const second = page.locator(`[data-game-floating-panel="${ids[1]}"]`);
  const stackSelect = (panel) => panel.locator('select[aria-label*="stack" i]').first();
  await stackSelect(first).selectOption(ids[1]);
  await page.waitForTimeout(300);

  const stackState = await page.evaluate(
    (id) => JSON.parse(localStorage.getItem(`marinara-game-panel-stacks:${id}`) ?? "{}"),
    chatId,
  );
  assert.equal(stackState[ids[0]], stackState[ids[1]], "joining an unstacked widget writes both members atomically");
  assert.ok(stackState[ids[0]], "stack group is persisted");
  assert.equal(
    await stackSelect(first).inputValue(),
    await stackSelect(second).inputValue(),
    "both controls show the same stack",
  );

  const before = await page.evaluate(
    (selected) => {
      const host = document.querySelector("[data-chat-resource-drop-surface]");
      if (!host) throw new Error("game surface unavailable");
      return [...host.querySelectorAll('[data-game-floating-panel^="widget:"]')].map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          id: element.getAttribute("data-game-floating-panel"),
          x: rect.x,
          y: rect.y,
          selected: selected.includes(element.getAttribute("data-game-floating-panel")),
        };
      });
    },
    ids.slice(0, 2),
  );
  const handle = first.locator('[data-panel-layout-controls] button[aria-label*="move" i]').first();
  await handle.waitFor();
  const box = await handle.boundingBox();
  assert.ok(box, "stacked widget move handle is available");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 520, box.y + 240, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const after = await page.evaluate(() =>
    [...document.querySelectorAll('[data-game-floating-panel^="widget:"]')].map((element) => {
      const rect = element.getBoundingClientRect();
      return { id: element.getAttribute("data-game-floating-panel"), x: rect.x, y: rect.y };
    }),
  );
  const oldFirst = before.find((item) => item.id === ids[0]);
  const oldSecond = before.find((item) => item.id === ids[1]);
  const newFirst = after.find((item) => item.id === ids[0]);
  const newSecond = after.find((item) => item.id === ids[1]);
  assert.ok(oldFirst && oldSecond && newFirst && newSecond, "stack members remain mounted after drag");
  assert.ok(
    Math.abs(newFirst.x - oldFirst.x - (newSecond.x - oldSecond.x)) <= 2,
    "stack members move together horizontally",
  );
  assert.ok(
    Math.abs(newFirst.y - oldFirst.y - (newSecond.y - oldSecond.y)) <= 2,
    "stack members move together vertically",
  );

  await page.reload();
  await first.waitFor();
  await page.waitForTimeout(500);
  const reloaded = await page.evaluate(
    (id) => JSON.parse(localStorage.getItem(`marinara-game-panel-stacks:${id}`) ?? "{}"),
    chatId,
  );
  assert.equal(reloaded[ids[0]], reloaded[ids[1]], "stack membership survives reload");
  console.info("Game widget stack regression passed: atomic join, grouped drag, and persistence.");
} finally {
  await browser.close();
}
