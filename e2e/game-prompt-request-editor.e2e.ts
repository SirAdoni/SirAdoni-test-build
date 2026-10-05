import { expect, request as playwrightRequest, test, type Locator, type Page } from "@playwright/test";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const MARKER = "PROMPT_EDITOR_E2E_MARKER";
const HISTORICAL_TEXT = "Historical narration stays unchanged.";

async function openGame(page: Page, chatId: string) {
  await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
  await seedUIState(page, {
    hasCompletedOnboarding: true,
    sidebarOpen: false,
    rightPanelOpen: false,
    chatHelpSeenModes: ["game"],
    gameInstantTextReveal: true,
  });
  await page.addInitScript(
    ({ id, appVersion }) => {
      localStorage.setItem("marinara-active-chat-id", id);
      localStorage.setItem("marinara:whats-new:seen-version", appVersion);
    },
    { id: chatId, appVersion: version },
  );
  await page.goto("/");
}

// Mobile projects tap the same responsive Chat Settings and full-screen editor controls.
async function activate(locator: Locator, mobile: boolean) {
  if (mobile) await locator.tap();
  else await locator.click();
}

async function openChatSettings(page: Page, mobile: boolean) {
  if (mobile) await page.getByRole("button", { name: "Game actions", exact: true }).tap();
  await activate(page.getByRole("button", { name: "Chat Settings", exact: true }).filter({ visible: true }), mobile);
}

async function openFullPrompt(page: Page, mobile: boolean) {
  await openChatSettings(page, mobile);
  const section = page.locator('[data-chat-settings-section="game-prompt"]');
  const header = section.locator("[role=button]");
  if ((await header.getAttribute("aria-expanded")) !== "true") await activate(header, mobile);
  await activate(section.getByRole("button", { name: "Open full prompt", exact: true }), mobile);
  return page.getByRole("dialog", { name: "Full Game prompt editor" });
}

test("Game full-prompt edits persist and reach the next provider request", async ({ page, baseURL }, testInfo) => {
  // Fence every destination before creating fixture data or making any API request.
  const projectName = testInfo.project.name;
  const mobile = projectName === "mobile-chromium" || projectName === "mobile-webkit";
  expect(["desktop-chromium", "mobile-chromium", "mobile-webkit"]).toContain(projectName);
  const expectedPorts = mobile ? { client: 5179, server: 7972 } : { client: 5178, server: 7971 };
  const clientPortEnv = mobile ? process.env.PLAYWRIGHT_MOBILE_CLIENT_PORT : process.env.PLAYWRIGHT_CLIENT_PORT;
  const serverPortEnv = mobile ? process.env.PLAYWRIGHT_MOBILE_SERVER_PORT : process.env.PLAYWRIGHT_SERVER_PORT;
  expect(baseURL).toBe(`http://127.0.0.1:${expectedPorts.client}`);
  expect(Number(clientPortEnv ?? expectedPorts.client)).toBe(expectedPorts.client);
  expect(Number(serverPortEnv ?? expectedPorts.server)).toBe(expectedPorts.server);
  const expectedOrigin = `http://127.0.0.1:${expectedPorts.client}`;
  const request = await playwrightRequest.newContext({ baseURL, timeout: 30_000 });
  let originalFeatures: Record<string, boolean> | undefined;

  const providerPrompts: Array<Array<{ role: string; content: string }>> = [];
  const provider = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      if (incoming.method !== "POST" || incoming.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        messages?: Array<{ role: string; content: string }>;
      };
      providerPrompts.push(body.messages ?? []);
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "The scene continues." }, finish_reason: null }] })}\n\n` +
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
          "data: [DONE]\n\n",
      );
    });
  });
  let connectionId: string | undefined;
  let chatId: string | undefined;
  let historicalMessageId: string | undefined;
  const externalRequests: string[] = [];
  const blockedMutations: string[] = [];
  let providerListening = false;
  try {
    const features = await request.get("/api/app-settings/features");
    expect(features.ok()).toBeTruthy();
    originalFeatures = (await features.json()).settings ?? {};
    const otherFeatures = { ...originalFeatures };
    delete otherFeatures.gamePromptEditing;
    const setFeatures = async (settings: Record<string, boolean>) => {
      expect((await request.put("/api/app-settings/features", { data: settings })).ok()).toBeTruthy();
    };
    await setFeatures(otherFeatures);
    await new Promise<void>((resolve, reject) => {
      provider.once("error", reject);
      provider.listen(0, "127.0.0.1", resolve);
    });
    providerListening = true;
    const providerAddress = provider.address();
    if (!providerAddress || typeof providerAddress === "string") throw new Error("Fake provider did not bind");
    expect(providerAddress.address).toBe("127.0.0.1");
    expect(providerAddress.port).toBeGreaterThan(0);
    expect(providerAddress.port).toBeLessThanOrEqual(65535);
    const providerUrl = `http://127.0.0.1:${providerAddress.port}/v1`;
    const connectionResponse = await request.post("/api/connections", {
      data: {
        name: "Prompt editor local-only fixture",
        provider: "custom",
        baseUrl: providerUrl,
        apiKey: "fixture-only",
        model: "fixture-only",
        maxContext: 32768,
      },
    });
    expect(connectionResponse.ok()).toBeTruthy();
    connectionId = ((await connectionResponse.json()) as { id: string }).id;

    const chatResponse = await request.post("/api/chats", {
      data: { name: "Prompt editor fixture", mode: "game", characterIds: [], connectionId },
    });
    expect(chatResponse.ok()).toBeTruthy();
    chatId = ((await chatResponse.json()) as { id: string }).id;

    const metadataResponse = await request.patch(`/api/chats/${chatId}/metadata`, {
      data: {
        gameId: chatId,
        gameSessionStatus: "active",
        gameIntroPresented: true,
        enableAgents: false,
        gameImageAutoGenerationEnabled: false,
        gameSceneTimelineEnabled: false,
      },
    });
    expect(metadataResponse.ok()).toBeTruthy();
    const historyResponse = await request.post(`/api/chats/${chatId}/messages`, {
      data: { role: "assistant", content: HISTORICAL_TEXT },
    });
    expect(historyResponse.ok()).toBeTruthy();
    historicalMessageId = ((await historyResponse.json()) as { id: string }).id;
    const userResponse = await request.post(`/api/chats/${chatId}/messages`, {
      data: { role: "user", content: "I enter the garden." },
    });
    expect(userResponse.ok()).toBeTruthy();

    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== expectedOrigin) {
        externalRequests.push(url.origin);
        return route.abort();
      }
      const method = route.request().method();
      if (method === "POST" && url.pathname === "/api/connections/refresh-local-context") {
        return route.fulfill({ json: { updated: [] } });
      }
      const metadataPath = `/api/chats/${chatId}/metadata`;
      const chatPath = `/api/chats/${chatId}`;
      const peekPromptPath = `/api/chats/${chatId}/peek-prompt`;
      const requestBody = route.request().postDataJSON() as Record<string, unknown> | null;
      const promptPresetUpdate =
        method === "PATCH" &&
        url.pathname === chatPath &&
        requestBody !== null &&
        Object.keys(requestBody).length === 1 &&
        typeof requestBody.promptPresetId === "string";
      if (
        url.pathname.startsWith("/api/") &&
        !["GET", "HEAD", "OPTIONS"].includes(method) &&
        !(method === "PATCH" && url.pathname === metadataPath) &&
        !(method === "POST" && url.pathname === peekPromptPath) &&
        !promptPresetUpdate
      ) {
        blockedMutations.push(`${method} ${url.pathname} ${route.request().postData() ?? ""}`);
        return route.abort();
      }
      return route.continue();
    });

    await openGame(page, chatId);
    await openChatSettings(page, mobile);
    await expect(page.getByRole("button", { name: "Open full prompt", exact: true })).toHaveCount(0);
    expect(
      (
        await request.patch(`/api/chats/${chatId}/metadata`, {
          data: { gamePromptDirectEdits: [] },
        })
      ).status(),
    ).toBe(403);
    await setFeatures({ ...otherFeatures, gamePromptEditing: true });
    await page.reload();
    const editor = await openFullPrompt(page, mobile);
    const textareas = editor.locator("textarea");
    await expect(textareas.first()).toBeVisible();
    const firstMessage = await textareas.first().inputValue();
    await textareas.first().fill(`${firstMessage}\n\n${MARKER}`);
    await activate(editor.getByRole("button", { name: "Save prompt edits", exact: true }), mobile);
    await expect(editor).toBeHidden();

    const metadataRead = await request.get(`/api/chats/${chatId}`);
    expect(metadataRead.ok()).toBeTruthy();
    const chat = (await metadataRead.json()) as { metadata?: string | Record<string, unknown> };
    const metadata = typeof chat.metadata === "string" ? JSON.parse(chat.metadata) : (chat.metadata ?? {});
    expect(metadata.gamePromptDirectEdits).toEqual(
      expect.arrayContaining([expect.objectContaining({ replace: expect.stringContaining(MARKER) })]),
    );

    const generateResponse = await request.post("/api/generate", { data: { chatId, connectionId } });
    expect(generateResponse.ok()).toBeTruthy();
    expect(providerPrompts).toHaveLength(1);
    expect(providerPrompts[0]!.some((message) => message.content.includes(MARKER))).toBe(true);

    await setFeatures({ ...otherFeatures, gamePromptEditing: false });
    expect(
      (
        await request.patch(`/api/chats/${chatId}/metadata`, {
          data: { gamePromptDirectEdits: [] },
        })
      ).status(),
    ).toBe(403);
    expect((await request.post("/api/generate", { data: { chatId, connectionId } })).ok()).toBeTruthy();
    expect(providerPrompts).toHaveLength(2);
    expect(providerPrompts[1]!.some((message) => message.content.includes(MARKER))).toBe(false);
    const retained = await (await request.get(`/api/chats/${chatId}`)).json();
    const retainedMetadata = typeof retained.metadata === "string" ? JSON.parse(retained.metadata) : retained.metadata;
    expect(retainedMetadata.gamePromptDirectEdits).toEqual(metadata.gamePromptDirectEdits);
    await setFeatures({ ...otherFeatures, gamePromptEditing: true });
    expect((await request.post("/api/generate", { data: { chatId, connectionId } })).ok()).toBeTruthy();
    expect(providerPrompts).toHaveLength(3);
    expect(providerPrompts[2]!.some((message) => message.content.includes(MARKER))).toBe(true);

    const historyRead = await request.get(`/api/chats/${chatId}/messages`);
    expect(historyRead.ok()).toBeTruthy();
    const messages = (await historyRead.json()) as Array<{ id: string; content: string }>;
    expect(messages.find((message) => message.id === historicalMessageId)?.content).toBe(HISTORICAL_TEXT);

    await page.reload();
    const reopenedEditor = await openFullPrompt(page, mobile);
    await expect(reopenedEditor.locator("textarea").first()).toHaveValue(new RegExp(MARKER));
    expect(externalRequests).toEqual([]);
    expect(blockedMutations).toEqual([]);
  } finally {
    try {
      if (chatId) {
        const deleted = await request.delete(`/api/chats/${chatId}?force=true`);
        expect(deleted.ok(), `Fixture chat cleanup failed: HTTP ${deleted.status()}`).toBeTruthy();
      }
    } finally {
      try {
        if (connectionId) {
          const deleted = await request.delete(`/api/connections/${connectionId}`);
          expect(deleted.ok(), `Fixture connection cleanup failed: HTTP ${deleted.status()}`).toBeTruthy();
        }
      } finally {
        try {
          if (providerListening) {
            await new Promise<void>((resolve, reject) => {
              provider.close((error) => (error ? reject(error) : resolve()));
            });
          }
        } finally {
          try {
            if (originalFeatures)
              expect((await request.put("/api/app-settings/features", { data: originalFeatures })).ok()).toBeTruthy();
          } finally {
            await request.dispose();
          }
        }
      }
    }
  }
});
