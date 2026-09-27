// Actual React modal and client CSS with deterministic HTTP responses. No campaign/provider access.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { startFixtureServer, stopFixtureServer } from "../lib/fixture-server.mjs";
const dir = path.dirname(fileURLToPath(import.meta.url));
const fixture = startFixtureServer(path.join(dir, "server.mjs"));
let browser;
try {
  const { base } = await fixture.ready;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const crashes = [];
  page.on("pageerror", (e) => crashes.push(e.message));
  let records = [],
    failList = false,
    conflict = false,
    lastWrite,
    lastWritePath;
  const person = {
    entityId: "person",
    kind: "character",
    aliases: ["Archivist Mira"],
    status: "active",
    tags: [],
    attributes: {},
    revision: 1,
    body: "Mira keeps the historical archives.",
    provenance: { source: "user-source", sourceRevision: "fixture", actor: "user" },
    owner: { type: "registry", store: "campaign-memory", recordId: "person" },
  };
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url()),
      p = url.pathname;
    const respond = (body, status = 200) => route.fulfill({ status, json: body });
    if (p.includes("game-calendar"))
      return respond({
        calendar: {
          enabled: true,
          config: {
            era: "First Age",
            months: [{ name: p.endsWith("/early") ? "Frostmoon" : "Rainmoon", days: p.endsWith("/early") ? 24 : 30 }],
          },
        },
      });
    if (p.endsWith("/world-history")) {
      if (failList) return respond({ error: { message: "fixture outage" } }, 500);
      const q = url.searchParams.get("q")?.toLowerCase(),
        era = url.searchParams.get("era");
      const all = records.filter((e) => url.searchParams.get("archived") === "true" || e.entity.status === "active");
      const selected = all.filter(
        (e) => (!q || JSON.stringify(e).toLowerCase().includes(q)) && (era === null || e.history.era === era),
      );
      const offset = Number(url.searchParams.get("offset"));
      return respond({
        items: selected.slice(offset, offset + 25),
        total: selected.length,
        offset,
        limit: 25,
        eras: [...new Set(all.map((e) => e.history.era))],
        relatedEntities: [person],
      });
    }
    if (p.endsWith("/entities")) return respond({ items: [person], total: 1, offset: 0, limit: 10, kindTotals: {} });
    if (p.endsWith("/entities/person")) {
      const empty = { items: [], total: 0, offset: 0, limit: 25 };
      return respond({
        entity: person,
        facts: empty,
        knowledge: empty,
        events: empty,
        currentState: empty,
        relationships: empty,
        relatedEntities: [],
        referencedFacts: [],
      });
    }
    if (p.endsWith("/mutations")) {
      lastWritePath = p;
      lastWrite = route.request().postDataJSON();
      if (conflict) return respond({ error: { code: "CAMPAIGN_MEMORY_CAS_MISMATCH", message: "changed" } }, 409);
      if (lastWrite.action === "create")
        records.push({
          entity: { ...lastWrite.input, revision: 1, chatId: "fixture", originChatId: "fixture" },
          history: lastWrite.input.attributes.worldHistory,
        });
      else {
        const entry = records.find((e) => e.entity.entityId === lastWrite.recordId);
        Object.assign(entry.entity, lastWrite.patch, { revision: entry.entity.revision + 1 });
        entry.history = entry.entity.attributes.worldHistory;
      }
      return respond({ operationId: lastWrite.operationId });
    }
    return respond({});
  });
  await page.goto(base);
  await expect(page.getByText("No events match this view.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Add historical event" }).click();
  await page.getByLabel("Event title", { exact: true }).fill("Founding of the harbor");
  await page
    .getByLabel("Description", { exact: true })
    .fill("The surviving charter records its founding; the date is not known.");
  await page.getByRole("button", { name: "Archivist Mira", exact: true }).click();
  await page.getByRole("button", { name: "Save event" }).click();
  await expect(page.getByRole("button", { name: "Founding of the harbor", exact: true })).toBeVisible();
  assert.equal(lastWrite.input.attributes.worldHistory.date, null);
  assert.equal(lastWrite.input.manualLock, true);
  assert.deepEqual(lastWrite.input.attributes.worldHistory.participantEntityIds, ["person"]);
  await page.getByRole("button", { name: "Archivist Mira", exact: true }).click();
  await expect(page.getByText("Mira keeps the historical archives.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to world history" }).click();
  await page.reload();
  await page.getByRole("button", { name: "Founding of the harbor", exact: true }).click();
  await page.getByLabel("Date certainty").selectOption("approximate");
  await page.getByLabel("Year (optional)").fill("-200");
  await page.getByLabel("Month (optional)").selectOption("0");
  await page.getByLabel("Day (optional)").fill("31");
  await page.getByRole("button", { name: "Save event" }).click();
  await expect(page.getByText("Enter a title and description", { exact: false })).toBeVisible();
  await page.getByLabel("Day (optional)").fill("2");
  conflict = true;
  await page.getByRole("button", { name: "Save event" }).click();
  await expect(page.getByText("The event could not be saved.", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Year (optional)")).toHaveValue("-200");
  conflict = false;
  await page.getByRole("button", { name: "Save event" }).click();
  await expect(page.getByText("2 Rainmoon -200", { exact: true })).toBeVisible();
  assert.deepEqual(lastWrite.patch.attributes.worldHistory.date, { year: -200, month: 0, day: 2 });
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByText("0 historical events", { exact: true })).toBeVisible();
  await page.getByLabel("Include archived events").check();
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByRole("button", { name: "Archive", exact: true })).toBeVisible();
  // Projected records use their source session calendar for both display and edit validation.
  records[0].entity.originChatId = "early";
  await page.reload();
  await expect(page.getByText("2 Frostmoon -200", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Founding of the harbor", exact: true }).click();
  await expect(page.getByLabel("Month (optional)").locator("option:checked")).toHaveText("Frostmoon");
  await page.getByLabel("Day (optional)").fill("25");
  await page.getByRole("button", { name: "Save event" }).click();
  await expect(page.getByText("Enter a title and description", { exact: false })).toBeVisible();
  await page.getByLabel("Day (optional)").fill("24");
  await page.getByRole("button", { name: "Save event" }).click();
  await expect(page.getByText("24 Frostmoon -200", { exact: true })).toBeVisible();
  assert.equal(lastWritePath, "/api/game/early/memory/mutations");
  const seed = structuredClone(records[0]);
  for (let i = 0; i < 26; i++)
    records.push({
      ...structuredClone(seed),
      entity: { ...structuredClone(seed.entity), entityId: `event-${i}`, aliases: [`Event ${i}`] },
    });
  await page.reload();
  await expect(page.getByText("27 historical events", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByRole("button", { name: "Event 25", exact: true })).toBeVisible();
  await page.getByLabel("Search events, dates or linked names").fill("harbor");
  await expect(page.getByText("1 historical event", { exact: true })).toBeVisible();
  for (const [width, height] of [
    [1280, 900],
    [768, 1024],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    for (const visual of ["default", "sillytavern"])
      for (const theme of ["dark", "light"]) {
        await page.evaluate(
          ({ theme, visual }) => {
            document.documentElement.setAttribute("data-theme", theme);
            document.documentElement.dataset.visualTheme = visual;
            document.documentElement.classList.toggle("dark", theme === "dark");
          },
          { theme, visual },
        );
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
          `overflow ${width} ${theme} ${visual}`,
        );
        await page.screenshot({ path: path.join(dir, `.out/${width}-${theme}-${visual}.png`), fullPage: true });
      }
  }
  await page.getByRole("button", { name: "Founding of the harbor", exact: true }).click();
  await page.getByLabel("Description", { exact: true }).fill("Unsaved new description");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByLabel("Description", { exact: true })).toHaveValue("Unsaved new description");
  await page.screenshot({ path: path.join(dir, ".out/mobile-editor.png"), fullPage: true });
  failList = true;
  await page.reload();
  await expect(page.getByText("World history could not be loaded.", { exact: true })).toBeVisible();
  failList = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByText("27 historical events", { exact: true })).toBeVisible();
  assert.deepEqual(crashes, []);
  console.log(
    "World history UI passed: create/reload/edit, unknown and approximate dates, validation, retained conflict draft, archive/restore, pagination/search, dirty guard, error recovery, desktop/tablet/mobile overflow and screenshots.",
  );
} finally {
  await browser?.close();
  await stopFixtureServer(fixture.server);
}
