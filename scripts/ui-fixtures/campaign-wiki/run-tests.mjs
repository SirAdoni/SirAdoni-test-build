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
const SEARCH = "Search people, places, lore";
const factRow = (page, name) => page.locator('[data-component="campaign-wiki-facts"]').getByRole("button", { name }).first();
try {
  const desktop = await browser.newPage({ viewport: VIEWPORTS.desktop });
  await step("desktop list", async () => {
    await openList(desktop);
    await shot(desktop, "desktop-list", true);
    await shot(desktop, "desktop-list-viewport");
    record("desktop list renders", (await text(desktop)).includes("Ariadne Vale"));
    const list = desktop.locator("[data-campaign-wiki-entity-list]");
    await list.locator('[data-campaign-wiki-rail-section="item"]').waitFor(WAIT);
    const sections = await list.locator("[data-campaign-wiki-rail-section]").evaluateAll((nodes) => nodes.map((node) => ({ kind: node.getAttribute("data-campaign-wiki-rail-section"), header: node.querySelector("button[aria-expanded]")?.textContent?.trim(), open: node.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded") })));
    record("default list groups by kind, people and places first", (await list.getAttribute("data-campaign-wiki-list-mode")) === "grouped" && sections.map((section) => section.kind).join(",") === "character,location,item" && /People\s*41/.test(sections[0]?.header ?? "") && /Places\s*40/.test(sections[1]?.header ?? "") && /Items\s*40/.test(sections[2]?.header ?? ""), JSON.stringify(sections));
    record("people and places start open, the rest collapsed", sections[0]?.open === "true" && sections[1]?.open === "true" && sections[2]?.open === "false", JSON.stringify(sections.map((section) => section.open)));
    const people = list.locator('[data-campaign-wiki-rail-section="character"]');
    await people.locator("[data-campaign-wiki-entity-row]").first().waitFor(WAIT);
    const firstRows = await people.locator("[data-campaign-wiki-entity-row]").count();
    record("a section shows its first rows", firstRows === 8, `rows=${firstRows}`);
    const chips = await desktop.getByRole("group", { name: "Filter by entity kind" }).innerText();
    record("kind chips carry the served totals", /All\s*121/.test(chips) && /Character\s*41/.test(chips), chips.replace(/\s+/g, " "));
    await people.getByRole("button", { name: /^Show \d+ more$/ }).click();
    await desktop.waitForFunction(() => document.querySelectorAll('[data-campaign-wiki-rail-section="character"] [data-campaign-wiki-entity-row]').length > 8, undefined, WAIT);
    const grownRows = await people.locator("[data-campaign-wiki-entity-row]").count();
    record("show more grows the section in place", grownRows === 20, `rows=${grownRows}`);
    const items = list.locator('[data-campaign-wiki-rail-section="item"]');
    await items.locator("button[aria-expanded]").first().click();
    await items.locator("[data-campaign-wiki-entity-row]").first().waitFor(WAIT);
    record("a collapsed section opens on demand", (await items.locator("[data-campaign-wiki-entity-row]").count()) === 8);
    await items.locator("button[aria-expanded]").first().click();
    // CampaignWiki.tsx debounces searchText (250 ms) and that effect also resets entityOffset to 0,
    // so a Next click within 250 ms of mount is discarded. Let the mount-time debounce settle first.
    await desktop.waitForTimeout(400);
    await people.getByRole("button", { name: /^See all 41$/ }).click();
    await desktop.getByText(/\d+–\d+ of 41/).first().waitFor(WAIT);
    const kindTotal = (await text(desktop)).match(/\d+–\d+ of 41/)?.[0] ?? "(none)";
    record("see all opens the paged kind list", kindTotal === "1–20 of 41" && (await list.getAttribute("data-campaign-wiki-list-mode")) === "kind", kindTotal);
    await desktop.getByRole("button", { name: "Next", exact: true }).first().click();
    try { await desktop.getByText("21–40 of 41").first().waitFor(WAIT); } catch {}
    await shot(desktop, "desktop-list-after-next-viewport");
    const nextTotal = (await text(desktop)).match(/\d+–\d+ of 41/)?.[0] ?? "(none)";
    record("desktop list next page", nextTotal === "21–40 of 41" && (await list.innerText()).includes("Character 63"), nextTotal);
  });
  await step("portrait placeholders", async () => {
    await openList(desktop);
    const ariadne = desktop.locator("[data-campaign-wiki-entity-list]").getByRole("button", { name: /Character 3\b/ }).first().locator("[data-avatar-state]");
    await ariadne.waitFor(WAIT);
    const early = await ariadne.evaluate((node) => ({ state: node.getAttribute("data-avatar-state"), initials: node.querySelector("[data-avatar-fallback]")?.textContent ?? "", opacity: getComputedStyle(node.querySelector("img") ?? node).opacity }));
    record("slow portrait shows initials while loading", early.state === "loading" && early.initials === "C3" && early.opacity === "0", JSON.stringify(early));
    await desktop.waitForFunction(() => document.querySelector('[data-campaign-wiki-entity-list] [data-avatar-state="loaded"]'), undefined, WAIT);
    await desktop.waitForTimeout(400);
    const loaded = await ariadne.evaluate((node) => ({ state: node.getAttribute("data-avatar-state"), fallback: node.querySelectorAll("[data-avatar-fallback]").length, opacity: getComputedStyle(node.querySelector("img") ?? node).opacity }));
    record("portrait fades in over the initials once loaded", loaded.state === "loaded" && loaded.fallback === 0 && loaded.opacity === "1", JSON.stringify(loaded));
    await desktop.waitForFunction(() => document.querySelector('[data-campaign-wiki-entity-list] [data-avatar-state="error"]'), undefined, WAIT);
    const broken = desktop.locator("[data-campaign-wiki-entity-list]").getByRole("button", { name: /Character 6\b/ }).first().locator("[data-avatar-state]");
    const failed = await broken.evaluate((node) => ({ state: node.getAttribute("data-avatar-state"), initials: node.querySelector("[data-avatar-fallback]")?.textContent ?? "", img: node.querySelectorAll("img").length }));
    record("missing portrait falls back to initials", failed.state === "error" && failed.initials === "C6" && failed.img === 0, JSON.stringify(failed));
  });
  await step("desktop overview", async () => {
    await openList(desktop);
    const overview = desktop.locator("[data-campaign-wiki-overview]");
    await overview.locator("[data-campaign-wiki-latest] li").first().waitFor(WAIT);
    await overview.locator("[data-campaign-wiki-overview-promises]").getByText("Recover the archive key", { exact: true }).waitFor(WAIT);
    await overview.locator("[data-campaign-wiki-overview-recent] li").first().waitFor(WAIT);
    const stats = await overview.locator("[data-campaign-wiki-overview-stats]").innerText();
    record("overview stat tiles per kind", /People\s*41/i.test(stats) && /Places\s*40/i.test(stats) && /Items\s*40/i.test(stats), stats.replace(/\s+/g, " "));
    const people = await overview.locator("[data-campaign-wiki-overview-people] li").allInnerTexts();
    record("overview people grid leads with portraits", people.length === 12 && people[0].includes("Character 3") && people[1].includes("Character 6") && people[2].includes("Ariadne Vale"), JSON.stringify(people.slice(0, 3)));
    const latest = await overview.locator("[data-campaign-wiki-latest] li").allInnerTexts();
    record("latest in the story is newest first and readable", latest.length === 2 && latest[0].includes("Ariadne kept watch at the gate") && /Session 3/i.test(latest[0]) && latest[1].includes("archive opened after the eclipse"), JSON.stringify(latest));
    const timelineRequests = await desktop.evaluate(() => window.__wikiMock.timelineRequests.slice());
    record("latest in the story is one order=desc&limit=10 request, no cursor walk", timelineRequests.length >= 1 && timelineRequests.every((query) => /[?&]order=desc\b/.test(query) && /[?&]limit=10\b/.test(query) && !/cursor=/.test(query)), JSON.stringify(timelineRequests));
    const heroTitle = (await overview.locator("header h2").first().innerText()).trim();
    record("front page names the campaign, not the session chat", heroTitle === "Fixture Campaign", heroTitle);
    const promises = await overview.locator("[data-campaign-wiki-overview-promises] li").allInnerTexts();
    record("open promises only", promises.length === 2 && promises.some((row) => row.includes("Keep the archive watch")) && !promises.some((row) => row.includes("Archive key recovered")), JSON.stringify(promises));
    record("places and recently changed render", (await overview.locator("[data-campaign-wiki-overview-places] li").count()) === 8 && (await overview.locator("[data-campaign-wiki-overview-recent] li").count()) === 6);
    await shot(desktop, "desktop-overview-viewport");
    await shot(desktop, "desktop-overview", true);
    record("overview no horizontal overflow", await noOverflow(desktop));
    await overview.locator("[data-campaign-wiki-overview-promises]").getByRole("button", { name: /^See all/ }).first().click();
    const region = desktop.getByRole("region", { name: /quests and commitments/i });
    await region.getByText("Recover the archive key", { exact: true }).waitFor(WAIT);
    record("see all promises opens the promises tab", (await desktop.getByRole("tab", { name: /Promises & quests/, selected: true }).count()) === 1);
  });
  await step("desktop campaign timeline", async () => {
    await openList(desktop);
    await desktop.getByRole("button", { name: "Timeline", exact: true }).click();
    const timeline = desktop.locator('[data-component="campaign-wiki-timeline"]');
    await timeline.getByText("Ariadne kept watch at the gate while the old records were checked.", { exact: true }).waitFor(WAIT);
    const sessions = await timeline.locator("h4[data-timeline-anchor]").allInnerTexts();
    record("timeline groups by session in story order", sessions.length === 2 && /Session 2\s*1 event/.test(sessions[0]) && /Session 3\s*1 event/.test(sessions[1]), JSON.stringify(sessions));
    const jumps = await timeline.locator("[data-campaign-wiki-timeline-jump] button").allInnerTexts();
    record("session jump bar", jumps.join("|") === "Session 2|Session 3", jumps.join("|"));
    const card = timeline.locator("article").first();
    const chips = await card.getByRole("button").allInnerTexts();
    record("event card shows place and people", chips.some((chip) => chip.includes("Location 1")) && chips.some((chip) => chip.includes("Ariadne Vale")) && (await card.locator("[data-avatar-state]").count()) >= 1, JSON.stringify(chips));
    await shot(desktop, "desktop-timeline-viewport");
    await card.getByRole("button", { name: /Ariadne Vale/ }).click();
    await desktop.getByRole("heading", { name: "Ariadne Vale", exact: true }).waitFor(WAIT);
    record("timeline participant opens the page", true);
  });
  await step("desktop search and filter", async () => {
    await openList(desktop);
    await desktop.getByPlaceholder(SEARCH).fill("Ariadne");
    await desktop.waitForTimeout(350);
    const listText = await desktop.locator("[data-campaign-wiki-entity-list]").innerText();
    record("search filters", listText.includes("Ariadne Vale") && !listText.includes("Location 1"));
    await desktop.getByPlaceholder(SEARCH).fill("1");
    await desktop.waitForTimeout(450);
    const kinds = await desktop.locator("[data-campaign-wiki-entity-list] [data-campaign-wiki-entity-row]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-campaign-wiki-entity-row")));
    const order = ["character", "persona", "location", "organization", "item", "quest", "lore", "note"];
    const ranked = kinds.every((kind, index) => index === 0 || order.indexOf(kinds[index - 1]) <= order.indexOf(kind));
    record("search results rank people before places before items", kinds.length > 3 && ranked && kinds[0] === "character" && (await desktop.locator("[data-campaign-wiki-entity-list]").getAttribute("data-campaign-wiki-list-mode")) === "search", kinds.join(","));
    await desktop.getByPlaceholder(SEARCH).fill("Ariadne");
    await desktop.waitForTimeout(350);
    await desktop.locator('[role="group"]:has(> button[aria-pressed])').getByRole("button", { name: /^Location\s*[\d,]*$/ }).click();
    await desktop.waitForTimeout(350);
    record("kind filter applies", (await text(desktop)).includes("No pages match"));
  });
  await step("same-name pages and grouped connections", async () => {
    await desktop.goto(`${base}?dupes=1`);
    await desktop.locator("[data-campaign-wiki-entity-list]").waitFor(WAIT);
    await desktop.getByPlaceholder(SEARCH).fill("continuity");
    const cluster = desktop.locator("[data-campaign-wiki-entity-list] [data-campaign-wiki-same-name]");
    await cluster.first().waitFor(WAIT);
    const collapsed = { clusters: await cluster.count(), size: await cluster.first().getAttribute("data-campaign-wiki-same-name"), rows: await desktop.locator("[data-campaign-wiki-entity-list] [data-campaign-wiki-entity-row]").count(), text: (await cluster.first().innerText()).replace(/\s+/g, " ") };
    record("same-name results collapse into one row with a count", collapsed.clusters === 1 && collapsed.size === "3" && collapsed.rows === 1 && /Game continuity 8/.test(collapsed.text) && /3 pages/.test(collapsed.text), JSON.stringify(collapsed));
    await cluster.first().getByRole("button", { name: /^Show all 3 pages named/ }).click();
    const expandedRows = await desktop.locator("[data-campaign-wiki-entity-list] [data-campaign-wiki-entity-row]").count();
    record("the cluster expands to every page", expandedRows === 3, `rows=${expandedRows}`);
    await desktop.getByPlaceholder(SEARCH).fill("");
    await desktop.locator('[data-campaign-wiki-entity-list] [data-campaign-wiki-rail-section="character"]').getByRole("button", { name: /Ariadne Vale/ }).click();
    const infobox = desktop.locator('[data-component="campaign-wiki-infobox"]');
    await infobox.getByRole("button", { name: /Allied with/ }).waitFor(WAIT);
    const rows = await infobox.getByRole("button", { name: /Location 1/ }).allInnerTexts();
    record("infobox connections: one row per page, labels deduplicated", rows.length === 1 && /Allied with, Trusts, Owes \(proposed\)/.test(rows[0]), JSON.stringify(rows));
  });
  await step("older server list fallback", async () => {
    await desktop.goto(`${base}?list=legacy`);
    await desktop.locator('[data-campaign-wiki-rail-section="character"]').waitFor(WAIT);
    await desktop.waitForTimeout(300);
    const chips = await desktop.getByRole("group", { name: "Filter by entity kind" }).innerText();
    record("without served totals the chips count per kind", /Character\s*41/.test(chips) && /Location\s*40/.test(chips) && /All\s*121/.test(chips), chips.replace(/\s+/g, " "));
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
    record("wrong sends a partial patch of status and lock only", wrong.action === "update" && wrong.recordType === "fact" && wrong.expectedRevision === 1 && JSON.stringify(Object.keys(wrong.patch).sort()) === JSON.stringify(["manualLock", "status"]) && wrong.patch.status === "retracted" && wrong.patch.manualLock === true && wrong.reason === "Marked wrong in the Campaign Wiki", JSON.stringify(wrong));
    await desktop.getByRole("button", { name: /^2 withdrawn/ }).waitFor(WAIT);
    record("wrong fact moves to withdrawn", !(await desktop.locator('[data-component="campaign-wiki-facts"]').innerText()).includes("promised to guard the gate"));

    await factRow(desktop, /archive rule 10\./).click();
    await desktop.locator('[data-component="campaign-wiki-fact-details"]').first().getByRole("button", { name: "Pin as canon", exact: true }).click();
    await desktop.waitForFunction(() => window.__wikiMock.lastMutation?.recordId === "fact-10", undefined, WAIT);
    const pin = await desktop.evaluate(() => window.__wikiMock.lastMutation);
    record("pin sets value.pinned and the lock", pin.patch.value?.pinned === true && pin.patch.manualLock === true && pin.patch.value?.text === "Ariadne learned archive rule 10.", JSON.stringify(pin.patch));
    record("pin sends a partial patch of value and lock only", JSON.stringify(Object.keys(pin.patch).sort()) === JSON.stringify(["manualLock", "value"]), JSON.stringify(Object.keys(pin.patch)));
    await desktop.locator('[data-component="campaign-wiki-pinned"]').getByText("Ariadne learned archive rule 10.", { exact: true }).waitFor(WAIT);
    record("pinned fact joins the pinned block", true);

    await desktop.locator('[data-component="campaign-wiki-pinned"]').getByRole("button", { name: /last sworn archivist/ }).click();
    await desktop.locator('[data-component="campaign-wiki-pinned"]').getByRole("button", { name: "Unpin", exact: true }).click();
    await desktop.waitForFunction(() => window.__wikiMock.lastMutation?.recordId === "fact-5", undefined, WAIT);
    const unpin = await desktop.evaluate(() => window.__wikiMock.lastMutation);
    record("unpin clears the flag and the pin lock", unpin.patch.value?.pinned === false && unpin.patch.manualLock === false, JSON.stringify(unpin.patch));

    // A write the server refuses as CAMPAIGN_MEMORY_CROSS_SESSION_REFERENCE (409) gets its own message, not the reload banner.
    await factRow(desktop, /archive rule 17\./).click();
    const crossDetails = desktop.locator('[data-component="campaign-wiki-facts"] li', { has: desktop.getByRole("button", { name: /archive rule 17\./ }) }).last().locator('[data-component="campaign-wiki-fact-details"]').first();
    await crossDetails.waitFor(WAIT);
    await desktop.evaluate(() => { window.__wikiMock.crossSessionOnce = true; });
    await crossDetails.getByRole("button", { name: "Pin as canon", exact: true }).click();
    const crossAlert = crossDetails.getByRole("alert");
    await crossAlert.waitFor(WAIT);
    const crossText = await crossAlert.innerText();
    record("fact pin cross-session 409 shows the specific message", crossText.includes("Not saved: this change points at a record from another session.") && crossText.includes("Mira Thorne has no page in that session yet") && !crossText.includes("changed since it was loaded") && (await crossAlert.getByRole("button", { name: "Reload", exact: true }).count()) === 0, crossText);

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
      await shot(mobile, `mobile-list-viewport-${tag}`);
      await mobile.getByRole("button", { name: "Front page", exact: true }).click();
      await mobile.locator("[data-campaign-wiki-overview] [data-campaign-wiki-latest] li").first().waitFor(WAIT);
      await mobile.waitForTimeout(300);
      await shot(mobile, `mobile-overview-viewport-${tag}`);
      await shot(mobile, `mobile-overview-${tag}`, true);
      rec("mobile front page opens and fits", (await mobile.locator("[data-campaign-wiki-overview-people] li").count()) === 12 && (await noOverflow(mobile)));
      await mobile.getByRole("button", { name: "Back to entities", exact: true }).first().click();
      await mobile.getByRole("button", { name: "Timeline", exact: true }).click();
      await mobile.locator('[data-component="campaign-wiki-timeline"] article').first().waitFor(WAIT);
      await shot(mobile, `mobile-timeline-viewport-${tag}`);
      rec("mobile timeline fits", await noOverflow(mobile));
    });
    await step(`mobile list states @${tag}`, async () => {
      await openList(mobile);
      await mobile.evaluate(() => { window.__wikiMock.delayMs = 500; });
      await mobile.locator('[role="group"]:has(> button[aria-pressed])').getByRole("button", { name: /^Character\s*[\d,]*$/ }).click();
      rec("loading state visible", await mobile.getByText("Loading campaign memory...", { exact: true }).isVisible());
      await mobile.getByPlaceholder(SEARCH).fill("No match");
      await mobile.waitForTimeout(800);
      rec("empty state visible", (await text(mobile)).includes("No pages match"));
      await mobile.evaluate(() => { window.__wikiMock.delayMs = 0; window.__wikiMock.failList = 1; });
      await mobile.getByPlaceholder(SEARCH).fill("ErrorTrigger");
      await mobile.waitForTimeout(350);
      await mobile.getByText("Campaign memory could not be loaded.", { exact: true }).waitFor(WAIT);
      rec("list error state visible", (await text(mobile)).includes("Retry"));
      await mobile.getByRole("button", { name: "Retry", exact: true }).click();
      await mobile.getByPlaceholder(SEARCH).fill("");
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
