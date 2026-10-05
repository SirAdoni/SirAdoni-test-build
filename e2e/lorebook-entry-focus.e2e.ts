import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

test("the latest lorebook entry request wins while loading and in an already-open editor", async ({
  page,
  request,
}) => {
  const created = await request.post("/api/lorebooks", { data: { name: "Isolated focus ordering" } });
  expect(created.ok()).toBeTruthy();
  const book = await created.json();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let waiting = false;
  try {
    const ids: string[] = [];
    for (let index = 0; index < 24; index++) {
      const response = await request.post(`/api/lorebooks/${book.id}/entries`, {
        data: { name: `Focus row ${index}`, content: "Synthetic focus fixture." },
      });
      expect(response.ok()).toBeTruthy();
      ids.push((await response.json()).id);
    }
    const firstId = ids[0];
    const lastId = ids[23];
    if (!firstId || !lastId) throw new Error("Focus fixture entries were not created");
    await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
    await seedUIState(page, { hasCompletedOnboarding: true, sidebarOpen: false, rightPanelOpen: false });
    await page.addInitScript((value) => localStorage.setItem("marinara:whats-new:seen-version", value), version);
    await page.route(`**/api/lorebooks/${book.id}/entries`, async (route) => {
      if (route.request().method() === "GET" && !waiting) {
        waiting = true;
        await gate;
      }
      await route.continue();
    });
    await page.goto("/");
    await page.evaluate(
      async ({ bookId, entryId }) => {
        const modulePath = "/src/stores/ui.store.ts";
        const { useUIStore } = await import(modulePath);
        useUIStore.getState().openLorebookDetail(bookId, { initialTab: "entries", entryId });
      },
      { bookId: book.id, entryId: firstId },
    );
    await expect.poll(() => waiting).toBe(true);
    const openLinked = async (entryId: string) =>
      page.evaluate(
        async ({ bookId, entryId }) => {
          const modulePath = "/src/lib/lorebook-entry-focus.ts";
          const { openLorebookEntry } = await import(modulePath);
          openLorebookEntry(bookId, entryId);
        },
        { bookId: book.id, entryId },
      );
    await openLinked(lastId);
    release();
    const first = page.locator(`[data-lorebook-entry-row-id="${firstId}"]`);
    const last = page.locator(`[data-lorebook-entry-row-id="${lastId}"]`);
    await expect(last.getByRole("button", { name: "Collapse entry", exact: true })).toBeVisible();
    await expect(last).toBeInViewport();
    await expect(first.getByRole("button", { name: "Collapse entry", exact: true })).toHaveCount(0);
    await openLinked(firstId);
    await expect(first.getByRole("button", { name: "Collapse entry", exact: true })).toBeVisible();
    await expect(first).toBeInViewport();
    await openLinked(lastId);
    await expect(last.getByRole("button", { name: "Collapse entry", exact: true })).toBeVisible();
    await expect(last).toBeInViewport();
    await last.getByRole("button", { name: "Collapse entry", exact: true }).click();
    await expect(last.getByRole("button", { name: "Collapse entry", exact: true })).toHaveCount(0);
    await openLinked(lastId);
    await expect(last.getByRole("button", { name: "Collapse entry", exact: true })).toBeVisible();
    await expect(last).toBeInViewport();
  } finally {
    release();
    await page.goto("about:blank");
    expect((await request.delete(`/api/lorebooks/${book.id}`)).ok()).toBeTruthy();
  }
});
