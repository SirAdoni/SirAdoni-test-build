import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const [url, storageState, chatId] = process.argv.slice(2);
if (!url || !chatId) throw new Error("Usage: node game-widget-tuck.browser.mjs URL STORAGE_STATE CHAT_ID");

const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const context = await browser.newContext({ storageState, serviceWorkers: "block" });
  await context.addInitScript((id) => {
    localStorage.setItem("marinara-active-chat-id", id);
    if (!sessionStorage.getItem("game-widget-tuck-fixture")) {
      for (const key of Object.keys(localStorage)) {
        if (
          key.startsWith(`marinara-game-panel:${id}:floating:widget:`) &&
          (key.endsWith(":tucked") || key.endsWith(":tucked:edge"))
        )
          localStorage.removeItem(key);
      }
      sessionStorage.setItem("game-widget-tuck-fixture", "true");
    }
  }, chatId);
  const page = await context.newPage();
  await page.route("**/api/**", async (route) => {
    if (route.request().method() === "GET" && new URL(route.request().url()).pathname === `/api/chats/${chatId}`) {
      const response = await route.fetch();
      const body = await response.json();
      const metadata = typeof body.metadata === "string" ? JSON.parse(body.metadata) : { ...body.metadata };
      metadata.gameWidgetState = [
        { id: "health", type: "progress_bar", label: "Health", position: "hud_left", config: { value: 50, max: 100 } },
      ];
      body.metadata = typeof body.metadata === "string" ? JSON.stringify(metadata) : metadata;
      return route.fulfill({ response, json: body });
    }
    if (route.request().method() === "GET") return route.continue();
    if (route.request().method() === "PUT" && route.request().url().includes(`/game/${chatId}/widgets`)) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true }) });
    }
    return route.abort();
  });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  const widget = page.locator('[data-game-floating-panel="widget:health"]').first();
  await widget.waitFor();
  const edit = page.getByRole("button", { name: /edit layout|done editing/i }).first();
  if ((await edit.getAttribute("aria-pressed")) !== "true") await edit.click();
  const tuck = widget.getByRole('button', { name: 'Collapse to edge', exact: true });
  const edge = widget.locator('select[aria-label*="widget edge" i]');
  await tuck.waitFor();
  for (const edgeName of ["left", "right", "top"]) {
    await edge.selectOption(edgeName, { force: true });
    await page.waitForTimeout(100);
    await tuck.evaluate((element) => element.click());
    const tab = widget.locator("[data-game-tuck-tab]");
    await tab.waitFor();
    const box = await widget.boundingBox();
    assert.ok(box && box.width <= 40, `${edgeName}: tucked widget uses a reachable edge tab`);
    if (edgeName === "top") {
      const surfaceBox = await widget.evaluate((element) => {
        const host = element.offsetParent;
        if (!host) return null;
        const rect = host.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      });
      assert.ok(
        surfaceBox && box && box.y <= surfaceBox.y + 2,
        `top tab remains reachable at the surface edge (panelY=${box?.y}, surfaceY=${surfaceBox?.y})`,
      );
    }
    await tab.click();
  }
  const tab = widget.locator("[data-game-tuck-tab]");
  await tuck.evaluate((element) => element.click());
  await tab.waitFor();

  await page.reload({ waitUntil: "domcontentloaded" });
  await widget.waitFor();
  assert.ok((await widget.boundingBox()).width <= 40, "initial mount stays tucked without a value change");
  const editAfterReload = page.getByRole("button", { name: /edit layout|done editing/i }).first();
  if ((await editAfterReload.getAttribute("aria-pressed")) !== "true") await editAfterReload.click();

  await tab.hover();
  await page.waitForTimeout(100);
  assert.ok((await widget.boundingBox()).width > 100, "hover temporarily reveals the widget");
  await page.mouse.move(900, 700);
  await page.waitForTimeout(100);
  assert.ok((await widget.boundingBox()).width <= 40, "widget closes after pointer leaves");

  // Holding the reveal tab past the value-change timeout must not close the
  // widget while the pointer is still over the control. It closes only after
  // the pointer leaves, which proves the hover interaction remains active.
  await tab.hover();
  await page.waitForTimeout(5100);
  assert.ok((await widget.boundingBox()).width > 100, "hover hold keeps the widget open past the reveal timeout");
  await page.mouse.move(900, 700);
  await page.waitForTimeout(150);
  assert.ok((await widget.boundingBox()).width <= 40, "hover-held widget closes after pointer leaves");

  await tab.hover();
  const editWidget = widget.locator('button[title*="edit" i]').first();
  await editWidget.evaluate((element) => element.click());
  const valueInput = page.locator('input[type="number"]').first();
  await valueInput.waitFor();
  await valueInput.fill(String(Number(await valueInput.inputValue()) + 1));
  await page.getByRole("button", { name: /save changes|update widget/i }).click({ force: true });
  await page.waitForTimeout(200);
  assert.ok((await widget.boundingBox()).width > 100, "actual value change reveals the widget immediately");
  await page.mouse.move(900, 700);
  await page.waitForTimeout(200);
  assert.ok(
    (await widget.boundingBox()).width > 100,
    "value-change reveal remains open after pointer leaves before deadline",
  );
  await page.waitForTimeout(5100);
  assert.ok(
    (await widget.boundingBox()).width <= 40,
    "value-change reveal closes after five seconds when not interacting",
  );

  await widget.locator("[data-game-tuck-tab]").evaluate((element) => element.click());
  assert.ok((await widget.boundingBox()).width > 100, "clicking the tab persistently reveals the widget");
  await page.waitForTimeout(300);
  assert.equal(
    await page.evaluate(
      ({ chat, panelId }) => localStorage.getItem(`marinara-game-panel:${chat}:floating:${panelId}:tucked`),
      { chat: chatId, panelId: await widget.getAttribute("data-game-floating-panel") },
    ),
    "false",
    "click reveal persists an untucked preference",
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await widget.waitFor();
  assert.ok((await widget.boundingBox()).width > 100, "persistent reveal survives reload");
  console.info("Game widget tuck, hover reveal, click reveal, and persistence regression passed");
} finally {
  await browser.close();
}
