import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const [url, storageState, chatId] = process.argv.slice(2);
if (!url || !chatId)
  throw new Error("Usage: node game-widget-tuck.browser.mjs URL STORAGE_STATE CHAT_ID [LAYOUT_SCOPE]");
// Layout keys live under the game's panel layout scope, which differs from the chat id for
// later sessions (chat metadata gamePanelLayoutScopeId). Pass it as the 4th argument when it does.
const layoutScope = process.argv[5] || chatId;

const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const context = await browser.newContext({ storageState, serviceWorkers: "block" });
  await context.addInitScript(
    ({ id, scope }) => {
      localStorage.setItem("marinara-active-chat-id", id);
      if (!sessionStorage.getItem("game-widget-tuck-fixture")) {
        // Tuck keys live under the layout scope, which differs from the chat id for later sessions.
        for (const key of Object.keys(localStorage)) {
          if (
            (key.startsWith(`marinara-game-panel:${id}:floating:widget:`) ||
              key.startsWith(`marinara-game-panel:${scope}:floating:widget:`)) &&
            (key.endsWith(":tucked") || key.endsWith(":tucked:edge"))
          )
            localStorage.removeItem(key);
        }
        sessionStorage.setItem("game-widget-tuck-fixture", "true");
      }
    },
    { id: chatId, scope: layoutScope },
  );
  const page = await context.newPage();
  // The mocked server keeps what the client saved. Echoing the original value after the save
  // made the chat refetch revert the widget, which is a second value change that restarted
  // the reveal timer (and, on busy chats, dropped the widget), so the five-second check flaked.
  let mockWidgets = [
    { id: "health", type: "progress_bar", label: "Health", position: "hud_left", config: { value: 50, max: 100 } },
  ];
  await page.route("**/api/**", async (route) => {
    if (route.request().method() === "GET" && new URL(route.request().url()).pathname === `/api/chats/${chatId}`) {
      const response = await route.fetch();
      const body = await response.json();
      const metadata = typeof body.metadata === "string" ? JSON.parse(body.metadata) : { ...body.metadata };
      metadata.gameWidgetState = mockWidgets;
      body.metadata = typeof body.metadata === "string" ? JSON.stringify(metadata) : metadata;
      return route.fulfill({ response, json: body });
    }
    if (route.request().method() === "GET") return route.continue();
    if (route.request().method() === "PUT" && route.request().url().includes(`/game/${chatId}/widgets`)) {
      const saved = route.request().postDataJSON()?.widgets;
      if (Array.isArray(saved)) mockWidgets = saved;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true }) });
    }
    return route.abort();
  });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
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
  const widget = page.locator('[data-game-floating-panel="widget:health"]').first();
  // Park the pointer on empty surface away from the widget, wherever the layout put it.
  const parkPointer = async () => {
    const box = await widget.boundingBox();
    const viewport = page.viewportSize();
    const x = box && box.x + box.width / 2 > viewport.width / 2 ? 200 : viewport.width - 200;
    await page.mouse.move(x, viewport.height / 2);
  };
  await widget.waitFor({ timeout: 180000 });
  // Transient toasts (for example "update ready") and the all-locked hint must not intercept clicks.
  await page.addStyleTag({
    content: "[data-sonner-toaster],[data-sonner-toast],[data-layout-locked-hint]{display:none!important}",
  });
  const edit = page.getByRole("button", { name: /edit layout|done editing/i }).first();
  if ((await edit.getAttribute("aria-pressed")) !== "true") await edit.click();
  const widgetSelector = '[data-game-floating-panel="widget:health"]';
  const collapse = async () =>
    (await panelOptions(widgetSelector)).getByRole("button", { name: "Collapse to edge", exact: true }).click();
  for (const edgeName of ["left", "right", "top"]) {
    await (await panelOptions(widgetSelector))
      .getByRole("radio", { name: new RegExp(`^${edgeName} edge$`, "i") })
      .click();
    await page.waitForTimeout(100);
    await collapse();
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
  await collapse();
  await tab.waitFor();

  await page.reload({ waitUntil: "domcontentloaded" });
  await widget.waitFor();
  assert.ok((await widget.boundingBox()).width <= 40, "initial mount stays tucked without a value change");
  await page.addStyleTag({
    content: "[data-sonner-toaster],[data-sonner-toast],[data-layout-locked-hint]{display:none!important}",
  });
  const editAfterReload = page.getByRole("button", { name: /edit layout|done editing/i }).first();
  // Hover reveal is a play-mode behaviour (edit mode keeps tabs still so they can be dragged).
  if ((await editAfterReload.getAttribute("aria-pressed")) === "true") await editAfterReload.click();

  await tab.hover();
  await page.waitForTimeout(100);
  assert.ok((await widget.boundingBox()).width > 100, "hover temporarily reveals the widget");
  await parkPointer();
  await page.waitForTimeout(100);
  assert.ok((await widget.boundingBox()).width <= 40, "widget closes after pointer leaves");

  // Holding the reveal tab past the value-change timeout must not close the
  // widget while the pointer is still over the control. It closes only after
  // the pointer leaves, which proves the hover interaction remains active.
  await tab.hover();
  await page.waitForTimeout(5100);
  assert.ok((await widget.boundingBox()).width > 100, "hover hold keeps the widget open past the reveal timeout");
  await parkPointer();
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
  await parkPointer();
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
      { chat: layoutScope, panelId: await widget.getAttribute("data-game-floating-panel") },
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
