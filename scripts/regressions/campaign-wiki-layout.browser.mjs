import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const [url, storageState, chatId] = process.argv.slice(2);
if (!url || !chatId) throw new Error("Expected URL, storage state, and chat ID");
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const context = await browser.newContext({
    storageState,
    serviceWorkers: "block",
    viewport: { width: 1920, height: 1080 },
  });
  await context.addInitScript((id) => localStorage.setItem("marinara-active-chat-id", id), chatId);
  const page = await context.newPage();
  await page.route("**/api/**", (route) => (route.request().method() === "GET" ? route.continue() : route.abort()));
  await page.goto(url);
  await page.getByRole("button", { name: "Campaign Wiki", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Campaign Wiki", exact: true });
  const index = dialog.locator("[data-campaign-wiki-overview-index]");
  await index.waitFor();
  assert.ok((await index.getByRole("button").count()) > 0, "overview contains navigable entries");
  const list = dialog.locator("[data-campaign-wiki-entity-list]");
  const name = await list.getByRole("button").first().innerText();
  await list.getByRole("button").first().click();
  const reader = dialog.locator('[data-campaign-wiki-scroll="reader"]');
  await reader.getByRole("heading").first().waitFor();
  assert.ok((await reader.innerText()).includes(name.split("\n")[0]), "entry opens from directory");
  const directoryTop = await list.evaluate((e) => e.scrollTop);
  await reader.evaluate((e) => {
    e.scrollTop = 200;
  });
  assert.equal(await list.evaluate((e) => e.scrollTop), directoryTop, "reading does not scroll directory");
  for (const width of [1920, 1024, 412]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(250);
    assert.ok(
      await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
      `${width}: dialog does not overflow horizontally`,
    );
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      `${width}: page stays bounded`,
    );
  }
  console.info(
    "Wiki layout passed: populated overview, entry navigation, independent scrolling, desktop and phone bounds.",
  );
} finally {
  await browser.close();
}
