import { expect, test } from "./wiki-feature-fixture";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
test.use({
  wikiFeatures: {
    campaignMemory: true,
    campaignWiki: false,
    familyTree: false,
    factionWeb: false,
    gameCalendar: false,
    worldHistory: true,
  },
});

for (const theme of ["light", "dark"] as const) {
  test(`World History opens in Game Mode and persists event archive actions (${theme})`, async ({
    page,
    request,
  }, testInfo) => {
    const fixtureId = Math.random().toString(36).slice(2, 10);
    const title = `World History fixture ${fixtureId}`;
    const description = "A synthetic historical note created by the browser test.";
    const createResponse = await request.post("/api/chats", {
      data: { name: `World History UI ${fixtureId}`, mode: "game", characterIds: [] },
    });
    expect(createResponse.ok()).toBeTruthy();
    const chat = await createResponse.json();

    const blockedUnapprovedMutations: string[] = [];
    try {
      const setupResponse = await request.patch(`/api/chats/${chat.id}/metadata`, {
        data: {
          gameId: chat.id,
          gameSessionStatus: "active",
          gameIntroPresented: true,
          enableAgents: false,
          gameImageAutoGenerationEnabled: false,
        },
      });
      expect(setupResponse.ok()).toBeTruthy();

      let appOrigin = "";
      const mutationPath = `/api/game/${chat.id}/memory/world-history/mutations`;
      await page.route("**/*", async (route) => {
        const request = route.request();
        const method = request.method().toUpperCase();
        if (["GET", "HEAD", "OPTIONS"].includes(method)) {
          await route.fallback();
          return;
        }

        const url = new URL(request.url());
        if (
          appOrigin &&
          url.origin === appOrigin &&
          url.pathname === "/api/characters/summaries" &&
          method === "POST"
        ) {
          const body: unknown = request.postDataJSON();
          if (
            body &&
            typeof body === "object" &&
            Object.keys(body).length === 1 &&
            "ids" in body &&
            Array.isArray(body.ids) &&
            body.ids.every((id) => typeof id === "string")
          ) {
            await route.fallback();
            return;
          }
        }
        if (
          appOrigin &&
          url.origin === appOrigin &&
          url.pathname === "/api/connections/refresh-local-context" &&
          method === "POST"
        ) {
          // Keep automatic local-provider metadata probes out of this deterministic UI fixture.
          await route.fulfill({ json: { updated: [] } });
          return;
        }
        let isSyntheticWorldHistoryWrite = false;
        if (appOrigin && url.origin === appOrigin && url.pathname === mutationPath && method === "POST") {
          try {
            const body = request.postDataJSON() as Record<string, unknown>;
            const input = body.input && typeof body.input === "object" ? (body.input as Record<string, unknown>) : {};
            const patch = body.patch && typeof body.patch === "object" ? (body.patch as Record<string, unknown>) : {};
            const inputAttributes =
              input.attributes && typeof input.attributes === "object"
                ? (input.attributes as Record<string, unknown>)
                : {};
            const patchAttributes =
              patch.attributes && typeof patch.attributes === "object"
                ? (patch.attributes as Record<string, unknown>)
                : {};
            const archiveChange =
              body.action === "update" &&
              body.recordType === "entity" &&
              typeof body.recordId === "string" &&
              body.recordId.startsWith("world-history-") &&
              body.reason === "Change world history archive status" &&
              (patch.status === "active" || patch.status === "archived");
            const authoredEdit =
              body.action === "update" &&
              body.recordType === "entity" &&
              typeof body.recordId === "string" &&
              body.recordId.startsWith("world-history-") &&
              body.reason === "Edit manually authored world history" &&
              Object.hasOwn(patchAttributes, "worldHistory");
            const authoredCreate =
              body.action === "create" &&
              body.recordType === "entity" &&
              body.reason === "Add manually authored world history" &&
              typeof input.entityId === "string" &&
              input.entityId.startsWith("world-history-") &&
              input.kind === "note" &&
              Object.hasOwn(inputAttributes, "worldHistory");
            isSyntheticWorldHistoryWrite = archiveChange || authoredEdit || authoredCreate;
          } catch {
            // Malformed or unexpected mutation payloads remain blocked.
          }
        }

        if (isSyntheticWorldHistoryWrite) {
          await route.fallback();
          return;
        }

        blockedUnapprovedMutations.push(`${method} ${url.origin}${url.pathname}`);
        await route.abort("blockedbyclient");
      });
      await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
      await seedUIState(page, {
        hasCompletedOnboarding: true,
        chatHelpSeenModes: ["conversation", "roleplay", "game"],
        sidebarOpen: false,
        rightPanelOpen: false,
        theme,
      });
      await page.addInitScript(
        ({ id, appVersion }) => {
          localStorage.setItem("marinara-active-chat-id", id);
          localStorage.setItem("marinara:whats-new:seen-version", appVersion);
        },
        { id: chat.id, appVersion: version },
      );
      await page.goto("/");
      appOrigin = new URL(page.url()).origin;

      const openWorldHistory = async () => {
        if (testInfo.project.name.startsWith("mobile"))
          await page.getByRole("button", { name: "Game actions", exact: true }).click();
        const button = page.getByRole("button", { name: "Open world history", exact: true });
        await expect(button).toBeVisible();
        await button.click();
      };

      await openWorldHistory();
      // The modal fixture contains deterministic load-error and revision-conflict scenarios;
      // this test proves the real app launch and empty-to-persisted workflow.
      await expect(page.getByText("No events match this view.", { exact: false })).toBeVisible();
      await page.getByRole("button", { name: "Add historical event", exact: true }).click();
      await page.getByLabel("Event title", { exact: true }).fill(title);
      await page.getByLabel("Description", { exact: true }).fill(description);
      await page.getByRole("button", { name: "Save event", exact: true }).click();
      await expect(page.getByRole("button", { name: title, exact: true })).toBeVisible();
      await expect(
        page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
      ).resolves.toBe(true);

      await page.reload();
      await openWorldHistory();
      const event = page.getByRole("button", { name: title, exact: true });
      await expect(event).toBeVisible();
      await page.getByRole("button", { name: "Archive", exact: true }).click();
      await page.getByRole("button", { name: "Confirm", exact: true }).click();
      await expect(page.getByText("0 historical events", { exact: true })).toBeVisible();
      await page.getByLabel("Include archived events").check();
      await expect(event).toBeVisible();
      await page.getByRole("button", { name: "Restore", exact: true }).click();
      await page.getByRole("button", { name: "Confirm", exact: true }).click();
      await page.getByLabel("Include archived events").uncheck();
      await expect(event).toBeVisible();
      expect(blockedUnapprovedMutations).toEqual([]);
    } finally {
      const cleanupResponse = await request.delete(`/api/chats/${chat.id}?force=true`);
      expect(cleanupResponse.ok()).toBeTruthy();
    }
  });
}
