import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { startFixtureServer, stopFixtureServer } from "../lib/fixture-server.mjs";

let fixture;
let browser;
try {
  fixture = startFixtureServer(fileURLToPath(new URL("component-server.mjs", import.meta.url)));
  const { base } = await fixture.ready;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(base);
  const contact = page.getByRole("dialog");
  const photo = contact.getByRole("button", { name: "Open Real NPC photo", exact: true });
  assert.equal(
    await contact.getByRole("button", { name: "Update Real NPC photo" }).count(),
    0,
    "thumbnail does not render an update camera",
  );
  await photo.click();
  const preview = page.getByRole("dialog", { name: /image preview/i });
  await preview.waitFor();
  assert.equal(
    await preview.getByRole("button", { name: "Update Real NPC photo" }).isEnabled(),
    true,
    "viewer update camera is enabled",
  );
  await page.keyboard.press("Tab");
  assert.equal(
    await preview.evaluate((el) => el.contains(document.activeElement)),
    true,
    "Tab stays in the photo viewer above a dialog",
  );
  await page.keyboard.press("Shift+Tab");
  assert.equal(
    await preview.evaluate((el) => el.contains(document.activeElement)),
    true,
    "reverse Tab stays in the viewer",
  );
  await page.keyboard.press("Escape");
  await preview.waitFor({ state: "hidden" });
  assert.equal(await photo.isVisible(), true, "closing the viewer preserves the character dialog");
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Open Real NPC photo");
  assert.equal(await page.locator("button button").count(), 0, "no nested photo buttons");
  await page.keyboard.press("Escape");
  await photo.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Open portrait menu", exact: true }).click();
  await page.getByRole("button", { name: "Open Menu NPC photo", exact: true }).click();
  await preview.waitFor();
  assert.equal(
    await preview.getByRole("button", { name: /update/i }).count(),
    0,
    "preview-only photos do not render an update camera",
  );
  await preview.locator('img[src="/npc-silhouette.svg"]').waitFor();
  const imageBounds = await preview.locator("img").boundingBox();
  assert.ok(imageBounds.width > 0 && imageBounds.height > 0, "SVG portraits retain visible dimensions");
  await preview.locator("img").click();
  assert.equal(await preview.isVisible(), true, "interacting with the image does not dismiss its owning menu");
  await page.keyboard.press("Escape");
  await preview.waitFor({ state: "hidden" });
  assert.equal(await page.locator("[data-photo-menu]").isVisible(), true, "menu remains after closing its preview");
  console.log("Photo viewer above a dialog preserves focus and the underlying dialog");
} finally {
  await browser?.close();
  await stopFixtureServer(fixture?.server);
}
