// Phase 1 of the real-Engine harness: through the real CampaignWiki bundle and
// the real API, create a knowledge record for the seeded fact, confirm the
// preview/apply routes were hit, the record persisted, and the source opens.
import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { VIEWPORTS } from "../lib/fixture-paths.mjs";

const out = process.env.E2E_OUT;
const base = process.env.E2E_BASE;
const chatId = process.env.E2E_CHAT;
if (!base || !chatId || !out) throw new Error("E2E_BASE, E2E_CHAT and E2E_OUT required");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: VIEWPORTS.desktop });
const requests = [];
const responses = [];
const pageErrors = [];
const consoleMessages = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("console", (message) => consoleMessages.push(`${message.type()}: ${message.text()}`));
page.on("request", (request) => { if (request.url().includes("/api/")) requests.push(`${request.method()} ${new URL(request.url()).pathname}`); });
page.on("response", async (response) => {
  if (!response.url().includes("/api/")) return;
  const status = response.status();
  if (status >= 400) responses.push({ url: response.url(), status, body: await response.text().catch(() => "") });
});
const checks = [];
const record = (name, pass, detail = "") => checks.push({ name, pass: Boolean(pass), detail });
try {
  await page.goto(`${base}/?chat=${encodeURIComponent(chatId)}`);
  await page.getByText("Campaign Wiki", { exact: true }).waitFor();
  await page.getByRole("button", { name: /E2E Character/ }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("heading", { name: "Edit campaign memory", exact: true }).waitFor();
  await page.getByRole("button", { name: "Add record", exact: true }).click();
  const form = page.getByRole("heading", { name: "Add record", exact: true }).locator("..").locator("..");
  const type = form.locator("select").first();
  record("character entity exposes knowledge create mode", await type.locator("option[value=knowledge]").count() === 1);
  await type.selectOption("knowledge");
  const selects = form.locator("select");
  await selects.nth(1).selectOption("e2e-fact");
  await form.getByLabel("Reason for this change", { exact: true }).fill("manual knowledge proof");
  await form.getByRole("button", { name: "Review preview", exact: true }).click();
  await form.getByText("Changed fields", { exact: true }).waitFor();
  record("knowledge preview API called", requests.some((value) => value === `POST /api/game/${chatId}/memory/mutations/preview`));
  await form.getByRole("button", { name: "Apply reviewed change", exact: true }).click();
  await page.waitForTimeout(500);
  record("knowledge apply API called", requests.some((value) => value === `POST /api/game/${chatId}/memory/mutations`));
  const detailResponse = await page.request.get(`${base}/api/game/${chatId}/memory/entities/e2e-character?offset=0&limit=20`);
  const detail = await detailResponse.json();
  record("knowledge persisted before restart", detail.knowledge?.items?.some((item) => item.factId === "e2e-fact" && item.epistemicState === "knows"), JSON.stringify(detail.knowledge));
  await page.getByText("Evidence and source quotes", { exact: true }).first().click();
  await page.getByRole("button", { name: "Read source", exact: true }).first().click();
  await page.getByText("The archive key is stored in the northern archive.", { exact: true }).waitFor();
  record("source opens through real API", requests.some((value) => value.includes("/memory/sources/")));
  record("no 4xx/5xx API responses", responses.length === 0, JSON.stringify(responses));
  await fs.writeFile(path.join(out, "phase1-results.json"), JSON.stringify({ generatedAt: new Date().toISOString(), checks, requests, responses, pageErrors, chatId, base }, null, 2));
  await page.screenshot({ path: path.join(out, "phase1.png"), fullPage: true });
} catch (error) {
  await fs.writeFile(path.join(out, "phase1-dom.txt"), await page.locator("body").innerText().catch(() => ""));
  await fs.writeFile(path.join(out, "phase1-page-errors.json"), JSON.stringify(pageErrors, null, 2));
  await fs.writeFile(path.join(out, "phase1-console.json"), JSON.stringify(consoleMessages, null, 2));
  await fs.writeFile(path.join(out, "phase1-error.txt"), String(error?.stack ?? error));
  throw error;
} finally { await browser.close(); }
