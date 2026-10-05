import { expect, request as playwrightRequest, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;

declare global {
  interface Window {
    __promptInspectorCopied?: string;
  }
}

test("saved prompt inspection filters sections and history without changing copied messages", async ({
  page,
}, info) => {
  const baseURL = info.project.use.baseURL;
  if (baseURL !== "http://127.0.0.1:5178" && baseURL !== "http://127.0.0.1:5179") {
    throw new Error("Prompt inspector fixture requires isolated loopback test servers");
  }
  const request = await playwrightRequest.newContext({ baseURL, timeout: 10_000 });
  let chatId: string | undefined;
  let originalFeatures: Record<string, boolean> | undefined;
  let lastMessageId: string | undefined;
  try {
    await page.route("**/*", async (route) => {
      if (new URL(route.request().url()).origin !== baseURL) return route.abort();
      return route.continue();
    });
    const features = await request.get("/api/app-settings/features");
    expect(features.ok()).toBeTruthy();
    originalFeatures = (await features.json()).settings ?? {};
    const otherFeatures = { ...originalFeatures };
    delete otherFeatures.promptInspector;
    expect((await request.put("/api/app-settings/features", { data: otherFeatures })).ok()).toBeTruthy();
    const created = await request.post("/api/chats", {
      data: { name: "Prompt inspector fixture", mode: "conversation", characterIds: [] },
    });
    expect(created.ok()).toBeTruthy();
    chatId = ((await created.json()) as { id: string }).id;
    const first = await request.post(`/api/chats/${chatId}/messages`, {
      data: { role: "user", content: "A synthetic opening message." },
    });
    expect(first.ok()).toBeTruthy();
    const assistant = await request.post(`/api/chats/${chatId}/messages`, {
      data: { role: "assistant", content: "A synthetic saved assistant turn." },
    });
    expect(assistant.ok()).toBeTruthy();
    lastMessageId = ((await assistant.json()) as { id: string }).id;

    const savedSystem = "<system_prompt>\nSynthetic system instructions.\n</system_prompt>";
    const savedCharacter = "<character_info>\nSynthetic character detail.\n</character_info>";
    const authoredDialogue =
      "Authored turn marker: prompt-like text follows.\n<system_prompt>\nAuthored dialogue, not a prompt section.\n</system_prompt>";
    const savedMessages = [
      {
        role: "system",
        content: savedSystem,
      },
      { role: "system", content: savedCharacter },
      { role: "user", content: authoredDialogue },
      { role: "assistant", content: "A synthetic response in the saved history." },
    ];
    const extra = {
      cachedPrompt: savedMessages,
      generationInfo: { model: "synthetic-inspector-fixture", provider: "custom" },
    };
    const saved = await request.patch(`/api/chats/${chatId}/messages/${lastMessageId}/extra`, { data: extra });
    expect(saved.ok()).toBeTruthy();

    let promptRequests = 0;
    let advancedRequests = false;
    await page.route(`**/api/chats/${chatId}/peek-prompt`, async (route) => {
      if (!advancedRequests) return route.continue();
      promptRequests++;
      if (promptRequests === 1) return route.continue();
      if (promptRequests === 2) {
        return route.fulfill({
          json: { source: "raw_messages", exact: false, messages: [], parameters: {} },
        });
      }
      return route.fulfill({ status: 503, json: { error: "Synthetic prompt retrieval failed" } });
    });
    await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
    await page.addInitScript(
      ({ chatId, version }) => {
        localStorage.setItem("marinara-active-chat-id", chatId);
        localStorage.setItem("marinara:whats-new:seen-version", version);
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: async (text: string) => (window.__promptInspectorCopied = text) },
        });
      },
      { chatId, version },
    );
    await seedUIState(page, {
      hasCompletedOnboarding: true,
      sidebarOpen: false,
      rightPanelOpen: false,
      chatHelpSeenModes: ["conversation", "roleplay", "game"],
    });
    await page.goto("/");
    const message = page.locator(`[data-message-id="${lastMessageId}"]`).first();
    await expect(message).toBeVisible();
    const mobile = info.project.name.includes("mobile");
    let mobileActionsOpened = false;
    const openInspector = async () => {
      if (!mobile) await message.hover();
      else if (!mobileActionsOpened) {
        await message.getByText("A synthetic saved assistant turn.", { exact: true }).tap();
        mobileActionsOpened = true;
      }
      const button = message.getByRole("button", { name: "Peek prompt", exact: true });
      if (mobile) await button.tap();
      else await button.click();
    };

    await openInspector();
    const panel = page.locator("[data-chat-floating-panel]").filter({ hasText: "Assembled Prompt" }).first();
    await expect(panel).toBeVisible();
    await expect(panel.getByText("Saved Engine input (text view)", { exact: true })).toBeVisible();
    await expect(panel.getByRole("searchbox", { name: "Search prompt text" })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Copy text messages", exact: true })).toHaveCount(0);
    expect(
      (
        await request.put("/api/app-settings/features", {
          data: { ...otherFeatures, promptInspector: true },
        })
      ).ok(),
    ).toBeTruthy();
    advancedRequests = true;
    mobileActionsOpened = false;
    await page.reload();
    await expect(message).toBeVisible();
    await openInspector();
    await expect(panel.getByRole("searchbox", { name: "Search prompt text" })).toBeVisible();

    await expect(panel.getByText(savedSystem, { exact: true })).toHaveCount(0);
    const sectionLabels = await panel
      .getByRole("button")
      .evaluateAll((buttons) =>
        buttons
          .map((button) => button.querySelector("span")?.textContent?.trim())
          .filter((label) => label === "System Prompt" || label === "Character Info"),
      );
    expect(sectionLabels).toEqual(["System Prompt", "Character Info"]);
    await panel.getByRole("button", { name: /^System Prompt/ }).click();
    await expect(panel.getByText(savedSystem, { exact: true })).toBeVisible();

    const scope = panel.getByRole("combobox", { name: "Filter prompt content" });
    await scope.selectOption("sections");
    const search = panel.getByRole("searchbox", { name: "Search prompt text" });
    await search.fill("character detail");
    await expect(panel.getByRole("button", { name: /^Character Info/ })).toBeVisible();
    await expect(panel.getByRole("button", { name: /^System Prompt/ })).toHaveCount(0);
    await search.fill("");
    await scope.selectOption("chat-history");
    await expect(panel.getByRole("button", { name: /^Chat History/ })).toBeVisible();
    await panel.getByRole("button", { name: /^Chat History/ }).click();
    const historyRows = panel.getByRole("button").filter({ hasText: /Authored turn marker|synthetic response/ });
    await expect(historyRows).toHaveCount(2);
    const historyLabels = await historyRows.allTextContents();
    expect(historyLabels[0]).toContain("Authored turn marker");
    expect(historyLabels[1]).toContain("synthetic response");
    await historyRows.first().click();
    await expect(panel.getByText(authoredDialogue, { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: /^System Prompt/ })).toHaveCount(0);

    await panel.getByRole("button", { name: "Close assembled prompt", exact: true }).click();
    await openInspector();
    await expect(panel.getByText("No prompt content matches these filters.", { exact: true })).toBeVisible();
    await expect(panel.getByText("Raw message preview (approximate)", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Close assembled prompt", exact: true }).click();
    await openInspector();
    await expect(page.getByText("Synthetic prompt retrieval failed", { exact: true })).toBeVisible();
    await expect(panel).toBeHidden();
    expect(promptRequests).toBe(3);

    // Reopen the persisted cached prompt to verify copy uses the original ordered role/content array.
    await page.unroute(`**/api/chats/${chatId}/peek-prompt`);
    await openInspector();
    await expect(panel.getByText("Saved Engine input (text view)", { exact: true })).toBeVisible();
    await panel.getByRole("combobox", { name: "Filter prompt content" }).selectOption("sections");
    await panel.getByRole("searchbox", { name: "Search prompt text" }).fill("character detail");
    await panel.getByRole("button", { name: "Copy text messages", exact: true }).click();
    await expect(panel.getByRole("status").filter({ hasText: "Copied" })).toBeVisible();
    const copied = await page.evaluate(() => window.__promptInspectorCopied);
    expect(copied).toBe(JSON.stringify(savedMessages, null, 2));

    if (mobile) {
      const bounds = await panel.locator(":scope > div").boundingBox();
      const viewportWidth = page.viewportSize()?.width ?? 0;
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewportWidth);
      await expect(panel.getByRole("searchbox", { name: "Search prompt text" })).toBeVisible();
      await expect(panel.getByRole("button", { name: "Copy text messages", exact: true })).toBeVisible();
    }

    expect(
      (
        await request.put("/api/app-settings/features", {
          data: { ...otherFeatures, promptInspector: false },
        })
      ).ok(),
    ).toBeTruthy();
    mobileActionsOpened = false;
    await page.reload();
    await expect(message).toBeVisible();
    await openInspector();
    await expect(panel.getByText("Saved Engine input (text view)", { exact: true })).toBeVisible();
    await expect(panel.getByRole("searchbox", { name: "Search prompt text" })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Copy text messages", exact: true })).toHaveCount(0);
    const retained = await request.post(`/api/chats/${chatId}/peek-prompt`, { data: { messageId: lastMessageId } });
    expect(retained.ok()).toBeTruthy();
    expect((await retained.json()).messages).toEqual(savedMessages);
  } finally {
    const failures: unknown[] = [];
    if (chatId) {
      try {
        expect((await request.delete(`/api/chats/${chatId}?force=true`)).ok()).toBeTruthy();
      } catch (error) {
        failures.push(error);
      }
    }
    if (originalFeatures) {
      try {
        expect((await request.put("/api/app-settings/features", { data: originalFeatures })).ok()).toBeTruthy();
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await request.dispose();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, "Prompt inspector cleanup failed");
  }
});
