import { expect, test, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

for (const mode of ["roleplay", "conversation"] as const) {
  test(`${mode} guided regeneration consumes only its own composer draft`, async ({ page, request }, testInfo) => {
    const chatIds: string[] = [];
    let pending: Route | undefined;
    let requests = 0;
    try {
      for (const name of ["Guided regeneration", "Other draft"]) {
        const response = await request.post("/api/chats", { data: { name, mode, characterIds: [] } });
        expect(response.ok(), await response.text()).toBeTruthy();
        chatIds.push((await response.json()).id);
      }
      const chatId = chatIds[0]!;
      const saved = await request.post(`/api/chats/${chatId}/messages`, {
        data: { role: "assistant", content: "An original response awaiting a new direction." },
      });
      expect(saved.ok()).toBeTruthy();
      const message = await saved.json();
      await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
      await page.route("**/api/generate", (route) => {
        pending = route;
        requests += 1;
      });
      await seedUIState(page, {
        hasCompletedOnboarding: true,
        sidebarOpen: false,
        rightPanelOpen: false,
        guideGenerations: true,
        chatHelpSeenModes: ["conversation", "roleplay", "game"],
        enableStreaming: false,
      });
      await page.addInitScript(
        ({ chatId, version }) => {
          localStorage.setItem("marinara-active-chat-id", chatId);
          localStorage.setItem("marinara:whats-new:seen-version", version);
        },
        { chatId, version },
      );
      await page.goto("/");
      await page.getByRole("button", { name: "Chats", exact: true }).click();
      const mobile = testInfo.project.name.includes("mobile");
      if (mobile) await page.getByRole("button", { name: "Close chats", exact: true }).click();
      const composer = page.locator("textarea[data-chat-composer]");
      const row = page.locator(`[data-message-id="${message.id}"]`);
      const confirm = page.getByRole("dialog", { name: "Regenerate Message", exact: true });
      const regenerate = async () => {
        await row.focus();
        await row.getByRole("button", { name: "Regenerate (guided)", exact: true }).click();
        if (mobile) await confirm.getByRole("button", { name: "Regenerate", exact: true }).click();
      };
      const settled = () =>
        expect
          .poll(() =>
            page.evaluate(async (id) => {
              const { useChatStore } = await import("/src/stores/chat.store.ts" as string);
              return useChatStore.getState().abortControllers.has(id);
            }, chatId),
          )
          .toBe(false);
      const fail = async () => {
        const route = pending!;
        pending = undefined;
        await route.fulfill({ status: 503, json: { error: "Synthetic guided regeneration failure." } });
        await settled();
      };
      const succeed = async () => {
        const route = pending!;
        pending = undefined;
        await route.fulfill({
          contentType: "text/event-stream",
          body: [
            { type: "token", data: message.content },
            { type: "message_saved", data: message },
            { type: "done", data: {} },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(""),
        });
        await settled();
      };
      const switchChat = async (id: string) => {
        await page.evaluate(async (chatId) => {
          const { useChatStore } = await import("/src/stores/chat.store.ts" as string);
          useChatStore.getState().setActiveChatId(chatId);
        }, id);
        await expect(composer).toHaveAttribute("data-chat-id", id);
      };

      await composer.fill("  Let the lantern flicker.  ");
      if (mobile) {
        await row.focus();
        await row.getByRole("button", { name: "Regenerate (guided)", exact: true }).click();
        await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(composer).toHaveValue("  Let the lantern flicker.  ");
        expect(requests).toBe(0);
      }
      await page.screenshot({ path: testInfo.outputPath("guidance-before.png") });
      await regenerate();
      await expect.poll(() => requests).toBe(1);
      expect(pending!.request().postDataJSON()).toMatchObject({
        chatId,
        regenerateMessageId: message.id,
        generationGuideSource: "guide",
        generationGuide: expect.stringContaining("Let the lantern flicker."),
      });
      await expect(composer).toHaveValue("");
      await page.screenshot({ path: testInfo.outputPath("guidance-consumed.png") });
      await fail();
      await expect(composer).toHaveValue("  Let the lantern flicker.  ");

      // Late success and failure must leave a draft typed after the click intact.
      for (const [index, finish] of [succeed, fail].entries()) {
        await regenerate();
        await expect.poll(() => requests).toBe(index + 2);
        await expect(composer).toHaveValue("");
        await composer.fill(`My next reply ${index}.`);
        await row.focus();
        await row.getByRole("button", { name: "Regenerate (guided)", exact: true }).click();
        await expect(confirm).toBeHidden();
        await expect(composer).toHaveValue(`My next reply ${index}.`);
        expect(requests).toBe(index + 2);
        await finish();
        await expect(composer).toHaveValue(`My next reply ${index}.`);
      }

      // A failed background attempt restores only the originating chat's empty draft.
      await regenerate();
      await expect.poll(() => requests).toBe(4);
      await expect(composer).toHaveValue("");
      await switchChat(chatIds[1]!);
      await composer.fill("Keep the other chat's draft.");
      await fail();
      await expect(composer).toHaveValue("Keep the other chat's draft.");
      await switchChat(chatId);
      await expect(composer).toHaveValue("My next reply 1.");

      // Guidance stays consumed after a successful background regeneration, including reload.
      await regenerate();
      await expect.poll(() => requests).toBe(5);
      await expect(composer).toHaveValue("");
      await switchChat(chatIds[1]!);
      await succeed();
      await expect(composer).toHaveValue("Keep the other chat's draft.");
      await switchChat(chatId);
      await expect(composer).toHaveValue("");
      await page.reload();
      await expect(composer).toHaveValue("");

      // Turning guidance off means regeneration must not touch the composer.
      await page.evaluate(async () => {
        const { useUIStore } = await import("/src/stores/ui.store.ts" as string);
        useUIStore.getState().setGuideGenerations(false);
        useUIStore.getState().setTheme("light");
      });
      await composer.fill("An unrelated normal draft.");
      await row.focus();
      await row.getByRole("button", { name: "Regenerate", exact: true }).click();
      if (mobile) await confirm.getByRole("button", { name: "Regenerate", exact: true }).click();
      await expect.poll(() => requests).toBe(6);
      expect(pending!.request().postDataJSON().generationGuide).toBeUndefined();
      await expect(composer).toHaveValue("An unrelated normal draft.");
      await succeed();
      await expect(composer).toHaveValue("An unrelated normal draft.");
      await page.screenshot({ path: testInfo.outputPath("normal-draft-preserved-light.png") });

      if (mobile) {
        await page.evaluate(async () => {
          const { useUIStore } = await import("/src/stores/ui.store.ts" as string);
          useUIStore.getState().setGuideGenerations(true);
        });
        await row.focus();
        await row.getByRole("button", { name: "Regenerate (guided)", exact: true }).click();
        await switchChat(chatIds[1]!);
        await confirm.getByRole("button", { name: "Regenerate", exact: true }).click();
        await expect(confirm).toBeHidden();
        await expect(composer).toHaveValue("Keep the other chat's draft.");
        expect(requests).toBe(6);
      }
    } finally {
      if (pending) await pending.abort().catch(() => {});
      await page.close();
      for (const chatId of chatIds) {
        const removed = await request.delete(`/api/chats/${chatId}`);
        expect(removed.ok(), await removed.text()).toBeTruthy();
      }
    }
  });
}
