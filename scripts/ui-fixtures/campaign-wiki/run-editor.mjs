// Campaign Wiki editor fixture: lock-only patch, apply retry reuses operation
// ID, preview invalidation, save render, typed fact locks, stale 409 keeps the
// draft, unsaved confirmations, refetch keeps draft, mobile close confirms.
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
const json = (page, expr) => page.evaluate(expr);
const openEditor = async (page) => {
  await page.goto(base);
  await page.locator('[data-campaign-wiki-entity-list]').waitFor();
  await page.locator('[data-campaign-wiki-entity-list]').getByRole("button", { name: /Ariadne Vale/ }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).waitFor();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  try { await page.getByRole("heading", { name: "Edit campaign memory", exact: true }).waitFor({ timeout: 5000 }); }
  catch (error) { console.log("OPEN_EDITOR_BODY", (await page.locator("body").innerText()).slice(0, 1200)); throw error; }
};
const patchOnly = (mutation, expected) => {
  const patch = mutation?.patch ?? null;
  return JSON.stringify(patch) === JSON.stringify(expected) && Object.keys(patch ?? {}).length === Object.keys(expected).length;
};
try {
  const desktop = await browser.newPage({ viewport: VIEWPORTS.desktop });
  desktop.on("pageerror", (error) => console.log("PAGE_ERROR", error.message));
  await openEditor(desktop);
  await desktop.getByLabel("Hold this record against automatic changes", { exact: true }).check();
  await desktop.getByLabel("Reason for this change", { exact: true }).fill("Lock reviewed entity");
  await desktop.getByRole("button", { name: "Review preview", exact: true }).click();
  await desktop.waitForTimeout(500);
  await desktop.getByRole("button", { name: "Apply reviewed change", exact: true }).waitFor();
  const entityPreview = await json(desktop, () => window.__wikiMock.lastMutation);
  record("entity lock preview sends only manualLock", patchOnly(entityPreview, { manualLock: true }), JSON.stringify(entityPreview?.patch));
  const entityOp = entityPreview?.operationId;
  await json(desktop, () => { window.__wikiMock.failApplyOnce = true; });
  await desktop.getByRole("button", { name: "Apply reviewed change", exact: true }).click();
  await desktop.waitForTimeout(250);
  await desktop.getByRole("button", { name: "Apply reviewed change", exact: true }).click();
  await desktop.locator('[data-component="campaign-wiki-article"]').getByText("Ariadne guards the northern archive.", { exact: true }).waitFor();
  const applyIds = await json(desktop, () => window.__wikiMock.mutationIds.slice(-2));
  record("apply retry reuses operation ID", applyIds.length === 2 && applyIds[0] === entityOp && applyIds[1] === entityOp, JSON.stringify(applyIds));
  await shot(desktop, "editor-desktop-viewport");

  await openEditor(desktop);
  const summary = desktop.locator("textarea").nth(2);
  await summary.fill("Previewed summary");
  await desktop.getByLabel("Reason for this change", { exact: true }).fill("Test preview invalidation");
  await desktop.getByRole("button", { name: "Review preview", exact: true }).click();
  await desktop.getByText("Changed fields", { exact: true }).waitFor();
  await summary.fill("Changed after preview");
  record("modified form invalidates old preview/apply", await desktop.getByRole("button", { name: "Apply reviewed change", exact: true }).count() === 0);
  await openEditor(desktop);
  await desktop.locator("textarea").nth(2).fill("Saved campaign description");
  await desktop.getByLabel("Reason for this change", { exact: true }).fill("Save reviewed description");
  await desktop.getByRole("button", { name: "Review preview", exact: true }).click();
  await desktop.getByRole("button", { name: "Apply reviewed change", exact: true }).click();
  await desktop.getByRole("heading", { name: "Edit campaign memory", exact: true }).waitFor({ state: "detached" });
  await desktop.getByText("Saved campaign description", { exact: true }).waitFor();
  record("successful save renders changed data", true);
  await shot(desktop, "editor-desktop-saved-viewport");

  const factCases = [
    ["holds the northern archive key", { key: "archive", count: 7 }],
    ["has archive count", 42],
    ["is trusted", true],
  ];
  for (const [predicate, value] of factCases) {
    const page = await browser.newPage({ viewport: VIEWPORTS.desktop });
    await openEditor(page);
    await page.getByRole("button", { name: "Fact", exact: true }).click();
    await page.locator("select").first().selectOption({ label: predicate });
    await page.locator('input[type="checkbox"]').first().check();
    await page.locator("textarea").nth(3).fill(`Lock ${predicate}`);
    await page.getByRole("button", { name: "Review preview", exact: true }).click();
    await page.waitForTimeout(300);
    const mutation = await json(page, () => window.__wikiMock.lastMutation);
    record(`fact ${typeof value} lock-only preserves value and conditions`, patchOnly(mutation, { manualLock: true }), JSON.stringify(mutation?.patch));
    await page.close();
  }

  // A typed condition value that does not fit its type is flagged inline, never coerced to null/false.
  const typedCondition = await browser.newPage({ viewport: VIEWPORTS.desktop });
  await openEditor(typedCondition);
  await typedCondition.getByRole("button", { name: "Fact", exact: true }).click();
  await typedCondition.locator("select").first().selectOption({ label: "has archive count" });
  const conditionField = typedCondition.getByLabel(/When it applies/).first();
  await conditionField.fill("threshold=third");
  await typedCondition.locator("textarea").nth(3).fill("Bad typed condition");
  const conditionError = typedCondition.getByText(/The value for "threshold" must be a number/);
  const previewButton = typedCondition.getByRole("button", { name: "Review preview", exact: true });
  record("invalid number condition shows inline error and blocks preview", (await conditionError.count()) === 1 && (await previewButton.isDisabled()), `errors=${await conditionError.count()} disabled=${await previewButton.isDisabled()}`);
  await conditionField.fill("threshold=12");
  await previewButton.click();
  await typedCondition.waitForTimeout(300);
  const typedMutation = await json(typedCondition, () => window.__wikiMock.lastMutation);
  record("valid number condition is sent as a number", JSON.stringify(typedMutation?.patch?.conditions) === JSON.stringify([{ kind: "threshold", value: 12 }]), JSON.stringify(typedMutation?.patch));
  await typedCondition.close();

  const conflict = await browser.newPage({ viewport: VIEWPORTS.desktop });
  await openEditor(conflict);
  const conflictSummary = conflict.locator("textarea").nth(2);
  await conflictSummary.fill("Draft retained on conflict");
  await conflict.getByLabel("Reason for this change", { exact: true }).fill("Stale revision test");
  await conflict.getByRole("button", { name: "Review preview", exact: true }).click();
  await conflict.evaluate(() => { window.__wikiMock.forceConflict = true; });
  await conflict.getByRole("button", { name: "Apply reviewed change", exact: true }).click();
  await conflict.waitForTimeout(500);
  const conflictBody = await conflict.locator("body").innerText();
  record("stale 409 retains draft", conflictBody.includes("This record changed since it was loaded") && await conflictSummary.inputValue() === "Draft retained on conflict");
  await conflict.close();

  const nav = await browser.newPage({ viewport: VIEWPORTS.desktop });
  await openEditor(nav);
  await nav.getByRole("button", { name: "Fact", exact: true }).click();
  const factValue = nav.locator("textarea").nth(1);
  await factValue.fill("draft value");
  const dialogs = [];
  nav.once("dialog", async (dialog) => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await nav.locator("select").first().selectOption({ label: "has archive count" });
  record("unsaved fact selection asks confirmation and retains draft", dialogs.length === 1 && await factValue.inputValue() === "draft value");
  await nav.locator("textarea").nth(3).fill("query refetch draft test");
  await nav.getByPlaceholder("Search people, places, lore").fill("Ariadne");
  await nav.waitForTimeout(350);
  record("query refetch does not reset editor draft", (await nav.locator("textarea").nth(3).inputValue()) === "query refetch draft test");
  await nav.close();

  for (const viewport of MOBILE_VIEWPORTS) {
    const tag = label(viewport);
    const mobile = await browser.newPage({ viewport });
    await openEditor(mobile);
    await mobile.locator("textarea").nth(2).fill("Mobile unsaved draft");
    let closePrompt = false;
    mobile.once("dialog", async (dialog) => { closePrompt = dialog.message().includes("Discard unsaved"); await dialog.dismiss(); });
    await mobile.getByRole("button", { name: "Close editor", exact: true }).click();
    record(`mobile back/close confirms unsaved editor @${tag}`, closePrompt && await mobile.getByRole("heading", { name: "Edit campaign memory", exact: true }).isVisible());
    const size = await mobile.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
    record(`mobile editor has no horizontal overflow @${tag}`, size.scrollWidth <= size.clientWidth, JSON.stringify(size));
    await shot(mobile, `editor-mobile-viewport-${tag}`);
    await mobile.close();
  }
  const output = { generatedAt: new Date().toISOString(), base, viewports: [VIEWPORTS.desktop, ...MOBILE_VIEWPORTS], checks, pass: checks.every((item) => item.pass), screenshots, note: "Fixture-only API responses; targeted undo is represented by the audit/compensate UI but has no retry control, so no retry assertion is claimed." };
  await fs.writeFile(path.join(out, "editor-results.json"), JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
  if (!output.pass) process.exitCode = 1;
} catch (error) { console.error(error); await fs.writeFile(path.join(out, "editor-error.txt"), String(error?.stack ?? error)); process.exitCode = 1; }
finally { await browser.close(); await stopFixtureServer(server); }
