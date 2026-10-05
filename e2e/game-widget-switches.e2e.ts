import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

test("Game widgets and player status are independent opt-ins with retained data", async ({ page, request }, info) => {
  test.setTimeout(120_000);
  const base = new URL(String(info.project.use.baseURL));
  const mobile = info.project.name.includes("mobile");
  expect(base.hostname).toBe("127.0.0.1");
  expect(base.port).toBe(mobile ? "5179" : "5178");
  const previous = await request.get("/api/app-settings/features");
  expect(previous.ok()).toBeTruthy();
  const previousFeatures = (await previous.json()).settings;
  const setFeatures = async (value: Record<string, boolean>) => {
    expect((await request.put("/api/app-settings/features", { data: value })).ok()).toBeTruthy();
  };
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
  const created = await request.post("/api/chats", {
    data: { name: "Widget opt-in fixture", mode: "game", characterIds: [] },
  });
  expect(created.ok()).toBeTruthy();
  const chat = await created.json();
  const widgets = [
    { id: "supplies", type: "counter", label: "Supplies", position: "hud_left", config: { count: 3 } },
    { id: "story-notes", type: "note", label: "Story notes", position: "hud_right", config: { text: "Retained note" } },
  ];
  const metadata = async () => {
    const response = await request.get(`/api/chats/${chat.id}`);
    expect(response.ok()).toBeTruthy();
    const current = await response.json();
    return typeof current.metadata === "string" ? JSON.parse(current.metadata) : current.metadata;
  };
  const reload = async () => {
    await page.goto("/");
    await expect(page.locator('[data-component="GameNarration.ActivePanel"]')).toContainText("A quiet room.");
  };
  const note = () =>
    mobile
      ? page.getByTitle("Story notes", { exact: true })
      : page.getByText("Story notes", { exact: true }).filter({ visible: true });
  try {
    await setFeatures({ extendedHudWidgets: true });
    expect(
      (
        await request.patch(`/api/chats/${chat.id}/metadata`, {
          data: {
            gameId: chat.id,
            gameSessionStatus: "active",
            gameIntroPresented: true,
            gameImageAutoGenerationEnabled: false,
            gameBackgroundAutoGenerationEnabled: false,
            enableAgents: false,
            gameExtendedWidgetsEnabled: true,
            gameWidgetState: widgets,
          },
        })
      ).ok(),
    ).toBeTruthy();
    expect(
      (
        await request.post(`/api/chats/${chat.id}/messages`, { data: { role: "assistant", content: "A quiet room." } })
      ).ok(),
    ).toBeTruthy();
    expect(
      (
        await request.patch(`/api/chats/${chat.id}/game-state`, {
          data: { manual: true, playerStats: { attributes: { Strength: 17 } } },
        })
      ).ok(),
    ).toBeTruthy();
    await setFeatures({});
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
    await expect(note()).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Game status", exact: true })).toHaveCount(0);
    const changed = structuredClone(widgets);
    changed[1]!.config.text = "Blocked";
    expect((await request.put(`/api/game/${chat.id}/widgets`, { data: { widgets: changed } })).status()).toBe(409);
    expect((await metadata()).gameWidgetState).toEqual(widgets);
    await setFeatures({ extendedHudWidgets: true });
    await reload();
    await expect(note()).toBeVisible();
    await expect(page.getByRole("region", { name: "Game status", exact: true })).toHaveCount(0);
    if (mobile) await note().click();
    await page.getByTitle("Edit Story notes", { exact: true }).filter({ visible: true }).click();
    const editor = page.getByRole("dialog", { name: "Edit Story notes", exact: true });
    await editor.locator("textarea").fill("Edited retained note");
    await editor.getByRole("button", { name: "Save Changes", exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect.poll(async () => (await metadata()).gameWidgetState[1].config.text).toBe("Edited retained note");
    await setFeatures({ playerStatus: true });
    await reload();
    await expect(note()).toHaveCount(0);
    if (mobile) await page.getByRole("button", { name: "Game status", exact: true }).click();
    await expect(
      page.getByRole("region", { name: "Game status", exact: true }).filter({ visible: true }),
    ).toContainText("17");
    await setFeatures({});
    await reload();
    await expect(note()).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Game status", exact: true })).toHaveCount(0);
    await setFeatures({ extendedHudWidgets: true });
    await reload();
    await expect(note()).toBeVisible();
    expect((await metadata()).gameWidgetState[1].config.text).toBe("Edited retained note");
    expect(external).toEqual([]);
  } finally {
    const cleanup = await Promise.allSettled([
      request.put("/api/app-settings/features", { data: previousFeatures }),
      request.delete(`/api/chats/${chat.id}?force=true`),
    ]);
    for (const result of cleanup) {
      expect(result.status).toBe("fulfilled");
      if (result.status === "fulfilled") expect.soft(result.value.ok(), await result.value.text()).toBeTruthy();
    }
  }
});

test("New game creation retains requested widgets and OFF preserves an existing larger set", async ({
  request,
}, info) => {
  expect(new URL(String(info.project.use.baseURL)).hostname).toBe("127.0.0.1");
  const previous = (await (await request.get("/api/app-settings/features")).json()).settings;
  let chatId: string | undefined;
  try {
    expect((await request.put("/api/app-settings/features", { data: { extendedHudWidgets: true } })).ok()).toBeTruthy();
    const widgets = [
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `count-${index}`,
        type: "counter",
        label: `Count ${index}`,
        position: "hud_left",
        config: { count: index },
      })),
      { id: "note", type: "note", label: "Note", position: "hud_right", config: { text: "Keep initial note" } },
    ];
    const created = await request.post("/api/game/create", {
      data: {
        name: "Widget initial-state regression",
        setupConfig: {
          genre: "Fantasy",
          setting: "A quiet room",
          tone: "Adventure",
          difficulty: "normal",
          gmMode: "standalone",
          partyCharacterIds: [],
          enableAgents: false,
          customHudWidgets: widgets,
        },
      },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    const body = await created.json();
    chatId = body.sessionChat.id;
    const state =
      typeof body.sessionChat.metadata === "string" ? JSON.parse(body.sessionChat.metadata) : body.sessionChat.metadata;
    expect(state.gameWidgetState.map((widget: { id: string }) => widget.id)).toEqual(
      widgets.map((widget) => widget.id),
    );
    expect(state.gameWidgetInitialState).toEqual(state.gameWidgetState);
    expect(state.gameWidgetState[5].config.text).toBe("Keep initial note");
    expect((await request.put("/api/app-settings/features", { data: {} })).ok()).toBeTruthy();
    const edited = structuredClone(state.gameWidgetState);
    edited[0].config.count = 77;
    const saved = await request.put(`/api/game/${chatId}/widgets`, { data: { widgets: edited } });
    expect(saved.ok(), await saved.text()).toBeTruthy();
    const changed = await (await request.get(`/api/chats/${chatId}`)).json();
    const after = typeof changed.metadata === "string" ? JSON.parse(changed.metadata) : changed.metadata;
    expect(after.gameWidgetState).toEqual(edited);
    expect(after.gameWidgetInitialState).toEqual(state.gameWidgetInitialState);
    expect(
      (
        await request.put(`/api/game/${chatId}/widgets`, {
          data: { widgets: [...edited, { ...widgets[0], id: "extra" }] },
        })
      ).status(),
    ).toBe(409);
  } finally {
    const cleanup = await Promise.allSettled([
      request.put("/api/app-settings/features", { data: previous }),
      ...(chatId ? [request.delete(`/api/chats/${chatId}?force=true`)] : []),
    ]);
    for (const result of cleanup) {
      expect.soft(result.status).toBe("fulfilled");
      if (result.status === "fulfilled") expect.soft(result.value.ok(), await result.value.text()).toBeTruthy();
    }
  }
});
