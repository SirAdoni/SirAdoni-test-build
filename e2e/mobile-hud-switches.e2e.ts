import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

test("HUD choices are independent opt-ins and survive disable and re-enable", async ({ page, request }, info) => {
  test.setTimeout(120_000);
  const mobile = info.project.name.includes("mobile");
  const base = new URL(String(info.project.use.baseURL));
  expect(base.hostname).toBe("127.0.0.1");
  expect(base.port).toBe(mobile ? "5179" : "5178");
  const previousResponse = await request.get("/api/app-settings/features");
  expect(previousResponse.ok()).toBeTruthy();
  const previous = (await previousResponse.json()).settings;
  const created = await request.post("/api/chats", {
    data: { name: "Mobile HUD opt-in fixture", mode: "game", characterIds: [] },
  });
  expect(created.ok()).toBeTruthy();
  const chat = await created.json();
  const gameId = `hud-game-${chat.id}`;
  const arrangementKey = `marinara-game-panel-mobile:${gameId}:arrangement`;
  const partyKey = `marinara-game-hud:${gameId}:party-bar:hidden`;
  const presenceKey = `marinara-game-hud:${gameId}:scene-presence:hidden`;
  const storedArrangement = JSON.stringify({ order: ["rations", "supplies"], hidden: ["rations"], expanded: [] });
  const external: string[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== base.origin) {
      external.push(url.origin);
      return route.abort();
    }
    if (url.pathname === "/api/connections/refresh-local-context") return route.abort();
    return route.continue();
  });
  const setFeatures = async (value: Record<string, boolean>) => {
    const result = await request.put("/api/app-settings/features", { data: value });
    expect(result.ok(), await result.text()).toBeTruthy();
  };
  const reload = async () => {
    await page.goto("/");
    await expect(page.locator('[data-component="GameNarration.ActivePanel"]')).toContainText("A quiet room.");
  };
  const arrange = () => page.locator("[data-mobile-arrange-button]").filter({ visible: true });
  const toggles = () => page.locator("[data-game-hud-list-toggle]").filter({ visible: true });
  const listControl = (name: string) =>
    (mobile ? page.locator("[data-chat-toolbar-overflow-menu]") : page)
      .getByRole("button", { name, exact: true })
      .filter({ visible: true });
  const storage = async () =>
    page.evaluate((keys) => keys.map((key) => localStorage.getItem(key)), [arrangementKey, partyKey, presenceKey]);
  try {
    await setFeatures({});
    const metadata = await request.patch(`/api/chats/${chat.id}/metadata`, {
      data: {
        gameId,
        gameSessionStatus: "active",
        gameIntroPresented: true,
        gameImageAutoGenerationEnabled: false,
        gameBackgroundAutoGenerationEnabled: false,
        enableAgents: false,
        gamePartyCharacterIds: ["fixture-companion"],
        gameNpcs: [
          {
            id: "fixture-companion",
            name: "Fixture companion",
            emoji: "F",
            description: "A test companion",
            disposition: "neutral",
            reputation: 0,
            notes: [],
          },
        ],
        gameWidgetState: [
          { id: "supplies", type: "counter", label: "Supplies", position: "hud_left", config: { count: 3 } },
          { id: "rations", type: "counter", label: "Rations", position: "hud_left", config: { count: 4 } },
        ],
      },
    });
    expect(metadata.ok(), await metadata.text()).toBeTruthy();
    expect(
      (
        await request.post(`/api/chats/${chat.id}/messages`, { data: { role: "assistant", content: "A quiet room." } })
      ).ok(),
    ).toBeTruthy();
    expect(
      (
        await request.patch(`/api/chats/${chat.id}/game-state`, {
          data: { manual: true, presentCharacters: [{ characterId: "fixture-companion", name: "Fixture companion" }] },
        })
      ).ok(),
    ).toBeTruthy();
    await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
    await seedUIState(page, {
      hasCompletedOnboarding: true,
      sidebarOpen: false,
      rightPanelOpen: false,
      chatHelpSeenModes: ["game"],
      theme: "dark",
    });
    await page.addInitScript(
      ({ id, currentVersion }) => {
        localStorage.setItem("marinara-active-chat-id", id);
        localStorage.setItem("marinara:whats-new:seen-version", currentVersion);
      },
      { id: chat.id, currentVersion: version },
    );
    await reload();
    await page.evaluate(
      ({ arrangementKey, partyKey, presenceKey, storedArrangement }) => {
        localStorage.setItem(arrangementKey, storedArrangement);
        localStorage.setItem(partyKey, "1");
        localStorage.setItem(presenceKey, "1");
      },
      { arrangementKey, partyKey, presenceKey, storedArrangement },
    );
    await reload();
    await expect(arrange()).toHaveCount(0);
    await expect(toggles()).toHaveCount(0);
    await expect(page.locator('[data-tour="game-party"]')).toBeVisible();
    if (mobile) await expect(page.getByTitle("Rations", { exact: true })).toBeVisible();
    expect(await storage()).toEqual([storedArrangement, "1", "1"]);

    await setFeatures({ mobileHudArrangement: true });
    await reload();
    await expect(toggles()).toHaveCount(0);
    if (mobile) {
      await expect(arrange()).toHaveCount(1);
      await expect(page.getByTitle("Rations", { exact: true })).toHaveCount(0);
      await arrange().click();
      await page.getByRole("button", { name: "Show Rations", exact: true }).click();
      await expect.poll(async () => JSON.parse((await storage())[0]!).hidden).not.toContain("rations");
      await page.getByRole("button", { name: "Move Rations down", exact: true }).click();
      await expect.poll(async () => JSON.parse((await storage())[0]!).order[0]).toBe("supplies");
      await page.getByRole("button", { name: "Expand Rations", exact: true }).click();
      await expect.poll(async () => JSON.parse((await storage())[0]!).expanded).toContain("rations");
    } else {
      await expect(arrange()).toHaveCount(0);
      expect((await storage())[0]).toBe(storedArrangement);
    }
    const retainedArrangement = (await storage())[0];
    await setFeatures({ hudListVisibility: true });
    await reload();
    await expect(arrange()).toHaveCount(0);
    if (mobile) await page.getByRole("button", { name: "Game actions", exact: true }).click();
    const partyToggle = listControl("Show party bar");
    await expect(partyToggle).toHaveCount(1);
    await expect(page.locator('[data-tour="game-party"]')).toHaveCount(0);
    await partyToggle.click();
    await expect(listControl("Hide party bar")).toHaveCount(1);
    await expect(page.locator('[data-tour="game-party"]')).toBeVisible();
    await listControl("Hide party bar").click();
    await expect(page.locator('[data-tour="game-party"]')).toHaveCount(0);
    expect((await storage())[2]).toBe("1");
    await listControl("Show Currently present").click();
    await expect(listControl("Hide Currently present")).toHaveCount(1);
    await expect.poll(async () => (await storage())[2]).toBeNull();
    if (mobile) {
      await expect(page.locator("[data-mobile-scene-presence]")).toBeVisible();
    } else {
      await expect(page.locator("[data-game-scene-presence]")).toContainText("Fixture companion");
      await expect(page.locator("[data-game-scene-presence]")).toBeVisible();
    }
    await listControl("Hide Currently present").click();
    await expect.poll(async () => (await storage())[2]).toBe("1");
    await expect(page.locator("[data-game-scene-presence], [data-mobile-scene-presence]")).toHaveCount(0);
    const retained = await storage();
    expect(retained[0]).toBe(retainedArrangement);
    await setFeatures({});
    await reload();
    await expect(arrange()).toHaveCount(0);
    await expect(toggles()).toHaveCount(0);
    expect(await storage()).toEqual(retained);
    await expect(page.locator('[data-tour="game-party"]')).toBeVisible();
    if (mobile) await expect(page.getByTitle("Rations", { exact: true })).toBeVisible();
    await setFeatures({ mobileHudArrangement: true, hudListVisibility: true });
    await reload();
    if (mobile) await page.getByRole("button", { name: "Game actions", exact: true }).click();
    await expect(listControl("Show party bar")).toHaveCount(1);
    await expect(page.locator('[data-tour="game-party"]')).toHaveCount(0);
    expect(await storage()).toEqual(retained);
    if (mobile) {
      await expect(arrange()).toHaveCount(1);
      await expect(page.getByTitle("Rations", { exact: true })).toHaveCount(0);
    }
    let failedReads = 0;
    await page.route("**/api/app-settings/features", (route) => {
      failedReads++;
      return route.fulfill({ status: 500, json: { error: "Synthetic unavailable feature settings" } });
    });
    await reload();
    await expect.poll(() => failedReads).toBeGreaterThan(0);
    await expect(arrange()).toHaveCount(0);
    await expect(toggles()).toHaveCount(0);
    expect(await storage()).toEqual(retained);
    expect(external).toEqual([]);
  } finally {
    const cleanup = await Promise.allSettled([
      request.put("/api/app-settings/features", { data: previous }),
      request.delete(`/api/chats/${chat.id}?force=true`),
    ]);
    for (const result of cleanup) {
      expect.soft(result.status).toBe("fulfilled");
      if (result.status === "fulfilled") expect.soft(result.value.ok(), await result.value.text()).toBeTruthy();
    }
  }
});
