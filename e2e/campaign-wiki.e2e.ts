import { expect, test } from "./wiki-feature-fixture";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

test("Campaign Wiki searches, edits, shows pinned facts read-only, reports write errors, and opens an owner", async ({
  page,
  request,
}, testInfo) => {
  const fixtureId = Math.random().toString(36).slice(2, 10);
  const ownerName = `Wiki owner ${fixtureId}`;
  const initialName = `Wiki page ${fixtureId}`;
  const editedName = `Wiki page edited ${fixtureId}`;
  const factValue = "Keeps the harbor gate";
  const characterResponse = await request.post("/api/characters", { data: { data: { name: ownerName } } });
  expect(characterResponse.ok()).toBeTruthy();
  const character = await characterResponse.json();
  let chatId: string | undefined;
  try {
    const chatResponse = await request.post("/api/chats", {
      data: { name: `Campaign Wiki ${fixtureId}`, mode: "game", characterIds: [character.id] },
    });
    expect(chatResponse.ok()).toBeTruthy();
    const chat = await chatResponse.json();
    chatId = chat.id;
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

    const createMemoryRecord = (operationId: string, recordType: "entity" | "fact", input: unknown) =>
      request.post(`/api/game/${chat.id}/memory/mutations`, {
        data: { operationId, action: "create", recordType, reason: "seed isolated browser fixture", input },
      });
    const entityResponse = await createMemoryRecord(`wiki-e2e-entity-${fixtureId}`, "entity", {
      entityId: `wiki-e2e-${fixtureId}`,
      kind: "character",
      owner: { type: "existing", store: "characters", recordId: character.id },
      aliases: [initialName],
      tags: ["browser fixture"],
      summary: "A user-authored fixture page.",
      attributes: {},
      status: "active",
      manualLock: false,
    });
    expect(entityResponse.ok()).toBeTruthy();
    const entity = await entityResponse.json();
    const factResponse = await createMemoryRecord(`wiki-e2e-fact-${fixtureId}`, "fact", {
      subjectEntityId: entity.entityId,
      predicate: "knows",
      value: { text: factValue, pinned: true, lockedBeforePin: "authored metadata" },
      conditions: [],
      status: "verified",
      evidence: [],
      manualLock: true,
    });
    expect(factResponse.ok()).toBeTruthy();

    await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
    await seedUIState(page, {
      hasCompletedOnboarding: true,
      chatHelpSeenModes: ["conversation", "roleplay", "game"],
      sidebarOpen: false,
      rightPanelOpen: false,
      theme: testInfo.project.name.includes("dark") ? "dark" : "light",
    });
    await page.addInitScript(
      ({ id, version: appVersion }) => {
        localStorage.setItem("marinara-active-chat-id", id);
        localStorage.setItem("marinara:whats-new:seen-version", appVersion);
      },
      { id: chat.id, version },
    );
    await page.goto("/");

    if (testInfo.project.name.startsWith("mobile")) {
      await page.getByRole("button", { name: "Game actions", exact: true }).click();
    }
    await page.getByRole("button", { name: "Session", exact: true }).click();
    await page.getByRole("button", { name: "Campaign Wiki", exact: true }).click();
    const search = page.getByRole("textbox", { name: "Search people, places, lore" });
    await search.fill(initialName);
    const pageRow = page.getByRole("button", { name: `${initialName} Character`, exact: true });
    await expect(pageRow).toBeVisible();
    await pageRow.click();
    await expect(page.getByRole("heading", { name: initialName, exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill(editedName);
    await page
      .getByRole("textbox", { name: "Reason for this change", exact: true })
      .fill("Correct a synthetic browser fixture page.");
    await page.getByRole("button", { name: "Review preview", exact: true }).click();
    const applyReviewedChange = page.getByRole("button", { name: "Apply reviewed change", exact: true });
    await expect(applyReviewedChange).toBeVisible();
    await expect(applyReviewedChange).toBeEnabled();
    await applyReviewedChange.click();
    await expect(page.getByRole("heading", { name: editedName, exact: true })).toBeVisible();

    await page.getByRole("button", { name: /^Facts\s+\d+$/, exact: true }).click();
    const factRows = page.getByRole("button", { name: new RegExp(factValue) });
    await expect(factRows).toHaveCount(2);
    const factRow = factRows.last();
    await expect(factRow).toBeVisible();
    await factRow.click();

    const pinnedMarkers = page.getByLabel("Pinned", { exact: true });
    await expect(pinnedMarkers).toHaveCount(2);
    await expect(pinnedMarkers.first()).toBeVisible();
    await expect(pinnedMarkers.last()).toBeVisible();
    await expect(page.getByRole("button", { name: "Pin as canon", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Unpin", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Correct", exact: true }).click();
    await expect(page.getByRole("checkbox", { name: "Protect this record from automatic changes" })).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.locator('[data-component="campaign-wiki-fact-details"]')).toHaveCount(0);
    await factRow.click();
    await expect(page.locator('[data-component="campaign-wiki-fact-details"]')).toBeVisible();

    let rejectedFactEdit = false;
    await page.route(`**/api/game/${chat.id}/memory/mutations`, async (route) => {
      const body = route.request().postDataJSON() as {
        action?: string;
        recordType?: string;
        patch?: { status?: string };
      };
      if (
        !rejectedFactEdit &&
        body.action === "update" &&
        body.recordType === "fact" &&
        body.patch?.status === "retracted"
      ) {
        rejectedFactEdit = true;
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "CAMPAIGN_MEMORY_REVISION_CONFLICT", message: "Fixture conflict" } }),
        });
        return;
      }
      await route.continue();
    });
    await page.getByRole("button", { name: "Wrong", exact: true }).click();
    await page.getByRole("button", { name: "Mark as wrong", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("This fact changed since it was loaded");
    await expect(page.getByRole("group", { name: "Confirm marking as wrong", exact: true })).toBeVisible();
    await expect(factRow).toBeVisible();
    await expect(page.getByRole("button", { name: "Reload", exact: true })).toBeVisible();
    expect(rejectedFactEdit).toBe(true);

    const ownerLink = page.locator('[data-component="campaign-wiki-owner-link"]');
    const ownerButton = ownerLink.getByRole("button");
    await expect(ownerButton).toBeVisible();
    await ownerButton.click();
    const characterSheet = page.locator('[data-component="GameCharacterSheet"]');
    await expect(characterSheet).toBeVisible();
    await expect(characterSheet).toContainText(ownerName);
    await page.screenshot({ path: testInfo.outputPath("campaign-wiki-owner-open.png") });
  } finally {
    if (chatId) await request.delete(`/api/chats/${chatId}?force=true`);
    await request.delete(`/api/characters/${character.id}`);
  }
});

test("Campaign Wiki Factions returns to a populated page after the last later-page link ends", async ({
  page,
  request,
}, testInfo) => {
  const fixtureId = Math.random().toString(36).slice(2, 10);
  const prefix = "faction-e2e-" + fixtureId;
  const characterResponse = await request.post("/api/characters", {
    data: { data: { name: "Faction fixture " + fixtureId } },
  });
  expect(characterResponse.ok()).toBeTruthy();
  const character = await characterResponse.json();
  let chatId: string | undefined;
  try {
    const chatResponse = await request.post("/api/chats", {
      data: { name: "Faction pagination " + fixtureId, mode: "game", characterIds: [character.id] },
    });
    expect(chatResponse.ok()).toBeTruthy();
    const chat = await chatResponse.json();
    chatId = chat.id;
    const setupResponse = await request.patch("/api/chats/" + chat.id + "/metadata", {
      data: {
        gameId: chat.id,
        gameSessionStatus: "active",
        gameIntroPresented: true,
        enableAgents: false,
        gameImageAutoGenerationEnabled: false,
      },
    });
    expect(setupResponse.ok()).toBeTruthy();

    const createMemoryRecord = (operationId: string, recordType: "entity" | "relationship", input: unknown) =>
      request.post("/api/game/" + chat.id + "/memory/mutations", {
        data: { operationId, action: "create", recordType, reason: "seed isolated faction pagination fixture", input },
      });
    const organizations: Array<{ id: string; name: string }> = [];
    for (let index = 0; index < 10; index += 1) {
      const id = prefix + "-org-" + index;
      const name = "Faction " + index + " " + fixtureId;
      const response = await createMemoryRecord("create-" + id, "entity", {
        entityId: id,
        kind: "organization",
        owner: { type: "registry", store: "campaign-memory", recordId: id },
        aliases: [name],
        tags: ["browser fixture"],
        attributes: {},
        status: "active",
        manualLock: false,
      });
      expect(response.ok()).toBeTruthy();
      organizations.push({ id, name });
    }

    const relations: Array<{ relationshipId: string; targetName: string }> = [];
    for (const target of organizations.slice(1)) {
      const response = await createMemoryRecord("create-link-" + target.id, "relationship", {
        sourceEntityId: organizations[0]!.id,
        targetEntityId: target.id,
        type: "allied-with",
        inverseLabel: "allied-with",
        status: "active",
        notes: "",
        evidence: [],
        manualLock: false,
      });
      expect(response.ok()).toBeTruthy();
      const relation = await response.json();
      relations.push({ relationshipId: relation.relationshipId, targetName: target.name });
    }
    relations.sort((left, right) => left.relationshipId.localeCompare(right.relationshipId));
    const finalPagedRelation = relations[8]!;

    await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
    await seedUIState(page, {
      hasCompletedOnboarding: true,
      chatHelpSeenModes: ["conversation", "roleplay", "game"],
      sidebarOpen: false,
      rightPanelOpen: false,
      theme: testInfo.project.name.includes("dark") ? "dark" : "light",
    });
    await page.addInitScript(
      ({ id, version: appVersion }) => {
        localStorage.setItem("marinara-active-chat-id", id);
        localStorage.setItem("marinara:whats-new:seen-version", appVersion);
      },
      { id: chat.id, version },
    );
    await page.goto("/");
    if (testInfo.project.name.startsWith("mobile")) {
      await page.getByRole("button", { name: "Game actions", exact: true }).click();
    }
    await page.getByRole("button", { name: "Session", exact: true }).click();
    await page.getByRole("button", { name: "Campaign Wiki", exact: true }).click();
    await page.getByRole("button", { name: "Faction relationships", exact: true }).click();
    const picker = page.getByRole("group", { name: "Choose a faction", exact: true });
    await picker.getByRole("button", { name: organizations[0]!.name, exact: true }).click();
    await page.getByRole("button", { name: "Next", exact: true }).click();

    const finalLink = page.locator("[data-faction-web] ul > li").filter({ hasText: finalPagedRelation.targetName });
    await expect(finalLink).toBeVisible();
    await finalLink.getByRole("button", { name: "Edit relationship", exact: true }).click();
    await page.getByLabel("Status", { exact: true }).selectOption("ended");
    await page.getByLabel("Reason for this change", { exact: true }).fill("End the final active link on page two");
    await page.getByRole("button", { name: "Save relationship", exact: true }).click();

    await expect(page.locator("[data-faction-web] ul > li")).toHaveCount(8);
    await expect(page.getByRole("button", { name: "Next", exact: true })).toHaveCount(0);
  } finally {
    if (chatId) await request.delete("/api/chats/" + chatId + "?force=true");
    await request.delete("/api/characters/" + character.id);
  }
});

test("Campaign Wiki opens the exact lorebook entry that owns a page", async ({ page, request }, testInfo) => {
  const fixtureId = Math.random().toString(36).slice(2, 10);
  const pageName = `Wiki lore owner ${fixtureId}`;
  const entryName = `Wiki linked entry ${fixtureId}`;
  const characterResponse = await request.post("/api/characters", {
    data: { data: { name: `Wiki lore fixture character ${fixtureId}` } },
  });
  expect(characterResponse.ok()).toBeTruthy();
  const character = await characterResponse.json();
  let chatId: string | undefined;
  let lorebookId: string | undefined;
  try {
    const chatResponse = await request.post("/api/chats", {
      data: { name: `Campaign Wiki lore ${fixtureId}`, mode: "game", characterIds: [character.id] },
    });
    expect(chatResponse.ok()).toBeTruthy();
    const chat = await chatResponse.json();
    chatId = chat.id;
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

    const lorebookResponse = await request.post("/api/lorebooks", {
      data: { name: `Wiki lorebook ${fixtureId}`, chatId: chat.id },
    });
    expect(lorebookResponse.ok()).toBeTruthy();
    const lorebook = await lorebookResponse.json();
    lorebookId = lorebook.id;
    const entryResponse = await request.post(`/api/lorebooks/${lorebook.id}/entries`, {
      data: { name: entryName, content: "Synthetic exact-entry focus target", order: 0 },
    });
    expect(entryResponse.ok()).toBeTruthy();
    const entry = await entryResponse.json();

    const entityResponse = await request.post(`/api/game/${chat.id}/memory/mutations`, {
      data: {
        operationId: `wiki-e2e-lore-entity-${fixtureId}`,
        action: "create",
        recordType: "entity",
        reason: "seed isolated lorebook entry-focus fixture",
        input: {
          entityId: `wiki-lore-e2e-${fixtureId}`,
          kind: "lore",
          owner: { type: "existing", store: "lorebook-entries", recordId: entry.id },
          aliases: [pageName],
          tags: ["browser fixture"],
          summary: "A lore page owned by one specific lorebook entry.",
          attributes: {},
          status: "active",
          manualLock: false,
        },
      },
    });
    expect(entityResponse.ok()).toBeTruthy();

    await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
    await seedUIState(page, {
      hasCompletedOnboarding: true,
      chatHelpSeenModes: ["conversation", "roleplay", "game"],
      sidebarOpen: false,
      rightPanelOpen: false,
      theme: testInfo.project.name.includes("dark") ? "dark" : "light",
    });
    await page.addInitScript(
      ({ id, version: appVersion }) => {
        localStorage.setItem("marinara-active-chat-id", id);
        localStorage.setItem("marinara:whats-new:seen-version", appVersion);
      },
      { id: chat.id, version },
    );
    await page.goto("/");

    if (testInfo.project.name.startsWith("mobile")) {
      await page.getByRole("button", { name: "Game actions", exact: true }).click();
    }
    await page.getByRole("button", { name: "Session", exact: true }).click();
    await page.getByRole("button", { name: "Campaign Wiki", exact: true }).click();
    await page.getByRole("textbox", { name: "Search people, places, lore" }).fill(pageName);
    const pageRow = page.getByRole("button", { name: `${pageName} Lore`, exact: true });
    await expect(pageRow).toBeVisible();
    await pageRow.click();
    await expect(page.getByRole("heading", { name: pageName, exact: true })).toBeVisible();

    const ownerLink = page.locator('[data-component="campaign-wiki-owner-link"]');
    await expect(ownerLink.getByRole("button")).toBeVisible();
    await ownerLink.getByRole("button").click();
    const exactEntryRow = page.locator(`[data-lorebook-entry-row-id="${entry.id}"]`);
    await expect(exactEntryRow).toBeVisible();
    await expect(exactEntryRow.getByRole("textbox", { name: "Untitled entry" })).toHaveValue(entryName);
    await expect(exactEntryRow.locator("textarea").first()).toBeVisible();
  } finally {
    if (lorebookId) await request.delete(`/api/lorebooks/${lorebookId}`);
    if (chatId) await request.delete(`/api/chats/${chatId}?force=true`);
    await request.delete(`/api/characters/${character.id}`);
  }
});
