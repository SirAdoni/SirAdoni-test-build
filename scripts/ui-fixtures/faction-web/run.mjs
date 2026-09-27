import { chromium, expect } from "@playwright/test";
import path from "node:path";
import { startFixtureServer, stopFixtureServer } from "../lib/fixture-server.mjs";
import { fixtureDir, outputDir } from "../lib/fixture-paths.mjs";
const root = fixtureDir(import.meta.url),
  out = outputDir(import.meta.url);
const { server, ready } = startFixtureServer(path.join(root, "server.mjs"));
const { base } = await ready;
const browser = await chromium.launch({ headless: true });
try {
  for (const theme of ["default", "sillytavern"])
    for (const mode of ["dark", "light"])
      for (const width of [390, 768, 1280]) {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        await page.goto(`${base}/?theme=${theme}&mode=${mode}`);
        await page.getByRole("button", { name: "North Council", exact: true }).click();
        await expect(page.getByText("Trade talks remain uncertain.")).toBeVisible();
        await expect(page.getByText("Originally user-authored")).toBeVisible();
        await page.getByRole("button", { name: "Edit relationship", exact: true }).click();
        await page.getByLabel("Notes", { exact: true }).fill("Explicit treaty signed.");
        await page.getByLabel("Reason for this change").fill("User recorded treaty");
        await page.getByRole("button", { name: "Save relationship" }).click();
        await expect(page.getByText("Explicit treaty signed.")).toBeVisible();
        await page.getByRole("button", { name: "Change history" }).click();
        await expect(page.getByText("User recorded treaty")).toBeVisible();
        await page.getByRole("button", { name: "Open faction page" }).click();
        await expect(page.locator("#selected")).toHaveText("org-0");
        await page.getByRole("button", { name: "Add relationship", exact: true }).click();
        await page.getByRole("button", { name: "Harbor League", exact: true }).click();
        await page.getByLabel("Relationship", { exact: true }).selectOption("neutral-faction-toward");
        await expect(page.getByLabel("Relationship", { exact: true })).toHaveValue("neutral-faction-toward");
        await page.getByLabel("Relationship", { exact: true }).selectOption("subordinate-to");
        await page.getByLabel("Reason for this change").fill("Explicit vassalage");
        await page.getByRole("button", { name: "Save relationship" }).click();
        await expect(page.locator("li").filter({ hasText: "Subordinate to" })).toHaveCount(1);
        await page.locator("svg").getByRole("button", { name: "Harbor League", exact: true }).click();
        await expect(page.locator("svg").getByRole("button", { name: "Harbor League", exact: true })).toHaveAttribute(
          "aria-pressed",
          "true",
        );
        await page.getByRole("button", { name: "Open faction page" }).click();
        await expect(page.locator("#selected")).toHaveText("org-2");
        await page.locator("svg").getByRole("button", { name: "North Council", exact: true }).click();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(errors).toEqual([]);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: path.join(out, `${theme}-${mode}-${width}.png`), fullPage: true });
        await page.close();
      }
  console.log(
    "Faction UI: 12 viewport/theme combinations passed (direction, edit, add, history, navigation, overflow).",
  );
} finally {
  await browser.close();
  await stopFixtureServer(server);
}

// Exercise the actual wiki entry, not just the standalone feature component.
const wiki = startFixtureServer(path.join(root, "../campaign-wiki/server.mjs"));
const wikiReady = await wiki.ready;
const wikiBrowser = await chromium.launch({ headless: true });
try {
  for (const width of [390, 1280]) {
    const page = await wikiBrowser.newPage({ viewport: { width, height: 900 } });
    await page.goto(wikiReady.base);
    await page.getByRole("button", { name: "Faction relationships", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Faction relationships", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.close();
  }
  console.log("Faction wiki entry: mobile and desktop passed.");
} finally {
  await wikiBrowser.close();
  await stopFixtureServer(wiki.server);
}
