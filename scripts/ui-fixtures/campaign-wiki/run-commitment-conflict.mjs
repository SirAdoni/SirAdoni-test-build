// Commitment transition conflict fixture: a transition sent with a stale
// revision answers 409, the Reload button refetches the commitments list and
// closes the form, and the retried transition sends the fresh expectedRevision.
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
const ev = (page, expr, arg) => page.evaluate(expr, arg);
const TITLE = "Recover the archive key";
try {
  const page = await browser.newPage({ viewport: VIEWPORTS.desktop });
  page.on("pageerror", (e) => console.log("PAGE_ERROR", e.message));
  await page.goto(base);
  await page.locator("[data-campaign-wiki-entity-list]").waitFor();
  await page.locator("[data-campaign-wiki-entity-list]").getByRole("button", { name: /Ariadne Vale/ }).click();
  await page.getByRole("heading", { name: /Ariadne Vale/ }).waitFor();
  await page.getByRole("button", { name: /^Promises & quests/ }).click();
  const region = page.getByRole("region", { name: /quests and commitments/i });
  await region.getByText(TITLE, { exact: true }).waitFor();
  const card = region.locator("li", { has: page.getByText(TITLE, { exact: true }) }).first();
  const openForm = async () => {
    await card.getByRole("button", { name: "Change state", exact: true }).click();
    await card.getByRole("menuitem", { name: /Accepted/ }).click();
    const form = card.getByRole("group", { name: "Accepted", exact: true });
    await form.waitFor();
    await form.getByLabel("Why? (required)").fill("She agreed at the gate");
    return form;
  };

  // The server moved on to revision 2 while the page still shows revision 1.
  await ev(page, () => { window.__wikiMock.commitmentRevisions["commitment-proposed"] = 2; });
  const form = await openForm();
  await form.getByRole("button", { name: "Mark as Accepted", exact: true }).click();
  const conflictAlert = form.getByRole("alert").filter({ hasText: "This commitment changed since it was loaded." });
  await conflictAlert.waitFor();
  const first = await ev(page, () => window.__wikiMock.transitions.slice());
  record("stale transition sends shown revision and gets 409", first.length === 1 && first[0].body.expectedRevision === 1 && first[0].status === 409 && first[0].body.state === "accepted", JSON.stringify(first));
  record("conflict disables the apply button", await form.getByRole("button", { name: "Mark as Accepted", exact: true }).isDisabled());
  await page.screenshot({ path: path.join(out, "commitment-conflict-desktop.png") }); screenshots.push("commitment-conflict-desktop.png");

  const fetchesBefore = await ev(page, () => window.__wikiMock.commitmentListFetches);
  await conflictAlert.getByRole("button", { name: "Reload", exact: true }).click();
  await form.waitFor({ state: "detached" });
  await page.waitForFunction((before) => window.__wikiMock.commitmentListFetches > before, fetchesBefore);
  const fetchesAfter = await ev(page, () => window.__wikiMock.commitmentListFetches);
  record("reload closes the form and refetches commitments", fetchesAfter > fetchesBefore && (await card.getByRole("group", { name: "Accepted", exact: true }).count()) === 0, `before=${fetchesBefore} after=${fetchesAfter}`);
  await page.waitForTimeout(200);

  const retryForm = await openForm();
  record("reopened form has no stale conflict alert", (await retryForm.getByRole("alert").count()) === 0);
  await retryForm.getByRole("button", { name: "Mark as Accepted", exact: true }).click();
  await retryForm.waitFor({ state: "detached" });
  const all = await ev(page, () => window.__wikiMock.transitions.slice());
  const retry = all[1];
  record("retried transition sends fresh expectedRevision and succeeds", all.length === 2 && retry?.body.expectedRevision === 2 && retry.status === 200 && retry.commitmentId === "commitment-proposed", JSON.stringify(all));
  await page.close();

  const output = { generatedAt: new Date().toISOString(), base, checks, pass: checks.every((check) => check.pass), screenshots, note: "Fixture-only API responses; the transition mock enforces compare-and-set on expectedRevision." };
  await fs.writeFile(path.join(out, "commitment-conflict-results.json"), JSON.stringify(output, null, 2)); console.log(JSON.stringify(output, null, 2));
  if (!output.pass) process.exitCode = 1;
} catch (error) { console.error(error); await fs.writeFile(path.join(out, "commitment-conflict-error.txt"), String(error?.stack ?? error)); process.exitCode = 1; }
finally { await browser.close(); await stopFixtureServer(server); }
