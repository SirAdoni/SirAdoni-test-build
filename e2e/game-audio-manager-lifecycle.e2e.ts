import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const silentWav = (() => {
  const sampleRate = 8_000;
  const samples = 800;
  const wav = Buffer.alloc(44 + samples);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples, 40);
  wav.fill(128, 44);
  return wav;
})();

const invalidAudio = Buffer.from("owned synthetic invalid audio fixture");

type AudioProbe = {
  bufferSourceStarts: number;
  mediaElements: Record<number, HTMLMediaElement>;
  playCalls: Array<{ elementId: number; path: string }>;
  playErrors: Array<{ name: string; path: string }>;
  playSuccesses: Array<{ elementId: number; path: string }>;
  oscillatorStarts: number;
  audioParamWrites: Array<{ paramId: number; value: number }>;
};

declare global {
  interface Window {
    __gameAudioProbe?: AudioProbe;
    gameAudioManager?: typeof import("../packages/client/src/lib/game-audio").audioManager;
  }
}

function assertLoopbackOrigin(origin: string): string {
  const parsed = new URL(origin);
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (!loopbackHosts.has(parsed.hostname.toLowerCase()) || !["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Refusing non-loopback Playwright origin: ${origin}`);
  }
  return parsed.origin;
}

async function prepareApp(
  page: import("@playwright/test").Page,
  origin: string,
  options: { disableWebAudio?: boolean; observeOscillators?: boolean; observeAudioParams?: boolean } = {},
) {
  origin = assertLoopbackOrigin(origin);
  await page.route("**/*", (route) => {
    const request = route.request();
    if (new URL(request.url()).origin !== origin || !["GET", "HEAD"].includes(request.method())) {
      return route.abort();
    }
    return route.continue();
  });
  await page.route(new URL("/api/app-settings/ui", origin).href, (route) => route.fulfill({ json: { value: "" } }));
  await seedUIState(page, { hasCompletedOnboarding: true, sidebarOpen: false, rightPanelOpen: false });
  await page.addInitScript((value) => localStorage.setItem("marinara:whats-new:seen-version", value), version);
  await page.addInitScript(({ disableWebAudio, observeOscillators, observeAudioParams }) => {
    const probe: AudioProbe = {
      bufferSourceStarts: 0,
      mediaElements: {},
      playCalls: [],
      playErrors: [],
      playSuccesses: [],
      oscillatorStarts: 0,
      audioParamWrites: [],
    };
    Object.defineProperty(window, "__gameAudioProbe", { configurable: false, value: probe });

    const elementIds = new WeakMap<HTMLMediaElement, number>();
    let nextElementId = 1;
    const nativePlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      let elementId = elementIds.get(this);
      if (!elementId) {
        elementId = nextElementId++;
        elementIds.set(this, elementId);
      }
      probe.mediaElements[elementId] = this;
      // A pooled element can retain its previous currentSrc until the new src loads.
      const path = new URL(this.src || this.currentSrc, location.href).pathname;
      if (path.startsWith("/api/game-assets/file/")) probe.playCalls.push({ elementId, path });
      return nativePlay.apply(this, args).then(
        () => {
          if (path.startsWith("/api/game-assets/file/")) probe.playSuccesses.push({ elementId, path });
        },
        (error: DOMException) => {
          if (path.startsWith("/api/game-assets/file/")) probe.playErrors.push({ name: error.name, path });
          throw error;
        },
      );
    };

    if (observeOscillators && window.AudioContext) {
      const prototype = window.AudioContext.prototype;
      const createBufferSource = prototype.createBufferSource;
      prototype.createBufferSource = function (...args) {
        const source = createBufferSource.apply(this, args);
        const start = source.start.bind(source);
        source.start = (...startArgs) => {
          probe.bufferSourceStarts += 1;
          return start(...startArgs);
        };
        return source;
      };
      const createOscillator = prototype.createOscillator;
      prototype.createOscillator = function (...args) {
        const oscillator = createOscillator.apply(this, args);
        const start = oscillator.start.bind(oscillator);
        oscillator.start = (...startArgs) => {
          probe.oscillatorStarts += 1;
          return start(...startArgs);
        };
        return oscillator;
      };
    }

    if (observeAudioParams && window.AudioParam) {
      const prototype = window.AudioParam.prototype;
      const setValueAtTime = prototype.setValueAtTime;
      const paramIds = new WeakMap<AudioParam, number>();
      let nextParamId = 1;
      prototype.setValueAtTime = function (value, startTime) {
        let paramId = paramIds.get(this);
        if (!paramId) {
          paramId = nextParamId++;
          paramIds.set(this, paramId);
        }
        probe.audioParamWrites.push({ paramId, value });
        return setValueAtTime.call(this, value, startTime);
      };
    }

    if (disableWebAudio) {
      Object.defineProperty(window, "AudioContext", { configurable: true, value: undefined });
      Object.defineProperty(window, "webkitAudioContext", { configurable: true, value: undefined });
    }
  }, options);
}

async function openApp(page: import("@playwright/test").Page) {
  await page.goto("/");
  await expect(page.locator("#root")).toBeAttached();
}

async function unlockAudio(page: Page, touch: boolean) {
  const home = page.getByRole("button", { name: "Home", exact: true }).filter({ visible: true });
  if (touch) await home.tap();
  else await home.click();
}

async function routeWav(page: import("@playwright/test").Page, origin: string, path: string) {
  await page.route(new URL(`/api/game-assets/file/${path}`, origin).href, (route) =>
    route.fulfill({ status: 200, contentType: "audio/wav", body: silentWav }),
  );
}

test("audio fixture rejects remote origins without making a request", () => {
  expect(() => assertLoopbackOrigin("https://example.invalid")).toThrow(/non-loopback/);
  expect(() => assertLoopbackOrigin("http://127.0.0.1:5178")).not.toThrow();
});

test("Game audio retries only the latest deferred music layer", async ({ page }, testInfo) => {
  const origin = new URL(String(testInfo.project.use.baseURL)).origin;
  await prepareApp(page, origin, { observeOscillators: true });

  let firstRequests = 0;
  let latestRequests = 0;
  await page.route(new URL("/api/game-assets/file/audio/synthetic/first.wav", origin).href, (route) => {
    firstRequests += 1;
    return route.fulfill({ contentType: "audio/wav", body: silentWav });
  });
  await page.route(new URL("/api/game-assets/file/audio/synthetic/latest.wav", origin).href, (route) => {
    latestRequests += 1;
    return route.fulfill({ contentType: "audio/wav", body: silentWav });
  });
  await openApp(page);

  await page.evaluate(async () => {
    const { audioManager } = await import("/src/lib/game-audio.ts" as string);
    audioManager.playMusic("music:first", { "music:first": { path: "audio/synthetic/first.wav" } });
    audioManager.playMusic("music:latest", { "music:latest": { path: "audio/synthetic/latest.wav" } });
  });
  expect(firstRequests).toBe(0);
  await unlockAudio(page, Boolean(testInfo.project.use.hasTouch));
  await expect.poll(() => latestRequests).toBe(1);
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (
            (await import("/src/lib/game-audio.ts" as string)) as typeof import("../packages/client/src/lib/game-audio")
          ).audioManager.getState().musicTag,
      ),
    )
    .toBe("music:latest");
  await expect
    .poll(() =>
      page.evaluate(() => (window as Window & { __gameAudioProbe: AudioProbe }).__gameAudioProbe.bufferSourceStarts),
    )
    .toBeGreaterThanOrEqual(2);
  expect(firstRequests).toBe(0);
});

test("A superseded in-flight media failure does not reclaim the music layer", async ({ page }, testInfo) => {
  const origin = new URL(String(testInfo.project.use.baseURL)).origin;
  await prepareApp(page, origin, { disableWebAudio: true });

  const firstPath = "/api/game-assets/file/audio/synthetic/in-flight.wav";
  const latestPath = "/api/game-assets/file/audio/synthetic/replacement.wav";
  let firstRequests = 0;
  let latestRequests = 0;
  let notifyFirstRequest!: () => void;
  let releaseFirstResponse!: () => void;
  const firstRequested = new Promise<void>((resolve) => (notifyFirstRequest = resolve));
  const holdFirstResponse = new Promise<void>((resolve) => (releaseFirstResponse = resolve));

  await page.route(new URL(firstPath, origin).href, async (route) => {
    firstRequests += 1;
    notifyFirstRequest();
    await holdFirstResponse;
    try {
      await route.fulfill({ contentType: "audio/wav", body: silentWav });
    } catch {
      // The browser may cancel this response when the manager releases the superseded element.
    }
  });
  await page.route(new URL(latestPath, origin).href, (route) => {
    latestRequests += 1;
    return route.fulfill({ contentType: "audio/wav", body: silentWav });
  });
  await openApp(page);

  await page.evaluate(async () => {
    const { audioManager } = await import("/src/lib/game-audio.ts" as string);
    Object.assign(window, { gameAudioManager: audioManager });
  });
  await unlockAudio(page, Boolean(testInfo.project.use.hasTouch));
  try {
    await page.evaluate(() => {
      const manager = window.gameAudioManager!;
      manager.playMusic("music:in-flight", { "music:in-flight": { path: "audio/synthetic/in-flight.wav" } });
    });
    await firstRequested;
    await page.evaluate(() => {
      const manager = window.gameAudioManager!;
      manager.playMusic("music:replacement", { "music:replacement": { path: "audio/synthetic/replacement.wav" } });
    });
    await expect.poll(() => latestRequests).toBe(1);
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as Window & { __gameAudioProbe: AudioProbe }).__gameAudioProbe.playSuccesses.some((success) =>
            success.path.endsWith("replacement.wav"),
          ),
        ),
      )
      .toBe(true);
    releaseFirstResponse();
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as Window & { __gameAudioProbe: AudioProbe }).__gameAudioProbe.playErrors.some((error) =>
            error.path.endsWith("in-flight.wav"),
          ),
        ),
      )
      .toBe(true);
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as Window & { __gameAudioProbe: AudioProbe }).__gameAudioProbe.playCalls.some((call) =>
            call.path.endsWith("replacement.wav"),
          ),
        ),
      )
      .toBe(true);
    await page.waitForTimeout(0);
    const afterStaleFailure = await page.evaluate(() => {
      const probe = (window as Window & { __gameAudioProbe: AudioProbe }).__gameAudioProbe;
      const replacement = probe.playSuccesses.find((success) => success.path.endsWith("replacement.wav"));
      const element = replacement && probe.mediaElements[replacement.elementId];
      return {
        replacementPlaying: !!element && !element.paused && !element.ended,
        musicTag: window.gameAudioManager!.getState().musicTag,
        inFlightPlayCalls: probe.playCalls.filter((call) => call.path.endsWith("in-flight.wav")).length,
        replacementSuccesses: probe.playSuccesses.filter((success) => success.path.endsWith("replacement.wav")).length,
      };
    });
    expect(afterStaleFailure.musicTag).toBe("music:replacement");
    expect(afterStaleFailure.inFlightPlayCalls).toBe(1);
    expect(afterStaleFailure.replacementSuccesses).toBe(1);
    expect(afterStaleFailure.replacementPlaying).toBe(true);

    await unlockAudio(page, Boolean(testInfo.project.use.hasTouch));
    await page.waitForTimeout(100);
    expect(firstRequests).toBe(1);
    expect(latestRequests).toBe(1);
    const afterGesture = await page.evaluate(() => {
      const probe = (window as Window & { __gameAudioProbe: AudioProbe }).__gameAudioProbe;
      const replacement = probe.playSuccesses.find((success) => success.path.endsWith("replacement.wav"));
      const element = replacement && probe.mediaElements[replacement.elementId];
      return {
        replacementPlaying: !!element && !element.paused && !element.ended,
        musicTag: window.gameAudioManager!.getState().musicTag,
        inFlightPlayCalls: probe.playCalls.filter((call) => call.path.endsWith("in-flight.wav")).length,
      };
    });
    expect(afterGesture.musicTag).toBe("music:replacement");
    expect(afterGesture.inFlightPlayCalls).toBe(afterStaleFailure.inFlightPlayCalls);
    expect(afterGesture.replacementPlaying).toBe(true);
  } finally {
    releaseFirstResponse();
  }
});

test("SFX delayed fallback stays with the pooled element owner", async ({ page }, testInfo) => {
  const origin = new URL(String(testInfo.project.use.baseURL)).origin;
  await prepareApp(page, origin, { observeOscillators: true });
  await routeWav(page, origin, "audio/synthetic/sfx-valid.wav");
  await page.route(new URL("/api/game-assets/file/audio/synthetic/sfx-invalid-old.wav", origin).href, (route) =>
    route.fulfill({ status: 200, contentType: "audio/wav", body: invalidAudio }),
  );
  await page.route(new URL("/api/game-assets/file/audio/synthetic/sfx-invalid-current.wav", origin).href, (route) =>
    route.fulfill({ status: 200, contentType: "audio/wav", body: invalidAudio }),
  );
  await openApp(page);

  await page.evaluate(async () => {
    const { audioManager } = await import("/src/lib/game-audio.ts" as string);
    Object.assign(window, { gameAudioManager: audioManager });
  });
  await unlockAudio(page, Boolean(testInfo.project.use.hasTouch));
  const oldManifest = { "ui:menu-hover": { path: "audio/synthetic/sfx-invalid-old.wav" } };
  await page.evaluate((manifest) => {
    const manager = window.gameAudioManager!;
    manager.playSfx("ui:menu-hover", manifest, 2);
  }, oldManifest);
  await expect
    .poll(() =>
      page.evaluate(() => (window as Window & { __gameAudioProbe: AudioProbe }).__gameAudioProbe.oscillatorStarts),
    )
    .toBe(1);

  const validManifest = { "ui:menu-hover": { path: "audio/synthetic/sfx-valid.wav" } };
  const currentManifest = { "ui:menu-hover": { path: "audio/synthetic/sfx-invalid-current.wav" } };
  await page.evaluate(
    ({ valid, current }) => {
      const manager = window.gameAudioManager!;
      for (let index = 0; index < 7; index += 1) manager.playSfx("ui:menu-hover", valid);
      manager.playSfx("ui:menu-hover", current);
    },
    { valid: validManifest, current: currentManifest },
  );

  const oldAndCurrentIds = await page.evaluate(() => {
    const calls = (window as Window & { __gameAudioProbe: AudioProbe }).__gameAudioProbe.playCalls;
    const oldCall = calls.find((call) => call.path.endsWith("sfx-invalid-old.wav"));
    const currentCall = calls.find((call) => call.path.endsWith("sfx-invalid-current.wav"));
    return { oldId: oldCall?.elementId, currentId: currentCall?.elementId };
  });
  expect(oldAndCurrentIds.oldId).toBeDefined();
  expect(oldAndCurrentIds.currentId).toBe(oldAndCurrentIds.oldId);
  await expect
    .poll(() =>
      page.evaluate(() => (window as Window & { __gameAudioProbe: AudioProbe }).__gameAudioProbe.oscillatorStarts),
    )
    .toBe(2);
  await page.waitForTimeout(450);
  expect(
    await page.evaluate(() => (window as Window & { __gameAudioProbe: AudioProbe }).__gameAudioProbe.oscillatorStarts),
  ).toBe(2);
});
test("Game audio applies current volumes while muted and during a live crossfade", async ({ page }, testInfo) => {
  const origin = new URL(String(testInfo.project.use.baseURL)).origin;
  await prepareApp(page, origin, { observeAudioParams: true, observeOscillators: true });
  await routeWav(page, origin, "audio/synthetic/volume-active.wav");
  await routeWav(page, origin, "audio/synthetic/volume-ambient.wav");
  await routeWav(page, origin, "audio/synthetic/volume-next.wav");
  await openApp(page);

  await page.evaluate(async () => {
    const { audioManager } = await import("/src/lib/game-audio.ts" as string);
    Object.assign(window, { gameAudioManager: audioManager });
  });
  await unlockAudio(page, Boolean(testInfo.project.use.hasTouch));

  const startsBeforePlayback = await page.evaluate(
    () => (window as Window & { __gameAudioProbe: AudioProbe }).__gameAudioProbe.bufferSourceStarts,
  );
  await page.evaluate(() => {
    const manager = window.gameAudioManager!;
    manager.setVolumes(0.42, 0.5, 0.31);
    manager.playMusic("music:volume-active", {
      "music:volume-active": { path: "audio/synthetic/volume-active.wav" },
    });
    manager.playAmbient("ambient:volume-active", {
      "ambient:volume-active": { path: "audio/synthetic/volume-ambient.wav" },
    });
  });
  await expect
    .poll(() =>
      page.evaluate(() => (window as Window & { __gameAudioProbe: AudioProbe }).__gameAudioProbe.bufferSourceStarts),
    )
    .toBeGreaterThan(startsBeforePlayback + 1);
  await page.waitForTimeout(2_100);

  await page.evaluate(() => {
    const manager = window.gameAudioManager!;
    manager.setMuted(true);
    manager.setVolumes(0.82, 0.5, 0.67);
    manager.setMuted(false);
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const writes = (window as Window & { __gameAudioProbe: AudioProbe }).__gameAudioProbe.audioParamWrites;
        return (
          writes.some(({ value }) => Math.abs(value - 0.82) < 0.00001) &&
          writes.some(({ value }) => Math.abs(value - 0.67) < 0.00001)
        );
      }),
    )
    .toBe(true);

  const crossfadeStart = await page.evaluate(() => {
    const probe = (window as Window & { __gameAudioProbe: AudioProbe }).__gameAudioProbe;
    const manager = window.gameAudioManager!;
    manager.setVolumes(0.2, 0.5, 0.67);
    return probe.audioParamWrites.length;
  });
  await page.evaluate(() => {
    window.gameAudioManager!.playMusic("music:volume-next", {
      "music:volume-next": { path: "audio/synthetic/volume-next.wav" },
    });
  });
  const layerIdsHandle = await page.waitForFunction(
    (start) => {
      const writes = (window as Window & { __gameAudioProbe: AudioProbe }).__gameAudioProbe.audioParamWrites.slice(
        start,
      );
      for (let index = 0; index + 1 < writes.length; index += 1) {
        const firstWrite = writes[index]!;
        const secondWrite = writes[index + 1]!;
        if (
          firstWrite.paramId !== secondWrite.paramId &&
          firstWrite.value > 0 &&
          firstWrite.value < 0.2 &&
          Math.abs(firstWrite.value + secondWrite.value - 0.2) < 0.0001
        ) {
          return { firstMusicParamId: firstWrite.paramId, secondMusicParamId: secondWrite.paramId };
        }
      }
      return null;
    },
    crossfadeStart,
    { polling: "raf" },
  );
  const { firstMusicParamId, secondMusicParamId } = (await layerIdsHandle.jsonValue()) as {
    firstMusicParamId: number;
    secondMusicParamId: number;
  };
  const afterLiveVolumeChange = await page.evaluate(() => {
    const probe = (window as Window & { __gameAudioProbe: AudioProbe }).__gameAudioProbe;
    window.gameAudioManager!.setVolumes(0.8, 0.5, 0.67);
    return probe.audioParamWrites.length;
  });
  await page.waitForFunction(
    ({ start, firstMusicParamId, secondMusicParamId }) => {
      const latestByParam = new Map<number, number>();
      const writes = (window as Window & { __gameAudioProbe: AudioProbe }).__gameAudioProbe.audioParamWrites.slice(
        start,
      );
      for (const write of writes) {
        if (write.paramId === firstMusicParamId || write.paramId === secondMusicParamId) {
          latestByParam.set(write.paramId, write.value);
        }
      }
      const first = latestByParam.get(firstMusicParamId);
      const second = latestByParam.get(secondMusicParamId);
      return first !== undefined && second !== undefined && Math.abs(first + second - 0.8) < 0.0001;
    },
    { start: afterLiveVolumeChange, firstMusicParamId, secondMusicParamId },
    { polling: "raf" },
  );
  await page.waitForFunction(
    ({ start, firstMusicParamId, secondMusicParamId }) => {
      const latestByParam = new Map<number, number>();
      const writes = (window as Window & { __gameAudioProbe: AudioProbe }).__gameAudioProbe.audioParamWrites.slice(
        start,
      );
      for (const write of writes) {
        if (write.paramId === firstMusicParamId || write.paramId === secondMusicParamId) {
          latestByParam.set(write.paramId, write.value);
        }
      }
      const first = latestByParam.get(firstMusicParamId);
      const second = latestByParam.get(secondMusicParamId);
      return (
        first !== undefined &&
        second !== undefined &&
        ((Math.abs(first - 0.8) < 0.0001 && Math.abs(second) < 0.00001) ||
          (Math.abs(second - 0.8) < 0.0001 && Math.abs(first) < 0.00001))
      );
    },
    { start: afterLiveVolumeChange, firstMusicParamId, secondMusicParamId },
    { polling: "raf", timeout: 3_000 },
  );
});
