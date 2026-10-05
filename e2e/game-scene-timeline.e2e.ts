import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

test("Game session panel renders a synthetic ordered scene timeline and current presence", async ({
  page,
  request,
}, info) => {
  let sceneEnabled = false;
  let timelineReads = 0;
  await page.route("**/api/app-settings/features", (route) =>
    route.fulfill({
      json: { settings: { sceneTimeline: sceneEnabled }, effective: { sceneTimeline: sceneEnabled }, envLocked: {} },
    }),
  );
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return ["127.0.0.1", "localhost"].includes(url.hostname) || ["data:", "blob:"].includes(url.protocol)
      ? route.fallback()
      : route.abort();
  });
  const connection = await (
    await request.post("/api/connections", {
      data: { name: "Scene UI fixture", provider: "openai", model: "fixture", apiKey: "synthetic" },
    })
  ).json();
  const characters: Array<{ id: string }> = [];
  for (const name of ["Mara", "Lyra"]) {
    characters.push(await (await request.post("/api/characters", { data: { data: { name } } })).json());
  }
  const chat = await (
    await request.post("/api/chats", {
      data: {
        name: "Scene timeline UI fixture",
        mode: "game",
        characterIds: characters.map((character) => character.id),
        connectionId: connection.id,
      },
    })
  ).json();

  try {
    await request.patch(`/api/chats/${chat.id}/metadata`, {
      data: {
        enableAgents: false,
        enableTools: false,
        gameId: chat.id,
        gameIntroPresented: true,
        gameSessionStatus: "active",
      },
    });
    await request.post(`/api/chats/${chat.id}/messages`, {
      data: { role: "assistant", content: "Mara and Lyra enter the archive." },
    });

    await page.route(`**/api/game/${chat.id}/scene-timeline`, (route) => {
      timelineReads++;
      return route.fulfill({
        json: {
          scenes: [
            {
              id: "old-harbor:0",
              location: "Old Harbor",
              participants: ["Mara", "Lyra"],
              present: [],
              summary: "Mara and Lyra secured the crossing.",
              closed: true,
              reviewed: true,
              messageIds: ["fixture-old-turn"],
            },
            {
              id: "archive:0",
              location: "Archive",
              participants: ["Mara", "Lyra"],
              present: ["Mara", "Lyra"],
              summary: "",
              closed: false,
              reviewed: true,
              messageIds: ["fixture-current-turn"],
            },
          ],
          pending: false,
          error: null,
          remaining: 0,
          reviewableSceneCount: 0,
          needsReview: false,
        },
      });
    });
    await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
    await seedUIState(page, {
      hasCompletedOnboarding: true,
      chatHelpSeenModes: ["game"],
      sidebarOpen: false,
      rightPanelOpen: false,
      theme: "dark",
    });
    await page.addInitScript(
      ({ id, version }) => {
        localStorage.setItem("marinara-active-chat-id", id);
        localStorage.setItem("marinara:whats-new:seen-version", version);
      },
      { id: chat.id, version },
    );

    const openSession = async () => {
      await page.goto("/");
      if (info.project.name.includes("mobile")) {
        await page.getByRole("button", { name: "Game actions", exact: true }).click();
      }
      await page.getByRole("button", { name: "Session", exact: true }).click();
    };
    await openSession();
    await expect(page.getByRole("button", { name: "Scenes", exact: true })).toHaveCount(0);
    expect(timelineReads).toBe(0);
    sceneEnabled = true;
    await request.patch(`/api/chats/${chat.id}/metadata`, { data: { gameSceneTimelineEnabled: false } });
    await openSession();
    await expect(page.getByRole("button", { name: "Scenes", exact: true })).toHaveCount(0);
    expect(timelineReads).toBe(0);
    await request.patch(`/api/chats/${chat.id}/metadata`, { data: { gameSceneTimelineEnabled: true } });
    await openSession();
    await page.getByRole("button", { name: "Scenes", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Scene timeline", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Old Harbor/ })).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Scene timeline" }).getByText("Mara and Lyra secured the crossing.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: /Archive/ })).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Scene timeline" }).getByText("Currently present: Mara, Lyra", {
        exact: true,
      }),
    ).toBeVisible();
    await page.screenshot({ path: info.outputPath("game-scene-timeline-dark.png") });
    sceneEnabled = false;
    const beforeOff = timelineReads;
    await openSession();
    await expect(page.getByRole("button", { name: "Scenes", exact: true })).toHaveCount(0);
    expect(timelineReads).toBe(beforeOff);
    sceneEnabled = true;
    await openSession();
    await page.getByRole("button", { name: "Scenes", exact: true }).click();
    await expect(page.getByRole("heading", { name: /Old Harbor/ })).toBeVisible();
  } finally {
    const cleanup = await Promise.allSettled([
      request.delete(`/api/chats/${chat.id}?force=true`),
      ...characters.map((character) => request.delete(`/api/characters/${character.id}`)),
      request.delete(`/api/connections/${connection.id}`),
    ]);
    for (const result of cleanup) {
      expect.soft(result.status).toBe("fulfilled");
      if (result.status === "fulfilled") expect.soft(result.value.ok(), await result.value.text()).toBe(true);
    }
  }
});
