import { expect, test as base, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";
import { inventoryButton } from "./game-inventory-fixture.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const test = base.extend<{ restoreFeatures: void }>({
  restoreFeatures: [
    async ({ request, context }, use) => {
      const response = await request.get("/api/app-settings/features");
      expect(response.ok()).toBeTruthy();
      const previous = (await response.json()).settings;
      await context.route("**/*", (route) => {
        const url = new URL(route.request().url());
        return ["http:", "https:"].includes(url.protocol) && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
          ? route.abort("blockedbyclient")
          : route.continue();
      });
      try {
        await use();
      } finally {
        const restored = await request.put("/api/app-settings/features", { data: previous });
        expect(restored.ok()).toBeTruthy();
      }
    },
    { auto: true },
  ],
});

async function setBrowsing(request: APIRequestContext, enabled: boolean) {
  const current = await (await request.get("/api/app-settings/features")).json();
  const response = await request.put("/api/app-settings/features", {
    data: { ...current.settings, inventoryBrowsing: enabled },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}
const fixtureItems = [
  { id: "stack-zebra", name: "Zebra charm", item: "plain:zebra-charm", quantity: 1 },
  { id: "stack-apple", name: "Apple", item: "plain:apple", quantity: 4 },
  { id: "stack-axe", name: "Axe", item: "plain:axe", quantity: 2 },
  { id: "stack-twin-a", name: "Twin token", item: "plain:twin-token-a", quantity: 1 },
  { id: "stack-twin-b", name: "Twin token", item: "plain:twin-token-b", quantity: 3 },
];

async function openInventory(
  page: Page,
  request: APIRequestContext,
  theme: "light" | "dark",
  mobile: boolean,
  enabled = true,
) {
  await setBrowsing(request, enabled);
  const created = await request.post("/api/chats", {
    data: { name: "Inventory identity fixture", mode: "game", characterIds: [] },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const chat = await created.json();
  const updated = await request.patch(`/api/chats/${chat.id}/metadata`, {
    data: {
      gameId: "inventory-identity-fixture",
      gameSessionStatus: "active",
      gameIntroPresented: true,
      gamePartyCharacterIds: [],
      gameInventory: fixtureItems,
    },
  });
  expect(updated.ok(), await updated.text()).toBeTruthy();
  const message = await request.post(`/api/chats/${chat.id}/messages`, {
    data: { role: "assistant", content: "The inventory is ready." },
  });
  expect(message.ok(), await message.text()).toBeTruthy();

  await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
  await seedUIState(page, {
    hasCompletedOnboarding: true,
    rightPanelOpen: false,
    sidebarOpen: false,
    chatHelpSeenModes: ["conversation", "roleplay", "game"],
    gameInstantTextReveal: true,
    theme,
  });
  await page.addInitScript(
    ({ id, appVersion }) => {
      localStorage.setItem("marinara-active-chat-id", id);
      localStorage.setItem("marinara:whats-new:seen-version", appVersion);
    },
    { id: chat.id, appVersion: version },
  );
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await inventoryButton(page).click({ timeout: 30000 });
  const panel = page.locator("div.fixed.inset-y-0").filter({ has: page.getByRole("heading", { name: /Inventory/ }) });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("searchbox", { name: "Search items" })).toHaveCount(enabled ? 1 : 0);
  return { chatId: chat.id, panel };
}

test("inventory browsing OFF/ON/OFF keeps saved identities and original order", async ({ page, request, isMobile }) => {
  const { chatId, panel } = await openInventory(page, request, "dark", isMobile, false);
  const firstTile = panel.locator(".grid.grid-cols-5 > button").first();
  await expect(firstTile).toContainText("Zebra charm");
  const readItems = async () => {
    const chat = await (await request.get(`/api/chats/${chatId}`)).json();
    const metadata = typeof chat.metadata === "string" ? JSON.parse(chat.metadata) : chat.metadata;
    return metadata.gameInventory;
  };
  const before = await readItems();
  for (const enabled of [true, false, true]) {
    await setBrowsing(request, enabled);
    await page.reload();
    await inventoryButton(page).click();
    const search = panel.getByRole("searchbox", { name: "Search items" });
    await expect(search).toHaveCount(enabled ? 1 : 0);
    await expect(firstTile).toContainText("Zebra charm");
    if (enabled) {
      await search.fill("twin token");
      await expect(panel.getByText("Twin token", { exact: true })).toHaveCount(2);
      await search.fill("");
      await panel.getByRole("button", { name: "Sort by Order", exact: true }).click();
      await expect(firstTile).toContainText("Apple");
    }
    expect(await readItems()).toEqual(before);
  }
});

for (const theme of ["light", "dark"] as const) {
  for (const mobile of [false, true]) {
    test(`inventory identity search, sort and reorder (${theme}${mobile ? ", mobile" : ", desktop"})`, async ({
      page,
      request,
    }) => {
      const { chatId, panel } = await openInventory(page, request, theme, mobile);
      const tiles = panel.locator(".grid.grid-cols-5 > button");
      await expect(tiles).toHaveCount(20);

      const search = panel.getByRole("searchbox", { name: "Search items" });
      await search.fill("twin token");
      await expect(panel.getByText("Twin token", { exact: true })).toHaveCount(2);
      await expect(tiles).toHaveCount(20); // empty slots remain; both duplicate-name rows are still present.
      await search.fill("no such item");
      await expect(panel.getByText("No items match your search.", { exact: true })).toBeVisible();

      await search.fill("");
      const sort = panel.getByRole("button", { name: "Sort by Order", exact: true });
      await sort.click();
      await expect(panel.getByRole("button", { name: "Sort by A-Z", exact: true })).toBeVisible();
      const firstLabels = await tiles.allTextContents();
      expect(firstLabels.filter(Boolean)[0]).toContain("Apple");
      await panel.getByRole("button", { name: "Sort by A-Z", exact: true }).click();
      await expect(panel.getByRole("button", { name: "Sort by Qty", exact: true })).toBeVisible();
      const quantityLabels = await tiles.allTextContents();
      expect(quantityLabels.filter(Boolean)[0]).toContain("Apple");

      await panel.getByRole("button", { name: "Sort by Qty", exact: true }).click();
      await expect(panel.getByRole("button", { name: "Sort by Order", exact: true })).toBeVisible();
      const source = await tiles.nth(0).boundingBox();
      const target = await tiles.nth(2).boundingBox();
      expect(source).not.toBeNull();
      expect(target).not.toBeNull();
      const reorderApiEvents: Array<Record<string, unknown>> = [];
      page.on("request", (requestEvent) => {
        if (requestEvent.url().includes(`/api/chats/${chatId}/metadata`)) {
          reorderApiEvents.push({
            phase: "request",
            method: requestEvent.method(),
            body: requestEvent.postData(),
          });
        }
      });
      page.on("response", (responseEvent) => {
        if (responseEvent.url().includes(`/api/chats/${chatId}/metadata`)) {
          reorderApiEvents.push({ phase: "response", status: responseEvent.status() });
        }
      });
      await page.mouse.move(source!.x + source!.width / 2, source!.y + source!.height / 2);
      await page.mouse.down();
      await page.mouse.move(source!.x + source!.width / 2 + 8, source!.y + source!.height / 2, { steps: 3 });
      await expect(tiles.nth(0)).toHaveAttribute("aria-pressed", "true");
      await page.mouse.move(target!.x + target!.width / 2, target!.y + target!.height / 2, { steps: 10 });
      let targetOver = false;
      try {
        await expect
          .poll(async () => (await tiles.nth(2).getAttribute("class"))?.includes("ring-2") === true)
          .toBe(true);
        targetOver = true;
      } catch {
        // Keep the release and persistence assertion so the failure receipt includes whether the
        // production reorder callback issued a durable metadata request.
      }
      const activeBeforeRelease = await tiles.nth(0).getAttribute("aria-pressed");
      await page.mouse.up();
      const readInventoryIds = async () => {
        const result = await request.get(`/api/chats/${chatId}`);
        const chat = await result.json();
        const metadata = typeof chat.metadata === "string" ? JSON.parse(chat.metadata) : chat.metadata;
        return metadata.gameInventory?.map((item: { id: string }) => item.id);
      };
      try {
        await expect
          .poll(readInventoryIds)
          .toEqual(["stack-axe", "stack-apple", "stack-zebra", "stack-twin-a", "stack-twin-b"]);
      } catch (error) {
        await test.info().attach("inventory-reorder-drag-diagnostic.json", {
          contentType: "application/json",
          body: JSON.stringify({
            activeStackId: "stack-zebra",
            overStackId: "stack-axe",
            activeBeforeRelease,
            targetOver,
            reorderApiEvents,
            persistedOrder: await readInventoryIds(),
          }),
        });
        throw error;
      }
    });
  }
}

test("inventory tracker locks only the selected duplicate-name row", async ({ page, request }) => {
  const created = await request.post("/api/chats", {
    data: { name: "Inventory tracker identity fixture", mode: "roleplay", characterIds: [] },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const chat = await created.json();
  try {
    const metadata = await request.patch(`/api/chats/${chat.id}/metadata`, {
      data: { enableAgents: true, activeAgentIds: ["inventory-tracker"] },
    });
    expect(metadata.ok(), await metadata.text()).toBeTruthy();
    const gameState = await request.patch(`/api/chats/${chat.id}/game-state`, {
      data: {
        manual: true,
        playerStats: {
          stats: [],
          attributes: null,
          skills: {},
          inventory: [],
          activeQuests: [],
          status: "",
          inventoryTrackerCurrencies: [],
          inventoryTrackerEquipped: [],
          inventoryTrackerInventory: [
            {
              itemId: "forged-same-name",
              name: "Twin token",
              qty: 2,
              description: "Copper token",
              location: "left pouch",
            },
            {
              itemId: "forged-same-name",
              name: "Twin token",
              qty: 3,
              description: "Silver token",
              location: "right pouch",
            },
          ],
        },
      },
    });
    expect(gameState.ok(), await gameState.text()).toBeTruthy();
    const persisted = await (await request.get(`/api/chats/${chat.id}/game-state`)).json();
    const rows = persisted.playerStats.inventoryTrackerInventory as Array<{
      itemId: string;
      name: string;
      description: string;
      location: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.itemId).toBeTruthy();
    expect(rows[1]?.itemId).toBeTruthy();
    expect(rows[0]?.itemId).not.toBe(rows[1]?.itemId);
    expect(rows.map(({ description, location }) => [description, location])).toEqual([
      ["Copper token", "left pouch"],
      ["Silver token", "right pouch"],
    ]);

    await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
    await seedUIState(page, {
      hasCompletedOnboarding: true,
      chatHelpSeenModes: ["conversation", "roleplay", "game"],
      sidebarOpen: false,
      rightPanelOpen: false,
      trackerPanelEnabled: true,
      trackerPanelOpen: true,
      trackerPanelOpenByChatId: { [chat.id]: true },
      theme: "dark",
      appAccentPulseMode: false,
    });
    await page.addInitScript(
      ({ id, appVersion }) => {
        localStorage.setItem("marinara-active-chat-id", id);
        localStorage.setItem("marinara:whats-new:seen-version", appVersion);
      },
      { id: chat.id, appVersion: version },
    );
    await page.goto("/");
    await page.getByRole("button", { name: "Open tracker settings", exact: true }).click();
    await page.getByRole("button", { name: "Enter tracker lock mode", exact: true }).click();
    const lockButtons = page.getByRole("button", { name: "Lock quantity for twin token", exact: true });
    await expect(lockButtons).toHaveCount(2);
    await lockButtons.nth(0).click();
    const unlockButtons = page.getByRole("button", { name: "Unlock quantity for twin token", exact: true });
    await expect(unlockButtons).toHaveCount(1);
    await expect(unlockButtons).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Lock quantity for twin token", exact: true })).toHaveCount(1);

    await expect
      .poll(async () => {
        const state = await (await request.get(`/api/chats/${chat.id}/game-state`)).json();
        const locks = state.fieldLocks as Record<string, boolean> | null;
        return rows.map(({ itemId }) =>
          Object.entries(locks ?? {}).some(([key, value]) => key.includes(itemId) && value),
        );
      })
      .toEqual([true, false]);
    await unlockButtons.click();
    await expect(page.getByRole("button", { name: "Unlock quantity for twin token", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Lock quantity for twin token", exact: true })).toHaveCount(2);
    await expect
      .poll(async () => {
        const state = await (await request.get(`/api/chats/${chat.id}/game-state`)).json();
        const locks = state.fieldLocks as Record<string, boolean> | null;
        return rows.every(
          ({ itemId }) => !Object.entries(locks ?? {}).some(([key, value]) => key.includes(itemId) && value),
        );
      })
      .toBe(true);
  } finally {
    await page.close();
    await request.delete(`/api/chats/${chat.id}?force=true`);
  }
});
