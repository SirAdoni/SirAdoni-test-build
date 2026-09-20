import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const [url, storageState, chatId] = process.argv.slice(2);
if (!url || !chatId) {
  throw new Error("Usage: node campaign-wiki-readable-facts.browser.mjs URL STORAGE_STATE CHAT_ID");
}

const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const context = await browser.newContext({ storageState, serviceWorkers: "block" });
  await context.addInitScript((id) => localStorage.setItem("marinara-active-chat-id", id), chatId);
  const page = await context.newPage();
  await page.route("**/api/**", (route) => (route.request().method() === "GET" ? route.continue() : route.abort()));
  await page.setViewportSize({ width: 2560, height: 1440 });
  await page.goto(url);

  const editLayout = page.getByRole("button", { name: "Edit layout", exact: true });
  await editLayout.waitFor();
  assert.equal((await editLayout.innerText()).trim(), "", "layout control is icon-only");
  assert.equal(await editLayout.locator("svg").count(), 1, "layout control has a pencil icon");
  await editLayout.click();
  assert.equal(
    await page.getByRole("button", { name: "Done editing", exact: true }).getAttribute("aria-pressed"),
    "true",
  );
  await page.getByRole("button", { name: "Done editing", exact: true }).click();

  await page.getByRole("button", { name: "Campaign Wiki", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Campaign Wiki", exact: true });
  await dialog.locator("[data-campaign-wiki-entity-list]").waitFor();
  const mentor = dialog
    .locator("[data-campaign-wiki-entity-list]")
    .getByRole("button")
    .filter({ hasText: /Elowen/i })
    .first();
  await mentor.waitFor();
  await mentor.click();

  const reader = dialog.locator('[data-campaign-wiki-scroll="reader"]');
  await reader.getByRole("heading").first().waitFor();
  const rendered = await reader.innerText();
  assert.match(rendered, /Elowen was to hand/i, "Elowen fact text is readable in the rendered reader");
  assert.match(rendered, /(?:Proposed|Unresolved)/i, "pending or unresolved fact state is visible");
  assert.doesNotMatch(rendered, /"receiptId"|"sourceHash"|\{"text"/i, "raw evidence JSON stays collapsed");

  const measureBounds = async () => {
    const state = await page.evaluate(() => {
      const root = document.documentElement;
      const viewport = { width: innerWidth, height: innerHeight };
      const elements = [
        document.querySelector('[role="dialog"]'),
        document.querySelector("[data-campaign-wiki-entity-list]"),
        document.querySelector('[data-campaign-wiki-scroll="reader"]'),
        ...document.querySelectorAll('[data-campaign-wiki-scroll="reader"] > *'),
      ].filter(Boolean);
      return {
        viewportWidth: viewport.width,
        documentWidth: root.scrollWidth,
        elements: elements.map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            name: element.getAttribute("data-campaign-wiki-scroll") ?? element.tagName,
            left: rect.left,
            right: rect.right,
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
          };
        }),
      };
    });
    assert.ok(state.documentWidth <= state.viewportWidth + 1, "document has no horizontal overflow");
    for (const element of state.elements) {
      assert.ok(
        element.left >= -1 && element.right <= state.viewportWidth + 1,
        `${element.name} stays within the viewport`,
      );
      assert.ok(element.scrollWidth <= element.clientWidth + 1, `${element.name} has no horizontal content overflow`);
    }
  };

  for (const viewport of [
    { width: 2560, height: 1440 },
    { width: 1920, height: 1080 },
    { width: 1440, height: 900 },
    { width: 412, height: 915 },
  ]) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(300);
    await measureBounds();
  }

  const rawRecord = reader
    .locator("details")
    .filter({ hasText: /Show complete record/i })
    .first();
  await rawRecord.locator("summary").click();
  const expanded = await reader.innerText();
  assert.match(expanded, /receiptId/i, "expanded raw evidence retains its receipt ID");
  console.info("Campaign Wiki readable facts and responsive bounds regression passed");
} finally {
  await browser.close();
}
