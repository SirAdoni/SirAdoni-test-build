import assert from "node:assert/strict";
import path from "node:path";
import { chromium } from "@playwright/test";
import { fixtureDir, outputDir } from "../lib/fixture-paths.mjs";
import { startFixtureServer, stopFixtureServer } from "../lib/fixture-server.mjs";
const root = fixtureDir(import.meta.url);
const out = outputDir(import.meta.url);
const { server, ready } = startFixtureServer(path.join(root, "server.mjs"));
let browser;
try {
  const { base } = await ready;
  browser = await chromium.launch({ headless: true });
  for (const [name, width, height, theme, mode] of [
    ["desktop", 1280, 900, "default", "dark"],
    ["mobile", 390, 844, "default", "light"],
    ["sillytavern", 960, 800, "sillytavern", "dark"],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${base}/?theme=${theme}&mode=${mode}`);
    await page.getByRole("heading", { name: "Family tree", exact: true }).waitFor();
    await page.getByRole("button", { name: "Add family link", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Profile", exact: true }).count(), 2);
    await page.evaluate(() => window.__family.wikiEdit());
    await page.getByText("Updated through the wiki", { exact: true }).waitFor();
    const centers = await page.getByLabel("Center on", { exact: true }).locator("option").allTextContents();
    assert.ok(centers.includes("Robin · characters · a") && centers.includes("Robin · characters · b"));
    await page.getByRole("button", { name: "Review", exact: true }).click();
    assert.equal(await page.getByLabel("Other person", { exact: true }).isDisabled(), true);
    await page.getByLabel("Note", { exact: true }).fill("Reviewed relationship note");
    await page.getByRole("button", { name: "Save link", exact: true }).click();
    await page.getByText("Family link saved.", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Profile", exact: true }).count(), 3);
    await page.getByText("Reviewed relationship note", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Add family link", exact: true }).click();
    await page.getByLabel("This person…", { exact: true }).selectOption("child");
    await page.getByLabel("Other person", { exact: true }).selectOption("__unknown");
    await page.getByLabel("Note", { exact: true }).fill("Parent unknown; no identity inferred");
    await page.evaluate(() => {
      window.__family.failSave = true;
    });
    await page.getByRole("button", { name: "Save link", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "This record changed" }).waitFor();
    assert.equal(await page.getByLabel("Note", { exact: true }).inputValue(), "Parent unknown; no identity inferred");
    await page.keyboard.press("Escape");
    assert.equal(await page.getByLabel("Note", { exact: true }).count(), 1, "Escape cannot discard the edit");
    await page.getByRole("button", { name: "Save link", exact: true }).click();
    await page.getByText("Parent unknown; no identity inferred", { exact: true }).waitFor();
    await page.locator("[data-family-tree] form").waitFor({ state: "detached" });
    const retryIds = await page.evaluate(() => window.__family.writes.slice(-2).map((write) => write.operationId));
    assert.equal(retryIds[0], retryIds[1], "Unchanged failed saves reuse their operation id");
    await page.locator("[data-family-tree]").evaluate((element) => element.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
    await page.getByRole("button", { name: "Open Robin photo", exact: true }).first().click();
    await page.getByRole("img", { name: "Robin", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("img", { name: "Robin", exact: true }).waitFor({ state: "detached" });
    assert.equal(await page.getByRole("heading", { name: "Family tree", exact: true }).count(), 1);
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      "No page-wide horizontal overflow",
    );
    assert.equal(
      await page
        .locator("body")
        .innerText()
        .then((text) => text.includes("ui.familyTree.")),
      false,
    );
    const row = page.getByText("Parent unknown; no identity inferred", { exact: true }).locator("../..");
    await row.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByLabel("Note", { exact: true }).fill("Updated uncertainty");
    await page.getByRole("button", { name: "Save link", exact: true }).click();
    await page.getByText("Updated uncertainty", { exact: true }).waitFor();
    await page.locator("[data-family-tree] form").waitFor({ state: "detached" });
    page.once("dialog", (dialog) => dialog.accept());
    await page
      .getByText("Updated uncertainty", { exact: true })
      .locator("../..")
      .getByRole("button", { name: "Remove link" })
      .click();
    await page.getByText("Updated uncertainty", { exact: true }).waitFor({ state: "detached" });
    await page.getByLabel("Find a person", { exact: true }).fill("Morgan");
    assert.equal(
      await page.getByLabel("Center on", { exact: true }).locator("option").count(),
      2,
      "Keeps focus plus matching person",
    );
    await page.getByLabel("Center on", { exact: true }).selectOption("d");
    await page.getByRole("button", { name: "Profile", exact: true }).click();
    assert.equal(await page.evaluate(() => window.__family.profile()), "d", "Profile uses exact owner id");
    assert.deepEqual(errors, []);
    await page.close();
    console.log(
      `Family tree ${name}: review, edit, conflict preservation, removal, filtering, profile and viewport checks passed.`,
    );
  }
} finally {
  await browser?.close();
  await stopFixtureServer(server);
}
