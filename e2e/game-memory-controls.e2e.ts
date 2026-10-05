import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

for (const theme of ["dark", "light"] as const) {
  test(`Game Session History shows saved continuity and persists memory controls (${theme})`, async ({
    page,
    request,
  }, testInfo) => {
    // This persistence/error journey repeatedly reloads the uncached development module graph.
    test.setTimeout(120_000);
    const baseURL = testInfo.project.use.baseURL;
    expect(typeof baseURL).toBe("string");
    if (typeof baseURL !== "string") throw new Error("This memory-controls fixture requires an explicit baseURL.");
    const base = new URL(baseURL);
    const isMobile = testInfo.project.name.startsWith("mobile");
    const expectedPort = isMobile
      ? (process.env.PLAYWRIGHT_MOBILE_CLIENT_PORT ?? "5179")
      : (process.env.PLAYWRIGHT_CLIENT_PORT ?? "5178");
    expect(base.protocol).toBe("http:");
    expect(base.hostname).toBe("127.0.0.1");
    expect(base.port).toBe(expectedPort);
    expect(base.username).toBe("");
    expect(base.password).toBe("");
    expect(base.search).toBe("");
    expect(base.hash).toBe("");
    const appOrigin = base.origin;
    const priorFeaturesResponse = await request.get("/api/app-settings/features");
    expect(priorFeaturesResponse.ok()).toBeTruthy();
    const priorFeatures = await priorFeaturesResponse.json();
    const setFeatures = async (settings: Record<string, boolean>) => {
      const response = await request.put("/api/app-settings/features", { data: settings });
      expect(response.ok()).toBeTruthy();
    };

    const created = await request.post("/api/chats", {
      data: { name: `Memory controls ${theme}`, mode: "game", characterIds: [] },
    });
    expect(created.ok()).toBeTruthy();
    const chat = await created.json();
    const generationRequests: string[] = [];
    const generationStatusReads: string[] = [];
    const continuityReads: string[] = [];
    const interceptedProviderMetadataRefreshes: string[] = [];
    const failedMemoryBudgetSaves: string[] = [];
    const blockedMutations: string[] = [];
    const offOriginProbeUrls = [
      `https://status-probe.invalid/api/generate/status/${chat.id}`,
      "https://provider-probe.invalid/v1/chat/completions",
    ];
    const offOriginProbeIntercepts: string[] = [];
    const unexpectedOffOriginRequests: string[] = [];
    let synthesizeStatusError = false;
    let failNextMemoryBudgetSave = false;
    await page.route("**/*", async (route) => {
      const requestUrl = new URL(route.request().url());
      const method = route.request().method();
      if (requestUrl.origin !== appOrigin) {
        const probeUrl = offOriginProbeUrls.find((url) => new URL(url).href === requestUrl.href);
        if (method === "GET" && probeUrl) {
          offOriginProbeIntercepts.push(`${method} ${requestUrl.href}`);
        } else {
          unexpectedOffOriginRequests.push(`${method} ${requestUrl.href}`);
        }
        await route.abort();
        return;
      }
      if (!requestUrl.pathname.startsWith("/api/")) {
        if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
          blockedMutations.push(`${method} ${requestUrl.pathname}`);
          await route.abort();
          return;
        }
        await route.continue();
        return;
      }
      if (requestUrl.pathname.startsWith("/api/generate")) {
        if (method === "GET" && /^\/api\/generate\/status\/[^/]+$/.test(requestUrl.pathname)) {
          generationStatusReads.push(`${method} ${requestUrl.pathname}`);
          await route.continue();
          return;
        }
        generationRequests.push(`${method} ${requestUrl.pathname}`);
        await route.abort();
        return;
      }
      if (method === "POST" && requestUrl.pathname === "/api/connections/refresh-local-context") {
        // This startup helper performs provider metadata probes on the server; never forward it in this fixture.
        interceptedProviderMetadataRefreshes.push(`${method} ${requestUrl.pathname}`);
        await route.abort();
        return;
      }
      if (synthesizeStatusError && method === "GET" && requestUrl.pathname === `/api/game/${chat.id}/continuity`) {
        await route.fulfill({ status: 503, json: { error: "Synthetic status failure" } });
        return;
      }
      if (method === "GET" && requestUrl.pathname === `/api/game/${chat.id}/continuity`)
        continuityReads.push(requestUrl.href);
      if (failNextMemoryBudgetSave && method === "PATCH" && requestUrl.pathname === `/api/chats/${chat.id}/metadata`) {
        failNextMemoryBudgetSave = false;
        failedMemoryBudgetSaves.push(`${method} ${requestUrl.pathname}`);
        await route.fulfill({ status: 503, json: { error: "Synthetic metadata save failure" } });
        return;
      }
      if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
        const approved =
          (method === "PATCH" && requestUrl.pathname === `/api/chats/${chat.id}/metadata`) ||
          (method === "PATCH" && requestUrl.pathname === `/api/game/${chat.id}/continuity`);
        if (!approved) {
          blockedMutations.push(`${method} ${requestUrl.pathname}`);
          await route.abort();
          return;
        }
      }
      await route.continue();
    });
    try {
      await setFeatures({ gameMemoryControls: true, gameContinuity: true });
      const savedPrompt = "Historical prompt bytes; never rewrite this message.  ";
      const savedSummaries = [
        { sessionNumber: 1, summary: "Earlier session" },
        { sessionNumber: 2, summary: "Current recap" },
      ];
      const metadataResponse = await request.patch(`/api/chats/${chat.id}/metadata`, {
        data: {
          enableAgents: false,
          enableTools: false,
          gameId: chat.id,
          gameIntroPresented: true,
          gameSessionNumber: 2,
          gameSessionStatus: "active",
          gameContinuity: { mode: "active", ownership: { lorebook: "keeper", fromSession: 1 } },
          gamePreviousSessionSummaries: savedSummaries,
          customGmPrompt: savedPrompt,
        },
      });
      expect(metadataResponse.ok()).toBeTruthy();
      const messageResponse = await request.post(`/api/chats/${chat.id}/messages`, {
        data: { role: "system", content: savedPrompt },
      });
      expect(messageResponse.ok()).toBeTruthy();

      await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
      await seedUIState(page, {
        hasCompletedOnboarding: true,
        sidebarOpen: false,
        rightPanelOpen: false,
        chatHelpSeenModes: ["game"],
        gameInstantTextReveal: true,
        theme,
      });
      await page.addInitScript(
        ({ id, version: appVersion }) => {
          localStorage.setItem("marinara-active-chat-id", id);
          localStorage.setItem("marinara:whats-new:seen-version", appVersion);
        },
        { id: chat.id, version },
      );

      const openHistory = async (expectControls = true) => {
        if (testInfo.project.name.includes("mobile")) {
          await page.getByRole("button", { name: "Game actions", exact: true }).click();
        }
        await page.getByRole("button", { name: "Session", exact: true }).filter({ visible: true }).click();
        const panel = page.locator("[data-chat-floating-panel]").filter({ hasText: "Session History" });
        await panel.getByRole("button", { name: "Session History", exact: true }).click();
        if (expectControls)
          await expect(panel.getByRole("heading", { name: "Campaign continuity", exact: true })).toBeVisible();
        else await expect(panel.getByRole("heading", { name: "Campaign continuity", exact: true })).toHaveCount(0);
        return panel;
      };
      const chatMetadata = async () => {
        const row = await (await request.get(`/api/chats/${chat.id}`)).json();
        return typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata;
      };

      await setFeatures({});
      await page.goto("/");
      const probeResults = await page.evaluate(async (urls) => {
        return Promise.all(
          urls.map(async (url) => {
            try {
              await fetch(url, { mode: "no-cors" });
              return "unexpected-response";
            } catch {
              return "blocked";
            }
          }),
        );
      }, offOriginProbeUrls);
      expect(probeResults).toEqual(["blocked", "blocked"]);
      expect(offOriginProbeIntercepts).toHaveLength(2);
      expect([...offOriginProbeIntercepts].sort()).toEqual(offOriginProbeUrls.map((url) => `GET ${url}`).sort());
      expect(unexpectedOffOriginRequests).toEqual([]);
      await openHistory(false);
      expect(continuityReads).toEqual([]);
      await setFeatures({ gameMemoryControls: true });
      await page.reload();
      const independentPanel = await openHistory();
      await expect(
        independentPanel
          .getByRole("region", { name: "Campaign continuity", exact: true })
          .getByText("Continuity is off. Saved coverage is preserved.", { exact: true }),
      ).toBeVisible();
      await expect(independentPanel.getByRole("alert")).toHaveCount(0);
      await expect(
        independentPanel.getByRole("switch", { name: "Replace the Lorebook Keeper", exact: true }),
      ).toBeDisabled();
      await expect(
        independentPanel.getByRole("combobox", { name: "Earlier session recaps in prompts", exact: true }),
      ).toBeEnabled();
      expect(continuityReads).toEqual([]);
      await setFeatures({ gameMemoryControls: true, gameContinuity: true });
      await page.reload();
      const statusResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes(`/api/game/${chat.id}/continuity`) && response.request().method() === "GET",
      );
      let panel = await openHistory();
      const statusResponse = await statusResponsePromise;
      expect(statusResponse.ok()).toBeTruthy();
      const continuity = panel.getByRole("region", { name: "Campaign continuity", exact: true });
      await expect(continuity.getByText("Status: On", { exact: true })).toBeVisible();
      await expect(continuity.getByText("Saved coverage records: 0", { exact: true })).toBeVisible();
      await expect(continuity.getByText("Uncovered gaps: 0", { exact: true })).toBeVisible();

      const memoryBudget = panel.getByRole("spinbutton", { name: "Memory budget for the GM", exact: true });
      await expect(memoryBudget).toHaveValue("");
      await expect(memoryBudget).toHaveAttribute("placeholder", "10000");

      const recapLimit = panel.getByRole("combobox", { name: "Earlier session recaps in prompts", exact: true });
      const recapSave = page.waitForResponse(
        (response) =>
          response.url().includes(`/api/chats/${chat.id}/metadata`) && response.request().method() === "PATCH",
      );
      await recapLimit.selectOption("2");
      expect((await recapSave).ok()).toBeTruthy();
      await expect.poll(async () => (await chatMetadata()).gamePromptRecentSessionLimit).toBe(2);

      const saveMemoryBudget = async (value: string) => {
        const response = page.waitForResponse(
          (item) => item.url().includes(`/api/chats/${chat.id}/metadata`) && item.request().method() === "PATCH",
        );
        await memoryBudget.fill(value);
        await memoryBudget.blur();
        return response;
      };
      const validBudgetSave = await saveMemoryBudget("24000");
      expect(validBudgetSave.ok()).toBeTruthy();
      await expect.poll(async () => (await chatMetadata()).gameCampaignMemoryMaxCharacters).toBe(24000);
      await expect(memoryBudget).toHaveValue("24000");

      const minimumBudgetSave = await saveMemoryBudget("100");
      expect(minimumBudgetSave.ok()).toBeTruthy();
      await expect.poll(async () => (await chatMetadata()).gameCampaignMemoryMaxCharacters).toBe(1000);
      await expect(memoryBudget).toHaveValue("1000");

      const maximumBudgetSave = await saveMemoryBudget("100001");
      expect(maximumBudgetSave.ok()).toBeTruthy();
      await expect.poll(async () => (await chatMetadata()).gameCampaignMemoryMaxCharacters).toBe(100000);
      await expect(memoryBudget).toHaveValue("100000");

      const ownerSwitch = panel.getByRole("switch", { name: "Replace the Lorebook Keeper", exact: true });
      await expect(ownerSwitch).not.toBeChecked();
      const ownerSave = page.waitForResponse(
        (response) =>
          response.url().includes(`/api/game/${chat.id}/continuity`) && response.request().method() === "PATCH",
      );
      await ownerSwitch.click();
      expect((await ownerSave).ok()).toBeTruthy();
      await expect(ownerSwitch).toBeChecked();
      await expect.poll(async () => (await chatMetadata()).gameContinuity.ownership.lorebook).toBe("continuity");

      await page.screenshot({ path: testInfo.outputPath(`game-memory-controls-${theme}.png`) });
      await page.reload();
      panel = await openHistory();
      await expect(panel.getByRole("combobox", { name: "Earlier session recaps in prompts", exact: true })).toHaveValue(
        "2",
      );
      await expect(panel.getByRole("spinbutton", { name: "Memory budget for the GM", exact: true })).toHaveValue(
        "100000",
      );
      await expect(panel.getByRole("switch", { name: "Replace the Lorebook Keeper", exact: true })).toBeChecked();
      await expect(
        panel
          .getByRole("region", { name: "Campaign continuity", exact: true })
          .getByText("Saved coverage records: 0", { exact: true }),
      ).toBeVisible();

      const messages = await (await request.get(`/api/chats/${chat.id}/messages`)).json();
      expect(messages.some((message: { content: string }) => message.content === savedPrompt)).toBe(true);
      expect((await chatMetadata()).gamePreviousSessionSummaries).toEqual(savedSummaries);
      expect((await chatMetadata()).customGmPrompt).toBe(savedPrompt);

      const retained = await chatMetadata();
      await setFeatures({});
      await page.reload();
      await openHistory(false);
      expect(await chatMetadata()).toEqual(retained);
      await setFeatures({ gameMemoryControls: true, gameContinuity: true });
      await page.reload();
      panel = await openHistory();
      await expect(memoryBudget).toHaveValue("100000");

      failNextMemoryBudgetSave = true;
      const failedBudgetResponse = await saveMemoryBudget("30000");
      expect(failedBudgetResponse.status()).toBe(503);
      await expect(
        page.getByRole("alert").filter({ hasText: "Could not save that setting. Try again." }),
      ).toBeVisible();
      await expect.poll(async () => (await chatMetadata()).gameCampaignMemoryMaxCharacters).toBe(100000);

      // The next status read is deliberately synthetic to prove the visible failure state.
      synthesizeStatusError = true;
      await page.reload();
      panel = await openHistory();
      await expect(
        panel
          .getByRole("region", { name: "Campaign continuity", exact: true })
          .getByText("Saved coverage status is unavailable.", { exact: true }),
      ).toBeVisible();
      expect(generationRequests).toEqual([]);
      expect(generationStatusReads.every((entry) => /^GET \/api\/generate\/status\/[^/]+$/.test(entry))).toBe(true);
      expect(interceptedProviderMetadataRefreshes.length).toBeGreaterThan(0);
      expect(
        interceptedProviderMetadataRefreshes.every((entry) => entry === "POST /api/connections/refresh-local-context"),
      ).toBe(true);
      expect(failedMemoryBudgetSaves).toEqual([`PATCH /api/chats/${chat.id}/metadata`]);
      expect(blockedMutations).toEqual([]);
    } finally {
      const cleanup = await Promise.allSettled([
        page.close(),
        request.delete(`/api/chats/${chat.id}?force=true`).then((response) => expect(response.ok()).toBeTruthy()),
        request
          .put("/api/app-settings/features", { data: priorFeatures.settings ?? {} })
          .then((response) => expect(response.ok()).toBeTruthy()),
      ]);
      for (const result of cleanup) if (result.status === "rejected") throw result.reason;
    }
  });
}
