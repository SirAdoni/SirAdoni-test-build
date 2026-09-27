import { expect, test, type Page, type TestInfo, type Locator } from "@playwright/test";
import { readFileSync } from "node:fs";

async function assertCenterReachable(target: Locator, testInfo: TestInfo, label: string) {
  const measurement = await target.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    const describe = (node: Element | null) =>
      node
        ? {
            tag: node.tagName,
            label: node.getAttribute("aria-label"),
            className: node.className,
            rect: node.getBoundingClientRect().toJSON(),
            zIndex: getComputedStyle(node).zIndex,
            position: getComputedStyle(node).position,
            transform: getComputedStyle(node).transform,
          }
        : null;
    const ancestors = [];
    for (let node = hit; node && ancestors.length < 8; node = node.parentElement) ancestors.push(describe(node));
    const remove = element.parentElement?.parentElement?.querySelector('[aria-label^="Remove "]');
    const pseudo = remove ? getComputedStyle(remove, "::before") : null;
    return {
      reachable: element === hit || element.contains(hit),
      target: describe(element),
      hit: describe(hit),
      ancestors,
      remove: describe(remove ?? null),
      pseudo: pseudo && {
        top: pseudo.top,
        right: pseudo.right,
        bottom: pseudo.bottom,
        left: pseudo.left,
        pointerEvents: pseudo.pointerEvents,
      },
    };
  });
  await testInfo.attach(label, { body: JSON.stringify(measurement, null, 2), contentType: "application/json" });
  expect(measurement.reachable, `${label}: control center must reach its own action`).toBe(true);
}
const APP_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;

const PORTRAIT_DATA_URL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

type Fixture = { chatId: string; characterId: string; messageId: string };

function isMobile(testInfo: TestInfo) {
  return testInfo.project.name.includes("mobile");
}

async function prepareFreshClient(page: Page, chatId: string) {
  await page.addInitScript((version) => localStorage.setItem("marinara:whats-new:seen-version", version), APP_VERSION);
  await page.addInitScript((activeChatId) => {
    localStorage.setItem("marinara-active-chat-id", activeChatId);
    localStorage.setItem(
      "marinara-engine-ui",
      JSON.stringify({
        state: {
          hasCompletedOnboarding: true,
          rightPanelOpen: false,
          sidebarOpen: false,
          chatHelpSeenModes: ["conversation", "roleplay", "game"],
          gameTutorialDisabled: true,
          gameInstantTextReveal: true,
        },
        version: 65,
      }),
    );
  }, chatId);
}

function storyboard(messageId: string, chatId: string, withError: boolean) {
  const now = "2026-09-11T00:00:00.000Z";
  const storyboardId = "mobile-layout-storyboard";
  const frame = (index: number, image: boolean) => ({
    id: `mobile-layout-frame-${index}`,
    storyboardId,
    index,
    title: `Storyboard frame ${index + 1}`,
    sectionStartIndex: index,
    sectionEndIndex: index,
    anchorQuote: "Mira studies the narrow bridge.",
    anchorKind: "dialogue" as const,
    narrationBeat: "A quiet turn at the bridge.",
    mangaPanelPrompt: "",
    imagePrompt: "A moonlit bridge.",
    videoPrompt: "",
    animationSuitability: "" as const,
    characters: ["Mira Mobile"],
    continuityNotes: "",
    cameraMotion: "",
    transitionHint: "",
    durationSeconds: 4,
    aspectRatio: "16:9" as const,
    chatImageId: null,
    sceneVideoId: null,
    image: image
      ? {
          id: `mobile-layout-image-${index}`,
          url: PORTRAIT_DATA_URL,
          prompt: "A moonlit bridge.",
          provider: "fixture",
          model: "fixture",
          createdAt: now,
        }
      : null,
    video: null,
    status: image ? ("image_complete" as const) : ("failed" as const),
    error: image ? null : "The fixture storyboard frame could not be rendered.",
    createdAt: now,
    updatedAt: now,
  });
  return {
    id: storyboardId,
    chatId,
    messageId,
    swipeIndex: 0,
    snapshotId: null,
    sessionNumber: 1,
    turnNumber: 1,
    title: "Mobile layout storyboard",
    sourceNarration: "Mira Mobile: The bridge waits below.",
    sourceNarrationHash: "mobile-layout-hash",
    status: withError ? ("partial" as const) : ("complete" as const),
    provider: "fixture",
    model: "fixture",
    directorPrompt: "",
    error: withError ? "One storyboard frame was unavailable in the fixture." : null,
    keyframes: [frame(0, true), frame(1, !withError)],
    createdAt: now,
    updatedAt: now,
  };
}

async function seedFixture(page: Page, withStoryboardError: boolean): Promise<Fixture> {
  const characterResponse = await page.request.post("/api/characters", {
    data: {
      data: {
        name: "Mira Mobile",
        description: "A named speaker for mobile layout coverage.",
        personality: "Patient and observant.",
        extensions: {
          rpgStats: {
            enabled: true,
            hp: { current: 200, max: 200 },
            attributes: { STR: 20 },
            pools: [{ name: "Resolve", current: 35, max: 50 }],
          },
        },
      },
    },
  });
  expect(characterResponse.ok()).toBeTruthy();
  const character = (await characterResponse.json()) as { id: string };
  const avatarResponse = await page.request.post(`/api/characters/${character.id}/avatar`, {
    data: { avatar: PORTRAIT_DATA_URL },
  });
  expect(avatarResponse.ok()).toBeTruthy();

  const chatResponse = await page.request.post("/api/chats", {
    data: { name: "Mobile Game Layout Smoke", mode: "game", characterIds: [character.id] },
  });
  expect(chatResponse.ok()).toBeTruthy();
  const chat = (await chatResponse.json()) as { id: string };
  const metadataResponse = await page.request.patch(`/api/chats/${chat.id}/metadata`, {
    data: {
      gameId: "mobile-game-layout-smoke",
      gameSessionStatus: "active",
      gameSessionNumber: 1,
      gameIntroPresented: true,
      gameActiveState: "dialogue",
      gamePartyCharacterIds: [character.id],
      gameCharacterCards: [],
      gameNpcs: [
        { id: "mira-mobile", name: "Mira Mobile", avatarUrl: PORTRAIT_DATA_URL },
        { id: "lyra-mobile", name: "Lyra Mobile", avatarUrl: PORTRAIT_DATA_URL },
      ],
      gameMap: {
        id: "bridge-map",
        type: "node",
        name: "Moonlit Bridge",
        partyPosition: "bridge",
        nodes: [
          { id: "bridge", label: "Bridge", x: 0, y: 0, discovered: true },
          { id: "tower", label: "Tower", x: 100, y: 0, discovered: true },
        ],
        edges: [{ from: "bridge", to: "tower" }],
      },
      gameSetupConfig: { partyCharacterIds: [character.id] },
      campaignIndexPrompt: { dismissedAt: "2026-01-01T00:00:00.000Z" },
      enableCustomWidgets: true,
      enableAgents: true,
      activeAgentIds: ["storyboard"],
    },
  });
  expect(metadataResponse.ok()).toBeTruthy();
  const widgetResponse = await page.request.put(`/api/game/${chat.id}/widgets`, {
    data: {
      widgets: [
        {
          id: "mobile-layout-clock",
          type: "counter",
          label: "Bridge clock",
          position: "hud_left",
          config: { count: 3 },
        },
      ],
    },
  });
  expect(widgetResponse.ok()).toBeTruthy();
  const messageResponse = await page.request.post(`/api/chats/${chat.id}/messages`, {
    data: {
      role: "assistant",
      content: `[Mira Mobile] [main]: "The bridge waits below. I check the ropes, the lantern, and the far tower before taking a careful step forward. ${"The wind pulls at the old boards while I keep reading the dark water below. ".repeat(12)}"`,
    },
  });
  expect(messageResponse.ok()).toBeTruthy();
  const message = (await messageResponse.json()) as { id: string };
  const fixture = { chatId: chat.id, characterId: character.id, messageId: message.id };

  await page.route("**/api/agents", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          id: "fixture-storyboard",
          type: "storyboard",
          name: "Fixture Storyboard",
          description: "Provider-free E2E storyboard agent.",
          phase: "post-generation",
          enabled: "true",
          connectionId: null,
          imagePath: null,
          promptTemplate: "",
          settings: JSON.stringify({ imageConnectionId: "fixture", keyframeCount: 2 }),
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ]),
    });
  });
  await page.route("**/api/capability-packages/installed", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  await page.route("**/api/game-assets/manifest", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ scannedAt: "2026-09-11T00:00:00.000Z", count: 0, assets: {}, byCategory: {} }),
    });
  });
  await page.route(`**/api/game/${chat.id}/scene-timeline`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        scenes: [
          {
            id: "bridge-scene",
            location: "Moonlit Bridge",
            participants: ["Mira Mobile", "Lyra Mobile"],
            present: ["Mira Mobile", "Lyra Mobile"],
            summary: "Mira and Lyra check the bridge.",
            closed: false,
            reviewed: true,
            messageIds: [message.id],
          },
        ],
        pending: false,
        error: null,
        remaining: 0,
      }),
    });
  });
  await page.route(`**/api/game/storyboards/${chat.id}*`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ storyboards: [storyboard(message.id, chat.id, withStoryboardError)] }),
    });
  });
  await page.route("**/api/generate", async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "E2E generation disabled" }),
    });
  });
  return fixture;
}

async function assertNoOverlap(page: Page, selector: string, target: string) {
  const result = await page
    .locator(selector)
    .filter({ visible: true })
    .first()
    .evaluate((element, targetSelector) => {
      const targetElement = document.querySelector<HTMLElement>(targetSelector);
      if (!targetElement) return null;
      const a = element.getBoundingClientRect();
      const b = targetElement.getBoundingClientRect();
      const overlap = !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
      return { overlap, first: a.toJSON(), second: b.toJSON(), viewport: { width: innerWidth, height: innerHeight } };
    }, target);
  expect(result?.overlap, JSON.stringify(result)).toBe(false);
}

test("Game mobile geometry keeps dialogue, compact header, panels, and storyboard reachable", async ({
  page,
  request,
}, testInfo) => {
  const mobile = isMobile(testInfo);
  test.skip(
    !mobile && !testInfo.project.name.includes("desktop"),
    "Only configured desktop/mobile projects run this fixture.",
  );
  test.setTimeout(90_000);

  const viewports = mobile
    ? [
        { width: 360, height: 800 },
        { width: 412, height: 915 },
        { width: 915, height: 412 },
        { width: 412, height: 400 },
      ]
    : [{ width: 1280, height: 900 }];
  const fixture = await seedFixture(page, mobile);
  await prepareFreshClient(page, fixture.chatId);
  await page.goto("/");

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.reload();
    const dialogue = page.locator('[data-tour="game-dialogue"]');
    const activePanel = page.locator('[data-component="GameNarration.ActivePanel"]').first();
    await expect(dialogue).toBeVisible();
    await expect(activePanel).toBeVisible();

    const geometry = await page.evaluate(() => {
      const viewportWidth = document.documentElement.clientWidth;
      const dialogue = document.querySelector<HTMLElement>('[data-tour="game-dialogue"]')!.getBoundingClientRect();
      const active = document
        .querySelector<HTMLElement>('[data-component="GameNarration.ActivePanel"]')!
        .getBoundingClientRect();
      const map = document.querySelector<HTMLElement>('[data-tour="game-map"]')?.getBoundingClientRect() ?? null;
      const party = document.querySelector<HTMLElement>('[data-tour="game-party"]')?.getBoundingClientRect() ?? null;
      return {
        dialogue,
        active,
        map,
        party,
        viewportWidth,
      };
    });
    expect(geometry.dialogue.left).toBeGreaterThanOrEqual(-1);
    expect(geometry.dialogue.right).toBeLessThanOrEqual(geometry.viewportWidth + 1);
    if (mobile) {
      const prose = page.locator(".game-narration-prose").first();
      await expect(prose).toBeVisible();
      const proseGeometry = await prose.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return { left: box.left, right: box.right, width: box.width };
      });
      expect(proseGeometry.left).toBeGreaterThanOrEqual(geometry.active.left - 1);
      expect(proseGeometry.right).toBeLessThanOrEqual(geometry.active.right + 1);
      expect(proseGeometry.width).toBeGreaterThanOrEqual(geometry.active.width * 0.8);
      expect(geometry.map).not.toBeNull();
      expect(geometry.party).not.toBeNull();
      expect(geometry.map!.bottom).toBeLessThanOrEqual(geometry.dialogue.top + 4);
      expect(geometry.party!.bottom).toBeLessThanOrEqual(geometry.dialogue.top + 4);
      await expect(page.getByRole("button", { name: "Open map", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Open map", exact: true }).click();
      const mapPopover = page.locator("[data-game-mobile-map-popover]");
      await expect(mapPopover).toBeVisible();
      await expect(mapPopover.getByRole("button", { name: "Close map", exact: true })).toBeVisible();
      await expect(mapPopover.getByText("Moonlit Bridge", { exact: true }).first()).toBeVisible();
      await mapPopover.getByRole("button", { name: "Zoom in map", exact: true }).click();
      await expect(mapPopover).toBeVisible();
      await assertCenterReachable(
        mapPopover.getByRole("button", { name: "Close map", exact: true }),
        testInfo,
        `map-hit-${viewport.width}x${viewport.height}`,
      );
      await mapPopover.getByRole("button", { name: "Close map", exact: true }).click();
      await expect(page.getByRole("button", { name: "Open map", exact: true })).toBeVisible();
      const mapTrigger = page.getByRole("button", { name: "Open map", exact: true });
      await expect(mapTrigger).toBeFocused();
      await mapTrigger.press("Enter");
      await expect(mapPopover.getByRole("button", { name: "Close map", exact: true })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(mapPopover).toBeHidden();
      await expect(mapTrigger).toBeFocused();
      await mapTrigger.click();
      await page.setViewportSize({ width: Math.max(320, viewport.width - 20), height: viewport.height });
      await expect
        .poll(async () =>
          mapPopover.evaluate((element) => {
            const box = element.getBoundingClientRect();
            return box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight;
          }),
        )
        .toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`map-fixed-${viewport.width}x${viewport.height}.png`) });
      await page.setViewportSize(viewport);
      // A real outside pointer dismisses; do not force a click through covered content.
      await page.mouse.click(2, 2);
      await expect(mapPopover).toBeHidden();
      const partyButton = page.getByRole("button", { name: "Open party members", exact: true });
      await expect(partyButton).toBeVisible();
      await partyButton.click();
      await assertCenterReachable(
        page.locator("[data-game-party-popover]").getByRole("button", { name: "Player", exact: true }),
        testInfo,
        `first-party-hit-${viewport.width}x${viewport.height}`,
      );
      await expect(
        page
          .locator(mobile ? "[data-game-party-popover]" : '[data-tour="game-party"]:visible')
          .getByRole("button", { name: /^Mira Mobile(?: - Click to open character sheet)?$/ }),
      ).toBeVisible();
      await page.setViewportSize({ width: Math.max(320, viewport.width - 20), height: viewport.height });
      await expect
        .poll(() =>
          page.locator("[data-game-party-popover]").evaluate((element) => {
            const box = element.getBoundingClientRect();
            return box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight;
          }),
        )
        .toBe(true);
      await page.setViewportSize(viewport);
      await page.mouse.click(2, 2);
      await expect(page.locator("[data-game-party-popover]")).toBeHidden();
      await partyButton.focus();
      await page.keyboard.press("Enter");
      const playerRow = page.locator("[data-game-party-popover]").getByRole("button", { name: "Player", exact: true });
      await playerRow.click();
      const playerSheet = page.getByRole("dialog", { name: "Player", exact: true });
      await expect(playerSheet).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(playerSheet).toBeHidden();
      await partyButton.click();
      await expect(playerRow).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(playerSheet).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(playerSheet).toBeHidden();
      await partyButton.click();
      await page.keyboard.press("Escape");
      await expect(page.locator("[data-game-party-popover]")).toBeHidden();
      await expect(partyButton).toBeFocused();
      const scenePresence = page.locator('[data-component="GameSurface.ScenePresence"]');
      if (await scenePresence.isVisible())
        await assertCenterReachable(
          scenePresence.getByRole("button", { name: "Open in Campaign Wiki", exact: true }),
          testInfo,
          `presence-after-party-${viewport.width}x${viewport.height}`,
        );
      expect(await page.locator('[data-game-floating-panel="map"], [data-game-floating-panel="party"]').count()).toBe(
        0,
      );
      expect(await page.locator('[data-game-floating-panel="storyboard"]').count()).toBeLessThanOrEqual(1);
      await expect(page.getByRole("button", { name: "Bridge clock", exact: true })).toHaveCount(1);
      await expect(page.getByTitle("Edit Bridge clock", { exact: true })).toHaveCount(0);
      await assertNoOverlap(page, '[data-tour="game-map"]', '[data-component="GameNarration.ActivePanel"]');
    } else {
      expect(geometry.dialogue.width).toBeLessThanOrEqual(geometry.viewportWidth);
      await expect(page.locator('[data-game-floating-panel="map"]')).toBeVisible();
      const partyBar = page.locator('[data-tour="game-party"]');
      await expect(partyBar).toBeVisible();
      const partyBox = await partyBar.boundingBox();
      expect(partyBox).not.toBeNull();
      expect(partyBox!.x).toBeGreaterThanOrEqual(-1);
      expect(partyBox!.x + partyBox!.width).toBeLessThanOrEqual(geometry.viewportWidth + 1);
      expect(partyBox!.y + partyBox!.height).toBeLessThanOrEqual(geometry.dialogue.top + 4);
    }

    if (mobile) await page.locator("[data-storyboard-phone-tab]").click();
    const storyboardFrame = mobile
      ? page.locator("[data-storyboard-phone-sheet]")
      : page.locator('[data-game-floating-panel="storyboard"]');
    const closeStoryboard = mobile
      ? storyboardFrame.getByRole("button", { name: "Hide storyboard", exact: true })
      : page.getByRole("button", { name: "Close storyboard viewer", exact: true });
    await expect(storyboardFrame).toBeVisible();
    await expect(storyboardFrame.locator("img").first()).toBeVisible();
    await expect(storyboardFrame.getByRole("button", { name: "Next storyboard page", exact: true })).toBeVisible();
    await expect(closeStoryboard).toBeVisible();
    if (mobile) {
      await storyboardFrame.locator("img").first().scrollIntoViewIfNeeded();
      const bounded = await storyboardFrame.evaluate((element) => {
        const media = element.querySelector<HTMLElement>("img,video");
        const mediaBox = media?.getBoundingClientRect();
        return mediaBox ? { media: mediaBox, viewport: { width: innerWidth, height: innerHeight } } : null;
      });
      expect(bounded).not.toBeNull();
      expect(bounded!.media.right).toBeLessThanOrEqual(bounded!.viewport.width + 1);
      expect(bounded!.media.bottom).toBeLessThanOrEqual(bounded!.viewport.height + 1);
      await storyboardFrame.getByRole("button", { name: "Next storyboard page", exact: true }).click();
      await expect(storyboardFrame.getByText("Storyboard frame 2", { exact: true })).toBeVisible();
      const frameDetails = storyboardFrame.locator("details").filter({ hasText: "Generation details" });
      await expect(frameDetails).not.toHaveAttribute("open", "");
      await frameDetails.locator(":scope > summary").click();
      await expect(frameDetails.getByText("The fixture storyboard frame could not be rendered.")).toBeVisible();
      await closeStoryboard.click();
      await expect(storyboardFrame).toHaveCount(0);
      await expect(page.locator("[data-storyboard-phone-tab]")).toHaveAttribute("aria-expanded", "false");
    }

    if (!mobile) await closeStoryboard.click();
    if (mobile) await page.getByRole("button", { name: "Open party members", exact: true }).click();
    await assertCenterReachable(
      page
        .locator(mobile ? "[data-game-party-popover]" : '[data-tour="game-party"]:visible')
        .getByRole("button", { name: /^Mira Mobile(?: - Click to open character sheet)?$/ }),
      testInfo,
      `party-hit-${viewport.width}x${viewport.height}`,
    );
    await page
      .locator(mobile ? "[data-game-party-popover]" : '[data-tour="game-party"]:visible')
      .getByRole("button", { name: /^Mira Mobile(?: - Click to open character sheet)?$/ })
      .click();
    const characterSheet = page.getByRole("dialog", { name: "Mira Mobile", exact: true });
    await expect(characterSheet).toBeVisible();
    await expect(characterSheet).toContainText("A named speaker for mobile layout coverage.");
    await expect(characterSheet).toContainText("Patient and observant.");
    await expect(characterSheet).toContainText("200/200");
    await expect(characterSheet).toContainText("Resolve");
    await expect(characterSheet).toContainText("35/50");
    await expect(characterSheet).not.toContainText("Character data will populate");
    await page.keyboard.press("Escape");
    await expect(characterSheet).toBeHidden();

    // Both independent actions must work through normal pointer and keyboard input.
    const revealPartyMenu = async () => {
      if (mobile) await page.getByRole("button", { name: "Open party members", exact: true }).click();
    };
    await revealPartyMenu();
    const avatar = page
      .locator(mobile ? "[data-game-party-popover]" : '[data-tour="game-party"]:visible')
      .getByRole("button", { name: /^Mira Mobile(?: - Click to open character sheet)?$/ });
    await avatar.focus();
    await page.keyboard.press("Enter");
    await expect(characterSheet).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(characterSheet).toBeHidden();
    await revealPartyMenu();
    const remove = page
      .locator(mobile ? "[data-game-party-popover]" : '[data-tour="game-party"]:visible')
      .getByRole("button", { name: "Remove Mira Mobile from party", exact: true });
    const removeBox = await remove.boundingBox();
    expect(removeBox).not.toBeNull();
    expect(removeBox!.width).toBeGreaterThanOrEqual(mobile ? 44 : 24);
    expect(removeBox!.height).toBeGreaterThanOrEqual(mobile ? 44 : 24);
    await remove.focus();
    await assertCenterReachable(remove, testInfo, `remove-hit-${viewport.width}x${viewport.height}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`party-fixed-${viewport.width}x${viewport.height}.png`) });
    await remove.click();
    const keep = page.getByRole("button", { name: "Keep", exact: true });
    await expect(keep).toBeVisible();
    await keep.click();
    if (!(await remove.isVisible())) await revealPartyMenu();
    await remove.focus();
    await page.keyboard.press("Enter");
    await expect(keep).toBeVisible();
    await keep.click();
    if (mobile) await page.keyboard.press("Escape");

    if (mobile && viewport.height === 800) {
      const scrollable = await page.locator('[data-component="GameNarration.ActivePanel"]').evaluate((element) => {
        const scroller = element.querySelector<HTMLElement>("[class*='overflow-y-auto']");
        return scroller ? scroller.scrollHeight > scroller.clientHeight : false;
      });
      expect(scrollable).toBe(true);
    }
  }

  if (mobile) {
    const mobileViewport = page.viewportSize()!;
    await page.getByRole("button", { name: "Open map", exact: true }).click();
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.locator("[data-game-mobile-map-popover]")).toBeHidden();
    await page.setViewportSize(mobileViewport);
    await page.getByRole("button", { name: "Open map", exact: true }).click();
    await expect(page.locator("[data-game-mobile-map-popover]")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Open map", exact: true })).toBeFocused();
    await page.getByRole("button", { name: "Open party members", exact: true }).click();
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.locator("[data-game-party-popover]")).toBeHidden();
    await page.setViewportSize(mobileViewport);
    await page.getByRole("button", { name: "Open party members", exact: true }).click();
    await expect(page.locator("[data-game-party-popover]")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Open party members", exact: true })).toBeFocused();
  }

  await request.delete(`/api/chats/${fixture.chatId}`).catch(() => undefined);
  await request.delete(`/api/characters/${fixture.characterId}`).catch(() => undefined);
});
