// Campaign Wiki branch-manifest fixture: held warning, keyboard expansion,
// wiki stays usable, overflow, empty/missing manifest, metadata error retry.
import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { startFixtureServer, stopFixtureServer } from "../lib/fixture-server.mjs";
import { MOBILE_VIEWPORTS, VIEWPORTS, fixtureDir, label, outputDir } from "../lib/fixture-paths.mjs";

const root = fixtureDir(import.meta.url);
const out = outputDir(import.meta.url);
const { server, ready } = startFixtureServer(path.join(root, "server.mjs"));
const { base } = await ready;
const browser = await chromium.launch({ headless: true });
const checks = [];
const screenshots = [];
const record = (name, pass, detail = "") => checks.push({ name, pass: Boolean(pass), detail });
const shot = async (page, name) => { await page.screenshot({ path: path.join(out, `${name}.png`) }); screenshots.push(`${name}.png`); };
const open = async (page, mode) => { await page.goto(`${base}?branch=${mode}`); await page.locator('[data-campaign-wiki-entity-list]').waitFor(); };
try {
  const desktop = await browser.newPage({ viewport: VIEWPORTS.desktop });
  await open(desktop, "held");
  await desktop.getByText("Some campaign memory was held during branch creation.", { exact: true }).waitFor();
  record("held warning renders from branch manifest", true);
  const heldSummary = desktop.getByText("Held records (2)", { exact: true });
  await heldSummary.focus(); await heldSummary.press("Enter");
  record("held list expands by keyboard", (await desktop.getByText("Source revision was unavailable", { exact: true }).count()) === 1 && (await desktop.getByText("Cause event was held", { exact: true }).count()) === 1);
  const diagnostic = desktop.getByText("Diagnostic details", { exact: true }).first();
  await diagnostic.focus(); await diagnostic.press("Enter");
  record("diagnostic details expand by keyboard", (await desktop.getByText("fact-held-1", { exact: true }).count()) === 1);
  record("wiki remains usable with held warning", (await desktop.locator('[data-campaign-wiki-entity-list]').getByRole("button", { name: /Ariadne Vale/ }).count()) === 1);
  const size = await desktop.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  record("desktop held warning has no horizontal overflow", size.scrollWidth <= size.clientWidth, JSON.stringify(size));
  await shot(desktop, "branch-held-desktop-viewport");
  await desktop.close();

  for (const viewport of MOBILE_VIEWPORTS) {
    const tag = label(viewport);
    const mobile = await browser.newPage({ viewport });
    await open(mobile, "held"); await mobile.getByText("Some campaign memory was held during branch creation.", { exact: true }).waitFor();
    const mobileSize = await mobile.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
    record(`mobile held warning has no horizontal overflow @${tag}`, mobileSize.scrollWidth <= mobileSize.clientWidth, JSON.stringify(mobileSize));
    await shot(mobile, `branch-held-mobile-viewport-${tag}`);
    await mobile.close();
  }

  const empty = await browser.newPage({ viewport: VIEWPORTS.desktop }); await open(empty, "empty");
  await empty.locator('[data-campaign-wiki-entity-list]').getByRole("button", { name: /Ariadne Vale/ }).waitFor(); record("empty held manifest leaves wiki usable", (await empty.getByText("Some campaign memory was held during branch creation.", { exact: true }).count()) === 0);
  await empty.close();
  const none = await browser.newPage({ viewport: VIEWPORTS.desktop }); await open(none, "no-metadata");
  await none.locator('[data-campaign-wiki-entity-list]').getByRole("button", { name: /Ariadne Vale/ }).waitFor(); record("missing branch metadata leaves wiki usable", (await none.getByText("Some campaign memory was held during branch creation.", { exact: true }).count()) === 0); await none.close();

  const err = await browser.newPage({ viewport: VIEWPORTS.desktop }); await open(err, "error");
  await err.getByText("Branch memory status could not be checked.", { exact: true }).waitFor({ timeout: 10000 });
  await err.evaluate(() => { window.__wikiMock.chatFailures = 0; });
  await err.getByRole("button", { name: "Retry", exact: true }).click();
  await err.getByText("Some campaign memory was held during branch creation.", { exact: true }).waitFor();
  record("branch metadata error retry recovers warning and wiki", (await err.locator('[data-campaign-wiki-entity-list]').getByRole("button", { name: /Ariadne Vale/ }).count()) === 1);
  await err.close();
  const output = { generatedAt: new Date().toISOString(), base, viewports: [VIEWPORTS.desktop, ...MOBILE_VIEWPORTS], checks, pass: checks.every((x) => x.pass), screenshots, note: "Fixture-only GET /api/chats/chat-demo metadata responses; no production server, database, or provider calls." };
  await fs.writeFile(path.join(out, "branch-results.json"), JSON.stringify(output, null, 2)); console.log(JSON.stringify(output, null, 2));
  if (!output.pass) process.exitCode = 1;
} catch (error) { console.error(error); await fs.writeFile(path.join(out, "branch-error.txt"), String(error?.stack ?? error)); process.exitCode = 1; }
finally { await browser.close(); await stopFixtureServer(server); }
