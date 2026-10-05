import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import { seedUIState } from "./ui-state-fixture.js";
import type { FeatureSettings, FeatureSettingsResponse } from "@marinara-engine/shared";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;
const chatTitle = "Synthetic authoring fixture";
const cleanupState = new Map<
  string,
  { origin: string; chatId: string; tableIds: string[]; api?: APIRequestContext; features?: FeatureSettings }
>();
const authoringEnabled = { libraryNavigation: true, gamePrepBoard: true, randomTables: true, diceLog: true } as const;

function assertLocalAppOrigin(testInfo: TestInfo): string {
  const baseURL = testInfo.project.use.baseURL;
  if (typeof baseURL !== "string") throw new Error("The game-authoring fixture needs an explicit configured base URL");
  const target = new URL(baseURL);
  if (
    !["http://127.0.0.1:5178", "http://127.0.0.1:5179"].includes(target.origin) ||
    target.username ||
    target.password
  ) {
    throw new Error("The game-authoring fixture only permits the isolated test origins");
  }
  return target.origin;
}

async function openGameChat(page: Page, chatName: string, isMobile: boolean) {
  await page.getByRole("button", { name: "Search chats and characters" }).click();
  const input = page.getByRole("combobox", { name: "Find chats or characters, or search messages" });
  await expect(input).toBeVisible();
  await input.fill(chatName);
  const option = page
    .getByRole("listbox", { name: "Search results" })
    .getByRole("option", { name: `${chatName} Game`, exact: true });
  await expect(option).toHaveCount(1);
  await option.click();
  await openSessionTools(page, isMobile);
}

async function openSessionTools(page: Page, isMobile: boolean) {
  const session = page
    .getByRole("button", { name: "Session", exact: true })
    .and(page.locator("[data-chat-help=session]"));
  if (isMobile && !(await session.isVisible())) {
    await page.getByRole("button", { name: "Game actions", exact: true }).click();
  }
  await session.click();
  const toolsTab = page.getByRole("button", { name: "Tools", exact: true });
  await expect(toolsTab).toBeVisible();
  await toolsTab.click();
}

test.afterEach(async ({ playwright }, testInfo) => {
  testInfo.setTimeout(30_000);
  const state = cleanupState.get(testInfo.testId);
  if (!state) return;
  const failures: string[] = [];
  let cleanupApi: APIRequestContext | undefined;
  try {
    cleanupApi = await playwright.request.newContext({ baseURL: state.origin, timeout: 5_000 });
    if (state.features) {
      try {
        const response = await cleanupApi.put("/api/app-settings/features", {
          data: { ...state.features, ...authoringEnabled },
        });
        if (!response.ok()) failures.push("enable cleanup: HTTP " + response.status());
      } catch (error) {
        failures.push("enable cleanup: " + String(error));
      }
    }
    const paths = state.tableIds.map((id) => "/api/random-tables/" + encodeURIComponent(id));
    if (state.chatId) paths.push("/api/prep-board?chatId=" + encodeURIComponent(state.chatId));
    const results = await Promise.allSettled(paths.map((path) => cleanupApi!.delete(path)));
    results.forEach((result, index) => {
      if (result.status === "rejected") failures.push(paths[index] + ": " + String(result.reason));
      else if (!result.value.ok()) failures.push(paths[index] + ": HTTP " + result.value.status());
    });
    // Chat deletion follows owned child cleanup, even if any child deletion failed.
    if (state.chatId) {
      try {
        const response = await cleanupApi.delete("/api/chats/" + encodeURIComponent(state.chatId) + "?force=true");
        if (!response.ok()) failures.push("chat: HTTP " + response.status());
      } catch (error) {
        failures.push("chat: " + String(error));
      }
    }
  } finally {
    if (state.features && cleanupApi) {
      try {
        const response = await cleanupApi.put("/api/app-settings/features", { data: state.features });
        if (!response.ok()) failures.push("restore features: HTTP " + response.status());
      } catch (error) {
        failures.push("restore features: " + String(error));
      }
    }
    const disposals = await Promise.allSettled([cleanupApi?.dispose(), state.api?.dispose()]);
    for (const result of disposals) if (result.status === "rejected") failures.push(String(result.reason));
    cleanupState.delete(testInfo.testId);
  }
  expect(failures, "All synthetic backend records should be removed").toEqual([]);
});

test("Game authoring tools edit and persist through the real App without providers", async ({
  page,
  playwright,
  isMobile,
}, testInfo) => {
  // Fence both API and browser origins before their first requests.
  const origin = assertLocalAppOrigin(testInfo);
  const suffix = randomUUID();
  const chatName = chatTitle + " " + suffix.slice(0, 8);
  let chatId = "";
  const tableIds: string[] = [];
  const state = {
    origin,
    chatId,
    tableIds,
    api: undefined as APIRequestContext | undefined,
    features: undefined as FeatureSettings | undefined,
  };
  cleanupState.set(testInfo.testId, state);
  const request = await playwright.request.newContext({ baseURL: origin, timeout: 10_000 });
  state.api = request;
  const originalFeatures = await request.get("/api/app-settings/features");
  expect(originalFeatures.ok()).toBeTruthy();
  state.features = ((await originalFeatures.json()) as FeatureSettingsResponse).settings;
  const disabled = { ...state.features, gamePrepBoard: false, randomTables: false, diceLog: false };
  expect((await request.put("/api/app-settings/features", { data: disabled })).ok()).toBeTruthy();
  for (const path of [
    "/api/prep-board?chatId=disabled",
    "/api/random-tables",
    "/api/game-tools/dice-log?chatId=disabled",
  ]) {
    expect((await request.get(path)).status(), path + " rejects when OFF").toBe(403);
  }
  expect(
    (await request.put("/api/app-settings/features", { data: { ...state.features, ...authoringEnabled } })).ok(),
  ).toBeTruthy();

  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || /\/api\/(?:generate|agents\/run)(?:\/|$)/.test(url.pathname)) {
      await route.abort();
      return;
    }
    await route.continue();
  });

  {
    const createdChat = await request.post("/api/chats", {
      data: { name: chatName, mode: "game", characterIds: [] },
    });
    expect(createdChat.ok(), await createdChat.text()).toBeTruthy();
    chatId = ((await createdChat.json()) as { id: string }).id;
    state.chatId = chatId;
    expect(chatId).toBeTruthy();
    const metadata = await request.patch("/api/chats/" + chatId + "/metadata", {
      data: { gameId: "authoring-fixture-" + suffix, gameSessionStatus: "active", gameIntroPresented: true },
    });
    expect(metadata.ok(), await metadata.text()).toBeTruthy();

    const initial = await request.get("/api/prep-board?chatId=" + encodeURIComponent(chatId));
    expect(initial.ok(), await initial.text()).toBeTruthy();
    const initialBody = (await initial.json()) as { revision: number };
    const board = {
      sections: [{ id: "fixture-section", title: "Fixture" }],
      items: [{ id: "fixture-item", sectionId: "fixture-section", text: "Synthetic clue" }],
    };
    const saved = await request.put("/api/prep-board", {
      data: { chatId, revision: initialBody.revision, board },
    });
    expect(saved.ok(), await saved.text()).toBeTruthy();
    const savedBody = (await saved.json()) as { revision: number; board: { items: Array<{ text: string }> } };
    expect(savedBody.revision).toBe(initialBody.revision + 1);
    expect(savedBody.board.items[0]?.text).toBe("Synthetic clue");

    const conflict = await request.put("/api/prep-board", {
      data: { chatId, revision: initialBody.revision, board: { sections: [], items: [] } },
    });
    expect(conflict.status()).toBe(409);
    expect(((await conflict.json()) as { revision: number }).revision).toBe(savedBody.revision);

    const tableName = "Fixture Encounters " + suffix.slice(0, 8);
    const gameTableResponse = await request.post("/api/random-tables", {
      data: { chatId, scope: "game", table: { name: tableName, rows: [{ text: "Synthetic encounter" }] } },
    });
    expect(gameTableResponse.ok(), await gameTableResponse.text()).toBeTruthy();
    const gameTable = (await gameTableResponse.json()) as { id: string };
    tableIds.push(gameTable.id);

    const globalTableResponse = await request.post("/api/random-tables", {
      data: { scope: "global", table: { name: tableName, rows: [{ text: "Global encounter" }] } },
    });
    expect(globalTableResponse.ok(), await globalTableResponse.text()).toBeTruthy();
    const globalTable = (await globalTableResponse.json()) as { id: string };
    tableIds.push(globalTable.id);

    const visibleResponse = await request.get("/api/random-tables?chatId=" + encodeURIComponent(chatId));
    expect(visibleResponse.ok(), await visibleResponse.text()).toBeTruthy();
    const visible = (await visibleResponse.json()) as { tables: Array<{ id: string; gameId: string }> };
    expect(visible.tables.slice(0, 2).map((table) => table.id)).toEqual([gameTable.id, globalTable.id]);
    expect(visible.tables[0]?.gameId).toBeTruthy();
    expect(visible.tables[1]?.gameId).toBe("");

    const importResponse = await request.post("/api/random-tables/import", {
      data: {
        chatId,
        scope: "game",
        skipExisting: true,
        data: {
          tables: [
            { name: tableName, rows: [{ text: "Must be skipped" }] },
            { name: "Fixture Imported " + suffix.slice(0, 8), rows: [{ text: "Imported result" }] },
          ],
        },
      },
    });
    expect(importResponse.ok(), await importResponse.text()).toBeTruthy();
    const imported = (await importResponse.json()) as { created: Array<{ id: string }>; existing: number };
    expect(imported.existing).toBe(1);
    expect(imported.created).toHaveLength(1);
    tableIds.push(imported.created[0]!.id);

    const apiRoll = await request.post("/api/random-tables/roll", {
      data: { tableId: gameTable.id, chatId, log: true },
    });
    expect(apiRoll.ok(), await apiRoll.text()).toBeTruthy();
    expect(((await apiRoll.json()) as { logged: number }).logged).toBe(1);
    const initialDiceLog = await request.get(
      "/api/game-tools/dice-log?chatId=" + encodeURIComponent(chatId) + "&scope=game",
    );
    expect(initialDiceLog.ok(), await initialDiceLog.text()).toBeTruthy();
    expect(((await initialDiceLog.json()) as { total: number }).total).toBe(1);

    await seedUIState(page, {
      hasCompletedOnboarding: true,
      sidebarOpen: false,
      rightPanelOpen: false,
      chibiProfessorMariEnabled: false,
    });
    await page.addInitScript((appVersion) => {
      localStorage.setItem("marinara:whats-new:seen-version", appVersion);
    }, version);
    await page.goto(origin + "/");
    await expect(page.getByRole("button", { name: "Search chats and characters" })).toBeVisible();
    await openGameChat(page, chatName, isMobile);

    let failedBoardLoads = 0;
    let failBoardLoads = true;
    await page.route("**/api/prep-board?**", async (route) => {
      if (route.request().method() === "GET" && failBoardLoads) {
        failedBoardLoads++;
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: '{"error":"Synthetic load failure"}',
        });
      } else {
        await route.fallback();
      }
    });
    await page.getByRole("button", { name: "GM prep board", exact: true }).click();
    const loadError = page.getByRole("alert").filter({
      hasText: "Could not load the prep board. Your saved board has not been changed.",
    });
    await expect(loadError).toBeVisible();
    expect(failedBoardLoads).toBeGreaterThan(0);
    failBoardLoads = false;
    await loadError.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(loadError).toHaveCount(0);
    const prepDialog = page
      .getByRole("dialog")
      .filter({ hasText: "Private to you. The prep board is never sent to the model." });
    await expect(prepDialog).toBeVisible();
    await expect(prepDialog.getByText("Synthetic clue", { exact: true })).toBeVisible();
    const addItem = prepDialog.getByRole("textbox", { name: "Add an item to Fixture" });
    const boardSave = page.waitForResponse((response) => {
      const req = response.request();
      return req.method() === "PUT" && new URL(response.url()).pathname === "/api/prep-board";
    });
    await addItem.fill("Edited in the real App");
    await addItem.press("Enter");
    expect((await boardSave).ok()).toBeTruthy();
    await page.keyboard.press("Escape");
    await expect(prepDialog).toHaveCount(0);

    await openSessionTools(page, isMobile);
    await page.getByRole("button", { name: "Random tables", exact: true }).click();
    const randomDialog = page.getByRole("dialog").filter({ hasText: "Random tables" });
    await expect(randomDialog).toBeVisible();
    const tablePicker = randomDialog.getByRole("combobox", { name: "Table" });
    await tablePicker.selectOption(gameTable.id);
    await randomDialog.getByRole("button", { name: "Edit table" }).click();
    await randomDialog.getByRole("textbox", { name: "Rows" }).fill("Synthetic encounter edited");
    const tableSave = page.waitForResponse((response) => {
      const req = response.request();
      return req.method() === "PUT" && new URL(response.url()).pathname === "/api/random-tables/" + gameTable.id;
    });
    await randomDialog.getByRole("button", { name: "Save", exact: true }).click();
    expect((await tableSave).ok()).toBeTruthy();

    const persistedTables = await request.get("/api/random-tables?chatId=" + encodeURIComponent(chatId));
    expect(persistedTables.ok(), await persistedTables.text()).toBeTruthy();
    const persistedTableRecords = (await persistedTables.json()) as {
      tables: Array<{ id: string; rows: Array<{ text: string }> }>;
    };
    expect(persistedTableRecords.tables.find((table) => table.id === gameTable.id)?.rows[0]?.text).toBe(
      "Synthetic encounter edited",
    );

    const appRollPromise = page.waitForResponse((response) => {
      const req = response.request();
      return req.method() === "POST" && new URL(response.url()).pathname === "/api/random-tables/roll";
    });
    await randomDialog.getByRole("button", { name: "Roll", exact: true }).click();
    const appRoll = await appRollPromise;
    expect(appRoll.ok()).toBeTruthy();
    await expect(randomDialog.getByText("Synthetic encounter edited", { exact: false })).toBeVisible();

    await page.keyboard.press("Escape");
    await page.reload();
    await openGameChat(page, chatName, isMobile);
    await page.getByRole("button", { name: "GM prep board", exact: true }).click();
    const reloadedPrepDialog = page.getByRole("dialog").filter({
      hasText: "Private to you. The prep board is never sent to the model.",
    });
    await expect(reloadedPrepDialog.getByText("Edited in the real App", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(reloadedPrepDialog).toHaveCount(0);
    await openSessionTools(page, isMobile);
    await page.getByRole("button", { name: "Random tables", exact: true }).click();
    const reloadedTablesDialog = page.getByRole("dialog").filter({ hasText: "Random tables" });
    await expect(reloadedTablesDialog).toBeVisible();
    await reloadedTablesDialog.getByRole("combobox", { name: "Table" }).selectOption(gameTable.id);
    await reloadedTablesDialog.getByRole("button", { name: "Edit table" }).click();
    await expect(reloadedTablesDialog.getByRole("textbox", { name: "Rows" })).toHaveValue("Synthetic encounter edited");
    await page.keyboard.press("Escape");
    expect((await request.put("/api/app-settings/features", { data: disabled })).ok()).toBeTruthy();
    await page.reload();
    await expect(page.getByRole("button", { name: "Tools", exact: true })).toHaveCount(0);
    expect((await request.get("/api/random-tables")).status()).toBe(403);
    expect((await request.get("/api/prep-board?chatId=" + encodeURIComponent(chatId))).status()).toBe(403);
    expect(
      (await request.put("/api/app-settings/features", { data: { ...state.features, ...authoringEnabled } })).ok(),
    ).toBeTruthy();
    const retainedBoard = await request.get("/api/prep-board?chatId=" + encodeURIComponent(chatId));
    expect(retainedBoard.ok()).toBeTruthy();
    expect(
      (await retainedBoard.json()).board.items.some((item: { text: string }) => item.text === "Edited in the real App"),
    ).toBe(true);
    const retainedTables = await request.get("/api/random-tables?chatId=" + encodeURIComponent(chatId));
    expect(retainedTables.ok()).toBeTruthy();
    expect((await retainedTables.json()).tables.some((table: { id: string }) => table.id === gameTable.id)).toBe(true);
  }
});
