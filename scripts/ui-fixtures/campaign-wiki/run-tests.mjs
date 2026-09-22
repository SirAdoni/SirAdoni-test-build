// Campaign Wiki reader fixture: list, paging, search, kind filter, detail,
// related navigation, mobile back control, loading/empty/error/retry states.
// Each step is isolated: a shifted or broken step is recorded as a failure and
// the remaining steps still run, so results.json always lists every check.
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
const WAIT = { timeout: 10000 };
const checks = [];
const screenshots = [];
const record = (name, pass, detail = "") => checks.push({ name, pass: Boolean(pass), detail });
const shot = async (page, name, fullPage = false) => { await page.screenshot({ path: path.join(out, `${name}.png`), fullPage }); screenshots.push(`${name}.png`); };
const text = (page) => page.locator("body").innerText();
// Pager text is "<from>–<to> of <total>"; the entity list pager comes before any detail pager in the DOM.
const listTotal = async (page) => (await text(page)).match(/\d+–\d+ of 121/)?.[0] ?? "(no list total rendered)";
const detailTotal = async (page) => (await text(page)).match(/\d+–\d+ of 101/)?.[0] ?? "(no detail total rendered)";
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const step = async (name, fn) => { try { await fn(); } catch (error) { record(`${name} (step aborted)`, false, String(error?.message ?? error).split("\n")[0]); } };
const openList = async (page) => { await page.goto(base); await page.locator('[data-campaign-wiki-entity-list]').waitFor(WAIT); };
const openDetail = async (page) => { await openList(page); await page.locator('[data-campaign-wiki-entity-list]').getByRole("button", { name: /Ariadne Vale/ }).click(); await page.getByText(/^holds the northern archive key$/i).first().waitFor(WAIT); };
try {
  const desktop = await browser.newPage({ viewport: VIEWPORTS.desktop });
  await step("desktop list", async () => {
    await openList(desktop);
    await shot(desktop, "desktop-list", true);
    await shot(desktop, "desktop-list-viewport");
    record("desktop list renders", (await text(desktop)).includes("Ariadne Vale"));
    const total = await listTotal(desktop);
    record("desktop list pagination", total === "1–20 of 121", total);
    // CampaignWiki.tsx debounces searchText (250 ms) and that effect also resets entityOffset to 0,
    // so a Next click within 250 ms of mount is discarded. Let the mount-time debounce settle first.
    await desktop.waitForTimeout(400);
    const nextButtons = desktop.getByRole("button", { name: "Next", exact: true });
    const nextCount = await nextButtons.count();
    await nextButtons.first().click();
    try { await desktop.getByText("Character 120", { exact: false }).waitFor(WAIT); } catch {}
    await shot(desktop, "desktop-list-after-next-viewport");
    const nextTotal = await listTotal(desktop);
    record("desktop list next page", nextTotal === "21–40 of 121" && (await text(desktop)).includes("Character 21"), `${nextTotal}; nextButtons=${nextCount}`);
  });
  await step("desktop search and filter", async () => {
    await openList(desktop);
    await desktop.getByPlaceholder("Search entities").fill("Ariadne");
    await desktop.waitForTimeout(350);
    const listText = await desktop.locator('[data-campaign-wiki-entity-list]').innerText();
    record("search filters", listText.includes("Ariadne Vale") && !listText.includes("Location 1"));
    await desktop.getByRole("button", { name: "Location", exact: true }).click();
    await desktop.waitForTimeout(350);
    record("kind filter applies", (await text(desktop)).includes("No pages match"));
  });
  await step("desktop detail", async () => {
    await openDetail(desktop);
    record("detail content visible", /holds the northern archive key/i.test(await text(desktop)) && (await desktop.getByRole("tab", { name: /What they know|Who knows/ }).count()) > 0);
    const total = await detailTotal(desktop);
    record("detail page pagination", total === "1–20 of 101", total);
    await desktop.getByRole("button", { name: "Next" }).last().click();
    try { await desktop.getByText("recorded property 100", { exact: false }).waitFor(WAIT); } catch {}
    const nextTotal = await detailTotal(desktop);
    record("detail next page", nextTotal === "21–40 of 101" && /recorded property 20/i.test(await text(desktop)), nextTotal);
  });
  await step("desktop related navigation", async () => {
    await openDetail(desktop);
    await desktop.getByRole("tab", { name: /Connections/ }).click();
    await desktop.getByRole("button", { name: "Allied with", exact: false }).waitFor(WAIT);
    await desktop.getByRole("button", { name: "Allied with", exact: false }).click();
    await desktop.getByRole("heading", { name: "Location 1", exact: true }).waitFor(WAIT);
    record("related entity click", (await text(desktop)).includes("Location 1"));
    await shot(desktop, "desktop-detail-related", true);
    record("desktop no horizontal overflow", await noOverflow(desktop));
  });
  await desktop.close();

  for (const viewport of MOBILE_VIEWPORTS) {
    const tag = label(viewport);
    const rec = (name, pass, detail = "") => record(`${name} @${tag}`, pass, detail);
    const mobile = await browser.newPage({ viewport });
    await step(`mobile detail and back @${tag}`, async () => {
      await openDetail(mobile);
      await mobile.getByRole("button", { name: "Back to entities", exact: true }).first().waitFor(WAIT);
      rec("mobile detail and back control", /holds the northern archive key/i.test(await text(mobile)));
      await shot(mobile, `mobile-detail-${tag}`, true);
      await shot(mobile, `mobile-detail-viewport-${tag}`);
      rec("mobile detail no horizontal overflow", await noOverflow(mobile));
      await mobile.getByRole("button", { name: "Back to entities", exact: true }).first().click();
      rec("mobile back returns list", (await text(mobile)).includes("Ariadne Vale"));
      rec("mobile no horizontal overflow", await noOverflow(mobile));
    });
    await step(`mobile list states @${tag}`, async () => {
      await openList(mobile);
      await mobile.evaluate(() => { window.__wikiMock.delayMs = 500; });
      await mobile.getByRole("button", { name: "Character", exact: true }).click();
      rec("loading state visible", await mobile.getByText("Loading campaign memory...", { exact: true }).isVisible());
      await mobile.getByPlaceholder("Search entities").fill("No match");
      await mobile.waitForTimeout(800);
      rec("empty state visible", (await text(mobile)).includes("No pages match"));
      await mobile.evaluate(() => { window.__wikiMock.delayMs = 0; window.__wikiMock.failList = 1; });
      await mobile.getByPlaceholder("Search entities").fill("ErrorTrigger");
      await mobile.waitForTimeout(350);
      await mobile.getByText("Campaign memory could not be loaded.", { exact: true }).waitFor(WAIT);
      rec("list error state visible", (await text(mobile)).includes("Retry"));
      await mobile.getByRole("button", { name: "Retry", exact: true }).click();
      await mobile.getByPlaceholder("Search entities").fill("");
      await mobile.waitForTimeout(350);
      await mobile.locator('[data-campaign-wiki-entity-list]').getByRole("button", { name: /Ariadne Vale/ }).waitFor(WAIT);
      rec("list retry recovers", (await text(mobile)).includes("Ariadne Vale"));
    });
    await step(`mobile detail states @${tag}`, async () => {
      await openDetail(mobile);
      await mobile.evaluate(() => { window.__wikiMock.failDetail = 1; });
      await mobile.getByRole("button", { name: "Next", exact: true }).click();
      await mobile.getByText("Campaign memory could not be loaded.", { exact: true }).waitFor(WAIT);
      rec("detail error state visible", (await text(mobile)).includes("Retry"));
      await mobile.getByRole("button", { name: "Retry", exact: true }).click();
      try { await mobile.getByText("Campaign memory could not be loaded.", { exact: true }).waitFor({ state: "detached", ...WAIT }); } catch {}
      const body = await text(mobile);
      const errorAt = body.indexOf("Campaign memory could not be loaded.");
      const errorGone = errorAt === -1;
      rec("detail retry recovers", errorGone && /recorded property \d+/i.test(body), `${await detailTotal(mobile)}; errorGone=${errorGone}; hasRecords=${/recorded property \d+/i.test(body)}${errorGone ? "" : `; context=${JSON.stringify(body.slice(Math.max(0, errorAt - 160), errorAt + 80))}`}`);
      await shot(mobile, `mobile-detail-page-2-${tag}`, true);
      await shot(mobile, `mobile-detail-page-2-viewport-${tag}`);
    });
    await mobile.close();
  }
  const output = { generatedAt: new Date().toISOString(), base, viewports: [VIEWPORTS.desktop, ...MOBILE_VIEWPORTS], checks, pass: checks.every((item) => item.pass), screenshots, note: "Fixture-only API responses (window.fetch mock); no production server, database, or provider calls." };
  await fs.writeFile(path.join(out, "results.json"), JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
  if (!output.pass) process.exitCode = 1;
} catch (error) { console.error(error); await fs.writeFile(path.join(out, "results-error.txt"), String(error?.stack ?? error)); process.exitCode = 1; }
finally { await browser.close(); await stopFixtureServer(server); }
