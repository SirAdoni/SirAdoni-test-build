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
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.goto(base);
  const pane = page.locator("[data-fixture-scroll]");
  const chooseConnection = page.getByRole("button", { name: "Choose a connection" });
  const reader = page.getByRole("combobox", { name: "Extractor connection" });
  await chooseConnection.waitFor();

  for (let attempt = 0; attempt < 2; attempt++) {
    await chooseConnection.click();
    await page.waitForFunction(() => {
      const scrollPane = document.querySelector("[data-fixture-scroll]");
      const readerSelect = document.querySelector('select[aria-label="Extractor connection"]');
      if (document.activeElement !== readerSelect || scrollPane.scrollTop <= 0) return false;
      const paneBounds = scrollPane.getBoundingClientRect();
      const readerBounds = readerSelect.getBoundingClientRect();
      return readerBounds.top >= paneBounds.top && readerBounds.bottom <= paneBounds.bottom;
    });
    assert.equal(await reader.inputValue(), "", "navigation does not change the saved draft selection");
    if (attempt === 0)
      await pane.evaluate((element) => {
        element.scrollTop = 0;
      });
  }
  assert.deepEqual(pageErrors, [], `browser page errors: ${pageErrors.join(" | ")}`);
  await page.screenshot({ path: path.join(screenshotDir, "connection-navigation.png"), fullPage: false });
  await browser.close();
  browser = null;
  await stopFixtureServer(fixture.server);
  fixture = null;
  console.log("game continuity connection navigation fixture passed (mocked browser component, repeated clicks)");
  console.log(`screenshot: ${path.join(screenshotDir, "connection-navigation.png")}`);
} finally {
  if (browser) await browser.close();
  if (fixture) await stopFixtureServer(fixture.server);
}
