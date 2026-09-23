// ChatSettingsDrawer fixture (surface=settings): the game-only "Character
// knowledge" control in the Agents section renders localized labels, starts
// isolated, persists a change through the metadata PATCH, and fits on mobile.
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
try {
  const page = await browser.newPage({ viewport: VIEWPORTS.desktop });
  await page.goto(`${base}?surface=settings`);
  await page.getByText("Agents", { exact: true }).click();
  await page.getByText("Character knowledge", { exact: true }).waitFor({ timeout: 15000 });
  const setting = page.getByText("Character knowledge", { exact: true }).locator("..").locator("select");
  const options = await setting.locator("option").allTextContents();
  record("character knowledge select renders localized labels", options.some((x) => x.includes("Shared GM dialogue")) && options.some((x) => x.includes("Separate character replies")), JSON.stringify(options));
  record("character knowledge starts isolated", await setting.inputValue() === "isolated");
  await setting.selectOption("legacy"); await page.waitForTimeout(300);
  const readback = await page.evaluate(() => window.__wikiMock.knowledgeMode);
  record("character knowledge change persists fixture metadata readback", readback === "legacy", String(readback));
  await shot(page, "knowledge-setting-viewport");
  await page.close();

  for (const viewport of MOBILE_VIEWPORTS) {
    const tag = label(viewport);
    const mobile = await browser.newPage({ viewport });
    await mobile.goto(`${base}?surface=settings`);
    await mobile.getByText("Agents", { exact: true }).click();
    const mobileSetting = mobile.getByText("Character knowledge", { exact: true }).locator("..").locator("select");
    await mobileSetting.waitFor(); await mobileSetting.focus(); await mobileSetting.selectOption("legacy");
    const mobileSize = await mobile.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
    const helpVisible = await mobile.getByText(/Each character reply uses that character's known information/, { exact: false }).isVisible();
    record(`mobile knowledge setting fits without horizontal overflow @${tag}`, mobileSize.scrollWidth <= mobileSize.clientWidth && helpVisible, JSON.stringify({ mobileSize, helpVisible }));
    await shot(mobile, `knowledge-setting-mobile-viewport-${tag}`);
    await mobile.close();
  }
  const output = { generatedAt: new Date().toISOString(), base, viewports: [VIEWPORTS.desktop, ...MOBILE_VIEWPORTS], checks, pass: checks.every((x) => x.pass), screenshots, note: "Fixture-only ChatSettingsDrawer metadata PATCH/readback; no production or provider calls." };
  await fs.writeFile(path.join(out, "knowledge-setting-results.json"), JSON.stringify(output, null, 2)); console.log(JSON.stringify(output, null, 2));
  if (!output.pass) process.exitCode = 1;
} catch (error) { console.error(error); await fs.writeFile(path.join(out, "knowledge-setting-error.txt"), String(error?.stack ?? error)); process.exitCode = 1; }
finally { await browser.close(); await stopFixtureServer(server); }
