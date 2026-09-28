import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { startFixtureServer, stopFixtureServer } from "../lib/fixture-server.mjs";

let fixture;
let browser;
const screenshotDir = path.join(path.dirname(fileURLToPath(import.meta.url)), ".out");
fs.mkdirSync(screenshotDir, { recursive: true });
try {
  fixture = startFixtureServer(fileURLToPath(new URL("./component-server.mjs", import.meta.url)));
  const { base } = await fixture.ready;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on("pageerror", (error) => {
    pageErrors.push(String(error));
    console.error("browser pageerror:", error.stack ?? error);
  });
  await fetch(`${base}/control?delayAutomaticGet=1`);
  await page.goto(base);
  const mode = page.getByLabel("Backup mode", { exact: true });
  await mode.waitFor();
  assert.equal(await mode.isDisabled(), true, "mode selector is disabled while loading");
  await mode.waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const control = document.querySelector("#backup-mode");
    return control instanceof HTMLSelectElement && !control.disabled;
  });

  await fetch(`${base}/control?delayPut=1`);
  const modeSave = page.waitForResponse(
    (response) => response.url().includes("/api/backup/automatic") && response.request().method() === "PUT",
  );
  await mode.selectOption("data");
  assert.equal(await mode.isDisabled(), true, "mode selector is disabled while saving");
  const saved = await modeSave;
  assert.equal(saved.status(), 200);
  await page
    .getByText("Back up chats, messages, campaign memory, characters and supporting records without media files.")
    .waitFor();
  let state = await (await fetch(`${base}/control`)).json();
  assert.deepEqual(
    state.events[0].body,
    { enabled: false, frequency: "weekly", retentionCount: 5, mode: "data" },
    "changing mode preserves other settings",
  );

  await fetch(`${base}/control?failPut=1`);
  await mode.selectOption("full");
  await page.getByText("fixture settings save failed").waitFor();
  await page.waitForFunction(() => {
    const control = document.querySelector("#backup-mode");
    return control instanceof HTMLSelectElement && control.value === "data";
  });

  await mode.selectOption("incremental");
  await page.waitForFunction(() => {
    const control = document.querySelector("#backup-mode");
    return control instanceof HTMLSelectElement && control.value === "incremental";
  });
  await page.getByText(/The first snapshot is full/).waitFor();
  await mode.evaluate((element) => element.scrollIntoView({ block: "center", inline: "nearest" }));
  await page.waitForTimeout(1_500);
  await page.screenshot({ path: path.join(screenshotDir, "desktop.png"), fullPage: false });
  const existingDownloadStarts = state.events.filter((event) => event.type === "download").length;
  const createResponse = page.waitForResponse(
    (response) => response.url().endsWith("/api/backup") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create snapshot", exact: true }).click();
  assert.equal((await createResponse).status(), 201);
  await page.getByText("Backup snapshot created.").waitFor();
  state = await (await fetch(`${base}/control`)).json();
  assert.equal(state.events.filter((event) => event.type === "create").at(-1).mode, "incremental");
  assert.equal(
    state.events.filter((event) => event.type === "download").length,
    existingDownloadStarts,
    "incremental snapshot creation does not start a portable ZIP download",
  );
  await page.getByRole("button", { name: "Download backup marinara-backup-incremental-1" }).waitFor();

  const portableDownload = page.waitForEvent("download");
  const portableRequest = page.waitForResponse(
    (response) => response.url().includes("/api/backup/download/start") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Download backup marinara-backup-incremental-1" }).click();
  assert.equal((await portableRequest).status(), 200);
  const download = await portableDownload;
  assert.equal(download.suggestedFilename(), "portable-backup.zip");
  state = await (await fetch(`${base}/control`)).json();
  assert.equal(
    state.events.filter((event) => event.type === "download").at(-1).backupName,
    "marinara-backup-incremental-1",
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await mode.evaluate((element) => {
    element.scrollIntoView({ block: "center", inline: "nearest" });
    let ancestor = element.parentElement;
    while (ancestor && ancestor.scrollHeight <= ancestor.clientHeight) ancestor = ancestor.parentElement;
    if (ancestor) ancestor.scrollTop = Math.max(0, ancestor.scrollTop - 180);
  });
  await page.waitForTimeout(1_500);
  const mobileModeBounds = await mode.boundingBox();
  assert.ok(mobileModeBounds && mobileModeBounds.y >= 200, "mobile mode selector sits below the sticky settings tabs");
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    "mobile settings panel has no horizontal overflow",
  );
  await page.screenshot({ path: path.join(screenshotDir, "mobile.png"), fullPage: false });
  assert.deepEqual(pageErrors, [], `browser page errors: ${pageErrors.join(" | ")}`);
  console.log(
    `backup settings UI fixture passed: desktop/mobile, mode save and error, pending disabled state, incremental local snapshot, portable download; screenshots=${screenshotDir}`,
  );
} finally {
  await browser?.close();
  await stopFixtureServer(fixture?.server);
}
