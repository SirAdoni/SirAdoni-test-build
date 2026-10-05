import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";

test("backup choices are opt-in and disabling preserves the selected mode", async ({ page, baseURL }) => {
  if (baseURL !== "http://127.0.0.1:5178" && baseURL !== "http://127.0.0.1:5179") {
    throw new Error("Backup UI proof requires an isolated test origin");
  }
  let features: Record<string, boolean> = {};
  const automatic = {
    enabled: false,
    frequency: "daily",
    retentionCount: 5,
    mode: "incremental",
    lastBackupAt: null,
    lastError: null,
    nextBackupAt: null,
    backupExists: false,
  };
  const downloads: string[] = [];
  const unexpectedWrites: string[] = [];
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== baseURL) return route.abort();
    if (url.pathname === "/api/app-settings/features") {
      if (request.method() === "PUT") features = request.postDataJSON();
      return route.fulfill({ json: { settings: features, envOverrides: {}, effective: {} } });
    }
    if (url.pathname === "/api/app-settings/ui") return route.fulfill({ json: { value: "" } });
    if (url.pathname === "/api/connections/refresh-local-context" && request.method() === "POST") {
      return route.fulfill({ json: { updated: [] } });
    }
    if (url.pathname === "/api/backup/automatic") {
      if (request.method() === "PUT") Object.assign(automatic, request.postDataJSON());
      return route.fulfill({ json: automatic });
    }
    if (url.pathname === "/api/backup/download/start") {
      downloads.push(request.postDataJSON().mode);
      return route.fulfill({ status: 503, json: { error: "Synthetic download capture" } });
    }
    if (url.pathname.startsWith("/api/") && !["GET", "HEAD"].includes(request.method())) {
      unexpectedWrites.push(`${request.method()} ${url.pathname}`);
      return route.abort();
    }
    return route.continue();
  });
  await seedUIState(page, { hasCompletedOnboarding: true, rightPanelOpen: false, sidebarOpen: false });
  const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  await page.addInitScript((value) => localStorage.setItem("marinara:whats-new:seen-version", value), version);
  await page.goto("/");
  await page.evaluate(async () => {
    const { useUIStore } = (await import(
      "/src/stores/ui.store.ts" as string
    )) as typeof import("../packages/client/src/stores/ui.store");
    useUIStore.getState().setSettingsTab("advanced");
    useUIStore.getState().openRightPanel("settings");
  });
  const toggle = page.getByRole("checkbox", { name: "Additional backup modes", exact: true });
  const clickToggle = async () =>
    page
      .locator(`label[for="${await toggle.getAttribute("id")}"]`)
      .last()
      .click();
  const mode = page.locator("#automatic-backup-mode");
  const download = page.getByRole("button", { name: "Download Backup", exact: true });
  await expect(toggle).not.toBeChecked();
  await expect(mode).toHaveCount(0);
  await download.click();
  await expect.poll(() => downloads).toEqual(["full"]);
  await clickToggle();
  await expect(toggle).toBeChecked();
  await expect(mode).toHaveValue("incremental");
  await mode.selectOption("data");
  await expect.poll(() => automatic.mode).toBe("data");
  await download.click();
  await expect.poll(() => downloads).toEqual(["full", "data"]);
  await clickToggle();
  await expect(toggle).not.toBeChecked();
  await expect(mode).toHaveCount(0);
  await download.click();
  await expect.poll(() => downloads).toEqual(["full", "data", "full"]);
  expect(automatic.mode).toBe("data");
  await clickToggle();
  await expect(toggle).toBeChecked();
  await expect(mode).toHaveValue("data");
  expect(unexpectedWrites).toEqual([]);
});
