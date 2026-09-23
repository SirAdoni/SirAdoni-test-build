// Campaign Wiki create/evidence/owner fixture: fact create payload shape,
// create retry reuses operation ID, stale verified fact excluded from knowledge
// choices, relationship target reset, escaped source text, stale source shows
// no content, owner check blocks preview while catching up and blocks apply for
// an owner that already has a page, owner links open character sheet / persona
// detail store actions.
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
  const otherIndex = factOptions.findIndex((x) => x.includes("met the ferryman"));
  const lastSameIndex = factOptions.findIndex((x) => x.includes("has archive count"));
  record("knowledge picker lists this session's facts first and labels the others", otherIndex > lastSameIndex && lastSameIndex > 0 && /\(from Session 1\)$/.test(factOptions[otherIndex] ?? "") && !factOptions[lastSameIndex].includes("from Session"), JSON.stringify(factOptions));
  const groups = await selects.nth(1).locator("optgroup").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("label")));
  record("knowledge picker groups facts by session", JSON.stringify(groups) === JSON.stringify(["From this session", "From other sessions (saved only if this session has a copy)"]), JSON.stringify(groups));
  await selects.nth(1).selectOption("fact-other-session");
  const otherHint = await desktop.getByText(/This fact was recorded in another session\./).count();
  record("choosing another session's fact explains the risk", otherHint === 1, `hint=${otherHint}`);
  await desktop.getByLabel("Reason for this change", { exact: true }).fill("Knows about the ferryman");
  await desktop.getByRole("button", { name: "Review preview", exact: true }).click();
  const crossAlert = desktop.getByRole("alert").filter({ hasText: "Not saved: this change points at a record from another session." });
  await crossAlert.waitFor();
  const crossText = await crossAlert.innerText();
  record("knowledge citing another session's fact shows the cross-session message", crossText.includes("That fact belongs to another session") && !crossText.includes("changed since it was loaded"), crossText);

  await openEditor(desktop); await addRecord(desktop); await selects.first().selectOption({ label: "Relationship" });
  const targetSearch = desktop.locator("textarea").first();
  await targetSearch.fill("Location"); await desktop.waitForTimeout(350);
  const targetSelect = desktop.locator("select").nth(1); await targetSelect.selectOption({ index: 1 });
  const oldTarget = await targetSelect.inputValue();
  await targetSearch.fill("Item"); await desktop.waitForTimeout(350);
  record("relationship search clears old target", oldTarget && (await targetSelect.inputValue()) === "", `old=${oldTarget} new=${await targetSelect.inputValue()}`);
  await shot(desktop, "create-desktop-viewport");

  // Owner check: it only counts when it covers the exact owner ID being sent and is not fetching.
  const STILL_CHECKING = "Still checking whether this owner already has a page. Try again in a moment.";
  await openEditor(desktop); await addRecord(desktop);
  await desktop.getByLabel("Record type", { exact: true }).selectOption({ label: "New entity page" });
  await desktop.getByLabel("Entity kind", { exact: true }).selectOption("item");
  await desktop.getByLabel("Name", { exact: true }).fill("Fixture Lantern");
  await desktop.getByLabel("Reason for this change", { exact: true }).fill("Owner check fixture");
  const ownerField = desktop.getByLabel("Existing owner record ID", { exact: true });
  const previewButton = desktop.getByRole("button", { name: "Review preview", exact: true });
  const stillChecking = desktop.getByText(STILL_CHECKING, { exact: true });
  await ev(desktop, () => { window.__wikiMock.ownerHold = true; window.__wikiMock.lastMutation = null; });
  await ownerField.fill("item-free");
  await previewButton.click();
  record("owner check: preview blocked before debounce catches up", (await stillChecking.count()) === 1 && (await ev(desktop, () => window.__wikiMock.lastMutation)) === null, `stillChecking=${await stillChecking.count()}`);
  await desktop.waitForFunction(() => window.__wikiMock.ownerLookups.includes("game-state:item-free"));
  await previewButton.click();
  record("owner check: preview blocked while lookup is in flight", (await stillChecking.count()) === 1 && (await desktop.getByText("Checking for an existing page...", { exact: true }).count()) === 1 && (await ev(desktop, () => window.__wikiMock.lastMutation)) === null, `stillChecking=${await stillChecking.count()}`);
  await ev(desktop, () => window.__wikiMock.releaseOwner());
  await desktop.getByText("No page exists for this owner yet.", { exact: true }).waitFor();
  record("owner check: still-checking notice clears once the lookup resolves", (await stillChecking.count()) === 0);

  // A finished check for the previous ID must not cover a new ID.
  await ev(desktop, () => { window.__wikiMock.ownerHold = true; window.__wikiMock.ownerLinked["game-state:item-linked"] = "Existing Lantern"; });
  await ownerField.fill("item-linked");
  await previewButton.click();
  record("owner check: result for old owner ID does not cover new ID", (await stillChecking.count()) === 1 && (await desktop.getByText("No page exists for this owner yet.", { exact: true }).count()) === 0 && (await ev(desktop, () => window.__wikiMock.lastMutation)) === null, `stillChecking=${await stillChecking.count()}`);
  await desktop.waitForFunction(() => window.__wikiMock.ownerLookups.includes("game-state:item-linked"));
  await ev(desktop, () => window.__wikiMock.releaseOwner());
  const linkedText = desktop.getByText("This owner already has a page: Existing Lantern", { exact: true });
  await linkedText.first().waitFor();
  await stillChecking.waitFor({ state: "detached" });
  await previewButton.click(); await desktop.waitForTimeout(200);
  record("owner check: owner with a page blocks preview", (await linkedText.count()) >= 2 && (await ev(desktop, () => window.__wikiMock.lastMutation)) === null && (await desktop.getByText("Changed fields", { exact: true }).count()) === 0, `linkedTexts=${await linkedText.count()}`);

  // Free owner previews; a check that later finds a page still blocks apply.
  await ownerField.fill("item-late");
  await desktop.getByText("No page exists for this owner yet.", { exact: true }).waitFor();
  await previewButton.click();
  await desktop.getByText("Changed fields", { exact: true }).waitFor();
  const previewed = await ev(desktop, () => window.__wikiMock.lastMutation);
  record("owner check: free owner previews with exact owner ref", previewed?.input?.owner?.recordId === "item-late" && previewed?.input?.owner?.store === "game-state", JSON.stringify(previewed?.input?.owner));
  const appliesBefore = await ev(desktop, () => window.__wikiMock.mutationIds.length);
  await ev(desktop, async () => { window.__wikiMock.ownerLinked["game-state:item-late"] = "Late Lantern"; await window.__queryClient.invalidateQueries({ queryKey: ["campaign-memory", "owner"] }); });
  const lateLinked = desktop.getByText("This owner already has a page: Late Lantern", { exact: true });
  await lateLinked.first().waitFor();
  await desktop.getByRole("button", { name: "Apply reviewed change", exact: true }).click(); await desktop.waitForTimeout(250);
  const appliesAfter = await ev(desktop, () => window.__wikiMock.mutationIds.length);
  record("owner check: owner that already has a page blocks apply", appliesAfter === appliesBefore && (await lateLinked.count()) >= 2, `applies ${appliesBefore}->${appliesAfter} linkedTexts=${await lateLinked.count()}`);
  await shot(desktop, "create-owner-linked-desktop");

  await openDetail(desktop);
  // The fact with a matching source and a stale source: its row expands in place and shows the quotes open under "From the story".
  await desktop.getByRole("button", { name: /Holds the northern archive key/ }).first().click();
  const evidence = desktop.locator("details").filter({ hasText: "The archive key is kept here." }).filter({ hasText: "Stale source quote" }).first();
  const evidenceSummary = evidence.locator("summary").first();
  record("evidence disclosure is labelled From the story", /^From the story/.test((await evidenceSummary.innerText()).trim()), await evidenceSummary.innerText());
  if ((await evidence.getAttribute("open")) === null) await evidenceSummary.click();
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
