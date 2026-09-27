import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";
const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

// Real shell, route registration and empty-state APIs; no generation or private campaign data.
test("Personal feature launchers coexist with turn review in the Game shell", async ({ page, request }, testInfo) => {
  const response = await request.post("/api/chats", {
    data: { name: "Synthetic integration", mode: "game", characterIds: [] },
  });
  expect(response.ok()).toBeTruthy();
  const chat = await response.json();
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
            gameBackgroundAutoGenerationEnabled: false,
          },
        })
      ).ok(),
    ).toBeTruthy();
    expect(
      (
        await request.post(`/api/chats/${chat.id}/messages`, {
          data: { role: "assistant", content: "[Narration]: The archive is quiet." },
        })
      ).ok(),
    ).toBeTruthy();
    await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
    await page.route("**/api/agents", (route) => route.fulfill({ json: [] }));
    let generationRequests = 0;
    await page.route("**/api/generate", (route) => {
      generationRequests++;
      return route.abort();
    });
    await seedUIState(page, {
      hasCompletedOnboarding: true,
      sidebarOpen: false,
      rightPanelOpen: false,
      chatHelpSeenModes: ["game"],
      gameInstantTextReveal: true,
    });
    await page.addInitScript(
      ({ id, version }) => {
        localStorage.setItem("marinara-active-chat-id", id);
        localStorage.setItem("marinara:whats-new:seen-version", version);
      },
      { id: chat.id, version },
    );
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/");
    await expect(page.getByRole("button", { name: "What changed this turn?", exact: true })).toBeVisible();
    const openTools = async () => {
      if (testInfo.project.name.includes("mobile"))
        await page.getByRole("button", { name: "Game actions", exact: true }).click();
      await page.getByRole("button", { name: "Session", exact: true }).filter({ visible: true }).click();
      await page.getByRole("button", { name: "Tools", exact: true }).filter({ visible: true }).click();
    };
    await openTools();
    await page.getByRole("button", { name: "Open family tree", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Family tree", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("family-tree-shell.png") });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Family tree", exact: true })).toBeHidden();
    if (!(await page.getByRole("button", { name: "Open world history", exact: true }).isVisible())) await openTools();
    await page.getByRole("button", { name: "Open world history", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "World history", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("world-history-shell.png") });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "World history", exact: true })).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(generationRequests).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await request.delete(`/api/chats/${chat.id}`).catch(() => undefined);
  }
});
