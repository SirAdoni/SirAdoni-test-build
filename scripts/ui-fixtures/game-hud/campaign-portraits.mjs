import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { startFixtureServer, stopFixtureServer } from "../lib/fixture-server.mjs";

const fixture = startFixtureServer(fileURLToPath(new URL("./component-server.mjs", import.meta.url)));
let browser;
try {
  const { base } = await fixture.ready;
  browser = await chromium.launch({ headless: true });
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base);
    const style = page.getByLabel("Portrait style", { exact: true });
    await style.waitFor();
    assert.match(await style.inputValue(), /2\.5D/);
    const chosen = "Stylized 2.5D, ink outlines and soft dimensional shading";
    await style.fill(chosen);
    const button = page.getByRole("button", { name: /Generate missing portraits/ });
    assert.match(await button.innerText(), /12/);
    await button.click();
    await page.waitForFunction(() => document.querySelector("[data-portrait-style]")?.textContent.includes("ink outlines"));
    assert.equal(await page.locator("[data-portrait-style]").textContent(), chosen);
    assert.equal(await button.isDisabled(), true, "duplicate batches are disabled while running");
    await page.waitForFunction(() => ![...document.querySelectorAll("button")].find((el) => el.textContent.includes("Generate missing portraits"))?.disabled);
    await page.reload();
    await style.waitFor();
    assert.equal(await style.inputValue(), chosen, "campaign style survives reload");
    const bounds = await style.boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1, "style editor fits viewport");
    if (width === 390 && process.env.PORTRAIT_UI_SCREENSHOT) await page.screenshot({ path: process.env.PORTRAIT_UI_SCREENSHOT, animations: "disabled" });
    assert.deepEqual(errors, [], "component has no uncaught browser errors");
    await page.goto(`${base}/?campaign=other`);
    await style.waitFor();
    assert.match(await style.inputValue(), /2\.5D/);
    assert.notEqual(await style.inputValue(), chosen, "another campaign does not inherit the edited style");
    for (const state of ["unavailable", "empty"]) {
      await page.goto(`${base}/?${state}`);
      await button.waitFor();
      assert.equal(await button.isDisabled(), true, `${state} prevents a generation request`);
    }
    await page.goto(`${base}/?fail`);
    await button.click();
    await page.getByRole("status").filter({ hasText: "Fixture image connection failed" }).waitFor();
    assert.equal(await button.isEnabled(), true, "failed generation permits a deliberate retry");
    await page.close();
  }
  console.log("Campaign portrait controls passed at desktop and 390px with simulated generation.");
} finally {
  await browser?.close();
  await stopFixtureServer(fixture.server);
}
