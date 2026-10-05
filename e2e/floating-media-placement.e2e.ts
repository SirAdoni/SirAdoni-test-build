import { expect, test, type APIRequestContext } from "@playwright/test";
import { Buffer } from "node:buffer";
import { APP_VERSION } from "../packages/shared/src/constants/defaults.js";
import { seedUIState } from "./ui-state-fixture.js";

const musicDj = {
  schemaVersion: 1,
  id: "spotify",
  name: "Music DJ",
  version: "1.0.0",
  description: "Matches scene mood with Spotify, YouTube, or local music.",
  engine: { min: "2.3.0", maxExclusive: "3.0.0" },
  kind: ["agent"],
  entrypoints: { agents: "agents.json" },
  files: [],
  permissions: ["agent-runtime", "chat-read", "prompt-context", "ui"],
  restartRequired: false,
};
function makeSilentWav(): Buffer {
  const sampleRate = 8_000;
  const dataLength = sampleRate;
  const wav = Buffer.alloc(44 + dataLength, 128);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataLength, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataLength, 40);
  return wav;
}
const SILENT_WAV = makeSilentWav();

test("mobile local-music bubble docks, avoids the real game map, and keeps a dragged position", async ({
  page,
  request,
  playwright,
  baseURL,
  isMobile,
}) => {
  if (baseURL !== "http://127.0.0.1:5178" && baseURL !== "http://127.0.0.1:5179") {
    throw new Error("Expected isolated audio fixture origin");
  }
  const ownedResources: string[] = [];
  const externalRequests: string[] = [];
  const cleanupFailures: string[] = [];
  let syntheticAudioRequests = 0;
  let cleanupRequest: APIRequestContext | undefined;
  let originalFeatures: Record<string, unknown> | undefined;
  let testFailed = false;
  let testFailure: unknown;

  try {
    cleanupRequest = await playwright.request.newContext({ baseURL });
    const featuresResponse = await request.get("/api/app-settings/features");
    expect(featuresResponse.ok()).toBeTruthy();
    const featureSnapshot = await featuresResponse.json();
    originalFeatures = featureSnapshot.settings ?? {};
    const disabledFeaturesResponse = await request.put("/api/app-settings/features", {
      data: { ...originalFeatures, floatingMediaPlacement: false },
    });
    expect(disabledFeaturesResponse.ok()).toBeTruthy();

    // Keep this actual-App proof offline. Local app requests continue; every third-party request is
    // recorded and blocked so a regression cannot silently use Spotify, YouTube, or a media provider.
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === baseURL || url.origin === "http://127.0.0.1:5179") {
        await route.continue();
        return;
      }
      externalRequests.push(url.origin);
      await route.abort();
    });
    await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: null } }));
    await page.route("**/api/capability-packages/installed", (route) =>
      route.fulfill({
        json: [
          {
            id: "spotify",
            version: "1.0.0",
            manifest: musicDj,
            installedAt: "2026-07-15T00:00:00.000Z",
            status: "active",
            error: null,
            legacy: false,
          },
        ],
      }),
    );
    await page.route("**/api/spotify/status", (route) =>
      route.fulfill({ json: { connected: false, expired: false, hasStreamingScope: false } }),
    );
    await page.route("**/api/game-assets/file/floating-widget-fixture.wav", (route) => {
      syntheticAudioRequests += 1;
      return route.fulfill({ status: 200, contentType: "audio/wav", body: SILENT_WAV });
    });

    const create = await request.post("/api/chats", {
      data: { name: "Floating music placement fixture", mode: "game", characterIds: [] },
    });
    expect(create.ok(), "the fixture must own the chat it later deletes").toBeTruthy();
    const chat = (await create.json()) as { id: string };
    expect(chat.id).toBeTruthy();
    const chatPath = `/api/chats/${chat.id}`;
    ownedResources.push(chatPath);
    expect(ownedResources).toHaveLength(1);
    expect((await request.get(chatPath)).ok(), "the created chat must be positively owned").toBeTruthy();

    const metadata = await request.patch(`${chatPath}/metadata`, {
      data: {
        gameId: chat.id,
        gameSessionStatus: "active",
        gameSessionNumber: 1,
        gameIntroPresented: true,
        gameActiveState: "dialogue",
        enableAgents: false,
        activeAgentIds: [],
        enableCustomWidgets: false,
        gameBlueprint: { campaignPlan: {}, hudWidgets: [], introSequence: [], visualTheme: {} },
      },
    });
    expect(metadata.ok()).toBeTruthy();
    const message = await request.post(`${chatPath}/messages`, {
      data: {
        role: "assistant",
        content: 'The map room opens.\\n\\n[choices: "Inspect the map"|"Leave the room"]',
      },
    });
    expect(message.ok()).toBeTruthy();

    await seedUIState(
      page,
      {
        hasCompletedOnboarding: true,
        sidebarOpen: false,
        rightPanelOpen: false,
        theme: "dark",
        musicPlayerEnabled: true,
        musicPlayerSource: "custom",
        spotifyMobileWidgetCollapsed: true,
        spotifyMobileWidgetPosition: { x: 16, y: 144 },
      },
      "if-missing",
    );
    await page.addInitScript((chatId) => localStorage.setItem("marinara-active-chat-id", chatId), chat.id);
    await page.addInitScript(
      (appVersion) => localStorage.setItem("marinara:whats-new:seen-version", appVersion),
      APP_VERSION,
    );
    if (isMobile) {
      await page.addInitScript(() => {
        const viewport = window.visualViewport;
        if (!viewport) throw new Error("Mobile visual viewport is unavailable for the simulated keyboard proof");
        Object.defineProperty(window, "__setFloatingVisualViewportForTest", {
          configurable: true,
          value: (next: { width: number; height: number; offsetLeft: number; offsetTop: number }) => {
            // Leave native geometry intact until the loaded app explicitly starts the simulation.
            // Capturing it in the init script freezes the pre-meta 980px mobile viewport.
            for (const property of ["width", "height", "offsetLeft", "offsetTop"] as const) {
              Object.defineProperty(viewport, property, { configurable: true, get: () => next[property] });
            }
            viewport.dispatchEvent(new Event("resize"));
            viewport.dispatchEvent(new Event("scroll"));
          },
        });
      });
    }
    await page.addInitScript(() => {
      HTMLMediaElement.prototype.play = function () {
        return Promise.resolve();
      };
    });
    await page.goto("/");
    await expect(page.locator('[data-component="TopBar"]')).toBeVisible({ timeout: 30_000 });

    await page.evaluate(async () => {
      const { useAgentStore } = (await import(
        "/src/stores/agent.store.ts" as string
      )) as typeof import("../packages/client/src/stores/agent.store");
      useAgentStore.getState().setLocalMusicPlay({
        path: "floating-widget-fixture.wav",
        title: "Synthetic local audio",
        mood: "placement fixture",
      });
    });
    await expect
      .poll(() =>
        page
          .locator("audio")
          .evaluateAll((elements) =>
            elements.some((element) =>
              (element as HTMLAudioElement).src.endsWith("/api/game-assets/file/floating-widget-fixture.wav"),
            ),
          ),
      )
      .toBe(true);
    expect(
      await page.locator("audio").evaluateAll((elements) => {
        const audio = elements.find((element) =>
          (element as HTMLAudioElement).src.endsWith("/api/game-assets/file/floating-widget-fixture.wav"),
        ) as HTMLAudioElement | undefined;
        audio?.load();
        return !!audio;
      }),
    ).toBe(true);
    await expect.poll(() => syntheticAudioRequests).toBeGreaterThan(0);
    const mobileLayer = page.locator('[data-component="MobileMusicWidgetLayer"]');
    const widget = mobileLayer.locator(":scope > div.fixed");
    if (!isMobile) {
      // The desktop player remains in the TopBar; its mobile floating counterpart stays absent.
      await expect(page.getByText("Synthetic local audio", { exact: true })).toBeVisible();
      await expect(widget).toHaveCount(0);
    } else {
      await expect(widget).toBeVisible({ timeout: 30_000 });
      const viewport = page.viewportSize();
      expect(viewport).not.toBeNull();
      const initial = await widget.boundingBox();
      expect(initial).not.toBeNull();
      expect(Math.round(initial!.x), "the feature-off default must keep the original placement").toBe(16);
      expect(Math.round(initial!.y)).toBe(144);

      const enabledFeaturesResponse = await request.put("/api/app-settings/features", {
        data: { ...originalFeatures, floatingMediaPlacement: true },
      });
      expect(enabledFeaturesResponse.ok()).toBeTruthy();
      await page.reload();
      await expect(widget).toBeVisible();
      expect(initial!.x + initial!.width).toBeLessThanOrEqual(viewport!.width + 1);

      // Simulate visual-viewport geometry emitted by a keyboard/pan; this is API-level coverage,
      // not a physical keyboard test. Render placement moves, while the user's stored point stays put.
      const requestedPosition = {
        x: viewport!.width - initial!.width - 8,
        y: viewport!.height - initial!.height - 8,
      };
      await page.evaluate(async (position) => {
        const { useUIStore } = (await import(
          "/src/stores/ui.store.ts" as string
        )) as typeof import("../packages/client/src/stores/ui.store");
        useUIStore.getState().setSpotifyMobileWidgetPosition(position);
      }, requestedPosition);
      await expect
        .poll(() =>
          page.evaluate(() => {
            const raw = localStorage.getItem("marinara-engine-ui");
            return raw ? JSON.parse(raw).state.spotifyMobileWidgetPosition : null;
          }),
        )
        .toEqual(requestedPosition);

      const visibleViewport = {
        width: Math.floor(viewport!.width * 0.65),
        height: Math.floor(viewport!.height * 0.32),
        offsetLeft: Math.floor(viewport!.width * 0.1),
        offsetTop: Math.floor(viewport!.height * 0.54),
      };
      await page.evaluate((geometry) => {
        const setGeometry = (
          window as Window & {
            __setFloatingVisualViewportForTest?: (next: typeof geometry) => void;
          }
        ).__setFloatingVisualViewportForTest;
        if (!setGeometry) throw new Error("Simulated visual-viewport control was not installed");
        setGeometry(geometry);
      }, visibleViewport);
      const expectedVisiblePosition = {
        x: Math.max(
          visibleViewport.offsetLeft + 8,
          visibleViewport.offsetLeft + visibleViewport.width - initial!.width - 8,
        ),
        y: Math.max(
          visibleViewport.offsetTop + 8,
          visibleViewport.offsetTop + visibleViewport.height - initial!.height - 88,
        ),
      };
      await expect
        .poll(() =>
          widget.evaluate((element) => {
            const style = getComputedStyle(element);
            return { x: Number.parseFloat(style.left), y: Number.parseFloat(style.top) };
          }),
        )
        .toEqual(expectedVisiblePosition);
      expect(expectedVisiblePosition.y + initial!.height).toBeLessThanOrEqual(
        visibleViewport.offsetTop + visibleViewport.height - 88,
      );
      const storedWhileKeyboardVisible = await page.evaluate(() => {
        const raw = localStorage.getItem("marinara-engine-ui");
        return raw ? JSON.parse(raw).state.spotifyMobileWidgetPosition : null;
      });
      expect(storedWhileKeyboardVisible).toEqual(requestedPosition);

      await page.evaluate(() => {
        const setGeometry = (
          window as Window & {
            __setFloatingVisualViewportForTest?: (next: {
              width: number;
              height: number;
              offsetLeft: number;
              offsetTop: number;
            }) => void;
          }
        ).__setFloatingVisualViewportForTest;
        if (!setGeometry) throw new Error("Simulated visual-viewport control was not installed");
        setGeometry({ width: window.innerWidth, height: window.innerHeight, offsetLeft: 0, offsetTop: 0 });
      });
      const restoredPosition = {
        x: requestedPosition.x,
        y: Math.min(requestedPosition.y, viewport!.height - initial!.height - 88),
      };
      await expect
        .poll(() =>
          widget.evaluate((element) => {
            const style = getComputedStyle(element);
            return { x: Number.parseFloat(style.left), y: Number.parseFloat(style.top) };
          }),
        )
        .toEqual(restoredPosition);

      // Open the real GameMap popover, then put the player over its marked header. The app's
      // MutationObserver-backed hook must move the bubble out of the actual rendered target.
      const map = page.locator('[data-tour="game-map"]');
      const openMap = map.getByRole("button", { name: "Open map", exact: true });
      await expect(openMap).toBeVisible();
      await openMap.click();
      const mapHeader = map.locator("[data-floating-widget-avoid]");
      await expect(mapHeader).toBeVisible();
      const header = await mapHeader.boundingBox();
      expect(header).not.toBeNull();
      const requested = {
        x: Math.round(header!.x + header!.width / 2 - initial!.width / 2),
        y: Math.round(header!.y + header!.height / 2 - initial!.height / 2),
      };
      await page.evaluate(async (position) => {
        const { useUIStore } = (await import(
          "/src/stores/ui.store.ts" as string
        )) as typeof import("../packages/client/src/stores/ui.store");
        useUIStore.getState().setSpotifyMobileWidgetPosition(position);
      }, requested);
      await expect
        .poll(async () => {
          const [widgetBox, targetBox] = await Promise.all([widget.boundingBox(), mapHeader.boundingBox()]);
          if (!widgetBox || !targetBox) return false;
          const overlaps =
            widgetBox.x < targetBox.x + targetBox.width &&
            widgetBox.x + widgetBox.width > targetBox.x &&
            widgetBox.y < targetBox.y + targetBox.height &&
            widgetBox.y + widgetBox.height > targetBox.y;
          return !overlaps;
        })
        .toBe(true);
      const avoided = await widget.boundingBox();
      expect(avoided).not.toBeNull();
      expect(Math.round(avoided!.x)).not.toBe(requested.x);

      const start = await widget.boundingBox();
      expect(start).not.toBeNull();
      const destination = { x: 180, y: 270 };
      await page.mouse.move(start!.x + start!.width / 2, start!.y + start!.height / 2);
      await page.mouse.down();
      await page.mouse.move(destination.x + start!.width / 2, destination.y + start!.height / 2, { steps: 5 });
      await page.mouse.up();
      // UI persistence debounces ordinary changes; wait for the real write before reloading.
      await expect
        .poll(() =>
          page.evaluate(() => {
            const raw = localStorage.getItem("marinara-engine-ui");
            return raw ? JSON.parse(raw).state.spotifyMobileWidgetPosition : null;
          }),
        )
        .toEqual(destination);

      const stored = await page.evaluate(() => {
        const raw = localStorage.getItem("marinara-engine-ui");
        return raw ? JSON.parse(raw).state.spotifyMobileWidgetPosition : null;
      });
      expect(stored).toMatchObject({ x: expect.any(Number), y: expect.any(Number) });
      expect(Math.abs(stored.x - destination.x)).toBeLessThanOrEqual(2);
      expect(Math.abs(stored.y - destination.y)).toBeLessThanOrEqual(2);

      // Dragging outside the map dismisses its popover through the existing outside-pointer handler.
      await expect(mapHeader).not.toBeVisible();
      await page.reload();
      await expect(widget).toBeVisible();
      await expect
        .poll(async () => {
          const box = await widget.boundingBox();
          return box ? { x: Math.round(box.x), y: Math.round(box.y) } : null;
        })
        .toEqual({ x: Math.round(stored.x), y: Math.round(stored.y) });

      const disableAgain = await request.put("/api/app-settings/features", {
        data: { ...originalFeatures, floatingMediaPlacement: false },
      });
      expect(disableAgain.ok()).toBeTruthy();
      await page.reload();
      await expect(widget).toBeVisible();
      await expect
        .poll(async () => {
          const box = await widget.boundingBox();
          return box ? { x: Math.round(box.x), y: Math.round(box.y) } : null;
        })
        .toEqual({ x: Math.round(stored.x), y: Math.round(stored.y) });
      expect(
        await page.evaluate(() => {
          const raw = localStorage.getItem("marinara-engine-ui");
          return raw ? JSON.parse(raw).state.spotifyMobileWidgetPosition : null;
        }),
      ).toMatchObject({ x: stored.x, y: stored.y });
    }
    expect(externalRequests).toEqual([]);
  } catch (error) {
    testFailed = true;
    testFailure = error;
  } finally {
    const cleanupApi = cleanupRequest;
    try {
      if (cleanupApi && originalFeatures) {
        try {
          const response = await cleanupApi.put("/api/app-settings/features", { data: originalFeatures });
          if (!response.ok()) throw new Error(`Feature settings cleanup failed: HTTP ${response.status()}`);
        } catch (error) {
          cleanupFailures.push(`Feature settings cleanup: ${String(error)}`);
        }
      }
      if (cleanupApi) {
        try {
          const deletes = await Promise.allSettled(
            ownedResources.map(async (path) => {
              const response = await cleanupApi.delete(`${path}?force=true`, { timeout: 10_000 });
              if (!response.ok() && response.status() !== 404) {
                throw new Error(`DELETE ${path}: HTTP ${response.status()}`);
              }
            }),
          );
          for (const result of deletes) if (result.status === "rejected") cleanupFailures.push(String(result.reason));
        } catch (error) {
          cleanupFailures.push(`DELETE cleanup: ${String(error)}`);
        }

        try {
          const verifies = await Promise.allSettled(
            ownedResources.map(async (path) => {
              const response = await cleanupApi.get(path, { timeout: 10_000 });
              if (response.status() !== 404) throw new Error(`GET ${path} after cleanup: HTTP ${response.status()}`);
            }),
          );
          for (const result of verifies) if (result.status === "rejected") cleanupFailures.push(String(result.reason));
        } catch (error) {
          cleanupFailures.push(`GET cleanup verification: ${String(error)}`);
        }
      }
    } finally {
      try {
        await cleanupApi?.dispose();
      } catch (error) {
        cleanupFailures.push(`cleanupRequest.dispose: ${String(error)}`);
      }
      // The Playwright webServer fixture owns server shutdown; always close this page, even if
      // resource cleanup itself fails during setup or assertions.
      await page.close().catch((error) => cleanupFailures.push(`page.close: ${String(error)}`));
    }
  }

  if (testFailed) {
    if (cleanupFailures.length) {
      throw new AggregateError([testFailure, ...cleanupFailures.map((failure) => new Error(failure))]);
    }
    throw testFailure;
  }
  expect(cleanupFailures, "attempt every owned-resource cleanup and verify it is gone").toEqual([]);
});
