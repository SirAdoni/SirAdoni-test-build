// Phase 2 of the real-Engine harness (after an Engine restart on the same
// DATA_DIR): the knowledge record is still shown by the UI at desktop and
// 390 px widths and is still returned by the API.
import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { VIEWPORTS, label } from "../lib/fixture-paths.mjs";

const out = process.env.E2E_OUT;
const base = process.env.E2E_BASE;
const chatId = process.env.E2E_CHAT;
if (!base || !chatId || !out) throw new Error("E2E_BASE, E2E_CHAT and E2E_OUT required");
const browser = await chromium.launch({ headless: true });
const checks = [];
const record = (name, pass, detail = "") => checks.push({ name, pass: Boolean(pass), detail });
try {
  for (const viewport of [VIEWPORTS.desktop, VIEWPORTS.mobileNarrow]) {
    const tag = label(viewport);
    const page = await browser.newPage({ viewport });
    await page.goto(`${base}/?chat=${encodeURIComponent(chatId)}`); await page.getByText("Campaign Wiki", { exact: true }).waitFor();
    await page.getByRole("button", { name: /E2E Character/ }).click(); await page.getByText("Knowledge and beliefs", { exact: true }).waitFor();
    const body = await page.locator("body").innerText();
    record(`ui shows knowledge after restart @${tag}`, body.includes("holds archive key"));
    const size = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
    record(`no horizontal overflow after restart @${tag}`, size.scrollWidth <= size.clientWidth, JSON.stringify(size));
    await page.screenshot({ path: path.join(out, `restart-${tag}.png`) });
    await page.close();
  }
  const detail = await (await browser.newPage()).request.get(`${base}/api/game/${chatId}/memory/entities/e2e-character?offset=0&limit=20`).then((r) => r.json());
  record("api returns knowledge after restart", detail.knowledge?.items?.some((item) => item.factId === "e2e-fact"), JSON.stringify(detail.knowledge));
  const result = { generatedAt: new Date().toISOString(), checks, uiHasKnowledge: checks.filter((c) => c.name.startsWith("ui shows")).every((c) => c.pass), apiHasKnowledge: checks.find((c) => c.name.startsWith("api returns"))?.pass ?? false };
  await fs.writeFile(path.join(out, "restart-results.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  if (!checks.every((c) => c.pass)) process.exitCode = 1;
} finally { await browser.close(); }
