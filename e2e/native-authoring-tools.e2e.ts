import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

const APP_VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

async function prepareFreshClient(page: Page) {
  await page.addInitScript((appVersion) => {
    localStorage.setItem("marinara:whats-new:seen-version", appVersion);
    if (!localStorage.getItem("marinara-engine-ui")) {
      localStorage.setItem(
        "marinara-engine-ui",
        JSON.stringify({
          state: {
            hasCompletedOnboarding: true,
            rightPanelOpen: false,
            sidebarOpen: false,
            chatHelpSeenModes: ["conversation", "roleplay", "game"],
          },
          version: 97,
        }),
      );
    }
  }, APP_VERSION);
}

async function bestEffortDelete(request: APIRequestContext, url: string) {
  await request.delete(url, { timeout: 5_000 }).catch(() => undefined);
}

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("desktop"), "Native authoring-tool interactions are covered on desktop.");

  await page.route("**/api/app-settings/ui", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { value: null } });
      return;
    }
    const body = route.request().postDataJSON() as { value?: unknown } | null;
    await route.fulfill({ json: { value: typeof body?.value === "string" ? body.value : "" } });
  });
  await prepareFreshClient(page);
});

test("AI Rewrite changes only the edit draft until the user explicitly saves", async ({ page, request }) => {
  const suffix = Date.now().toString(36);
  const originalText = "I have never, in all my nineteen years, heard such words.";
  const rewrittenText = "I've never heard anyone say that before.";
  const rewriteRequests: Array<Record<string, unknown>> = [];
  let connectionId = "";
  let chatId = "";

  try {
    const connectionResponse = await request.post("/api/connections", {
      data: {
        name: `Draft Rewrite ${suffix}`,
        provider: "custom",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "e2e-draft-rewrite",
        model: "rewrite-model",
      },
    });
    expect(connectionResponse.ok(), await connectionResponse.text()).toBeTruthy();
    connectionId = ((await connectionResponse.json()) as { id: string }).id;

    const chatResponse = await request.post("/api/chats", {
      data: {
        name: `AI Rewrite Review ${suffix}`,
        mode: "conversation",
        characterIds: [],
        connectionId,
      },
    });
    expect(chatResponse.ok(), await chatResponse.text()).toBeTruthy();
    chatId = ((await chatResponse.json()) as { id: string }).id;

    const messageResponse = await request.post(`/api/chats/${chatId}/messages`, {
      data: { role: "user", content: originalText },
    });
    expect(messageResponse.ok(), await messageResponse.text()).toBeTruthy();
    const message = (await messageResponse.json()) as { id: string };

    await page.route("**/api/agents/suite/rewrite", async (route) => {
      rewriteRequests.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ rewrittenText }),
      });
    });
    await page.addInitScript((activeChatId) => {
      localStorage.setItem("marinara-active-chat-id", activeChatId);
    }, chatId);
    await page.goto("/");

    const messageRow = page.locator(`[data-message-id="${message.id}"]`);
    await expect(messageRow).toBeVisible();
    await messageRow.hover();
    await messageRow.getByTitle("Edit", { exact: true }).click();

    const editor = messageRow.getByRole("textbox", { name: "Edit your message", exact: true });
    await expect(editor).toHaveValue(originalText);
    await messageRow.getByRole("button", { name: "AI Rewrite", exact: true }).click();
    await expect(
      messageRow.getByText("The original message is unchanged until you review this draft and press Save.", {
        exact: true,
      }),
    ).toBeVisible();

    await messageRow.getByRole("button", { name: "Apply to draft", exact: true }).click();
    await expect(editor).toHaveValue(rewrittenText);
    expect(rewriteRequests).toHaveLength(1);
    expect(rewriteRequests[0]).toMatchObject({
      connectionId,
      selectedText: originalText,
      dataLabel: "User-authored chat message",
    });

    const beforeSaveResponse = await request.get(`/api/chats/${chatId}/messages`);
    expect(beforeSaveResponse.ok(), await beforeSaveResponse.text()).toBeTruthy();
    const beforeSave = (await beforeSaveResponse.json()) as Array<{ id: string; content: string }>;
    expect(beforeSave.find((candidate) => candidate.id === message.id)?.content).toBe(originalText);
    await expect(messageRow.getByRole("button", { name: "Undo AI rewrite", exact: true })).toBeVisible();

    await messageRow.getByRole("button", { name: "Save edit", exact: true }).click();
    await expect
      .poll(async () => {
        const response = await request.get(`/api/chats/${chatId}/messages`);
        const messages = (await response.json()) as Array<{ id: string; content: string }>;
        return messages.find((candidate) => candidate.id === message.id)?.content;
      })
      .toBe(rewrittenText);
    await expect(messageRow.getByRole("textbox", { name: "Edit your message", exact: true })).toHaveCount(0);
    await expect(messageRow).toContainText(rewrittenText);
  } finally {
    if (chatId) await bestEffortDelete(request, `/api/chats/${chatId}?force=true`);
    if (connectionId) await bestEffortDelete(request, `/api/connections/${connectionId}`);
  }
});

test("Prompt Inspector filters derived sections without changing Copy all", async ({ context, page, request }) => {
  const rawPrompt = [
    { role: "system", content: "<character_info>\nCaptain Lysa keeps the harbor ledger.\n</character_info>" },
    { role: "user", content: "## Context\nThis is a literal user heading about moonstone cargo." },
    { role: "assistant", content: "The harbor master answers with the blue-ledger needle." },
  ];
  let chatId = "";

  try {
    const chatResponse = await request.post("/api/chats", {
      data: { name: "Prompt Inspector Native Smoke", mode: "conversation", characterIds: [] },
    });
    expect(chatResponse.ok(), await chatResponse.text()).toBeTruthy();
    chatId = ((await chatResponse.json()) as { id: string }).id;

    const messageResponse = await request.post(`/api/chats/${chatId}/messages`, {
      data: {
        role: "assistant",
        content: "The cached prompt can be inspected.",
        extra: { cachedPrompt: rawPrompt },
      },
    });
    expect(messageResponse.ok(), await messageResponse.text()).toBeTruthy();
    const message = (await messageResponse.json()) as { id: string };

    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.addInitScript((activeChatId) => {
      localStorage.setItem("marinara-active-chat-id", activeChatId);
    }, chatId);
    await page.goto("/");

    const messageRow = page.locator(`[data-message-id="${message.id}"]`);
    await expect(messageRow).toBeVisible();
    await messageRow.hover();
    await messageRow.getByTitle("Peek prompt", { exact: true }).click();

    const inspector = page.getByRole("dialog", { name: "Assembled Prompt" });
    await expect(inspector).toBeVisible();
    await expect(inspector.getByRole("status")).toHaveText("3 prompt items shown");

    await inspector.getByRole("button", { name: "Sections", exact: true }).click();
    await expect(inspector.getByRole("status")).toHaveText("1 prompt item shown");
    await expect(inspector.getByText("Character Info", { exact: true })).toBeVisible();
    await expect(inspector.getByText("Chat History", { exact: true })).toHaveCount(0);

    const search = inspector.getByPlaceholder("Search labels, roles, and prompt text");
    await search.fill("literal user heading");
    await expect(inspector.getByRole("status")).toHaveText("0 prompt items shown");
    await inspector.getByRole("button", { name: "Chat history", exact: true }).click();
    await expect(inspector.getByRole("status")).toHaveText("1 prompt item shown");
    await expect(inspector.getByText(/literal user heading about moonstone cargo/u)).toBeVisible();
    await expect(inspector.getByText("Captain Lysa keeps the harbor ledger.", { exact: false })).toHaveCount(0);

    await inspector.getByRole("button", { name: "Copy ordered role/content text as JSON", exact: true }).click();
    await expect(inspector.getByText("Copied", { exact: true })).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(JSON.parse(copied)).toEqual(rawPrompt);
  } finally {
    if (chatId) await bestEffortDelete(request, `/api/chats/${chatId}?force=true`);
  }
});

test("Conversation background opacity applies immediately and survives reload", async ({ page, request }) => {
  const filename = "conversation-opacity-smoke.svg";
  const backgroundUrl = `/api/backgrounds/file/${filename}`;
  let chatId = "";

  try {
    const chatResponse = await request.post("/api/chats", {
      data: { name: "Conversation Background Opacity Smoke", mode: "conversation", characterIds: [] },
    });
    expect(chatResponse.ok(), await chatResponse.text()).toBeTruthy();
    chatId = ((await chatResponse.json()) as { id: string }).id;
    const metadataResponse = await request.patch(`/api/chats/${chatId}/metadata`, {
      data: { background: filename },
    });
    expect(metadataResponse.ok(), await metadataResponse.text()).toBeTruthy();

    await page.route(`**${backgroundUrl}**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><path fill="#245a70" d="M0 0h1600v900H0z"/></svg>',
      });
    });
    await page.addInitScript((activeChatId) => {
      localStorage.setItem("marinara-active-chat-id", activeChatId);
    }, chatId);
    await page.goto("/");

    const activeBackground = page.locator(`img.mari-background[src^="${backgroundUrl}"]`);
    await expect(activeBackground).toHaveCSS("opacity", "0.45");
    await expect(page.locator("[data-conversation-background-gradient-veil]")).toHaveCSS("opacity", "0.35");

    await page.locator('[data-tour="panel-settings"]').click();
    await page.getByRole("tab", { name: "Appearance", exact: true }).click();
    const opacitySlider = page.getByLabel("Conversation background image opacity", { exact: true });
    await opacitySlider.fill("80");
    await expect(opacitySlider).toHaveValue("80");
    await expect(activeBackground).toHaveCSS("opacity", "0.8");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const persisted = JSON.parse(localStorage.getItem("marinara-engine-ui") ?? '{"state":{}}') as {
            state?: { conversationBackgroundImageOpacity?: unknown };
          };
          return persisted.state?.conversationBackgroundImageOpacity;
        }),
      )
      .toBe(80);

    await page.reload();
    await expect(activeBackground).toHaveCSS("opacity", "0.8");
    await expect(page.locator("[data-conversation-background-gradient-veil]")).toHaveCSS("opacity", "0.35");
  } finally {
    if (chatId) await bestEffortDelete(request, `/api/chats/${chatId}?force=true`);
  }
});

test("Private Notebook exposes scopes, autosaves, and resolves revision conflicts without losing the draft", async ({
  page,
  request,
}) => {
  const suffix = Date.now().toString(36);
  let characterId = "";
  let chatId = "";

  try {
    const characterResponse = await request.post("/api/characters", {
      data: { data: { name: `Notebook Character ${suffix}` } },
    });
    expect(characterResponse.ok(), await characterResponse.text()).toBeTruthy();
    characterId = ((await characterResponse.json()) as { id: string }).id;

    const chatResponse = await request.post("/api/chats", {
      data: {
        name: `Private Notebook ${suffix}`,
        mode: "conversation",
        characterIds: [characterId],
        groupId: `notebook-family-${suffix}`,
      },
    });
    expect(chatResponse.ok(), await chatResponse.text()).toBeTruthy();
    chatId = ((await chatResponse.json()) as { id: string }).id;
    await page.addInitScript((activeChatId) => {
      localStorage.setItem("marinara-active-chat-id", activeChatId);
    }, chatId);
    await page.goto("/");

    const opener = page.getByRole("button", { name: "Private Notebook", exact: true }).filter({ visible: true });
    await opener.click();
    const notebook = page.getByRole("dialog", { name: "Private Notebook" });
    await expect(notebook).toBeVisible();
    const scope = notebook.getByRole("combobox", { name: "Scope", exact: true });
    await expect(scope.locator("option")).toHaveText(["Global", "Character", "This chat", "All branches"]);

    const editor = notebook.getByRole("textbox", { name: "Notes", exact: true });
    await scope.selectOption("character");
    await expect(scope).toHaveValue("character");
    await expect(notebook.getByRole("combobox", { name: "Character", exact: true })).toHaveValue(characterId);
    await scope.selectOption("chat");
    await expect(scope).toHaveValue("chat");

    const firstDraft = "A chat-only note that should autosave.";
    const firstSaveResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        new URL(response.url()).pathname === `/api/private-notebook/chats/${chatId}`,
    );
    await editor.fill(firstDraft);
    await expect(notebook.getByText("Autosave pending", { exact: true })).toBeVisible();
    const firstSave = await firstSaveResponse;
    expect(firstSave.ok()).toBeTruthy();
    const savedDraft = (await firstSave.json()) as { revision: number };
    await expect(notebook.getByText("Saved", { exact: true })).toBeVisible();

    const externalResponse = await request.put(`/api/private-notebook/chats/${chatId}`, {
      data: {
        target: { scope: "chat" },
        content: "A newer note saved elsewhere.",
        expectedRevision: savedDraft.revision,
      },
    });
    expect(externalResponse.ok(), await externalResponse.text()).toBeTruthy();
    const external = (await externalResponse.json()) as { revision: number };

    const conflictResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        new URL(response.url()).pathname === `/api/private-notebook/chats/${chatId}` &&
        response.status() === 409,
    );
    await editor.fill("My unsaved conflict draft.");
    await conflictResponse;
    await expect(notebook.getByText("Saved notes changed elsewhere", { exact: true })).toBeVisible();
    await expect(editor).toHaveValue("My unsaved conflict draft.");
    await expect(notebook.getByRole("button", { name: "Reload saved", exact: true })).toBeVisible();
    await expect(notebook.getByRole("button", { name: "Save mine", exact: true })).toBeVisible();

    await notebook.getByRole("button", { name: "Reload saved", exact: true }).click();
    await expect(editor).toHaveValue("A newer note saved elsewhere.");
    await expect(notebook.getByText("Saved", { exact: true })).toBeVisible();

    const secondExternalResponse = await request.put(`/api/private-notebook/chats/${chatId}`, {
      data: {
        target: { scope: "chat" },
        content: "Another writer moved first.",
        expectedRevision: external.revision,
      },
    });
    expect(secondExternalResponse.ok(), await secondExternalResponse.text()).toBeTruthy();

    const secondConflictResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        new URL(response.url()).pathname === `/api/private-notebook/chats/${chatId}` &&
        response.status() === 409,
    );
    const winningDraft = "Keep my draft after refreshing the current revision.";
    await editor.fill(winningDraft);
    await secondConflictResponse;
    const saveMineResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        new URL(response.url()).pathname === `/api/private-notebook/chats/${chatId}` &&
        response.ok(),
    );
    await notebook.getByRole("button", { name: "Save mine", exact: true }).click();
    expect((await saveMineResponse).ok()).toBeTruthy();
    await expect(editor).toHaveValue(winningDraft);
    await expect(notebook.getByText("Saved", { exact: true })).toBeVisible();

    const contextResponse = await request.get(`/api/private-notebook/chats/${chatId}`);
    expect(contextResponse.ok(), await contextResponse.text()).toBeTruthy();
    const context = (await contextResponse.json()) as {
      documents: Array<{ target: { scope: string }; content: string }>;
    };
    expect(context.documents.find((document) => document.target.scope === "chat")?.content).toBe(winningDraft);

    await notebook.getByRole("button", { name: "Close Private Notebook", exact: true }).click();
    await expect(notebook).toHaveCount(0);
    await expect(opener).toBeFocused();
  } finally {
    if (chatId) await bestEffortDelete(request, `/api/chats/${chatId}?force=true`);
    if (characterId) await bestEffortDelete(request, `/api/characters/${characterId}`);
  }
});
