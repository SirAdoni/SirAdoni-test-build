import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { seedUIState } from "./ui-state-fixture.js";

type SourceState = "success" | "error" | "empty";
type PaletteFixtureState = { chats: SourceState; characters: SourceState };

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;
const chatName = "Synthetic Navigation Chat";
const characterName = "Synthetic Navigation Character";
const fixtureTimestamp = "2026-10-01T00:00:00.000Z";

function assertLocalAppOrigin(testInfo: TestInfo): string {
  const baseURL = testInfo.project.use.baseURL;
  if (typeof baseURL !== "string") throw new Error("The palette fixture requires an explicit configured baseURL.");
  const target = new URL(baseURL);
  if (target.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)) {
    throw new Error(`Refusing palette fixture navigation outside a local HTTP origin: ${target.origin}`);
  }
  return target.origin;
}

async function installPaletteFixture(
  page: Page,
  testInfo: TestInfo,
  state: PaletteFixtureState,
  libraryNavigationEnabled = true,
) {
  // Fence the configured origin before registering routes or navigating.
  const origin = assertLocalAppOrigin(testInfo);
  const chatId = `palette-fixture-${randomUUID()}`;
  const chat = {
    id: chatId,
    name: chatName,
    mode: "conversation",
    characterIds: [],
    groupId: null,
    personaId: null,
    personaCharacterId: null,
    promptPresetId: null,
    connectionId: null,
    connectedChatId: null,
    folderId: null,
    sortOrder: 0,
    createdAt: fixtureTimestamp,
    updatedAt: fixtureTimestamp,
    metadata: { summary: null, tags: [], enableAgents: false, agentOverrides: {}, activeAgentIds: [] },
  };
  const characterId = `palette-character-${randomUUID()}`;
  const character = {
    id: characterId,
    name: characterName,
    comment: "",
    creator: "Synthetic fixture",
    version: "1",
    tags: [],
    favorite: false,
    summary: "",
    explicitSummary: "",
    description: "Synthetic browser-test character.",
    personality: "",
    scenario: "",
    firstMessage: "",
    creatorNotes: "",
    tokenEstimate: 0,
    nameColor: null,
    avatarPath: null,
    avatarCrop: null,
    createdAt: fixtureTimestamp,
    updatedAt: fixtureTimestamp,
  };

  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      await route.abort();
      return;
    }
    if (!url.pathname.startsWith("/api/")) {
      await route.continue();
      return;
    }

    // Browser API mutations are acknowledged locally and never reach storage or providers.
    if (request.method() !== "GET") {
      await route.fulfill({ json: { success: true } });
      return;
    }
    if (/(?:refresh|update|install|sync)/iu.test(url.pathname)) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Fixture blocks startup refresh" }),
      });
      return;
    }
    if (url.pathname === "/api/app-settings/ui") {
      await route.fulfill({ json: { value: "" } });
      return;
    }
    if (url.pathname === "/api/app-settings/features") {
      await route.fulfill({
        json: {
          settings: { libraryNavigation: libraryNavigationEnabled },
          envOverrides: {},
          effective: { libraryNavigation: libraryNavigationEnabled },
        },
      });
      return;
    }
    if (url.pathname === "/api/chats") {
      if (state.chats === "error") {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: "Fixture chat failure" }),
        });
      } else {
        await route.fulfill({ json: state.chats === "empty" ? [] : [chat] });
      }
      return;
    }
    if (url.pathname === "/api/characters/catalog") {
      if (state.characters === "error") {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: "Fixture character failure" }),
        });
      } else {
        const items = state.characters === "empty" ? [] : [character];
        await route.fulfill({
          json: {
            items,
            limit: Number(url.searchParams.get("limit") ?? 50),
            offset: Number(url.searchParams.get("offset") ?? 0),
            hasMore: false,
            catalogGeneration: 1,
          },
        });
      }
      return;
    }
    if (url.pathname === `/api/chats/${chatId}`) {
      await route.fulfill({ json: chat });
      return;
    }
    if (url.pathname === `/api/chats/${chatId}/messages`) {
      await route.fulfill({ json: [] });
      return;
    }
    if (url.pathname === `/api/generate/status/${chatId}`) {
      await route.fulfill({ json: { active: false } });
      return;
    }
    if (/\/(?:generate|images|tts|provider|providers)(?:\/|$)/iu.test(url.pathname)) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Fixture blocks generation" }),
      });
      return;
    }
    await route.continue();
  });

  await seedUIState(page, {
    hasCompletedOnboarding: true,
    sidebarOpen: false,
    rightPanelOpen: false,
    chibiProfessorMariEnabled: false,
  });
  await page.addInitScript((appVersion) => {
    localStorage.setItem("marinara:whats-new:seen-version", appVersion);
  }, version);
  await page.goto(new URL("/", origin).toString());
  if (libraryNavigationEnabled) {
    await expect(page.getByRole("button", { name: "Search chats and characters" })).toBeVisible();
  } else {
    await expect(page.getByRole("button", { name: "Search chats and characters" })).toHaveCount(0);
  }
  return { chatId };
}

// Mobile projects use real taps; keyboard shortcuts below remain external-keyboard contracts.
async function activate(locator: Locator, testInfo: TestInfo) {
  if (testInfo.project.name.startsWith("mobile-")) await locator.tap();
  else await locator.click();
}

async function openPalette(page: Page, testInfo: TestInfo) {
  await activate(page.getByRole("button", { name: "Search chats and characters" }), testInfo);
  const input = page.getByRole("combobox", { name: "Find chats or characters, or search messages" });
  await expect(input).toBeVisible();
  return input;
}

test("library navigation stays hidden and its shortcut inactive while switched off", async ({ page }, testInfo) => {
  await installPaletteFixture(page, testInfo, { chats: "success", characters: "success" }, false);
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Search chats and characters" })).toHaveCount(0);
});

test("palette preserves character results and actions through chat failure and retry", async ({ page }, testInfo) => {
  const state: PaletteFixtureState = { chats: "error", characters: "success" };
  await installPaletteFixture(page, testInfo, state);
  const input = await openPalette(page, testInfo);
  const listbox = page.getByRole("listbox", { name: "Search results" });
  const chatAlert = page.getByRole("alert").filter({ hasText: "Could not load chats" });
  await expect(chatAlert).toBeVisible();
  await expect(listbox.getByRole("alert")).toHaveCount(0);
  await input.fill(characterName);
  await expect(listbox.getByRole("option", { name: new RegExp(`^${characterName} Character$`) })).toBeVisible();
  await activate(listbox.getByRole("option", { name: new RegExp(`Search messages for ${characterName}`) }), testInfo);
  const globalSearch = page.getByRole("searchbox", { name: "Search messages in all chats" });
  await expect(globalSearch).toBeVisible();
  await expect(globalSearch).toHaveValue(characterName);
  if (testInfo.project.name.startsWith("mobile-")) {
    await activate(page.getByRole("dialog").getByRole("button", { name: /^Close/i }), testInfo);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await openPalette(page, testInfo);
  }
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await openPalette(page, testInfo);
  await expect(chatAlert).toBeVisible();
  await input.fill("");
  state.chats = "success";
  await activate(chatAlert.getByRole("button"), testInfo);
  await expect(chatAlert).toHaveCount(0);
  await input.fill(chatName);
  await expect(listbox.getByRole("option", { name: new RegExp(`^${chatName} Conversation$`) })).toBeVisible();
});

test("palette preserves chat results through character failure and retry", async ({ page }, testInfo) => {
  const state: PaletteFixtureState = { chats: "success", characters: "error" };
  const { chatId } = await installPaletteFixture(page, testInfo, state);
  const input = await openPalette(page, testInfo);
  const listbox = page.getByRole("listbox", { name: "Search results" });
  const characterAlert = page.getByRole("alert").filter({ hasText: "Could not load characters" });
  await expect(characterAlert).toBeVisible();
  await expect(listbox.getByRole("alert")).toHaveCount(0);
  await input.fill(chatName);
  await expect(listbox.getByRole("option", { name: new RegExp(`^${chatName} Conversation$`) })).toBeVisible();
  state.characters = "success";
  await activate(characterAlert.getByRole("button"), testInfo);
  await expect(characterAlert).toHaveCount(0);
  await input.fill(chatName);
  await activate(listbox.getByRole("option", { name: new RegExp(`^${chatName} Conversation$`) }), testInfo);
  const activeChatId = await page.evaluate(async () => {
    const { useChatStore } = await import("/src/stores/chat.store.ts" as string);
    return useChatStore.getState().activeChatId;
  });
  expect(activeChatId).toBe(chatId);
});

test("both source failures keep palette actions usable, while successful empty lists stay quiet", async ({
  page,
}, testInfo) => {
  const state: PaletteFixtureState = { chats: "error", characters: "error" };
  await installPaletteFixture(page, testInfo, state);
  await openPalette(page, testInfo);
  const listbox = page.getByRole("listbox", { name: "Search results" });
  await expect(page.getByRole("alert")).toHaveCount(2);
  await expect(listbox.getByRole("alert")).toHaveCount(0);
  await activate(listbox.getByRole("option", { name: "Open character library" }), testInfo);
  const rightPanel = await page.evaluate(async () => {
    const { useUIStore } = await import("/src/stores/ui.store.ts" as string);
    return useUIStore.getState().rightPanel;
  });
  expect(rightPanel).toBe("characters");

  state.chats = "empty";
  state.characters = "empty";
  await page.reload();
  await openPalette(page, testInfo);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(listbox.getByRole("option", { name: "Open character library" })).toBeVisible();
  await expect(listbox.getByRole("option", { name: "Search all chats" })).toBeVisible();
});

test("palette dirty-editor confirmation and nested modal protect keyboard navigation", async ({ page }, testInfo) => {
  const state: PaletteFixtureState = { chats: "success", characters: "success" };
  const { chatId } = await installPaletteFixture(page, testInfo, state);
  let input = await openPalette(page, testInfo);
  await input.fill(chatName);
  await page.evaluate(async () => {
    const { useUIStore } = await import("/src/stores/ui.store.ts" as string);
    useUIStore.getState().setEditorDirty(true);
  });
  await activate(page.getByRole("option", { name: new RegExp(`^${chatName} Conversation$`) }), testInfo);
  let unsavedDialog = page.getByRole("dialog").filter({ hasText: /unsaved changes/i });
  await expect(unsavedDialog).toBeVisible();
  const beforeCancel = await page.evaluate(async () => {
    const { useChatStore } = await import("/src/stores/chat.store.ts" as string);
    return useChatStore.getState().activeChatId;
  });
  await activate(unsavedDialog.getByRole("button", { name: "Cancel" }), testInfo);
  const afterCancel = await page.evaluate(async () => {
    const { useChatStore } = await import("/src/stores/chat.store.ts" as string);
    return useChatStore.getState().activeChatId;
  });
  expect(afterCancel).toBe(beforeCancel);

  input = await openPalette(page, testInfo);
  await input.fill(chatName);
  await activate(page.getByRole("option", { name: new RegExp(`^${chatName} Conversation$`) }), testInfo);
  unsavedDialog = page.getByRole("dialog").filter({ hasText: /unsaved changes/i });
  await expect(unsavedDialog).toBeVisible();
  await activate(unsavedDialog.getByRole("button", { name: "Discard" }), testInfo);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { useChatStore } = await import("/src/stores/chat.store.ts" as string);
        return useChatStore.getState().activeChatId;
      }),
    )
    .toBe(chatId);

  await activate(page.getByRole("button", { name: "Search chats and characters" }), testInfo);
  input = page.getByRole("combobox", { name: "Find chats or characters, or search messages" });
  await expect(input).toBeVisible();
  await page.evaluate(async () => {
    const { useUIStore } = await import("/src/stores/ui.store.ts" as string);
    useUIStore.getState().setEditorDirty(false);
    const { showConfirmDialog } = await import("/src/lib/app-dialogs.ts" as string);
    void showConfirmDialog({
      title: "Synthetic nested overlay",
      message: "Confirm overlay stacking behavior.",
      confirmLabel: "Continue",
      tone: "destructive",
    });
  });
  const dialogs = page.getByRole("dialog");
  await expect(dialogs).toHaveCount(2);
  await page.keyboard.press("Control+k");
  await expect(dialogs).toHaveCount(2);
  await expect(input).toBeVisible();
  await activate(
    page.getByRole("dialog").filter({ hasText: "Synthetic nested overlay" }).getByRole("button", { name: "Continue" }),
    testInfo,
  );
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
