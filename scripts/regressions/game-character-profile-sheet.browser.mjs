import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { request, chromium } from "@playwright/test";

const baseURL = process.env.GAME_PROFILE_SHEET_BASE_URL ?? process.env.PLAYWRIGHT_BASE_URL;
if (!baseURL) {
  throw new Error(
    "Set GAME_PROFILE_SHEET_BASE_URL to an isolated local e2e server before running this browser fixture.",
  );
}
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseURL).hostname))
  throw new Error("Isolated loopback server required");

const version = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const requestContext = await request.newContext({ baseURL });
const chats = [];
const characters = [];
const evidenceDir = process.env.GAME_PROFILE_SHEET_EVIDENCE_DIR;
let browser;
let originalFeatures;
async function setFeature(value, page) {
  const settings = { ...originalFeatures, savedCharacterProfiles: value };
  const result = await requestContext.put("/api/app-settings/features", { data: settings });
  assert.equal(result.ok(), true, await result.text());
  const response = await result.json();
  if (page)
    await page.evaluate((data) => {
      const element = document.querySelector('[data-component="GameCharacterSheet"]');
      const key = Object.keys(element).find((name) => name.startsWith("__reactFiber"));
      let fiber = element[key];
      while (fiber && !fiber.memoizedProps?.client?.getQueryCache) fiber = fiber.return;
      if (!fiber) throw new Error("Actual App QueryClient not found");
      window.profileQueryClient = fiber.memoizedProps.client;
      window.profileQueryClient.setQueryData(["features"], data);
    }, response);
}

try {
  const settings = await requestContext.get("/api/app-settings/features");
  assert.equal(settings.ok(), true, await settings.text());
  const savedFeatures = (await settings.json()).settings;
  assert.ok(
    savedFeatures && typeof savedFeatures === "object" && !Array.isArray(savedFeatures),
    "Feature settings must be an object before the fixture can mutate state",
  );
  originalFeatures = savedFeatures;
  for (const [name, description] of [
    ["Élodie", "Saved profile description"],
    ["Elodie", "Second saved profile description"],
  ]) {
    const created = await requestContext.post("/api/characters", {
      data: {
        data: {
          name,
          description,
          personality: "Patient and exacting.",
          tags: ["archivist", "scholar"],
          extensions: { backstory: "Raised beside the old observatory.", appearance: "Ink-stained cuffs." },
        },
      },
    });
    assert.equal(created.ok(), true, await created.text());
    characters.push((await created.json()).id);
  }

  const createdChat = await requestContext.post("/api/chats", {
    data: { name: `Profile sheet fixture ${suffix}`, mode: "game", characterIds: characters },
  });
  assert.equal(createdChat.ok(), true, await createdChat.text());
  const chatId = (await createdChat.json()).id;
  chats.push(chatId);

  const metadata = await requestContext.patch(`/api/chats/${chatId}/metadata`, {
    data: {
      gameId: `profile-sheet-fixture-${suffix}`,
      gameSessionStatus: "active",
      gameIntroPresented: true,
      gamePartyCharacterIds: characters,
      gameCharacterCards: [],
      gameInventory: [],
    },
  });
  assert.equal(metadata.ok(), true, await metadata.text());

  const message = await requestContext.post(`/api/chats/${chatId}/messages`, {
    data: { role: "assistant", content: "A quiet afternoon at the archive." },
  });
  assert.equal(message.ok(), true, await message.text());

  const gameState = await requestContext.patch(`/api/chats/${chatId}/game-state`, {
    data: {
      presentCharacters: [
        {
          characterId: characters[0],
          name: "Élodie in the observatory",
          emoji: "📚",
          mood: "Focused",
          appearance: "Current scene clothing",
          outfit: "Travel coat",
          thoughts: "The star chart is incomplete.",
          avatarPath: null,
          stats: [{ name: "Focus", value: 7, max: 10, color: "#60a5fa" }],
        },
      ],
      manual: true,
    },
  });
  assert.equal(gameState.ok(), true, await gameState.text());
  const before = await requestContext.get(`/api/chats/${chatId}/game-state`);
  assert.equal(before.ok(), true, await before.text());
  const initialScene = (await before.json()).presentCharacters;

  browser = await chromium.launch({ headless: true });
  for (const viewport of [
    { width: 1440, height: 1000, name: "desktop" },
    { width: 390, height: 844, name: "mobile" },
  ]) {
    await setFeature(false);
    const page = await browser.newPage({ viewport });
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      return url.origin === new URL(baseURL).origin || ["data:", "blob:"].includes(url.protocol)
        ? route.continue()
        : route.abort();
    });
    await page.route("**/api/connections/refresh-local-models", (route) =>
      route.fulfill({ json: { results: [], warnings: [] } }),
    );
    const browserErrors = [];
    let characterListInterceptCount = 0;
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
    await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
    await page.route("**/api/characters*", async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() !== "GET" || url.pathname !== "/api/characters") return route.continue();
      characterListInterceptCount += 1;
      const response = await route.fetch();
      const saved = await response.json();
      const rows = Array.isArray(saved) ? saved : saved.characters;
      assert.ok(Array.isArray(rows), "the saved character endpoint should return its full character rows");
      const fixtureCharacter = rows.find((row) => row.id === characters[0]);
      assert.ok(fixtureCharacter, "the saved character endpoint should contain the synthetic profile record");
      const data =
        typeof fixtureCharacter.data === "string" ? JSON.parse(fixtureCharacter.data) : fixtureCharacter.data;
      assert.deepEqual(
        {
          name: data.name,
          description: data.description,
          personality: data.personality,
          backstory: data.extensions?.backstory,
          appearance: data.extensions?.appearance,
        },
        {
          name: "Élodie",
          description: "Saved profile description",
          personality: "Patient and exacting.",
          backstory: "Raised beside the old observatory.",
          appearance: "Ink-stained cuffs.",
        },
        "the API fixture should return all saved profile fields in the production character contract",
      );
      for (const row of rows) {
        if (row.id === characters[0]) row.avatarPath = "/api/avatars/file/stale-saved-avatar.png";
      }
      await route.fulfill({ response, json: saved });
    });
    await page.addInitScript(() => {
      localStorage.setItem(
        "marinara-engine-ui",
        JSON.stringify({
          state: {
            chibiProfessorMariEnabled: false,
            hasCompletedOnboarding: true,
            rightPanelOpen: false,
            sidebarOpen: false,
            chatHelpSeenModes: ["conversation", "roleplay", "game"],
            gameInstantTextReveal: true,
          },
          version: 101,
        }),
      );
    });
    await page.addInitScript(
      ({ id, appVersion }) => {
        localStorage.setItem("marinara-active-chat-id", id);
        localStorage.setItem("marinara:whats-new:seen-version", appVersion);
      },
      { id: chatId, appVersion: version },
    );
    await page.goto(baseURL);

    const portrait = page.getByTitle("Élodie - Click to open character sheet", { exact: true });
    const members = page.getByRole("button", { name: "Open party members", exact: true });
    try {
      await portrait.or(members).first().waitFor({ state: "visible", timeout: 30_000 });
    } catch (error) {
      console.error(
        JSON.stringify({
          viewport: viewport.name,
          url: page.url(),
          title: await page.title(),
          body: (await page.locator("body").innerText()).slice(0, 2000),
          browserErrors,
        }),
      );
      throw error;
    }
    if (await members.isVisible()) await members.click();
    await portrait.first().click();

    const dialog = page.locator('[data-component="GameCharacterSheet"]');
    await dialog.waitFor();
    assert.equal(
      await dialog.getByText("Saved Profile", { exact: true }).count(),
      0,
      "OFF keeps baseline sheet without optional profile",
    );
    assert.equal(await dialog.getByText("Saved profile description", { exact: true }).count(), 0);
    await setFeature(true, page);
    assert.ok(characterListInterceptCount > 0, "the production saved-character list request should be intercepted");
    try {
      await dialog.getByText("Saved Profile", { exact: true }).waitFor({ state: "visible" });
    } catch (error) {
      if (evidenceDir) {
        mkdirSync(evidenceDir, { recursive: true });
        await page.screenshot({ path: join(evidenceDir, `profile-sheet-failure-${viewport.name}.png`) });
      }
      console.error(
        JSON.stringify({
          viewport: viewport.name,
          url: page.url(),
          sheetCount: await dialog.count(),
          body: (await page.locator("body").innerText()).slice(0, 2500),
          browserErrors,
        }),
      );
      throw error;
    }
    await dialog.getByText("Saved profile description", { exact: true }).waitFor({ state: "visible" });
    await dialog.getByText("Patient and exacting.", { exact: true }).waitFor({ state: "visible" });
    await dialog.getByText("Raised beside the old observatory.", { exact: true }).waitFor({ state: "visible" });
    await dialog.getByText("Ink-stained cuffs.", { exact: true }).waitFor({ state: "visible" });
    await dialog.getByText("archivist", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await dialog.getByText("Wrong duplicate profile must stay hidden", { exact: true }).count(), 0);
    assert.equal(await dialog.getByText("Élodie in the observatory", { exact: true }).count(), 1);
    assert.equal(
      await dialog.locator('img[src*="stale-saved-avatar.png"]').count(),
      0,
      "an explicit scene clear must not restore the saved portrait",
    );
    if (evidenceDir) {
      mkdirSync(evidenceDir, { recursive: true });
      await dialog.screenshot({ path: join(evidenceDir, `profile-sheet-${viewport.name}.png`) });
    }
    await setFeature(false, page);
    await dialog.getByText("Saved Profile", { exact: true }).waitFor({ state: "detached" });
    assert.equal(await dialog.isVisible(), true, "Disabling optional profile keeps the ordinary sheet");
    await setFeature(true, page);
    await dialog.getByText("Saved profile description", { exact: true }).waitFor();
    await page.evaluate(() =>
      window.profileQueryClient
        .getQueryCache()
        .find({ queryKey: ["features"] })
        .setState({ status: "error", error: new Error("fixture") }),
    );
    await dialog.getByText("Saved Profile", { exact: true }).waitFor({ state: "detached" });
    await setFeature(true, page);
    await dialog.getByText("Saved profile description", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Close character sheet", exact: true }).click();

    const offScenePortrait = page.getByTitle("Elodie - Click to open character sheet", { exact: true });
    if (await members.isVisible()) {
      // Mobile shows one party member until the user opens the full party list.
      await members.click();
      await offScenePortrait.first().waitFor({ state: "visible" });
    } else {
      // Desktop keeps the full party in a horizontally scrollable strip.
      await offScenePortrait.first().scrollIntoViewIfNeeded();
    }
    await offScenePortrait.first().click();
    const offSceneDialog = page.locator('[data-component="GameCharacterSheet"]');
    await offSceneDialog.getByText("Second saved profile description", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await offSceneDialog.getByText("Saved profile description", { exact: true }).count(), 0);
    const closeButton = page.getByRole("button", { name: "Close character sheet", exact: true });
    await closeButton.focus();
    await page.keyboard.press("Enter");
    await offSceneDialog.waitFor({ state: "detached" });
    await page.close();
  }

  const after = await requestContext.get(`/api/chats/${chatId}/game-state`);
  assert.equal(after.ok(), true, await after.text());
  assert.deepEqual(
    (await after.json()).presentCharacters,
    initialScene,
    "opening the saved profile sheet must not change scene presence",
  );
  console.info("GameCharacterSheet browser fixture passed on desktop and mobile.");
} finally {
  const failures = [];
  if (browser) await browser.close().catch((error) => failures.push(error));
  if (originalFeatures)
    await requestContext
      .put("/api/app-settings/features", { data: originalFeatures })
      .then(async (response) => {
        assert.equal(response.ok(), true, await response.text());
      })
      .catch((error) => failures.push(error));
  for (const id of chats) await requestContext.delete(`/api/chats/${id}`).catch((error) => failures.push(error));
  for (const id of characters)
    await requestContext.delete(`/api/characters/${id}`).catch((error) => failures.push(error));
  await requestContext.dispose();
  if (failures.length) throw new AggregateError(failures, "Profile fixture cleanup failed");
}
