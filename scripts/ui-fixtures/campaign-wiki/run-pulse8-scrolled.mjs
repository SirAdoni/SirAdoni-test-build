// Screenshot-only companion to run-pulse8.mjs: captures the current-state and
// relationships sections scrolled into view at every viewport.
import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { startFixtureServer, stopFixtureServer } from "../lib/fixture-server.mjs";
import { VIEWPORTS, fixtureDir, label, outputDir } from "../lib/fixture-paths.mjs";

const root = fixtureDir(import.meta.url);
const out = outputDir(import.meta.url);
const { server, ready } = startFixtureServer(path.join(root, "server.mjs"));
const { base } = await ready;
const browser = await chromium.launch({ headless: true });
const open = async (page) => { await page.goto(base); await page.locator('[data-campaign-wiki-entity-list]').waitFor(); await page.locator('[data-campaign-wiki-entity-list]').getByRole("button", { name: /Ariadne Vale/ }).click(); await page.getByRole("heading", { name: /Ariadne Vale/ }).waitFor(); };
const screenshots = [];
const checks = [];
const record = (name, pass, detail = "") => checks.push({ name, pass: Boolean(pass), detail });
try {
  for (const viewport of Object.values(VIEWPORTS)) {
    const tag = label(viewport);
    const page = await browser.newPage({ viewport }); await open(page);
    const commitments = page.getByRole("region", { name: /quests and commitments/i });
    await commitments.getByText("Recover the archive key", { exact: true }).waitFor();
    record(`commitments initial items @${tag}`, (await commitments.getByText("Keep the archive watch", { exact: true }).count()) === 1 && (await commitments.getByText(/Proposed \(1\)/).count()) === 1 && (await commitments.getByText(/Active \(1\)/).count()) === 1);
    if (tag === "1280x900") {
      await commitments.getByRole("button", { name: "Next page", exact: true }).click();
      await commitments.getByText("Archive key recovered", { exact: true }).waitFor();
      record("commitments cursor pagination", (await commitments.getByText(/Completed \(1\)/).count()) === 1 && (await commitments.getByRole("button", { name: "Previous page", exact: true }).isEnabled()));
      await commitments.getByRole("button", { name: "Previous page", exact: true }).click();
      await commitments.getByText("Recover the archive key", { exact: true }).waitFor();
      await page.goto(base);
      await page.locator('[data-campaign-wiki-entity-list]').waitFor();
      await page.evaluate(() => { window.__wikiMock.failCommitments = 1; });
      await page.locator('[data-campaign-wiki-entity-list]').getByRole("button", { name: /Ariadne Vale/ }).click();
      const erroredCommitments = page.getByRole("region", { name: /quests and commitments/i });
      await erroredCommitments.getByText("Commitments could not be loaded.", { exact: true }).waitFor();
      record("commitments error state renders", await erroredCommitments.getByRole("button", { name: "Reload", exact: true }).count() === 1);
      await erroredCommitments.getByRole("button", { name: "Reload", exact: true }).click();
      await erroredCommitments.getByText("Recover the archive key", { exact: true }).waitFor();
      record("commitments retry recovers", (await erroredCommitments.getByText("Keep the archive watch", { exact: true }).count()) === 1);
    }
    const current = page.getByText("Current state", { exact: true }).first(); await current.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(out, `pulse8-current-state-${tag}.png`) }); screenshots.push(`pulse8-current-state-${tag}.png`);
    const relationship = page.getByText("Relationships", { exact: true }).first(); await relationship.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(out, `pulse8-relationships-${tag}.png`) }); screenshots.push(`pulse8-relationships-${tag}.png`);
    await page.close();
  }
  checks.push({ name: "scrolled screenshots captured", pass: screenshots.length === Object.keys(VIEWPORTS).length * 2, detail: `${screenshots.length} screenshots` });
  const output = { generatedAt: new Date().toISOString(), base, checks, pass: checks.every((check) => check.pass), screenshots, note: "Fixture-only API responses; commitments loading, grouping, cursor pagination, and error/retry are covered. State-changing commitment transitions are intentionally untested." };
  await fs.writeFile(path.join(out, "pulse8-scrolled-results.json"), JSON.stringify(output, null, 2)); console.log(JSON.stringify(output, null, 2));
  if (!output.pass) process.exitCode = 1;
} catch (error) { console.error(error); await fs.writeFile(path.join(out, "pulse8-scrolled-error.txt"), String(error?.stack ?? error)); process.exitCode = 1; }
finally { await browser.close(); await stopFixtureServer(server); }
