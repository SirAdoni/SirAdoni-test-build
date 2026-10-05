import { expect, test } from "@playwright/test";
import type { Response } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

for (const theme of ["light", "dark"] as const) {
  test(`Game Dice log displays actual chat history and a player tray roll (${theme})`, async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(120_000);
    const base = new URL(String(testInfo.project.use.baseURL));
    expect(base.hostname).toBe("127.0.0.1");
    expect(base.port).toBe(testInfo.project.name.includes("mobile") ? "5179" : "5178");
    const priorResponse = await request.get("/api/app-settings/features");
    expect(priorResponse.ok()).toBeTruthy();
    const priorFeatures = await priorResponse.json();
    const setFeatures = async (settings: Record<string, boolean>) => {
      const response = await request.put("/api/app-settings/features", { data: settings });
      expect(response.ok()).toBeTruthy();
    };
    const externalRequests: string[] = [];
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== base.origin) {
        externalRequests.push(url.origin);
        await route.abort();
      } else if (url.pathname === "/api/connections/refresh-local-context") {
        await route.abort();
      } else await route.continue();
    });
    const chatResponse = await request.post("/api/chats", {
      data: { name: "Dice history UI fixture", mode: "game", characterIds: [] },
    });
    expect(chatResponse.ok()).toBeTruthy();
    const chat = await chatResponse.json();
    try {
      await setFeatures({});
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
            },
          })
        ).ok(),
      ).toBeTruthy();
      expect(
        (
          await request.post(`/api/chats/${chat.id}/messages`, {
            data: { role: "assistant", content: "A quiet room waits for a roll." },
          })
        ).ok(),
      ).toBeTruthy();

      await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
      await seedUIState(page, {
        hasCompletedOnboarding: true,
        sidebarOpen: false,
        rightPanelOpen: false,
        chatHelpSeenModes: ["game"],
        theme,
      });
      await page.addInitScript(
        ({ id, currentVersion }) => {
          localStorage.setItem("marinara-active-chat-id", id);
          localStorage.setItem("marinara:whats-new:seen-version", currentVersion);
        },
        { id: chat.id, currentVersion: version },
      );
      await page.goto("/");
      const narration = page.locator('[data-component="GameNarration.ActivePanel"]');
      await expect(narration).toContainText("A quiet room waits for a roll.");
      const openSession = async () => {
        if (testInfo.project.name.includes("mobile")) {
          await page.getByRole("button", { name: "Game actions", exact: true }).click();
        }
        await page.getByRole("button", { name: "Session", exact: true }).filter({ visible: true }).click();
      };
      await openSession();
      await expect(page.getByRole("button", { name: "Tools", exact: true })).toHaveCount(0);
      expect((await request.get(`/api/game-tools/dice-log?chatId=${chat.id}`)).status()).toBe(403);
      await setFeatures({ diceLog: true });
      await page.reload();
      await expect(narration).toContainText("A quiet room waits for a roll.");
      const waitForHistoryRead = (scope: "session" | "game") =>
        page.waitForResponse((response) => {
          const url = new URL(response.url());
          return (
            url.pathname === "/api/game-tools/dice-log" &&
            url.searchParams.get("chatId") === chat.id &&
            url.searchParams.get("scope") === scope &&
            response.request().method() === "GET"
          );
        });

      let sessionStubHits = 0;
      let gameStubHits = 0;
      let forceGameFailures = false;
      await page.route(new RegExp("/api/game-tools/dice-log\\?"), async (route) => {
        const url = new URL(route.request().url());
        const scope = url.searchParams.get("scope");
        if (url.searchParams.get("chatId") === chat.id && scope === "session" && sessionStubHits === 0) {
          sessionStubHits += 1;
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "fixture" }),
          });
          return;
        }
        if (url.searchParams.get("chatId") === chat.id && scope === "game" && forceGameFailures && gameStubHits < 2) {
          gameStubHits += 1;
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "fixture" }),
          });
          return;
        }
        await route.continue();
      });

      if (testInfo.project.name.includes("mobile")) {
        await page.getByRole("button", { name: "Game actions", exact: true }).click();
      }
      const openDiceLog = async () => {
        await page.getByRole("button", { name: "Session", exact: true }).filter({ visible: true }).click();
        await page.getByRole("button", { name: "Tools", exact: true }).click();
        const region = page.getByRole("region", { name: "Dice log" });
        await expect(region).toBeVisible();
        return region;
      };
      const emptyRead = waitForHistoryRead("session");
      const emptyRecoveryRead = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname === "/api/game-tools/dice-log" &&
          url.searchParams.get("chatId") === chat.id &&
          url.searchParams.get("scope") === "session" &&
          response.request().method() === "GET" &&
          response.status() === 200
        );
      });
      let diceLog = await openDiceLog();
      expect((await emptyRead).status()).toBe(503);
      expect((await emptyRecoveryRead).ok()).toBeTruthy();
      expect(sessionStubHits).toBe(1);
      await expect(diceLog).toContainText("No rolls yet.");
      const emptyHistory = await emptyRecoveryRead.then((response) => response.json());
      expect(emptyHistory.stats.rolls).toBe(0);

      await page.getByRole("button", { name: "Close session", exact: true }).click();
      let generateStubHits = 0;
      await page.route("**/api/generate", async (route) => {
        generateStubHits += 1;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "fixture stub" }),
        });
      });
      await page.getByRole("button", { name: "Roll dice", exact: true }).click();
      const rollRequest = page.waitForResponse(
        (response) => response.url().includes("/api/game/dice/roll") && response.request().method() === "POST",
      );
      const historyWrite = page.waitForResponse(
        (response) => response.url().includes("/api/game-tools/dice-log") && response.request().method() === "POST",
      );
      const generateRequest = page.waitForResponse(
        (response) => response.url().endsWith("/api/generate") && response.request().method() === "POST",
      );
      const historyRead = waitForHistoryRead("session");
      await page.getByRole("button", { name: "🎲 d20", exact: true }).click();
      await expect(page.getByRole("button", { name: "Send game turn", exact: true })).toBeEnabled();
      await page.getByRole("button", { name: "Send game turn", exact: true }).click();
      const [rollResponse, writeResponse, generateResponse] = await Promise.all([
        rollRequest,
        historyWrite,
        generateRequest,
      ]);
      expect(rollResponse.ok()).toBeTruthy();
      expect(rollResponse.request().postDataJSON()).toMatchObject({ chatId: chat.id, notation: "d20" });
      expect(generateResponse.status()).toBe(503);
      expect(generateStubHits).toBe(1);

      expect(writeResponse.ok()).toBeTruthy();
      const payload = writeResponse.request().postDataJSON();
      expect(payload).toMatchObject({ chatId: chat.id, source: "player" });

      diceLog = await openDiceLog();
      const sessionHistory = await historyRead.then((response) => response.json());
      expect(sessionHistory.stats.rolls).toBe(1);
      expect(sessionHistory.recent[0]).toMatchObject({ source: "player", notation: "d20" });

      await expect(diceLog).toContainText("d20");
      await expect(diceLog).toContainText("Player");
      await expect(diceLog).toContainText("Most rolled:");
      await expect(diceLog).toContainText("Natural 20:");

      forceGameFailures = true;
      const gameFailures: number[] = [];
      const observeGameFailure = (response: Response) => {
        const url = new URL(response.url());
        if (
          url.pathname === "/api/game-tools/dice-log" &&
          url.searchParams.get("chatId") === chat.id &&
          url.searchParams.get("scope") === "game" &&
          response.request().method() === "GET" &&
          response.status() === 503
        ) {
          gameFailures.push(response.status());
        }
      };
      page.on("response", observeGameFailure);
      const gameRead = waitForHistoryRead("game");
      await page.getByRole("button", { name: "Whole game", exact: true }).click();
      expect((await gameRead).status()).toBe(503);
      await expect(diceLog).toContainText("Could not load the dice log.");
      expect(gameStubHits).toBe(2);
      expect(gameFailures).toHaveLength(2);
      page.off("response", observeGameFailure);
      forceGameFailures = false;
      const gameRetry = waitForHistoryRead("game");
      await diceLog.getByRole("button", { name: "Retry", exact: true }).click();
      expect((await gameRetry).ok()).toBeTruthy();
      expect(gameStubHits).toBe(2);
      await expect(diceLog).toContainText("Latest 1 of 1");
      const gameHistory = await gameRetry.then((response) => response.json());
      expect(gameHistory.stats.rolls).toBe(1);
      await page.getByRole("button", { name: "Close session", exact: true }).click();
      await setFeatures({});
      await page.reload();
      await expect(narration).toContainText("A quiet room waits for a roll.");
      await openSession();
      await expect(page.getByRole("button", { name: "Tools", exact: true })).toHaveCount(0);
      const ordinaryRoll = await request.post("/api/game/dice/roll", { data: { chatId: chat.id, notation: "d20" } });
      expect(ordinaryRoll.ok()).toBeTruthy();
      expect((await request.get(`/api/game-tools/dice-log?chatId=${chat.id}`)).status()).toBe(403);
      await setFeatures({ diceLog: true });
      const retained = await request.get(`/api/game-tools/dice-log?chatId=${chat.id}`);
      expect(retained.ok()).toBeTruthy();
      expect((await retained.json()).recent).toEqual(sessionHistory.recent);
      expect(externalRequests).toEqual([]);
    } finally {
      const cleanup = await Promise.allSettled([
        page.close(),
        request.delete(`/api/chats/${chat.id}?force=true`).then((response) => expect(response.ok()).toBeTruthy()),
        setFeatures(priorFeatures.settings ?? {}),
      ]);
      for (const result of cleanup) expect(result.status).toBe("fulfilled");
    }
  });
}
