// Campaign Wiki lore owner fixture (?lore=1): a page owned by a lorebook entry links to that entry in its lorebook,
// whether the entry sits in the chat's active lorebook or in an earlier session's chat-scoped lorebook; a page owned
// by a whole lorebook opens that lorebook; only a page whose entry no longer exists shows "Linked page unavailable".
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
const shot = async (page, name) => { await page.screenshot({ path: path.join(out, `${name}.png`) }); screenshots.push(`${name}.png`); };
const step = async (name, fn) => { try { await fn(); } catch (error) { record(`${name} (step aborted)`, false, String(error?.message ?? error).split("\n").slice(0, 4).join(" ")); } };
const SEARCH = "Search people, places, lore";
const openPage = async (page, alias) => {
  const search = page.getByPlaceholder(SEARCH);
  await search.fill(alias);
  const row = page.locator("[data-campaign-wiki-entity-list]").getByRole("button", { name: new RegExp(alias) }).first();
  await row.waitFor(WAIT);
  await row.click();
  await page.getByRole("heading", { name: alias, exact: true }).waitFor(WAIT);
};
const ownerLink = (page) => page.locator('[data-component="campaign-wiki-owner-link"]');
const settledOwner = async (page) => {
  await ownerLink(page).waitFor(WAIT);
  await page.waitForFunction(() => !document.querySelector('[data-component="campaign-wiki-owner-link"] .animate-spin'), undefined, WAIT);
  return (await ownerLink(page).innerText()).replace(/\s+/g, " ").trim();
};
const uiState = (page) => page.evaluate(() => window.__ownerStores?.ui());

try {
  const desktop = await browser.newPage({ viewport: VIEWPORTS.desktop });
  desktop.on("pageerror", (e) => console.log("PAGE_ERROR", e.message));
  await desktop.goto(`${base}?lore=1`);
  await desktop.locator("[data-campaign-wiki-entity-list]").waitFor(WAIT);

  await step("entry in the active lorebook", async () => {
    await openPage(desktop, "Fixture Lore Near");
    const linkText = await settledOwner(desktop);
    await shot(desktop, "lore-owner-near-desktop");
    record("active-lorebook entry page shows no unavailable notice", !linkText.includes("Linked page unavailable"), linkText);
    const button = ownerLink(desktop).getByRole("button", { name: "Open Near Entry", exact: true });
    record("active-lorebook entry page offers a link named after the entry", (await button.count()) === 1 && linkText.includes("Lorebook entry"), linkText);
    await button.click();
    const ui = await uiState(desktop);
    record("entry link opens its lorebook on the entries tab", ui?.lorebookDetailId === "book-active" && ui?.lorebookDetailInitialTab === "entries", JSON.stringify(ui));
    const fetches = await desktop.evaluate(() => window.__wikiMock.loreFetches);
    record("a near hit never loads other sessions' lorebooks", !fetches.includes("/api/lorebooks/book-older/entries") && !fetches.includes("/api/lorebooks/book-deleted/entries"), JSON.stringify(fetches));
  });

  await step("entry in an earlier session's lorebook", async () => {
    await openPage(desktop, "Fixture Lore Far");
    const linkText = await settledOwner(desktop);
    const button = ownerLink(desktop).getByRole("button", { name: "Open Far Entry", exact: true });
    record("earlier-session entry page links to its entry", (await button.count()) === 1 && !linkText.includes("Linked page unavailable"), linkText);
    await button.click();
    const ui = await uiState(desktop);
    record("earlier-session entry link opens the session lorebook", ui?.lorebookDetailId === "book-older" && ui?.lorebookDetailInitialTab === "entries", JSON.stringify(ui));
  });

  await step("page owned by a whole lorebook", async () => {
    await openPage(desktop, "Fixture Lore Book");
    const linkText = await settledOwner(desktop);
    const button = ownerLink(desktop).getByRole("button", { name: "Open Fixture Active Book", exact: true });
    record("lorebook-owned page offers Open lorebook", (await button.count()) === 1 && linkText.includes("Open lorebook"), linkText);
    await button.click();
    const ui = await uiState(desktop);
    record("lorebook link opens the lorebook on its default tab", ui?.lorebookDetailId === "book-active" && ui?.lorebookDetailInitialTab === null, JSON.stringify(ui));
  });

  await step("entry that no longer exists", async () => {
    await openPage(desktop, "Fixture Lore Gone");
    const linkText = await settledOwner(desktop);
    await shot(desktop, "lore-owner-gone-desktop");
    record("missing entry keeps the unavailable notice and no button", linkText.includes("Linked page unavailable") && (await ownerLink(desktop).getByRole("button").count()) === 0, linkText);
  });
  await desktop.close();

  for (const viewport of MOBILE_VIEWPORTS) {
    const tag = label(viewport);
    const mobile = await browser.newPage({ viewport });
    await step(`mobile @${tag}`, async () => {
      await mobile.goto(`${base}?lore=1`);
      await mobile.locator("[data-campaign-wiki-entity-list]").waitFor(WAIT);
      await openPage(mobile, "Fixture Lore Near");
      const linkText = await settledOwner(mobile);
      await shot(mobile, `lore-owner-near-mobile-${tag}`);
      record(`mobile lore link renders @${tag}`, (await ownerLink(mobile).getByRole("button", { name: "Open Near Entry", exact: true }).count()) === 1, linkText);
      const size = await mobile.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
      record(`mobile lore page has no horizontal overflow @${tag}`, size.scrollWidth <= size.clientWidth, JSON.stringify(size));
    });
    await mobile.close();
  }
  const output = { generatedAt: new Date().toISOString(), base, viewports: [VIEWPORTS.desktop, ...MOBILE_VIEWPORTS], checks, pass: checks.length > 0 && checks.every((x) => x.pass), screenshots, note: "Fixture-only API responses; no production server, database, or provider calls." };
  await fs.writeFile(path.join(out, "lore-owner-results.json"), JSON.stringify(output, null, 2)); console.log(JSON.stringify(output, null, 2));
  if (!output.pass) process.exitCode = 1;
} catch (error) { console.error(error); await fs.writeFile(path.join(out, "lore-owner-error.txt"), String(error?.stack ?? error)); process.exitCode = 1; }
finally { await browser.close(); await stopFixtureServer(server); }
