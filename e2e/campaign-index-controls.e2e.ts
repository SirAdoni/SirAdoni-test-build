import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import { seedUIState } from "./ui-state-fixture";

const LOOPBACK_HOST = "127.0.0.1";

function assertLoopback(testInfo: TestInfo): string {
  const baseURL = testInfo.project.use.baseURL;
  if (typeof baseURL !== "string")
    throw new Error("Campaign Index browser proof requires an explicit loopback baseURL.");
  const url = new URL(baseURL);
  const mobile = testInfo.project.name.startsWith("mobile-");
  const expectedClientPort = mobile ? "5179" : "5178";
  const expectedServerPort = mobile ? "7972" : "7971";
  const configuredClientPort = mobile ? process.env.PLAYWRIGHT_MOBILE_CLIENT_PORT : process.env.PLAYWRIGHT_CLIENT_PORT;
  const configuredServerPort = mobile ? process.env.PLAYWRIGHT_MOBILE_SERVER_PORT : process.env.PLAYWRIGHT_SERVER_PORT;
  if (
    process.env.PLAYWRIGHT_SKIP_WEBSERVER === "true" ||
    url.protocol !== "http:" ||
    url.hostname !== LOOPBACK_HOST ||
    url.port !== expectedClientPort ||
    (configuredClientPort && configuredClientPort !== expectedClientPort) ||
    (configuredServerPort && configuredServerPort !== expectedServerPort)
  ) {
    throw new Error(
      `Refusing Campaign Index browser proof outside its isolated ${expectedClientPort}/${expectedServerPort} test pair: ${url.origin}`,
    );
  }
  return url.origin;
}

async function installBrowserSafetyGuard(
  page: Page,
  testInfo: TestInfo,
  chatId: string,
  features: { campaignIndex: boolean; gameContinuity: boolean; campaignMemory: boolean } = {
    campaignIndex: true,
    gameContinuity: true,
    campaignMemory: true,
  },
) {
  const origin = assertLoopback(testInfo);
  const blockedOperations: string[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      blockedOperations.push(`external ${url.origin}`);
      return route.abort("blockedbyclient");
    }
    const method = route.request().method().toUpperCase();
    const path = url.pathname;
    if (path === "/api/app-settings/features" && method === "GET") {
      return route.fulfill({ json: { settings: features, envOverrides: {}, effective: {} } });
    }
    if (path.startsWith("/api/generate/status/") && method === "GET") {
      return route.fulfill({ json: { active: false, translating: false } });
    }
    if (path === "/api/connections/refresh-local-context" && method === "POST") {
      return route.fulfill({ json: { updated: [] } });
    }
    if (path === "/api/app-settings/ui" && method === "PUT") {
      return route.fulfill({ json: {} });
    }
    if (
      ["generate", "generation", "jobs", "provider"].some((segment) => path.toLowerCase().split("/").includes(segment))
    ) {
      blockedOperations.push(`${method} ${path}`);
      return route.fulfill({ status: 403, json: { error: "Blocked by Campaign Index browser proof" } });
    }
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      let body: Record<string, unknown> | null = null;
      try {
        body = route.request().postDataJSON() as Record<string, unknown> | null;
      } catch {
        // Non-JSON writes are denied below.
      }
      const keys = body ? Object.keys(body) : [];
      const metadataPath = path === `/api/chats/${chatId}/metadata`;
      const dismissalWrite =
        method === "PATCH" &&
        metadataPath &&
        keys.length === 1 &&
        typeof body?.campaignIndexPrompt === "object" &&
        body.campaignIndexPrompt !== null &&
        typeof (body.campaignIndexPrompt as { dismissedAt?: unknown }).dismissedAt === "string";
      const presetInitialization =
        method === "PATCH" &&
        metadataPath &&
        keys.length === 1 &&
        (typeof body?.promptPresetId === "string" || body?.promptPresetId === null);
      if (dismissalWrite || presetInitialization) return route.continue();
      blockedOperations.push(`${method} ${path}`);
      return route.fulfill({ status: 403, json: { error: "Blocked by Campaign Index browser proof" } });
    }
    return route.continue();
  });
  return () => expect(blockedOperations, "unexpected mutating browser requests").toEqual([]);
}

async function deleteSyntheticGame(request: APIRequestContext, chatId: string) {
  const response = await request.delete(`/api/chats/${chatId}?force=true`);
  expect(response.ok(), `Synthetic chat cleanup failed: HTTP ${response.status()}`).toBeTruthy();
}

async function createSyntheticGame(request: APIRequestContext, testInfo: TestInfo) {
  assertLoopback(testInfo);
  const response = await request.post("/api/chats", {
    data: { name: `Campaign Index browser fixture ${Date.now()}`, mode: "game", characterIds: [] },
  });
  expect(response.ok()).toBeTruthy();
  const chat = (await response.json()) as { id: string };
  try {
    const metadata = await request.patch(`/api/chats/${chat.id}/metadata`, {
      data: {
        gameId: chat.id,
        gameSessionStatus: "active",
        gameIntroPresented: true,
        gameImageAutoGenerationEnabled: false,
      },
    });
    expect(metadata.ok()).toBeTruthy();
    return chat;
  } catch (error) {
    await deleteSyntheticGame(request, chat.id);
    throw error;
  }
}

async function selectSyntheticGame(page: Page, chatId: string) {
  await seedUIState(page, {
    hasCompletedOnboarding: true,
    chatHelpSeenModes: ["conversation", "roleplay", "game"],
    sidebarOpen: false,
    rightPanelOpen: false,
    theme: "dark",
  });
  await page.addInitScript((id) => localStorage.setItem("marinara-active-chat-id", id), chatId);
}

async function dismissWhatsNew(page: Page) {
  const gotIt = page.getByRole("button", { name: "Got it", exact: true });
  await gotIt.waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click();
}

function planFor(chatId: string, state: "ready" | "held", dismissedAt: string | null = null) {
  return {
    games: [
      {
        gameId: chatId,
        promptDismissedAt: dismissedAt,
        continuityConfigured: true,
        needsIndexing: true,
        pending: false,
        job: null,
        chats: [
          {
            chatId,
            name: "Synthetic Campaign Index session",
            sessionNumber: 1,
            preparedMessages: 2,
            ownersRegistered: false,
            ownersPlanned: 1,
            receiptCounts: {},
            published: 0,
            manifests: [],
            uncoveredMessages: 1,
            estimate: { turns: 1, receipts: 1 },
            continuityConfigured: true,
            totals: null,
          },
        ],
        lineage: {
          targetChatId: chatId,
          identity: "synthetic-lineage-v1",
          status: state,
          sessions: [{ chatId, sessionNumber: 1, branchPathChatIds: [] }],
          edges: [],
          holds: state === "held" ? [{ chatId, edge: "branch", reason: "missing-parent-proof" }] : [],
        },
      },
    ],
  };
}

test.describe("Campaign Index on the actual Game Mode surface (synthetic, loopback-only)", () => {
  test("keeps the Index dormant while OFF and retains dismissal across re-enable", async ({
    page,
    request,
  }, testInfo) => {
    const chat = await createSyntheticGame(request, testInfo);
    const features = { campaignIndex: false, gameContinuity: false, campaignMemory: false };
    let planRequests = 0;
    let dismissedAt: string | null = null;
    try {
      const assertNoBlockedOperations = await installBrowserSafetyGuard(page, testInfo, chat.id, features);
      await page.route("**/api/game/campaign-index/plan?*", (route) => {
        planRequests += 1;
        return route.fulfill({ json: planFor(chat.id, "ready", dismissedAt) });
      });
      const directOff = await request.get(`/api/game/campaign-index/plan?chatId=${chat.id}`);
      expect(directOff.status()).toBe(403);
      await selectSyntheticGame(page, chat.id);
      await page.goto("/");
      await dismissWhatsNew(page);
      if (page.viewportSize()!.width < 768)
        await page.getByRole("button", { name: "Game actions", exact: true }).click();
      await expect(page.getByRole("button", { name: "Index campaign history", exact: true })).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Index campaign history" })).toHaveCount(0);
      expect(planRequests).toBe(0);

      Object.assign(features, { campaignIndex: true, gameContinuity: true, campaignMemory: true });
      await page.reload();
      const title = page.getByRole("heading", { name: "Index campaign history" });
      await expect(title).toBeVisible();
      await page.getByRole("button", { name: "Not now", exact: true }).click();
      await expect(title).toHaveCount(0);
      const readMetadata = async () => {
        const response = await request.get(`/api/chats/${chat.id}`);
        expect(response.ok()).toBeTruthy();
        return (await response.json()).metadata as { campaignIndexPrompt?: { dismissedAt?: string } };
      };
      await expect
        .poll(async () => (await readMetadata()).campaignIndexPrompt?.dismissedAt)
        .toEqual(expect.any(String));
      dismissedAt = (await readMetadata()).campaignIndexPrompt!.dismissedAt!;
      features.campaignIndex = false;
      const requestsBeforeOff = planRequests;
      await page.reload();
      await dismissWhatsNew(page);
      if (page.viewportSize()!.width < 768)
        await page.getByRole("button", { name: "Game actions", exact: true }).click();
      await expect(page.getByRole("button", { name: "Index campaign history", exact: true })).toHaveCount(0);
      expect(planRequests).toBe(requestsBeforeOff);
      expect((await readMetadata()).campaignIndexPrompt?.dismissedAt).toBe(dismissedAt);
      features.campaignIndex = true;
      await page.reload();
      await dismissWhatsNew(page);
      if (page.viewportSize()!.width < 768)
        await page.getByRole("button", { name: "Game actions", exact: true }).click();
      await page.getByRole("button", { name: "Index campaign history", exact: true }).click();
      await expect(title).toBeVisible();
      expect((await readMetadata()).campaignIndexPrompt?.dismissedAt).toBe(dismissedAt);
      assertNoBlockedOperations();
    } finally {
      await deleteSyntheticGame(request, chat.id);
    }
  });

  test("persists first-run prompt dismissal", async ({ page, request }, testInfo) => {
    const chat = await createSyntheticGame(request, testInfo);
    let dismissedAt: string | null = null;
    try {
      const assertNoBlockedOperations = await installBrowserSafetyGuard(page, testInfo, chat.id);
      await page.route("**/api/game/campaign-index/plan?*", (route) =>
        route.fulfill({ json: planFor(chat.id, "ready", dismissedAt) }),
      );
      await selectSyntheticGame(page, chat.id);
      await page.goto("/");
      await dismissWhatsNew(page);
      const title = page.getByRole("heading", { name: "Index campaign history" });
      await expect(title).toBeVisible();
      await page.getByRole("button", { name: "Not now", exact: true }).click();
      await expect(title).toHaveCount(0);
      const readDismissal = async () => {
        const response = await request.get(`/api/chats/${chat.id}`);
        expect(response.ok()).toBeTruthy();
        const saved = (await response.json()) as {
          metadata?: { campaignIndexPrompt?: { dismissedAt?: unknown } };
        };
        return saved.metadata?.campaignIndexPrompt?.dismissedAt;
      };
      await expect.poll(readDismissal).toEqual(expect.any(String));
      dismissedAt = (await readDismissal()) as string;
      assertNoBlockedOperations();
    } finally {
      await deleteSyntheticGame(request, chat.id);
    }
  });

  test("opens Campaign Index manually after its first-run prompt was dismissed", async ({
    page,
    request,
  }, testInfo) => {
    const chat = await createSyntheticGame(request, testInfo);
    const dismissedAt = new Date().toISOString();
    try {
      const metadata = await request.patch(`/api/chats/${chat.id}/metadata`, {
        data: { campaignIndexPrompt: { dismissedAt } },
      });
      expect(metadata.ok()).toBeTruthy();
      const assertNoBlockedOperations = await installBrowserSafetyGuard(page, testInfo, chat.id);
      await page.route("**/api/game/campaign-index/plan?*", (route) =>
        route.fulfill({ json: planFor(chat.id, "ready", dismissedAt) }),
      );
      await selectSyntheticGame(page, chat.id);
      await page.goto("/");
      await dismissWhatsNew(page);
      if (page.viewportSize()!.width < 768) {
        await page.getByRole("button", { name: "Game actions", exact: true }).click();
      }
      await page.getByRole("button", { name: "Index campaign history", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Index campaign history" })).toBeVisible();
      assertNoBlockedOperations();
    } finally {
      await deleteSyntheticGame(request, chat.id);
    }
  });

  test("shows a held-lineage explanation and prevents starting the job", async ({ page, request }, testInfo) => {
    const chat = await createSyntheticGame(request, testInfo);

    try {
      const assertNoBlockedOperations = await installBrowserSafetyGuard(page, testInfo, chat.id);
      await page.route("**/api/game/campaign-index/plan?*", (route) =>
        route.fulfill({ json: planFor(chat.id, "held") }),
      );
      await selectSyntheticGame(page, chat.id);
      await page.goto("/");
      await dismissWhatsNew(page);

      const dialog = page.getByRole("dialog");
      await expect(dialog.locator("[data-campaign-index-lineage]")).toHaveAttribute(
        "data-campaign-index-lineage",
        "held",
      );
      await expect(dialog.getByText(/selected history could not be verified/i)).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Start", exact: true })).toBeDisabled();
      assertNoBlockedOperations();
    } finally {
      await deleteSyntheticGame(request, chat.id);
    }
  });

  test("recovers from a plan-load error on retry without starting the job", async ({ page, request }, testInfo) => {
    const chat = await createSyntheticGame(request, testInfo);
    let planRequests = 0;
    let allowRecovery = false;
    try {
      const assertNoBlockedOperations = await installBrowserSafetyGuard(page, testInfo, chat.id);
      await page.route("**/api/game/campaign-index/plan?*", (route) => {
        planRequests += 1;
        if (allowRecovery) return route.fulfill({ json: planFor(chat.id, "ready") });
        return route.fulfill({ status: 503, json: { error: "Synthetic plan read failure" } });
      });
      await selectSyntheticGame(page, chat.id);
      await page.goto("/");
      await dismissWhatsNew(page);

      if (page.viewportSize()!.width < 768) {
        await page.getByRole("button", { name: "Game actions", exact: true }).click();
      }
      await page.getByRole("button", { name: "Index campaign history", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByText("The indexing plan could not be loaded.")).toBeVisible();
      const requestsBeforeRetry = planRequests;
      allowRecovery = true;
      await dialog.getByRole("button", { name: "Retry", exact: true }).click();
      await expect.poll(() => planRequests).toBeGreaterThan(requestsBeforeRetry);
      await expect(dialog.getByText("The indexing plan could not be loaded.")).toHaveCount(0);
      await expect(dialog).toHaveCount(1);
      await expect(dialog.locator("[data-campaign-index-lineage]")).toHaveAttribute(
        "data-campaign-index-lineage",
        "ready",
      );
      await expect(dialog.getByRole("button", { name: "Start", exact: true })).toBeEnabled();
      await dialog.getByRole("button", { name: "Close Index campaign history", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      assertNoBlockedOperations();
    } finally {
      await deleteSyntheticGame(request, chat.id);
    }
  });
});
