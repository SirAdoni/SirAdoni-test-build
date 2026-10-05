import { expect, test } from "./wiki-feature-fixture";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
test.use({
  wikiFeatures: {
    campaignMemory: true,
    campaignWiki: false,
    familyTree: true,
    factionWeb: false,
    gameCalendar: false,
    worldHistory: false,
  },
});

test("Game Mode session actions open the Family Tree modal", async ({ page, request }, testInfo) => {
  const fixtureId = Math.random().toString(36).slice(2, 10);
  const characterResponse = await request.post("/api/characters", {
    data: { data: { name: `Family Tree owner ${fixtureId}` } },
  });
  expect(characterResponse.ok()).toBeTruthy();
  const character = await characterResponse.json();
  let chatId: string | undefined;

  try {
    const chatResponse = await request.post("/api/chats", {
      data: { name: `Family Tree ${fixtureId}`, mode: "game", characterIds: [character.id] },
    });
    expect(chatResponse.ok()).toBeTruthy();
    const chat = await chatResponse.json();
    chatId = chat.id;

    const setupResponse = await request.patch(`/api/chats/${chat.id}/metadata`, {
      data: {
        gameId: chat.id,
        gameSessionStatus: "active",
        gameIntroPresented: true,
        enableAgents: false,
        gameImageAutoGenerationEnabled: false,
      },
    });
    expect(setupResponse.ok()).toBeTruthy();

    await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
    await seedUIState(page, {
      hasCompletedOnboarding: true,
      chatHelpSeenModes: ["conversation", "roleplay", "game"],
      sidebarOpen: false,
      rightPanelOpen: false,
      theme: testInfo.project.name.includes("dark") ? "dark" : "light",
    });
    await page.addInitScript(
      ({ id, appVersion }) => {
        localStorage.setItem("marinara-active-chat-id", id);
        localStorage.setItem("marinara:whats-new:seen-version", appVersion);
      },
      { id: chat.id, appVersion: version },
    );
    await page.goto("/");

    if (testInfo.project.name.startsWith("mobile")) {
      await page.getByRole("button", { name: "Game actions", exact: true }).click();
    }
    await page.getByRole("button", { name: "Session", exact: true }).click();
    const treeResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === `/api/family-tree/${encodeURIComponent(chat.id)}`;
    });
    await page.getByRole("button", { name: "Open family tree", exact: true }).click();
    const treeResponse = await treeResponsePromise;
    expect(treeResponse.ok()).toBeTruthy();
    await expect(page.getByRole("heading", { name: "Family tree", exact: true })).toBeVisible();
  } finally {
    if (chatId) await request.delete(`/api/chats/${chatId}?force=true`);
    await request.delete(`/api/characters/${character.id}`);
  }
});
