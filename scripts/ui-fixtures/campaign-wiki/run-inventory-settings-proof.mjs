// GameInventory identity fixture (surface=inventory) plus the historical
// ChatSettingsDrawer probe that looked for the knowledge control under the
// "Party" section. Kept verbatim for the record; the control lives in the
// Agents section and is proven by run-knowledge-setting-proof.mjs. Not part of
// the default regression:wiki-ui set (pass --all to run-all.mjs to include it).
import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { startFixtureServer, stopFixtureServer } from "../lib/fixture-server.mjs";
import { VIEWPORTS, fixtureDir, outputDir } from "../lib/fixture-paths.mjs";

const root = fixtureDir(import.meta.url);
const out = outputDir(import.meta.url);
const { server, ready } = startFixtureServer(path.join(root, "server.mjs"));
const { base } = await ready;
const browser = await chromium.launch({ headless: true });
const checks = [];
const screenshots = [];
const record = (name, pass, detail = "") => checks.push({ name, pass: Boolean(pass), detail });
const shot = async (page, name) => { await page.screenshot({ path: path.join(out, `${name}.png`) }); screenshots.push(`${name}.png`); };
try {
  const page = await browser.newPage({ viewport: VIEWPORTS.desktop }); await page.goto(`${base}?surface=inventory`); await page.getByRole("heading", { name: "Inventory" }).waitFor();
  const slots = page.getByRole("button", { name: /Moonstone/ }); record("same-named inventory items render separately", await slots.count() === 2);
  await slots.nth(1).click(); await page.getByPlaceholder("Item name").fill("Moonstone Renamed"); await page.getByRole("button", { name: /Save/ }).click();
  record("rename changes selected same-named item only", (await page.getByRole("button", { name: /Moonstone x2/ }).count()) === 1 && (await page.getByRole("button", { name: /Moonstone Renamed x5/ }).count()) === 1);
  await page.getByRole("button", { name: /Increase Moonstone Renamed amount/ }).click();
  record("quantity change targets selected item identity", (await page.getByRole("button", { name: /Moonstone x2/ }).count()) === 1 && (await page.getByRole("button", { name: /Moonstone Renamed x6/ }).count()) === 1);
  const decrease = page.getByRole("button", { name: /Decrease Moonstone Renamed amount/ }); for (let i = 0; i < 5; i += 1) await decrease.click(); await page.getByRole("button", { name: /Delete Moonstone Renamed/ }).click();
  record("remove reaches selected item only", (await page.getByRole("button", { name: /Moonstone x2/ }).count()) === 1 && (await page.getByRole("button", { name: /Moonstone Renamed/ }).count()) === 0);
  await shot(page, "inventory-identity-viewport");
  const settings = await browser.newPage({ viewport: VIEWPORTS.desktop }); await settings.goto(`${base}?surface=settings`); await settings.getByText("Party", { exact: true }).click();
  try {
    await settings.getByText("Character knowledge", { exact: true }).waitFor({ timeout: 8000 });
    const options = await settings.locator("select").evaluateAll((xs) => xs.flatMap((x) => Array.from(x.options).map((o) => o.textContent || "")));
    record("knowledge isolation setting renders localized labels (Party section probe)", options.some((x) => x.includes("Shared GM dialogue")) && options.some((x) => x.includes("Separate character replies")), JSON.stringify(options.filter((x) => /Shared|Separate|knowledge/i.test(x))));
    await shot(settings, "knowledge-isolation-settings-viewport");
  } catch { record("knowledge isolation setting renders localized labels (Party section probe)", false, "Character knowledge control is not under the Party section; see run-knowledge-setting-proof.mjs (Agents section)."); }
  const output = { generatedAt: new Date().toISOString(), base, checks, pass: checks.every((x) => x.pass), screenshots, note: "Fixture-only harness; no live campaign or provider calls." };
  await fs.writeFile(path.join(out, "inventory-settings-results.json"), JSON.stringify(output, null, 2)); console.log(JSON.stringify(output, null, 2));
  if (!output.pass) process.exitCode = 1;
} catch (error) { console.error(error); await fs.writeFile(path.join(out, "inventory-settings-error.txt"), String(error?.stack ?? error)); process.exitCode = 1; }
finally { await browser.close(); await stopFixtureServer(server); }
