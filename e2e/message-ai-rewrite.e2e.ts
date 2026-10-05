import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const draft = "A cold wind crosses the stone bridge. Mira studies the sealed gate.";
const selectedDraft = "Mira studies";

let originalFeatures: Record<string, boolean>;
test.beforeEach(async ({ request }) => {
  const read = await request.get("/api/app-settings/features");
  expect(read.ok()).toBeTruthy();
  originalFeatures = (await read.json()).settings;
  const saved = await request.put("/api/app-settings/features", {
    data: { ...originalFeatures, draftRewrites: true, localRewriteConnection: false },
  });
  expect(saved.ok()).toBeTruthy();
});
test.afterEach(async ({ request }) => {
  const restored = await request.put("/api/app-settings/features", { data: originalFeatures });
  expect(restored.ok()).toBeTruthy();
});

async function setDraftFeature(request: APIRequestContext, enabled: boolean, page?: Page) {
  const saved = await request.put("/api/app-settings/features", {
    data: { ...originalFeatures, draftRewrites: enabled, localRewriteConnection: false },
  });
  expect(saved.ok()).toBeTruthy();
  if (page)
    await page.evaluate(
      (response) => {
        const textarea = document.querySelector("[data-chat-message-editor]");
        const key = Object.keys(textarea!).find((name) => name.startsWith("__reactFiber"))!;
        let fiber = (textarea as any)[key];
        while (fiber && !fiber.memoizedProps?.client?.getQueryCache) fiber = fiber.return;
        if (!fiber) throw new Error("Actual App QueryClient missing");
        (window as any).rewriteQueryClient = fiber.memoizedProps.client;
        fiber.memoizedProps.client.setQueryData(["features"], response);
      },
      await saved.json(),
    );
}

type Fixture = { chatId: string; messageId: string; connectionId: string };

async function createFixture(
  request: APIRequestContext,
  mode: "conversation" | "roleplay" | "game",
  content = draft,
): Promise<Fixture> {
  const create = async (path: string, data: unknown) => {
    const response = await request.post(path, { data });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  const connection = await create("/api/connections", {
    name: "Draft rewrite browser fixture",
    provider: "custom",
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "synthetic-fixture-only",
    model: "fixture",
    treatAsLocalEndpoint: true,
  });
  const chat = await create("/api/chats", {
    name: `Draft rewrite ${mode} fixture`,
    mode,
    characterIds: [],
    connectionId: connection.id,
  });
  if (mode === "game") {
    const response = await request.patch(`/api/chats/${chat.id}/metadata`, {
      data: {
        enableAgents: false,
        enableTools: false,
        gameId: chat.id,
        gameSessionStatus: "active",
        gameIntroPresented: true,
        gameImageAutoGenerationEnabled: false,
      },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
  }
  const messageResponse = await request.post(`/api/chats/${chat.id}/messages`, {
    data: { role: "assistant", content },
  });
  expect(messageResponse.ok(), await messageResponse.text()).toBeTruthy();
  const message = await messageResponse.json();
  return { chatId: chat.id, messageId: message.id, connectionId: connection.id };
}

async function openEditor(
  page: Page,
  mode: "conversation" | "roleplay" | "game",
  messageId: string,
  expectedContent = draft,
  mobile = false,
) {
  if (mode === "game") {
    const panel = page.locator('[data-component="GameNarration.ActivePanel"]');
    await expect(panel).toContainText(expectedContent);
    if (mobile) {
      const segment = panel.getByText(expectedContent, { exact: true });
      const bounds = await segment.boundingBox();
      expect(bounds).toBeTruthy();
      const point = { x: bounds!.x + bounds!.width / 2, y: bounds!.y + bounds!.height / 2 };
      await page.touchscreen.tap(point.x, point.y);
      await page.touchscreen.tap(point.x, point.y);
    } else {
      await panel.getByTitle("Edit").click();
    }
  } else {
    const message = page.locator(`[data-message-id="${messageId}"]`).first();
    await expect(message).toContainText(expectedContent);
    if (mode === "conversation") {
      if (mobile) {
        await message.tap();
        const edit = message.getByTitle("Edit", { exact: true });
        await expect(edit).toBeVisible();
        await edit.tap();
      } else {
        await message.hover();
        await message.getByTitle("Edit", { exact: true }).click();
      }
    } else if (mobile) {
      const content = message.locator(".mari-message-content").first();
      const bounds = await content.boundingBox();
      expect(bounds).toBeTruthy();
      const point = { x: bounds!.x + bounds!.width / 2, y: bounds!.y + bounds!.height / 2 };
      await page.touchscreen.tap(point.x, point.y);
      await page.touchscreen.tap(point.x, point.y);
    } else {
      await message.dblclick();
    }
  }
  return page.getByRole("textbox", { name: "Edit assistant message", exact: true });
}

async function setupPage(page: Page, chatId: string, theme: "light" | "dark") {
  await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
  await seedUIState(page, {
    hasCompletedOnboarding: true,
    sidebarOpen: false,
    rightPanelOpen: false,
    chatHelpSeenModes: ["conversation", "roleplay", "game"],
    editMessageOnDoubleClick: true,
    gameInstantTextReveal: true,
    theme,
  });
  await page.addInitScript(
    ({ id, version: appVersion }) => {
      localStorage.setItem("marinara-active-chat-id", id);
      localStorage.setItem("marinara:whats-new:seen-version", appVersion);
    },
    { id: chatId, version },
  );
  await page.goto("/");
}

test.describe("message AI rewrite production caller fixtures", () => {
  test("OFF preserves ordinary drafts and rejects a pending optional result", async ({ page, request }, info) => {
    const fixture = await createFixture(request, "conversation");
    let release: (() => void) | undefined;
    let calls = 0;
    await page.route("**/api/agents/suite/rewrite-message", async (route) => {
      calls += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await route.fulfill({ json: { rewrittenText: "Rejected late result" } });
    });
    try {
      await setDraftFeature(request, false);
      await setupPage(page, fixture.chatId, "light");
      const editor = await openEditor(
        page,
        "conversation",
        fixture.messageId,
        draft,
        info.project.name.startsWith("mobile-"),
      );
      await expect(page.getByRole("button", { name: "AI Rewrite", exact: true })).toHaveCount(0);
      await expect(editor).toHaveValue(draft);
      await expect(page.getByRole("button", { name: "Save edit", exact: true })).toBeEnabled();
      expect(calls).toBe(0);
      await setDraftFeature(request, true, page);
      await page.getByRole("button", { name: "AI Rewrite", exact: true }).click();
      await page.getByRole("button", { name: "Apply to draft", exact: true }).click();
      await expect.poll(() => calls).toBe(1);
      await setDraftFeature(request, false, page);
      await expect(page.getByRole("button", { name: "AI Rewrite", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Save edit", exact: true })).toBeEnabled();
      const response = page.waitForResponse("**/api/agents/suite/rewrite-message");
      release?.();
      await response;
      await setDraftFeature(request, true, page);
      await page.getByRole("button", { name: "AI Rewrite", exact: true }).click();
      await expect(page.getByRole("button", { name: "Apply to draft", exact: true })).toBeEnabled();
      await expect(editor).toHaveValue(draft);
      await page.evaluate(() => {
        (window as any).rewriteQueryClient
          .getQueryCache()
          .find({ queryKey: ["features"] })
          .setState({ status: "error", error: new Error("synthetic settings failure") });
      });
      await expect(page.getByRole("button", { name: "AI Rewrite", exact: true })).toHaveCount(0);
      await expect(editor).toHaveValue(draft);
      expect(calls).toBe(1);
    } finally {
      release?.();
      await request.delete(`/api/chats/${fixture.chatId}`);
      await request.delete(`/api/connections/${fixture.connectionId}`);
    }
  });

  test("conversation line supports selection, review, cancel, undo, and its message save callback", async ({
    page,
    request,
  }, info) => {
    const fixture = await createFixture(request, "conversation");
    const rewrites: Array<Record<string, unknown>> = [];
    await page.route("**/api/agents/suite/rewrite-message", async (route) => {
      rewrites.push(route.request().postDataJSON());
      await route.fulfill({ json: { rewrittenText: "Mira examines" } });
    });
    try {
      await setupPage(page, fixture.chatId, info.project.name === "desktop-chromium" ? "light" : "dark");
      const editor = await openEditor(
        page,
        "conversation",
        fixture.messageId,
        draft,
        info.project.name.startsWith("mobile-"),
      );
      await expect(editor).toHaveValue(draft);

      await page.getByRole("button", { name: "AI Rewrite", exact: true }).click();
      await expect(page.getByText(/A selection may send the full draft/)).toBeVisible();
      const rewriteButton = page.getByRole("button", { name: "AI Rewrite", exact: true });
      await expect
        .poll(() => rewriteButton.evaluate((element) => Number.parseFloat(getComputedStyle(element).height)))
        .toBeGreaterThanOrEqual(44);
      await page.getByRole("button", { name: "Cancel edit", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "Edit assistant message", exact: true })).toHaveCount(0);
      await expect(page.locator(`[data-message-id="${fixture.messageId}"]`).first()).toContainText(draft);

      const reopened = await openEditor(page, "conversation", fixture.messageId);
      await reopened.evaluate((textarea: HTMLTextAreaElement) => {
        const start = textarea.value.indexOf("Mira studies");
        textarea.setSelectionRange(start, start + "Mira studies".length);
      });
      await page.getByRole("button", { name: "AI Rewrite", exact: true }).click();
      await expect(page.getByRole("button", { name: "Apply to draft", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Apply to draft", exact: true }).click();
      await expect(reopened).toHaveValue("A cold wind crosses the stone bridge. Mira examines the sealed gate.");
      expect(rewrites[0]).toMatchObject({
        connectionId: fixture.connectionId,
        selectedText: selectedDraft,
        documentText: draft,
      });

      await page.getByRole("button", { name: "Undo AI rewrite", exact: true }).click();
      await expect(reopened).toHaveValue(draft);
      await reopened.evaluate((textarea: HTMLTextAreaElement) => {
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      });
      await page.getByRole("button", { name: "AI Rewrite", exact: true }).click();
      await page.getByRole("button", { name: "AI Rewrite", exact: true }).click();
      await page.getByRole("button", { name: "Apply to draft", exact: true }).click();
      await expect(reopened).toHaveValue("Mira examines");
      expect(rewrites[1]).toMatchObject({ selectedText: draft });
      expect(rewrites[1]).not.toHaveProperty("documentText");

      const save = page.waitForRequest(
        (candidate) =>
          candidate.method() === "PATCH" &&
          candidate.url().includes(`/api/chats/${fixture.chatId}/messages/${fixture.messageId}`),
      );
      await page.getByRole("button", { name: "Save edit", exact: true }).click();
      const saved = await save;
      expect(saved.postDataJSON()).toMatchObject({ content: "Mira examines" });
      const row = page.locator(`[data-message-id="${fixture.messageId}"]`).first();
      await expect(row).toContainText("Mira examines");
      await page.screenshot({ path: info.outputPath("message-rewrite-conversation.png") });
    } finally {
      await request.delete(`/api/chats/${fixture.chatId}`).catch(() => undefined);
      await request.delete(`/api/connections/${fixture.connectionId}`).catch(() => undefined);
    }
  });

  test("roleplay caller protects pending user edits and surfaces provider and empty-response errors", async ({
    page,
    request,
  }, info) => {
    const fixture = await createFixture(request, "roleplay");
    let next: "hold" | "error" | "empty" | "success" = "hold";
    let releaseHeld: (() => void) | undefined;
    const requestBodies: Array<Record<string, unknown>> = [];
    await page.route("**/api/agents/suite/rewrite-message", async (route) => {
      requestBodies.push(route.request().postDataJSON());
      const behavior = next;
      if (behavior === "hold") await new Promise<void>((resolve) => (releaseHeld = resolve));
      if (behavior === "error") {
        await route.fulfill({ status: 502, json: { error: "Synthetic provider failure" } });
      } else if (behavior === "empty") {
        await route.fulfill({ status: 502, json: { error: "Provider returned empty text" } });
      } else {
        await route.fulfill({
          json: { rewrittenText: behavior === "hold" ? "Late provider draft" : "Roleplay saved prose" },
        });
      }
    });
    try {
      await setupPage(page, fixture.chatId, info.project.name === "desktop-chromium" ? "light" : "dark");
      const editor = await openEditor(
        page,
        "roleplay",
        fixture.messageId,
        draft,
        info.project.name.startsWith("mobile-"),
      );
      await page.getByRole("button", { name: "AI Rewrite", exact: true }).click();
      const pending = page.getByRole("button", { name: "Apply to draft", exact: true }).click();
      await expect.poll(() => requestBodies.length).toBe(1);
      await editor.fill("A newer user correction kept intact.");
      releaseHeld?.();
      await pending;
      await expect(page.getByRole("alert")).toContainText("draft changed while the rewrite was running");
      await expect(editor).toHaveValue("A newer user correction kept intact.");

      next = "error";
      await page.getByRole("button", { name: "Apply to draft", exact: true }).click();
      await expect(page.getByRole("alert")).toContainText(/Synthetic provider failure|rewrite failed/i);
      next = "empty";
      await page.getByRole("button", { name: "Apply to draft", exact: true }).click();
      await expect(page.getByRole("alert")).toBeVisible();

      next = "success";
      await editor.fill(draft);
      await page.getByRole("button", { name: "Apply to draft", exact: true }).click();
      await expect(editor).toHaveValue("Roleplay saved prose");
      const save = page.waitForRequest(
        (candidate) =>
          candidate.method() === "PATCH" &&
          candidate.url().includes(`/api/chats/${fixture.chatId}/messages/${fixture.messageId}`),
      );
      await page.getByRole("button", { name: "Save edit", exact: true }).click();
      expect((await save).postDataJSON()).toMatchObject({ content: "Roleplay saved prose" });
      await page.screenshot({ path: info.outputPath("message-rewrite-roleplay.png") });
    } finally {
      releaseHeld?.();
      await request.delete(`/api/chats/${fixture.chatId}`).catch(() => undefined);
      await request.delete(`/api/connections/${fixture.connectionId}`).catch(() => undefined);
    }
  });

  for (const segment of [
    {
      kind: "narration",
      source: draft,
      visible: draft,
      replacement: "A colder wind crosses the stone bridge.",
    },
    {
      kind: "dialogue",
      source: '[Mira]: "Stay close."',
      visible: "Stay close.",
      replacement: "Keep near me.",
    },
  ] as const) {
    test(`GameNarration ${segment.kind} editor saves through its original source segment`, async ({
      page,
      request,
    }, info) => {
      const fixture = await createFixture(request, "game", segment.source);
      let rewriteRequest: Record<string, unknown> | undefined;
      await page.route("**/api/agents/suite/rewrite-message", async (route) => {
        rewriteRequest = route.request().postDataJSON();
        await route.fulfill({ json: { rewrittenText: segment.replacement } });
      });
      try {
        await setupPage(page, fixture.chatId, info.project.name === "desktop-chromium" ? "light" : "dark");
        const editor = await openEditor(
          page,
          "game",
          fixture.messageId,
          segment.visible,
          info.project.name.startsWith("mobile-"),
        );
        await expect(editor).toHaveValue(segment.visible);
        const rewriteButton = page.getByRole("button", { name: "AI Rewrite", exact: true });
        await expect(rewriteButton).toBeEnabled();
        if ((await rewriteButton.getAttribute("aria-expanded")) !== "true") {
          if (info.project.name.startsWith("mobile-")) {
            await rewriteButton.tap();
          } else {
            await rewriteButton.click();
          }
        }
        const applyButton = page.getByRole("button", { name: "Apply to draft", exact: true });
        await expect(applyButton).toBeVisible();
        if (info.project.name.startsWith("mobile-")) {
          await applyButton.tap();
        } else {
          await applyButton.click();
        }
        await expect.poll(() => rewriteRequest).toBeDefined();
        await expect(editor).toHaveValue(segment.replacement);
        expect(rewriteRequest).toMatchObject({ connectionId: fixture.connectionId, selectedText: segment.visible });

        const metadataSave = page.waitForRequest(
          (candidate) =>
            candidate.method() === "PATCH" &&
            candidate.url().endsWith(`/api/chats/${fixture.chatId}/metadata`) &&
            Object.keys(candidate.postDataJSON() as Record<string, unknown>).some((key) =>
              key.startsWith(`segmentEdit:${fixture.messageId}:`),
            ),
        );
        await page.getByTitle("Save", { exact: true }).click();
        const saved = await metadataSave;
        const payload = saved.postDataJSON() as Record<string, unknown>;
        const segmentEdit = Object.entries(payload).find(([key]) =>
          key.startsWith(`segmentEdit:${fixture.messageId}:`),
        );
        expect(segmentEdit, "GameNarration must retain the native source message and segment identity").toBeTruthy();
        expect(segmentEdit?.[1]).toMatchObject({ content: segment.replacement });
        await expect(page.locator('[data-component="GameNarration.ActivePanel"]')).toContainText(segment.replacement);
        await page.screenshot({ path: info.outputPath(`message-rewrite-game-${segment.kind}.png`) });
      } finally {
        await request.delete(`/api/chats/${fixture.chatId}`).catch(() => undefined);
        await request.delete(`/api/connections/${fixture.connectionId}`).catch(() => undefined);
      }
    });
  }
});
