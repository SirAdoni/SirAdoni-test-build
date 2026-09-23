import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

test("NPC category moves preserve the card and work in the library and editor", async ({ page, request }, testInfo) => {
  await page.addInitScript((appVersion) => {
    localStorage.setItem("marinara:whats-new:seen-version", appVersion);
    localStorage.setItem(
      "marinara-engine-ui",
      JSON.stringify({
        state: {
          hasCompletedOnboarding: true,
          sidebarOpen: false,
          rightPanelOpen: false,
          chatHelpSeenModes: ["conversation", "roleplay", "game"],
        },
        version: 97,
      }),
    );
  }, version);
  const response = await request.post("/api/characters", {
    data: {
      data: {
        name: `NPC organization ${Date.now()}`,
        description: "An independently described weaver.",
        extensions: {
          marinara: { gameNpc: { autoCreated: true, gameId: "fixture", npcId: "npc:weaver", sourceChatId: "fixture" } },
        },
      },
    },
  });
  expect(response.ok()).toBeTruthy();
  const card = (await response.json()) as { id: string; data: string };
  const name = JSON.parse(card.data).name;
  try {
    await page.goto("/");
    await page.evaluate(async () => {
      const { useUIStore } = (await import("/src/stores/ui.store.ts" as string)) as {
        useUIStore: { getState: () => { openCharacterLibrary: () => void } };
      };
      useUIStore.getState().openCharacterLibrary();
    });
    const library = page.locator('[data-component="CharacterLibraryView"]');
    await expect(library).toBeVisible();
    const filters = library.getByRole("group", { name: "Library category" });
    await expect(library.getByText(name, { exact: true })).toHaveCount(0);
    await filters.getByRole("button", { name: "NPCs", exact: true }).click();
    await expect(library.getByText(name, { exact: true }).first()).toBeVisible();
    await page.evaluate(async (id) => {
      const { useUIStore } = (await import("/src/stores/ui.store.ts" as string)) as {
        useUIStore: { getState: () => { openCharacterDetail: (id: string) => void } };
      };
      useUIStore.getState().openCharacterDetail(id);
    }, card.id);
    const editor = page.locator(".mari-editor-shell");
    await expect(editor.getByLabel("Library category")).toHaveValue("npcs");
    await expect(editor.getByRole("button", { name: "Build NPC profile" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("npc-category-editor.png") });
    await editor.getByLabel("Library category").selectOption("characters");
    await expect(editor.getByRole("button", { name: "Build NPC profile" })).toBeDisabled();
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect
      .poll(
        async () =>
          JSON.parse((await (await request.get(`/api/characters/${card.id}`)).json()).data).extensions.libraryCategory,
      )
      .toBe("characters");
    await expect(editor.getByRole("button", { name: "Build NPC profile" })).toBeEnabled();
    await editor.getByLabel("Library category").selectOption("npcs");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect
      .poll(
        async () =>
          JSON.parse((await (await request.get(`/api/characters/${card.id}`)).json()).data).extensions.libraryCategory,
      )
      .toBe("npcs");
    const saved = await (await request.get(`/api/characters/${card.id}`)).json();
    expect(saved.id).toBe(card.id);
    expect(JSON.parse(saved.data).description).toBe("An independently described weaver.");
  } finally {
    await request.delete(`/api/characters/${card.id}`);
  }
});
