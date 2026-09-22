// Campaign Wiki create/evidence/owner fixture: fact create payload shape,
// create retry reuses operation ID, stale verified fact excluded from knowledge
// choices, relationship target reset, escaped source text, stale source shows
// no content, owner links open character sheet / persona detail store actions.
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
const ev = (page, expr) => page.evaluate(expr);
const openDetail = async (page) => { await page.goto(base); await page.locator('[data-campaign-wiki-entity-list]').waitFor(); await page.locator('[data-campaign-wiki-entity-list]').getByRole("button", { name: /Ariadne Vale/ }).click(); await page.getByRole("heading", { name: /Ariadne Vale/ }).waitFor(); };
const openEditor = async (page) => { await openDetail(page); await page.getByRole("button", { name: "Edit", exact: true }).click(); await page.getByRole("heading", { name: "Edit campaign memory", exact: true }).waitFor(); };
const addRecord = async (page) => { await page.getByRole("button", { name: /Add record/i }).click(); await page.locator("select").last().waitFor(); };
try {
  const desktop = await browser.newPage({ viewport: VIEWPORTS.desktop });
  desktop.on("pageerror", (e) => console.log("PAGE_ERROR", e.message));
  await openEditor(desktop);
  await addRecord(desktop);
  const selects = desktop.locator("select");
  const textareas = desktop.locator("textarea");
  await textareas.nth(0).fill("created plain numeric");
  await textareas.nth(1).fill("007");
  await textareas.nth(2).fill("weather=rain\nchapter=03");
  await textareas.nth(3).fill("Create numeric text fact");
  await desktop.getByRole("button", { name: "Review preview", exact: true }).click();
  await desktop.getByText("Changed fields", { exact: true }).waitFor();
  const previewMutation = await ev(desktop, () => window.__wikiMock.lastMutation);
  const input = previewMutation?.input;
  record("fact preview keeps plain numeric value as string", typeof input?.value === "string" && input.value === "007", JSON.stringify(input));
  record("fact preview keeps condition lines exact", JSON.stringify(input?.conditions) === JSON.stringify([{ kind: "condition", value: "weather=rain" }, { kind: "condition", value: "chapter=03" }]), JSON.stringify(input?.conditions));
  const op = previewMutation?.operationId;
  await ev(desktop, () => { window.__wikiMock.failApplyOnce = true; });
  await desktop.getByRole("button", { name: "Apply reviewed change", exact: true }).click(); await desktop.waitForTimeout(250);
  await desktop.getByRole("button", { name: "Apply reviewed change", exact: true }).click(); await desktop.waitForTimeout(400);
  const ids = await ev(desktop, () => window.__wikiMock.mutationIds.slice(-2));
  record("create apply retry reuses same operation ID", ids.length === 2 && ids[0] === op && ids[1] === op, JSON.stringify(ids));

  await openEditor(desktop); await addRecord(desktop); await selects.first().selectOption({ label: "Knowledge" });
  const factOptions = await selects.nth(1).locator("option").allTextContents();
  record("stale verified fact excluded from knowledge choices", !factOptions.some((x) => x.includes("holds the northern archive key")) && factOptions.some((x) => x.includes("has archive count")), JSON.stringify(factOptions));

  await openEditor(desktop); await addRecord(desktop); await selects.first().selectOption({ label: "Relationship" });
  const targetSearch = desktop.locator("textarea").first();
  await targetSearch.fill("Location"); await desktop.waitForTimeout(350);
  const targetSelect = desktop.locator("select").nth(1); await targetSelect.selectOption({ index: 1 });
  const oldTarget = await targetSelect.inputValue();
  await targetSearch.fill("Item"); await desktop.waitForTimeout(350);
  record("relationship search clears old target", oldTarget && (await targetSelect.inputValue()) === "", `old=${oldTarget} new=${await targetSelect.inputValue()}`);
  await shot(desktop, "create-desktop-viewport");

  await openDetail(desktop);
  // The fact with a matching source and a stale source; its quotes sit in a closed "From the story" disclosure.
  const evidence = desktop.locator("details").filter({ hasText: "The archive key is kept here." }).filter({ hasText: "Stale source quote" }).first();
  const evidenceSummary = evidence.locator("summary").first();
  record("evidence disclosure is labelled From the story", /^From the story/.test((await evidenceSummary.innerText()).trim()), await evidenceSummary.innerText());
  await evidenceSummary.click();
  const reads = evidence.getByRole("button", { name: "Show full message", exact: true });
  await reads.first().click(); await desktop.getByText("matched source text", { exact: false }).waitFor();
  const body = await desktop.locator("body").innerText();
  const scriptCount = await desktop.locator("script").count();
  record("source opens escaped matching content", body.includes('<script>alert("xss")</script>') && body.includes("matched source text") && scriptCount === 1, `scriptCount=${scriptCount}`);
  const closeSource = evidence.getByRole("button", { name: "Hide full message", exact: true });
  record("full message can be hidden again", (await closeSource.count()) === 1, `hideButtons=${await closeSource.count()}`);
  await closeSource.click();
  const reads2 = evidence.getByRole("button", { name: "Show full message", exact: true });
  record("both quotes offer the full message", (await reads2.count()) === 2, `showButtons=${await reads2.count()}`);
  await reads2.nth(1).click(); await desktop.waitForTimeout(350);
  await desktop.waitForTimeout(350);
  const staleBody = await desktop.locator("body").innerText();
  record("stale source shows no changed source content", staleBody.includes("This source changed and is no longer available under the recorded hash.") && !staleBody.includes("matched source text") && !staleBody.includes('<script>alert("xss")</script>'), staleBody.slice(-700));

  const ownerButton = desktop.getByRole("button", { name: /Ariadne Character/ });
  await ownerButton.click(); await desktop.waitForTimeout(250);
  const gameOwner = await ev(desktop, () => window.__ownerStores?.game());
  record("character owner opens character store action", gameOwner?.characterSheetOpen === true && gameOwner.characterSheetCharId === "char-1", JSON.stringify(gameOwner));
  await desktop.getByRole("button", { name: /^Location 1 Location/ }).click(); await desktop.getByRole("heading", { name: /Location 1/ }).waitFor();
  const personaButton = desktop.getByRole("button", { name: /Persona One/ });
  await personaButton.click(); await desktop.waitForTimeout(250);
  const personaOwner = await ev(desktop, () => window.__ownerStores?.ui());
  record("persona owner opens persona store action", personaOwner?.personaDetailId === "persona-1", JSON.stringify(personaOwner));
  await desktop.close();

  for (const viewport of MOBILE_VIEWPORTS) {
    const tag = label(viewport);
    const mobile = await browser.newPage({ viewport });
    await openEditor(mobile); await addRecord(mobile); await shot(mobile, `create-mobile-viewport-${tag}`);
    record(`mobile create form renders @${tag}`, await mobile.locator("select").count() > 0, `selects=${await mobile.locator("select").count()}`);
    const size = await mobile.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
    record(`mobile create form has no horizontal overflow @${tag}`, size.scrollWidth <= size.clientWidth, JSON.stringify(size));
    await mobile.close();
  }
  const output = { generatedAt: new Date().toISOString(), base, viewports: [VIEWPORTS.desktop, ...MOBILE_VIEWPORTS], checks, pass: checks.every((x) => x.pass), screenshots, note: "Fixture-only API responses; no production server, database, or provider calls." };
  await fs.writeFile(path.join(out, "create-evidence-owner-results.json"), JSON.stringify(output, null, 2)); console.log(JSON.stringify(output, null, 2));
  if (!output.pass) process.exitCode = 1;
} catch (error) { console.error(error); await fs.writeFile(path.join(out, "create-evidence-owner-error.txt"), String(error?.stack ?? error)); process.exitCode = 1; }
finally { await browser.close(); await stopFixtureServer(server); }
