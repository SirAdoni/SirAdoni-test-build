import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { chromium } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const server = spawn(process.execPath, [path.join(root, "server.mjs")], { stdio: ["ignore", "pipe", "inherit"] });
const lines = createInterface({ input: server.stdout });
const ready = new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("Family Tree fixture server did not become ready")), 30_000);
  lines.on("line", (line) => {
    if (!line.startsWith("FAMILY_TREE_FIXTURE_READY:")) return;
    clearTimeout(timeout);
    resolve(JSON.parse(line.slice("FAMILY_TREE_FIXTURE_READY:".length)));
  });
  server.once("exit", (code) => reject(new Error(`Family Tree fixture server exited (${code})`)));
});
let browser;
try {
  const { base } = await ready;
  browser = await chromium.launch({ headless: true });
  for (const [name, width, height, theme, mode] of [
    ["desktop", 1280, 900, "default", "dark"],
    ["mobile", 390, 844, "default", "light"],
    ["sillytavern", 960, 800, "sillytavern", "dark"],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto(`${base}/?theme=${theme}&mode=${mode}`);
    await page.getByRole("button", { name: "Open family tree", exact: true }).click();
    await page.getByRole("heading", { name: "Family tree", exact: true }).waitFor();
    const graph = page.getByRole("region", { name: "Family relationship diagram" }).locator("svg").first();
    await graph.waitFor();
    assert.equal(
      await graph.locator("path").count(),
      1,
      "Only confirmed, identified parentage contributes a graph edge",
    );
    await page
      .getByText("Suggested by campaign records; excluded from the tree until you review and save it.")
      .waitFor();
    await page
      .getByRole("region", { name: "Family relationships" })
      .getByText("Unknown / uncertain relative")
      .waitFor();

    await page.getByRole("button", { name: "Review", exact: true }).click();
    await page.getByLabel("Note", { exact: true }).fill("Reviewed sibling relationship");
    await page.getByRole("button", { name: "Save link", exact: true }).click();
    await page.getByText("Family link saved.", { exact: true }).waitFor();
    assert.equal(await graph.locator("path").count(), 2, "Reviewed link enters the rendered graph");

    await page.getByLabel("Center on", { exact: true }).selectOption('["characters","b"]');
    await page.getByRole("button", { name: "Add family link", exact: true }).click();
    await page.getByLabel("This person…", { exact: true }).selectOption("parent");
    await page.getByLabel("Other person", { exact: true }).selectOption('["characters","a"]');
    const cycleWriteCount = await page.evaluate(() => window.__family.writes.length);
    await page.getByRole("button", { name: "Save link", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "This link would make someone their own ancestor" }).waitFor();
    const cycleEdit = await page.evaluate(() => window.__family.writes.slice(-1)[0]);
    assert.equal(await page.evaluate(() => window.__family.writes.length), cycleWriteCount + 1);
    assert.equal(cycleEdit.sourceId, '["characters","b"]');
    assert.equal(cycleEdit.targetId, '["characters","a"]');
    assert.equal(cycleEdit.kind, "parent", "The localized cycle alert follows the mocked API 409");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();

    await page.getByRole("button", { name: "Add family link", exact: true }).click();
    await page.getByLabel("This person…", { exact: true }).selectOption("child");
    await page.getByLabel("Other person", { exact: true }).selectOption("__unknown");
    await page.getByLabel("Note", { exact: true }).fill("Parent identity unknown; keep uncertainty explicit");
    await page.evaluate(() => {
      window.__family.failSave = true;
    });
    await page.getByRole("button", { name: "Save link", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "This record changed since you opened it" }).waitFor();
    assert.equal(
      await page.getByLabel("Note", { exact: true }).inputValue(),
      "Parent identity unknown; keep uncertainty explicit",
      "A conflict preserves the user's draft",
    );
    await page.keyboard.press("Escape");
    assert.equal(await page.getByLabel("Note", { exact: true }).count(), 1, "Escape cannot discard a dirty draft");
    await page.getByRole("button", { name: "Save link", exact: true }).click();
    await page.getByText("Family link saved.", { exact: true }).waitFor();
    const retryIds = await page.evaluate(() => window.__family.writes.slice(-2).map((write) => write.operationId));
    assert.equal(retryIds[0], retryIds[1], "Unchanged failed saves reuse their operation id");
    await page.locator("[data-family-tree] form").waitFor({ state: "detached" });

    await page.getByLabel("Center on", { exact: true }).selectOption('["entity","wiki-person"]');
    await page.getByRole("button", { name: "Profile", exact: true }).click();
    await page.getByRole("heading", { name: "Campaign Wiki", exact: true }).waitFor();
    await page.getByRole("heading", { name: "Morgan", exact: true }).waitFor();
    const backToRoleplay = page.getByRole("button", { name: "Back to roleplay", exact: true });
    await backToRoleplay.click();
    await page.getByRole("heading", { name: "Family tree", exact: true }).waitFor();
    await graph.waitFor();
    assert.equal(await graph.locator("path").count(), 2, "Returning from the wiki preserves the reviewed family link");
    const familyModal = page.locator('[data-component="Modal"][aria-label="Family tree"]');
    await familyModal.waitFor();
    await page.waitForFunction(() => {
      const modal = document.querySelector('[data-component="Modal"][aria-label="Family tree"]');
      return modal !== null && getComputedStyle(modal).opacity === "1";
    });
    assert.ok(
      await page.evaluate(() => window.__family.ownerQueries.includes("campaign-memory:wiki-person")),
      "Unavailable registry owners navigate through the canonical wiki owner identity",
    );
    assert.ok(
      await page.evaluate(() =>
        window.__family.requests.some(
          (request) => new URL(request, location.origin).pathname === "/api/family-tree/s2",
        ),
      ),
      "The production hook requests the tree for the active chat",
    );
    assert.ok(
      await page.evaluate(() =>
        window.__family.requests.some((request) => {
          const url = new URL(request, location.origin);
          return url.pathname === "/api/game/s2/memory/entities/wiki-person" && url.searchParams.has("limit");
        }),
      ),
      "The wiki deep link loads entity detail by canonical owner identity",
    );
    await page.screenshot({ path: path.resolve(root, `.tmp-${name}.png`) });
    await page.keyboard.press("Escape");
    await page.getByRole("heading", { name: "Family tree", exact: true }).waitFor({ state: "detached" });
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    "Family Tree fixture: action/ModalRenderer, confirmed-vs-unconfirmed graph, unknown identity, cycle rejection, conflict draft retention, stable retry, wiki navigation, Escape, and desktop/mobile/SillyTavern viewport checks passed.",
  );
} finally {
  await browser?.close();
  lines.close();
  server.kill("SIGTERM");
}
