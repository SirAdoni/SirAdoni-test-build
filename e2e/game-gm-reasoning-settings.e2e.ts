import { expect, request as playwrightRequest, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

for (const theme of ["dark", "light"] as const) {
  test(`Game narration effort persists and explains provider limits (${theme})`, async ({ page }, info) => {
    // This multi-chat persistence journey repeatedly reloads the uncached development module graph.
    test.setTimeout(120_000);
    const baseURL = info.project.use.baseURL;
    if (baseURL !== "http://127.0.0.1:5178" && baseURL !== "http://127.0.0.1:5179") {
      throw new Error("GM reasoning fixture requires isolated loopback test servers");
    }
    const request = await playwrightRequest.newContext({ baseURL, timeout: 10_000 });
    const chatIds: string[] = [];
    const connectionIds: string[] = [];
    let originalFeatures: Record<string, boolean> | undefined;
    try {
      const features = await request.get("/api/app-settings/features");
      expect(features.ok()).toBeTruthy();
      originalFeatures = (await features.json()).settings ?? {};
      const otherFeatures = { ...originalFeatures };
      delete otherFeatures.gmNarrationReasoning;
      const setFeatures = async (settings: Record<string, boolean>) => {
        expect((await request.put("/api/app-settings/features", { data: settings })).ok()).toBeTruthy();
      };
      await setFeatures({ ...otherFeatures, gmNarrationReasoning: true });
      const createConnection = async (name: string, provider: string, model: string) => {
        const response = await request.post("/api/connections", {
          data: {
            name,
            provider,
            model,
            baseUrl: "http://127.0.0.1:9/api/v1",
            apiKey: "synthetic-gm-settings-fixture-key",
          },
        });
        expect(response.ok()).toBeTruthy();
        const connection = await response.json();
        connectionIds.push(connection.id);
        return connection;
      };
      const claude = await createConnection("GM reasoning offline fixture", "anthropic", "claude-opus-5-5");
      const unsupported = await createConnection("GM unsupported offline fixture", "openai", "gpt-4o");
      const createChat = async (
        name: string,
        mode: "game" | "roleplay",
        connectionId?: string,
        gameGmReasoningEffort?: string,
      ) => {
        const response = await request.post("/api/chats", {
          data: { name, mode, characterIds: [], ...(connectionId ? { connectionId } : {}) },
        });
        expect(response.ok()).toBeTruthy();
        const chat = await response.json();
        chatIds.push(chat.id);
        const metadata = await request.patch(`/api/chats/${chat.id}/metadata`, {
          data: {
            conversationSetupComplete: true,
            enableAgents: false,
            enableTools: false,
            ...(mode === "game" ? { gameId: chat.id, gameSessionStatus: "active", gameIntroPresented: true } : {}),
            ...(gameGmReasoningEffort ? { gameGmReasoningEffort } : {}),
          },
        });
        expect(metadata.ok()).toBeTruthy();
        const message = await request.post(`/api/chats/${chat.id}/messages`, {
          data: { role: "assistant", content: "The harbor is quiet." },
        });
        expect(message.ok()).toBeTruthy();
        return chat;
      };
      const game = await createChat("GM effort saved fixture", "game", claude.id, "high");
      const noConnection = await createChat("GM effort no connection fixture", "game", undefined, "medium");
      const noControl = await createChat("GM effort unsupported fixture", "game", unsupported.id, "high");
      const alwaysThinks = await createChat("GM effort always thinks fixture", "game", claude.id, "none");
      const roleplay = await createChat("GM effort roleplay isolation fixture", "roleplay", claude.id);

      for (const connection of [claude, unsupported]) {
        await page.route(`**/api/connections/${connection.id}/models`, (route) =>
          route.fulfill({
            json: {
              models: [
                {
                  id: connection.model,
                  name: connection.model,
                  capabilities: { supportedParameters: ["reasoningEffort"] },
                },
              ],
            },
          }),
        );
      }
      await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
      await page.route("**/*", (route) => {
        const url = new URL(route.request().url());
        return url.origin === baseURL ? route.fallback() : route.abort();
      });
      await seedUIState(page, {
        hasCompletedOnboarding: true,
        rightPanelOpen: false,
        sidebarOpen: false,
        chatHelpSeenModes: ["conversation", "roleplay", "game"],
        theme,
      });
      await page.addInitScript(
        ({ appVersion }) => {
          localStorage.setItem("marinara:whats-new:seen-version", appVersion);
        },
        { appVersion: version },
      );
      await page.goto("/");

      const openSettings = async (chatId: string, enabled = true) => {
        await page.evaluate((id) => localStorage.setItem("marinara-active-chat-id", id), chatId);
        await page.reload();
        if (info.project.name.includes("mobile"))
          await page
            .getByRole("button", { name: chatId === roleplay.id ? "More options" : "Game actions", exact: true })
            .click();
        await page.getByRole("button", { name: "Chat Settings", exact: true }).filter({ visible: true }).click();
        const section = page.locator(
          '.mari-chat-settings-drawer [data-chat-settings-section="game-gm-reasoning-effort"]',
        );
        if (chatId !== roleplay.id && enabled) {
          await expect(section).toBeVisible();
          const header = section.locator(':scope > [role="button"]');
          if ((await header.getAttribute("aria-expanded")) === "false") await header.click();
        }
        return section;
      };
      const effortSelect = (section: ReturnType<typeof page.locator>) =>
        section.locator('[data-gm-reasoning-effort-select="true"]');

      const saveEffort = async (select: ReturnType<typeof page.locator>, value: string) => {
        await Promise.all([
          page.waitForResponse(
            (response) =>
              response.url().endsWith(`/api/chats/${game.id}/metadata`) &&
              response.request().method() === "PATCH" &&
              response.ok(),
          ),
          select.selectOption(value),
        ]);
      };
      await setFeatures(otherFeatures);
      await expect(await openSettings(game.id, false)).toHaveCount(0);
      expect(
        (
          await request.patch(`/api/chats/${game.id}/metadata`, {
            data: { gameGmReasoningEffort: "low" },
          })
        ).status(),
      ).toBe(403);
      await setFeatures({ ...otherFeatures, gmNarrationReasoning: true });
      let section = await openSettings(game.id);
      let select = effortSelect(section);
      await expect(select).toHaveValue("high");
      await saveEffort(select, "low");
      await expect(select).toHaveValue("low");
      await setFeatures({ ...otherFeatures, gmNarrationReasoning: false });
      await expect(await openSettings(game.id, false)).toHaveCount(0);
      expect(
        (
          await request.patch(`/api/chats/${game.id}/metadata`, {
            data: { gameGmReasoningEffort: "default" },
          })
        ).status(),
      ).toBe(403);
      await setFeatures({ ...otherFeatures, gmNarrationReasoning: true });
      section = await openSettings(game.id);
      select = effortSelect(section);
      await expect(select).toHaveValue("low");
      await saveEffort(select, "default");
      section = await openSettings(game.id);
      await expect(effortSelect(section)).toHaveValue("default");

      section = await openSettings(noConnection.id);
      await expect(effortSelect(section)).toHaveValue("medium");
      await expect(section.getByText(/expose no reasoning-effort control here/i)).toHaveCount(0);

      section = await openSettings(noControl.id);
      await expect(effortSelect(section)).toHaveValue("high");
      await expect(section.getByText(/expose no reasoning-effort control here/i)).toBeVisible();

      section = await openSettings(alwaysThinks.id);
      await expect(effortSelect(section)).toHaveValue("none");
      await expect(section.getByText(/will use Low reasoning instead/i)).toBeVisible();

      const screenshotPath = info.outputPath("gm-reasoning-settings.png");
      await page.screenshot({ path: screenshotPath, animations: "disabled" });
      await info.attach("game-gm-reasoning-settings", {
        path: screenshotPath,
        contentType: "image/png",
      });

      section = await openSettings(roleplay.id);
      await expect(section).toHaveCount(0);
      await expect(
        page.locator('.mari-chat-settings-drawer [data-chat-settings-section="game-gm-reasoning-effort"]'),
      ).toHaveCount(0);
    } finally {
      const failures: unknown[] = [];
      const attempt = async (cleanup: () => Promise<void>) => {
        try {
          await cleanup();
        } catch (error) {
          failures.push(error);
        }
      };
      for (const id of chatIds)
        await attempt(async () => {
          expect((await request.delete(`/api/chats/${id}?force=true`)).ok()).toBeTruthy();
          expect((await request.get(`/api/chats/${id}`)).status()).toBe(404);
        });
      for (const id of connectionIds)
        await attempt(async () => {
          expect((await request.delete(`/api/connections/${id}`)).ok()).toBeTruthy();
        });
      if (originalFeatures)
        await attempt(async () => {
          expect((await request.put("/api/app-settings/features", { data: originalFeatures })).ok()).toBeTruthy();
        });
      await attempt(() => request.dispose());
      if (failures.length) throw new AggregateError(failures, "GM reasoning fixture cleanup failed");
    }
  });
}
