import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, request as playwrightRequest, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { seedUIState } from "./ui-state-fixture";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

type NotebookTarget =
  { scope: "global" } | { scope: "character"; characterId: string } | { scope: "chat" } | { scope: "branch-family" };

type NotebookDocument = {
  target: NotebookTarget;
  content: string;
  revision: number;
  updatedAt: string | null;
};

type NotebookContext = {
  chatId: string;
  mode: "game";
  groupId: string | null;
  characterIds: string[];
  documents: NotebookDocument[];
};

function targetKey(target: NotebookTarget): string {
  return target.scope === "character" ? `character:${target.characterId}` : target.scope;
}

test("Private Notebook saves isolated scopes, survives reload, and protects drafts on conflict", async ({
  page,
}, testInfo) => {
  const runId = randomUUID();
  const baseURL = testInfo.project.use.baseURL;
  if (typeof baseURL !== "string") throw new Error("Playwright project must define baseURL");
  if (baseURL !== "http://127.0.0.1:5178" && baseURL !== "http://127.0.0.1:5179") {
    throw new Error("Private Notebook fixture requires the isolated loopback test servers");
  }

  // This independent API context stays available for cleanup if the test body times out.
  const cleanupRequest: APIRequestContext = await playwrightRequest.newContext({ baseURL, timeout: 10_000 });
  let characterId: string | null = null;
  let originalFeatureSettings: Record<string, boolean> | null = null;
  let chatId: string | null = null;
  const nonLocalRequests: string[] = [];
  const generationRequests: string[] = [];
  const cleanupFailures: string[] = [];

  const attemptCleanup = async (label: string, action: () => Promise<{ status(): number }>, expectedStatus: number) => {
    try {
      const response = await action();
      if (response.status() !== expectedStatus) {
        cleanupFailures.push(`${label}: expected HTTP ${expectedStatus}, received ${response.status()}`);
      }
    } catch (error) {
      cleanupFailures.push(`${label}: ${String(error)}`);
    }
  };

  try {
    const featureSettingsResponse = await cleanupRequest.get("/api/app-settings/features");
    expect(featureSettingsResponse.ok()).toBeTruthy();
    const featureSettings = (await featureSettingsResponse.json()) as { settings?: Record<string, boolean> };
    originalFeatureSettings = featureSettings.settings ?? {};
    const enabledNotebook = await cleanupRequest.put("/api/app-settings/features", {
      data: { ...originalFeatureSettings, privateNotebook: true },
    });
    expect(enabledNotebook.ok()).toBeTruthy();
    const characterResponse = await cleanupRequest.post("/api/characters", {
      data: {
        data: {
          name: `Private Notebook E2E ${runId.slice(0, 8)}`,
          description: "Synthetic character owned by the private notebook browser regression.",
          creator: "Codex E2E",
          tags: ["test-fixture"],
        },
      },
    });
    expect(characterResponse.ok()).toBeTruthy();
    characterId = ((await characterResponse.json()) as { id: string }).id;

    const groupId = `private-notebook-e2e-${runId}`;
    const chatResponse = await cleanupRequest.post("/api/chats", {
      data: {
        name: `Private Notebook E2E ${runId.slice(0, 8)}`,
        mode: "game",
        groupId,
        characterIds: [characterId],
      },
    });
    expect(chatResponse.ok()).toBeTruthy();
    chatId = ((await chatResponse.json()) as { id: string }).id;
    const setupResponse = await cleanupRequest.patch(`/api/chats/${chatId}/metadata`, {
      data: {
        conversationSetupComplete: true,
        enableAgents: false,
        enableTools: false,
        gameId: chatId,
        gameSessionStatus: "active",
        gameIntroPresented: true,
      },
    });
    expect(setupResponse.ok()).toBeTruthy();

    const notebookPath = `/api/private-notebook/chats/${chatId}`;
    const readContext = async (): Promise<NotebookContext> => {
      const response = await cleanupRequest.get(notebookPath);
      expect(response.ok()).toBeTruthy();
      return (await response.json()) as NotebookContext;
    };
    const readDocument = async (target: NotebookTarget): Promise<NotebookDocument> => {
      const context = await readContext();
      const document = context.documents.find((candidate) => targetKey(candidate.target) === targetKey(target));
      if (!document) throw new Error(`Notebook scope missing from context: ${targetKey(target)}`);
      return document;
    };

    // Keep every browser request on loopback. Native regression coverage owns prompt/Mari data-flow proof;
    // this UI fixture performs no generation and gives the app no external provider route.
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1") {
        await route.continue();
      } else {
        nonLocalRequests.push(url.origin);
        await route.abort("blockedbyclient");
      }
    });
    page.on("request", (browserRequest) => {
      const url = new URL(browserRequest.url());
      if (browserRequest.method() === "POST" && /\/api\/generate(?:\/|$)/u.test(url.pathname)) {
        generationRequests.push(url.pathname);
      }
    });
    await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
    await seedUIState(page, {
      hasCompletedOnboarding: true,
      chatHelpSeenModes: ["conversation", "roleplay", "game"],
      sidebarOpen: false,
      rightPanelOpen: false,
      theme: "dark",
      appAccentPulseMode: false,
    });
    await page.addInitScript(
      ({ id, version: appVersion }) => {
        localStorage.setItem("marinara-active-chat-id", id);
        localStorage.setItem("marinara:whats-new:seen-version", appVersion);
      },
      { id: chatId, version },
    );
    await page.goto("/");

    if (testInfo.project.name === "mobile-chromium") {
      await page.getByRole("button", { name: "Game actions", exact: true }).click();
    }
    await page.getByRole("button", { name: "Private Notebook", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Private Notebook" });
    await expect(dialog).toBeVisible();
    const scope = dialog.getByRole("combobox", { name: "Scope", exact: true });
    const notes = dialog.getByRole("textbox", { name: "Notes", exact: true });

    const savedValues = new Map<string, { target: NotebookTarget; content: string }>();
    const saveScope = async (target: NotebookTarget, scopeValue: NotebookTarget["scope"], value: string) => {
      await scope.selectOption(scopeValue);
      await notes.fill(value);
      await expect.poll(async () => (await readDocument(target)).content).toBe(value);
      await expect(dialog.getByText("Saved", { exact: true })).toBeVisible();
      savedValues.set(targetKey(target), { target, content: value });
    };

    await saveScope({ scope: "global" }, "global", "Synthetic global note");
    await saveScope({ scope: "character", characterId }, "character", "Synthetic character note");
    await saveScope({ scope: "chat" }, "chat", "Synthetic chat note");
    await saveScope({ scope: "branch-family" }, "branch-family", "Synthetic campaign note");

    for (const { target, content } of savedValues.values()) {
      await scope.selectOption(target.scope);
      await expect(notes).toHaveValue(content);
    }

    // A separate API client advances the real stored revision while this panel retains its older draft.
    const chatTarget: NotebookTarget = { scope: "chat" };
    const firstConcurrentState = await readDocument(chatTarget);
    const firstConcurrentWrite = await cleanupRequest.put(notebookPath, {
      data: {
        target: chatTarget,
        content: "Concurrent synthetic update",
        expectedRevision: firstConcurrentState.revision,
      },
    });
    expect(firstConcurrentWrite.ok()).toBeTruthy();
    await scope.selectOption("chat");
    await notes.fill("Draft retained after conflict");
    await expect(dialog.getByText("Saved notes changed elsewhere", { exact: true })).toBeVisible();
    await expect(notes).toHaveValue("Draft retained after conflict");
    await dialog.getByRole("button", { name: "Reload saved", exact: true }).click();
    await expect(notes).toHaveValue("Concurrent synthetic update");

    const secondConcurrentState = await readDocument(chatTarget);
    const secondConcurrentWrite = await cleanupRequest.put(notebookPath, {
      data: {
        target: chatTarget,
        content: "Second concurrent synthetic update",
        expectedRevision: secondConcurrentState.revision,
      },
    });
    expect(secondConcurrentWrite.ok()).toBeTruthy();
    await notes.fill("Explicitly chosen draft");
    await expect(dialog.getByText("Saved notes changed elsewhere", { exact: true })).toBeVisible();
    await expect(notes).toHaveValue("Explicitly chosen draft");
    await dialog.getByRole("button", { name: "Save mine", exact: true }).click();
    await expect.poll(async () => (await readDocument(chatTarget)).content).toBe("Explicitly chosen draft");

    await page.reload();
    if (testInfo.project.name === "mobile-chromium") {
      await page.getByRole("button", { name: "Game actions", exact: true }).click();
    }
    await page.getByRole("button", { name: "Private Notebook", exact: true }).click();
    const reloadedDialog = page.getByRole("dialog", { name: "Private Notebook" });
    const reloadedScope = reloadedDialog.getByRole("combobox", { name: "Scope", exact: true });
    const reloadedNotes = reloadedDialog.getByRole("textbox", { name: "Notes", exact: true });
    for (const { target, content } of savedValues.values()) {
      await reloadedScope.selectOption(target.scope);
      await expect(reloadedNotes).toHaveValue(target.scope === "chat" ? "Explicitly chosen draft" : content);
    }

    const disabledNotebook = await cleanupRequest.put("/api/app-settings/features", {
      data: { ...originalFeatureSettings, privateNotebook: false },
    });
    expect(disabledNotebook.ok()).toBeTruthy();
    await page.reload();
    if (testInfo.project.name === "mobile-chromium") {
      await page.getByRole("button", { name: "Game actions", exact: true }).click();
    }
    await expect(page.getByRole("button", { name: "Private Notebook", exact: true })).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "Private Notebook" })).toHaveCount(0);
    expect((await cleanupRequest.get(`/api/private-notebook/chats/${chatId}`)).status()).toBe(403);
    const reenabledNotebook = await cleanupRequest.put("/api/app-settings/features", {
      data: { ...originalFeatureSettings, privateNotebook: true },
    });
    expect(reenabledNotebook.ok()).toBeTruthy();
    for (const { target, content } of savedValues.values()) {
      expect((await readDocument(target)).content).toBe(target.scope === "chat" ? "Explicitly chosen draft" : content);
    }

    expect(nonLocalRequests).toEqual([]);
    expect(generationRequests).toEqual([]);
  } finally {
    // Attempt every deletion and absence check independently; one failure never skips later cleanup.
    if (chatId) {
      await attemptCleanup(
        `delete chat ${chatId}`,
        () => cleanupRequest.delete(`/api/chats/${chatId}?force=true`),
        204,
      );
      await attemptCleanup(`verify deleted chat ${chatId}`, () => cleanupRequest.get(`/api/chats/${chatId}`), 404);
    }
    if (characterId) {
      await attemptCleanup(
        `delete character ${characterId}`,
        () => cleanupRequest.delete(`/api/characters/${characterId}`),
        204,
      );
      await attemptCleanup(
        `verify deleted character ${characterId}`,
        () => cleanupRequest.get(`/api/characters/${characterId}`),
        404,
      );
    }
    if (originalFeatureSettings) {
      await attemptCleanup(
        "restore feature settings",
        () =>
          cleanupRequest.put("/api/app-settings/features", {
            data: originalFeatureSettings,
          }),
        200,
      );
    }
    try {
      await cleanupRequest.dispose();
    } catch (error) {
      cleanupFailures.push(`dispose independent cleanup request context: ${String(error)}`);
    }
    if (cleanupFailures.length > 0) {
      throw new Error(`Private Notebook E2E cleanup failed: ${cleanupFailures.join("; ")}`);
    }
  }
});
