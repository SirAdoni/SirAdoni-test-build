import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { startFixtureServer, stopFixtureServer } from "../lib/fixture-server.mjs";

let fixture;
let browser;
const geometryObservations = [];
try {
  fixture = startFixtureServer(fileURLToPath(new URL("component-server.mjs", import.meta.url)));
  const { base } = await fixture.ready;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(base);
  await page.getByText("Real NPC", { exact: true }).waitFor();
  let contact = page.getByRole("dialog").last();
  assert.equal(await contact.getByText(/Recorded opinion: 0/).count(), 1, "numeric zero opinion renders");
  await contact.getByRole("button", { name: "Real NPC", exact: true }).click();
  assert.equal(
    await page.locator("[data-profile-callback]").textContent(),
    "char-real",
    "profile callback receives character id",
  );

  await page.reload();
  await page.getByText("Real NPC", { exact: true }).waitFor();
  contact = page.getByRole("dialog").last();
  const name = contact.locator("aside input").first();
  await name.fill("Parent");
  await contact.getByRole("button", { name: /add category/i }).click();
  await name.fill("Child");
  await contact.getByRole("combobox", { name: /parent category/i }).selectOption({ label: "Parent" });
  await contact.getByRole("button", { name: /add category/i }).click();
  const article = contact.locator("article").filter({ hasText: "Real NPC" });
  await article.locator("select").first().selectOption({ label: "Child" });
  await contact.getByRole("button", { name: "Parent", exact: true }).click();
  assert.equal(await article.count(), 1, "nested parent category includes child contact");

  await page.keyboard.press("Escape");
  await contact.waitFor({ state: "hidden" });
  const photo = page.locator("[data-character-photo-fixture]");
  const openButton = photo.getByRole("button", { name: "Open Real NPC photo" });
  const portraitBounds = await openButton.boundingBox();
  const cropBounds = await openButton.locator("img").boundingBox();
  assert.equal(portraitBounds.width, 48, "adjacent camera does not compress the photo");
  assert.equal(cropBounds.width, portraitBounds.width, "cropped image stays inside the photo button");
  assert.equal(
    await photo.getByRole("button", { name: "Update Real NPC photo" }).count(),
    0,
    "thumbnail does not render an update camera",
  );
  assert.equal(await photo.locator("[data-photo-updates]").textContent(), "0", "photo update starts idle");
  await openButton.click();
  await page.getByRole("button", { name: /close image/i }).waitFor();
  assert.equal(await photo.locator("[data-photo-updates]").textContent(), "0", "photo preview does not update");
  const viewerUpdateButton = page.getByRole("button", { name: "Update Real NPC photo" });
  assert.equal(await viewerUpdateButton.isEnabled(), true, "viewer update camera is enabled");
  await viewerUpdateButton.click();
  await page.getByRole("button", { name: /close image/i }).waitFor({ state: "hidden" });
  assert.equal(await photo.locator("[data-photo-updates]").textContent(), "1", "viewer update invokes callback");
  assert.notEqual(
    await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
    "Open Real NPC photo",
    "viewer update does not restore thumbnail focus",
  );
  await openButton.focus();
  await openButton.click();
  await page.getByRole("button", { name: /close image/i }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /close image/i }).waitFor({ state: "hidden" });
  assert.equal(await photo.locator("[data-photo-updates]").textContent(), "1", "viewer close does not update");
  await openButton.focus();
  await page.keyboard.press("Enter");
  const keyboardPreview = page.getByRole("dialog", { name: /image preview/i });
  await keyboardPreview.waitFor();
  await page.keyboard.press("Escape");
  await keyboardPreview.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Open Real NPC photo");
  assert.equal(await photo.locator("[data-photo-updates]").textContent(), "1");
  await page.setViewportSize({ width: 390, height: 844 });
  await openButton.click();
  const dialog = page.getByRole("dialog", { name: /image preview/i });
  await dialog.waitFor();
  const bounds = await dialog.boundingBox();
  assert.equal(bounds.width, 390);
  assert.equal(bounds.height, 844);
  await page.keyboard.press("Escape");
  assert.equal(await photo.locator("[data-photo-updates]").textContent(), "1");
  console.log(
    "Character photo desktop/mobile preview, update isolation, keyboard preview, Escape and focus restoration passed",
  );
} finally {
  await browser?.close();
  await stopFixtureServer(fixture?.server);
}
