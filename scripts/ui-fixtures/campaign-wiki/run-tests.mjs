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
const loadedText = async (page) => (await text(page)).match(/Showing \d+ of \d+ (matching )?facts/)?.[0] ?? "(no loaded count rendered)";
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const step = async (name, fn) => { try { await fn(); } catch (error) { record(`${name} (step aborted)`, false, String(error?.message ?? error).split("\n").slice(0, 4).join(" ")); } };
const openList = async (page) => { await page.goto(base); await page.locator('[data-campaign-wiki-entity-list]').waitFor(WAIT); };
const openDetail = async (page, query = "") => { await page.goto(`${base}${query}`); await page.locator('[data-campaign-wiki-entity-list]').waitFor(WAIT); await page.locator('[data-campaign-wiki-entity-list]').getByRole("button", { name: /Ariadne Vale/ }).click(); await page.getByText(/^holds the northern archive key$/i).first().waitFor(WAIT); };
const factRow = (page, name) => page.locator('[data-component="campaign-wiki-facts"]').getByRole("button", { name }).first();
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
    await desktop.locator('[role="group"]:has(> button[aria-pressed])').getByRole("button", { name: /^Location\s*[\d,]*$/ }).click();
    await desktop.waitForTimeout(350);
    record("kind filter applies", (await text(desktop)).includes("No pages match"));
  });
  await step("desktop detail", async () => {
    await openDetail(desktop);
    await shot(desktop, "desktop-detail-viewport");
    await shot(desktop, "desktop-detail", true);
    record("detail content visible", /holds the northern archive key/i.test(await text(desktop)) && (await desktop.getByRole("button", { name: /^(What they know|Who knows)/ }).count()) === 1);
    const groups = await desktop.locator('[data-component="campaign-wiki-session-group"] > button[aria-expanded]').allInnerTexts();
    record("facts grouped by session, newest first, with totals", groups.length === 4 && /Session 3\s*40 facts/.test(groups[0]) && /Session 2\s*30 facts/.test(groups[1]) && /Earlier\s*5 facts/.test(groups[3]), JSON.stringify(groups));
    const expanded = await desktop.locator('[data-component="campaign-wiki-session-group"] > button[aria-expanded="true"]').count();
    record("only the newest session starts open", expanded === 1, `open=${expanded}`);
    const pinned = desktop.locator('[data-component="campaign-wiki-pinned"]');
    record("pinned canon at the top", (await pinned.count()) === 1 && (await pinned.innerText()).includes("last sworn archivist"), await pinned.innerText().catch(() => ""));
    const loaded = await loadedText(desktop);
    record("newest session pages its facts", loaded === "Showing 20 of 40 facts", loaded);
    await desktop.getByRole("button", { name: "Load more facts", exact: true }).first().click();
    await desktop.getByText("Ariadne agreed to escort caravan 39.", { exact: true }).waitFor(WAIT);
    record("load more appends the next page", (await desktop.getByRole("button", { name: "Load more facts", exact: true }).count()) === 0);
    await desktop.getByRole("button", { name: /^Session 2/ }).click();
    await desktop.getByText("Ariadne learned archive rule 45.", { exact: true }).waitFor(WAIT);
    record("opening a session loads that session", (await text(desktop)).includes("Ariadne learned archive rule 45."));
    record("withdrawn facts collapse into one line", (await desktop.getByRole("button", { name: /^1 withdrawn/ }).count()) === 1 && !(await text(desktop)).includes("born in the southern marshes"));
  });
  await step("desktop fact filters", async () => {
    await openDetail(desktop);
    await desktop.getByRole("group", { name: "Filter facts by kind" }).getByRole("button", { name: /^Commitment/ }).click();
    await desktop.getByText("Ariadne promised to guard the gate until the thaw.", { exact: true }).waitFor(WAIT);
    const rows = await desktop.locator('[data-component="campaign-wiki-facts"] li').allInnerTexts();
    record("kind chip filters on the server", rows.length === 15 && !rows.some((row) => /holds the northern archive key/i.test(row)) && rows.some((row) => row.includes("Ariadne agreed to escort caravan 11.")), `rows=${rows.length}`);
    await desktop.getByRole("group", { name: "Filter facts by kind" }).getByRole("button", { name: /^All/ }).click();
    await desktop.getByPlaceholder(/^Search 101 facts$/).fill("caravan 60");
    await desktop.getByText("Ariadne agreed to escort caravan 60.", { exact: true }).waitFor(WAIT);
    const found = await desktop.locator('[data-component="campaign-wiki-facts"] li button[aria-expanded]').count();
    record("search finds a fact from a closed session", found === 1, `rows=${found}`);
    await shot(desktop, "desktop-detail-search-viewport");
  });
  await step("desktop fact actions", async () => {
    await openDetail(desktop);
    await factRow(desktop, /promised to guard the gate/).click();
    const details = desktop.locator('[data-component="campaign-wiki-fact-details"]').first();
    await details.waitFor(WAIT);
    record("expanded row shows its quote open", (await details.locator("details[open]").count()) === 1);
    await shot(desktop, "desktop-detail-expanded-viewport");
    await details.getByRole("button", { name: "Wrong", exact: true }).click();
    await details.getByText("Mark as wrong? The memory will stop using it.", { exact: true }).waitFor(WAIT);
    await details.getByRole("button", { name: "Mark as wrong", exact: true }).click();
    await desktop.waitForFunction(() => window.__wikiMock.lastMutation?.recordId === "fact-6", undefined, WAIT);
    const wrong = await desktop.evaluate(() => window.__wikiMock.lastMutation);
    record("wrong sends the full fact patch", wrong.action === "update" && wrong.recordType === "fact" && wrong.expectedRevision === 1 && wrong.patch.status === "retracted" && wrong.patch.manualLock === true && wrong.patch.predicate === "continuity.record" && wrong.patch.value?.kind === "commitment" && Array.isArray(wrong.patch.evidence) && wrong.reason === "Marked wrong in the Campaign Wiki", JSON.stringify(wrong));
    await desktop.getByRole("button", { name: /^2 withdrawn/ }).waitFor(WAIT);
    record("wrong fact moves to withdrawn", !(await desktop.locator('[data-component="campaign-wiki-facts"]').innerText()).includes("promised to guard the gate"));

    await factRow(desktop, /archive rule 10\./).click();
    await desktop.locator('[data-component="campaign-wiki-fact-details"]').first().getByRole("button", { name: "Pin as canon", exact: true }).click();
    await desktop.waitForFunction(() => window.__wikiMock.lastMutation?.recordId === "fact-10", undefined, WAIT);
    const pin = await desktop.evaluate(() => window.__wikiMock.lastMutation);
    record("pin sets value.pinned and the lock", pin.patch.value?.pinned === true && pin.patch.manualLock === true && pin.patch.value?.text === "Ariadne learned archive rule 10.", JSON.stringify(pin.patch));
    await desktop.locator('[data-component="campaign-wiki-pinned"]').getByText("Ariadne learned archive rule 10.", { exact: true }).waitFor(WAIT);
    record("pinned fact joins the pinned block", true);

    await desktop.locator('[data-component="campaign-wiki-pinned"]').getByRole("button", { name: /last sworn archivist/ }).click();
    await desktop.locator('[data-component="campaign-wiki-pinned"]').getByRole("button", { name: "Unpin", exact: true }).click();
    await desktop.waitForFunction(() => window.__wikiMock.lastMutation?.recordId === "fact-5", undefined, WAIT);
    const unpin = await desktop.evaluate(() => window.__wikiMock.lastMutation);
    record("unpin clears the flag and the pin lock", unpin.patch.value?.pinned === false && unpin.patch.manualLock === false, JSON.stringify(unpin.patch));

    await factRow(desktop, /Holds the northern archive key/).click();
    await desktop.locator('[data-component="campaign-wiki-fact-details"]').first().getByRole("button", { name: "Correct", exact: true }).click();
    await desktop.getByRole("heading", { name: "Edit campaign memory", exact: true }).waitFor(WAIT);
    record("correct opens the editor", true);
  });
  await step("desktop legacy server fallback", async () => {
    await openDetail(desktop, "?facts=legacy");
    await desktop.waitForTimeout(600);
    const groups = await desktop.locator('[data-component="campaign-wiki-facts"] section > button[aria-expanded]').allInnerTexts();
    record("older server: facts still grouped by session", groups.length === 4 && /Session 3\s*39 facts/.test(groups[0]), JSON.stringify(groups));
  });
  await step("desktop related navigation", async () => {
    await openDetail(desktop);
    const infobox = desktop.locator('[data-component="campaign-wiki-infobox"]');
    await infobox.getByRole("button", { name: /Allied with/ }).click();
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
      await mobile.locator('[role="group"]:has(> button[aria-pressed])').getByRole("button", { name: /^Character\s*[\d,]*$/ }).click();
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
      await mobile.evaluate(() => { window.__wikiMock.failFactPage = 1; });
      await mobile.getByRole("button", { name: "Load more facts", exact: true }).first().click();
      await mobile.getByText("Campaign memory could not be loaded.", { exact: true }).waitFor(WAIT);
      rec("fact page error state visible", (await text(mobile)).includes("Retry"));
      await mobile.getByRole("button", { name: "Retry", exact: true }).click();
      await mobile.getByText("Ariadne agreed to escort caravan 39.", { exact: true }).waitFor(WAIT);
      const body = await text(mobile);
      rec("fact page retry recovers", !body.includes("Campaign memory could not be loaded.") && body.includes("Ariadne agreed to escort caravan 39."));
      await factRow(mobile, /promised to guard the gate/).click();
      await mobile.locator('[data-component="campaign-wiki-fact-details"]').first().waitFor(WAIT);
      await mobile.locator('[data-component="campaign-wiki-fact-details"]').first().scrollIntoViewIfNeeded();
      await shot(mobile, `mobile-detail-expanded-viewport-${tag}`);
      rec("mobile expanded row no horizontal overflow", await noOverflow(mobile));
      await mobile.evaluate(() => { window.__wikiMock.failDetail = 1; });
      await mobile.getByRole("button", { name: /^Session 2/ }).click();
      await mobile.getByText("Campaign memory could not be loaded.", { exact: true }).waitFor(WAIT);
      await mobile.getByRole("button", { name: "Retry", exact: true }).click();
      await mobile.getByText("Ariadne learned archive rule 45.", { exact: true }).waitFor(WAIT);
      rec("session group error and retry", true);
    });
    await mobile.close();
  }
  const output = { generatedAt: new Date().toISOString(), base, viewports: [VIEWPORTS.desktop, ...MOBILE_VIEWPORTS], checks, pass: checks.every((item) => item.pass), screenshots, note: "Fixture-only API responses (window.fetch mock); no production server, database, or provider calls." };
  await fs.writeFile(path.join(out, "results.json"), JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
  if (!output.pass) process.exitCode = 1;
} catch (error) { console.error(error); await fs.writeFile(path.join(out, "results-error.txt"), String(error?.stack ?? error)); process.exitCode = 1; }
finally { await browser.close(); await stopFixtureServer(server); }
