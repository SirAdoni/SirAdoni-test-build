import { readFileSync } from "node:fs";
import { expect, test, wikiFeatureDefaults } from "./wiki-feature-fixture";
import { seedUIState } from "./ui-state-fixture";

const off = Object.fromEntries(Object.keys(wikiFeatureDefaults).map((key) => [key, false]));
const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
test.use({ wikiFeatures: off });

test("Wiki opt-in hides entries, preserves records, and opens Factions independently", async ({
  page,
  request,
}, info) => {
  const created = await request.post("/api/chats", {
    data: { name: "Isolated Wiki opt-in", mode: "game", characterIds: [] },
  });
  expect(created.ok()).toBeTruthy();
  const chat = await created.json();
  const entityId = `wiki-opt-in-${crypto.randomUUID()}`;
  const alias = "Retained opt-in organization";
  const set = async (flags: Record<string, boolean>) => {
    const result = await request.put("/api/app-settings/features", { data: { ...off, ...flags } });
    expect(result.ok()).toBeTruthy();
  };
  const session = async () => {
    await page.goto("/");
    if (info.project.name.startsWith("mobile"))
      await page.getByRole("button", { name: "Game actions", exact: true }).click();
    await page.getByRole("button", { name: "Session", exact: true }).click();
  };
  try {
    expect(
      (
        await request.patch(`/api/chats/${chat.id}/metadata`, {
          data: {
            gameId: chat.id,
            gameSessionStatus: "active",
            gameIntroPresented: true,
            enableAgents: false,
            gameImageAutoGenerationEnabled: false,
          },
        })
      ).ok(),
    ).toBeTruthy();
    await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
    await seedUIState(page, {
      hasCompletedOnboarding: true,
      chatHelpSeenModes: ["game", "roleplay", "conversation"],
      sidebarOpen: false,
      rightPanelOpen: false,
    });
    await page.addInitScript(
      ({ id, v }) => {
        localStorage.setItem("marinara-active-chat-id", id);
        localStorage.setItem("marinara:whats-new:seen-version", v);
      },
      { id: chat.id, v: version },
    );
    await session();
    await expect(page.getByRole("button", { name: "Campaign Wiki", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Open family tree", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Faction Web", exact: true })).toHaveCount(0);
    expect((await request.get(`/api/game/${chat.id}/memory/entities`)).status()).toBe(403);
    await set({ campaignMemory: true, campaignWiki: true });
    const record = await request.post(`/api/game/${chat.id}/memory/mutations`, {
      data: {
        operationId: crypto.randomUUID(),
        action: "create",
        recordType: "entity",
        reason: "isolated opt-in retention fixture",
        input: {
          entityId,
          kind: "organization",
          owner: { type: "registry", store: "campaign-memory", recordId: entityId },
          aliases: [alias],
          tags: [],
          summary: "Preserve when disabled",
          attributes: {},
          status: "active",
          manualLock: true,
        },
      },
    });
    expect(record.ok()).toBeTruthy();
    await session();
    await page.getByRole("button", { name: "Campaign Wiki", exact: true }).click();
    await page.getByRole("textbox", { name: "Search people, places, lore" }).fill(alias);
    await expect(page.getByRole("button", { name: `${alias} Organization`, exact: true })).toBeVisible();
    await set({});
    await session();
    await expect(page.getByRole("button", { name: "Campaign Wiki", exact: true })).toHaveCount(0);
    expect((await request.get(`/api/game/${chat.id}/memory/entities/${entityId}`)).status()).toBe(403);
    await set({ campaignMemory: true, factionWeb: true });
    await session();
    await expect(page.getByRole("button", { name: "Campaign Wiki", exact: true })).toHaveCount(0);
    const picker = page.waitForResponse(
      (r) => new URL(r.url()).pathname === `/api/game/${chat.id}/memory/factions/entities`,
    );
    await page.getByRole("button", { name: "Faction Web", exact: true }).click();
    expect((await picker).ok()).toBeTruthy();
    await expect(page.getByRole("button", { name: alias, exact: true })).toBeVisible();
    await set({ campaignMemory: true, campaignWiki: true });
    const retained = await request.get(`/api/game/${chat.id}/memory/entities/${entityId}`);
    expect(retained.ok()).toBeTruthy();
    expect((await retained.json()).entity.aliases).toContain(alias);
  } finally {
    expect((await request.delete(`/api/chats/${chat.id}?force=true`)).ok()).toBeTruthy();
  }
});
