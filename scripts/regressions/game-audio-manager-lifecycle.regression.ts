import assert from "node:assert/strict";

type Deferred = { resolve: () => void; reject: (error: Error) => void };

class SyntheticDocument {
  private listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const callback =
      typeof listener === "function" ? listener : (event: unknown) => listener.handleEvent(event as Event);
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(callback as (event: unknown) => void);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const callback =
      typeof listener === "function" ? listener : (event: unknown) => listener.handleEvent(event as Event);
    this.listeners.get(type)?.delete(callback as (event: unknown) => void);
  }

  visibilityState = "hidden";

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  dispatch(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener({ type });
  }
}

class SyntheticAudio {
  static instances: SyntheticAudio[] = [];
  static createdSources: string[] = [];
  static nextPlayError: Error | null = null;
  static nextDeferred: Deferred | null = null;

  src = "";
  preload = "";
  loop = false;
  muted = false;
  volume = 1;
  currentTime = 0;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(src = "") {
    this.src = src;
    if (src) SyntheticAudio.createdSources.push(src);
    SyntheticAudio.instances.push(this);
  }

  play(): Promise<void> {
    const deferred = SyntheticAudio.nextDeferred;
    if (deferred) {
      SyntheticAudio.nextDeferred = null;
      return new Promise<void>((resolve, reject) => {
        deferred.resolve = resolve;
        deferred.reject = reject;
      });
    }

    const error = SyntheticAudio.nextPlayError;
    SyntheticAudio.nextPlayError = null;
    return error ? Promise.reject(error) : Promise.resolve();
  }

  pause(): void {}
  load(): void {}
  removeAttribute(name: string): void {
    if (name === "src") this.src = "";
  }
}

class SyntheticAudioContext {
  static instances: SyntheticAudioContext[] = [];

  state = "running";
  sampleRate = 44_100;
  currentTime = 0;
  destination = {};
  oscillatorsStarted = 0;
  bufferSourcesStarted = 0;
  resumeCalls = 0;
  resumePromise: Promise<void> | null = null;
  gainValues: number[] = [];
  gainStates: Array<{ value: number }> = [];

  constructor() {
    SyntheticAudioContext.instances.push(this);
  }

  resume(): Promise<void> {
    this.resumeCalls += 1;
    if (this.resumePromise) return this.resumePromise;
    this.state = "running";
    return Promise.resolve();
  }

  decodeAudioData(_data: ArrayBuffer): Promise<AudioBuffer> {
    return Promise.resolve({} as AudioBuffer);
  }

  createBuffer(): object {
    return {};
  }

  createBufferSource() {
    return {
      buffer: null,
      loop: false,
      connect() {},
      start: () => {
        this.bufferSourcesStarted += 1;
      },
      stop() {},
      disconnect() {},
    };
  }

  createMediaElementSource() {
    return { connect() {}, disconnect() {} };
  }

  createGain() {
    const state = { value: 1 };
    this.gainStates.push(state);
    return {
      context: this,
      gain: {
        setValueAtTime: (value: number) => {
          state.value = value;
          this.gainValues.push(value);
        },
        exponentialRampToValueAtTime() {},
      },
      connect() {},
      disconnect() {},
    };
  }

  createOscillator() {
    return {
      frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      type: "",
      connect() {},
      start: () => {
        this.oscillatorsStarted += 1;
      },
      stop() {},
      disconnect() {},
    };
  }
}

function namedError(name: string): Error {
  return Object.assign(new Error(name), { name });
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

Object.defineProperty(globalThis, "document", { configurable: true, value: new SyntheticDocument() });
Object.defineProperty(globalThis, "Audio", { configurable: true, value: SyntheticAudio });
Object.defineProperty(globalThis, "window", { configurable: true, value: { AudioContext: SyntheticAudioContext } });
let allowSyntheticAudioFetch = false;
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  value: async () => {
    if (!allowSyntheticAudioFetch) throw new Error("synthetic audio asset unavailable");
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) };
  },
});

const { audioManager } = await import("../../packages/client/src/lib/game-audio.ts");
const syntheticDocument = globalThis.document as unknown as SyntheticDocument;
const failures: string[] = [];
const expect = (condition: boolean, message: string) => {
  if (!condition) failures.push(message);
};

// A user gesture enables SFX fallback and starts the manager's ordinary playback path.
syntheticDocument.dispatch("click");

// When the fixed-size pool wraps, play() on the old source can reject after that same element
// already belongs to a newer sound. Its stale rejection must not schedule a procedural fallback.
const firstPlay: Deferred = { resolve: () => {}, reject: () => {} };
SyntheticAudio.nextDeferred = firstPlay;
for (let index = 0; index < 9; index++) audioManager.playSfx(`sfx:menu-hover-${index}`);
const scheduledTimeouts: number[] = [];
const nativeSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
  scheduledTimeouts.push(Number(timeout ?? 0));
  return nativeSetTimeout(handler, timeout, ...args);
}) as typeof setTimeout;
firstPlay.reject(namedError("AbortError"));
await flushPromises();
globalThis.setTimeout = nativeSetTimeout;
expect(
  scheduledTimeouts.length === 0,
  `stale pooled SFX rejection scheduled ${scheduledTimeouts.length} procedural fallback timer(s)`,
);

// A rejected media format is not repaired by another user gesture and must not be retried as if
// the browser had blocked autoplay. True autoplay rejection remains eligible for one gesture retry.
SyntheticAudio.nextPlayError = namedError("NotSupportedError");
audioManager.playMusic("music:unsupported", { "music:unsupported": { path: "unsupported.mp3" } });
await flushPromises();
const afterUnsupportedFailure = SyntheticAudio.instances.length;
syntheticDocument.dispatch("pointerdown");
await flushPromises();
expect(
  SyntheticAudio.instances.length === afterUnsupportedFailure,
  "non-autoplay music failure was retried after a user gesture",
);

SyntheticAudio.nextPlayError = namedError("NotAllowedError");
audioManager.playMusic("music:autoplay-blocked", { "music:autoplay-blocked": { path: "autoplay.mp3" } });
await flushPromises();
const afterAutoplayFailure = SyntheticAudio.instances.length;
syntheticDocument.dispatch("pointerdown");
await flushPromises();
expect(
  SyntheticAudio.instances.length > afterAutoplayFailure,
  "autoplay-blocked music was not retried after a user gesture",
);

SyntheticAudio.nextPlayError = namedError("NotSupportedError");
audioManager.playAmbient("ambient:unsupported", { "ambient:unsupported": { path: "unsupported.ogg" } });
await flushPromises();
const afterUnsupportedAmbientFailure = SyntheticAudio.instances.length;
syntheticDocument.dispatch("pointerdown");
await flushPromises();
expect(
  SyntheticAudio.instances.length === afterUnsupportedAmbientFailure,
  "non-autoplay ambient failure was retried after a user gesture",
);

SyntheticAudio.nextPlayError = namedError("NotAllowedError");
audioManager.playAmbient("ambient:autoplay-blocked", { "ambient:autoplay-blocked": { path: "autoplay.ogg" } });
await flushPromises();
const afterAutoplayAmbientFailure = SyntheticAudio.instances.length;
syntheticDocument.dispatch("pointerdown");
await flushPromises();
expect(
  SyntheticAudio.instances.length > afterAutoplayAmbientFailure,
  "autoplay-blocked ambient was not retried after a user gesture",
);

const audioUrl = (path: string) => `/api/game-assets/file/${path}`;
const musicAPath = "music/pending-a.mp3";
const musicBPath = "music/unsupported-b.mp3";
SyntheticAudio.nextPlayError = namedError("NotAllowedError");
audioManager.playMusic("music:pending-a", { "music:pending-a": { path: musicAPath } });
await flushPromises();
SyntheticAudio.nextPlayError = namedError("NotSupportedError");
audioManager.playMusic("music:unsupported-b", { "music:unsupported-b": { path: musicBPath } });
await flushPromises();
const beforeMusicSupersessionGesture = SyntheticAudio.createdSources.length;
syntheticDocument.dispatch("pointerdown");
await flushPromises();
expect(
  !SyntheticAudio.createdSources.slice(beforeMusicSupersessionGesture).includes(audioUrl(musicAPath)),
  "a superseded autoplay-blocked music tag resumed after the newer tag failed for another reason",
);

const lateMusicPath = "music/late-old-failure.mp3";
const laterMusicPath = "music/later-request.mp3";
const lateMusicPlay: Deferred = { resolve: () => {}, reject: () => {} };
SyntheticAudio.nextDeferred = lateMusicPlay;
audioManager.playMusic("music:late-old-failure", { "music:late-old-failure": { path: lateMusicPath } });
await flushPromises();
SyntheticAudio.nextPlayError = namedError("NotSupportedError");
audioManager.playMusic("music:later-request", { "music:later-request": { path: laterMusicPath } });
await flushPromises();
lateMusicPlay.reject(namedError("NotAllowedError"));
await flushPromises();
const beforeLateMusicGesture = SyntheticAudio.createdSources.length;
syntheticDocument.dispatch("pointerdown");
await flushPromises();
expect(
  !SyntheticAudio.createdSources.slice(beforeLateMusicGesture).includes(audioUrl(lateMusicPath)),
  "an older in-flight music failure replaced the newer request's retry state",
);

const ambientAPath = "ambient/pending-a.ogg";
const ambientBPath = "ambient/unsupported-b.ogg";
SyntheticAudio.nextPlayError = namedError("NotAllowedError");
audioManager.playAmbient("ambient:pending-a", { "ambient:pending-a": { path: ambientAPath } });
await flushPromises();
SyntheticAudio.nextPlayError = namedError("NotSupportedError");
audioManager.playAmbient("ambient:unsupported-b", { "ambient:unsupported-b": { path: ambientBPath } });
await flushPromises();
const beforeAmbientSupersessionGesture = SyntheticAudio.createdSources.length;
syntheticDocument.dispatch("pointerdown");
await flushPromises();
expect(
  !SyntheticAudio.createdSources.slice(beforeAmbientSupersessionGesture).includes(audioUrl(ambientAPath)),
  "a superseded autoplay-blocked ambient tag resumed after the newer tag failed for another reason",
);

const lateAmbientPath = "ambient/late-old-failure.ogg";
const laterAmbientPath = "ambient/later-request.ogg";
const lateAmbientPlay: Deferred = { resolve: () => {}, reject: () => {} };
SyntheticAudio.nextDeferred = lateAmbientPlay;
audioManager.playAmbient("ambient:late-old-failure", { "ambient:late-old-failure": { path: lateAmbientPath } });
await flushPromises();
SyntheticAudio.nextPlayError = namedError("NotSupportedError");
audioManager.playAmbient("ambient:later-request", { "ambient:later-request": { path: laterAmbientPath } });
await flushPromises();
lateAmbientPlay.reject(namedError("NotAllowedError"));
await flushPromises();
const beforeLateAmbientGesture = SyntheticAudio.createdSources.length;
syntheticDocument.dispatch("pointerdown");
await flushPromises();
expect(
  !SyntheticAudio.createdSources.slice(beforeLateAmbientGesture).includes(audioUrl(lateAmbientPath)),
  "an older in-flight ambient failure replaced the newer request's retry state",
);

// The latest blocked request still owns the one-shot retry when an older blocked request was pending.
const musicLatestAPath = "music/older-blocked.mp3";
const musicLatestBPath = "music/latest-blocked.mp3";
SyntheticAudio.nextPlayError = namedError("NotAllowedError");
audioManager.playMusic("music:older-blocked", { "music:older-blocked": { path: musicLatestAPath } });
await flushPromises();
SyntheticAudio.nextPlayError = namedError("NotAllowedError");
audioManager.playMusic("music:latest-blocked", { "music:latest-blocked": { path: musicLatestBPath } });
await flushPromises();
const beforeLatestMusicGesture = SyntheticAudio.createdSources.length;
syntheticDocument.dispatch("pointerdown");
await flushPromises();
const latestMusicRetries = SyntheticAudio.createdSources.slice(beforeLatestMusicGesture);
expect(
  latestMusicRetries.includes(audioUrl(musicLatestBPath)),
  "the latest autoplay-blocked music request was not retried",
);
expect(!latestMusicRetries.includes(audioUrl(musicLatestAPath)), "an older autoplay-blocked music request was retried");

const ambientLatestAPath = "ambient/older-blocked.ogg";
const ambientLatestBPath = "ambient/latest-blocked.ogg";
SyntheticAudio.nextPlayError = namedError("NotAllowedError");
audioManager.playAmbient("ambient:older-blocked", { "ambient:older-blocked": { path: ambientLatestAPath } });
await flushPromises();
SyntheticAudio.nextPlayError = namedError("NotAllowedError");
audioManager.playAmbient("ambient:latest-blocked", { "ambient:latest-blocked": { path: ambientLatestBPath } });
await flushPromises();
const beforeLatestAmbientGesture = SyntheticAudio.createdSources.length;
syntheticDocument.dispatch("pointerdown");
await flushPromises();
const latestAmbientRetries = SyntheticAudio.createdSources.slice(beforeLatestAmbientGesture);
expect(
  latestAmbientRetries.includes(audioUrl(ambientLatestBPath)),
  "the latest autoplay-blocked ambient request was not retried",
);
expect(
  !latestAmbientRetries.includes(audioUrl(ambientLatestAPath)),
  "an older autoplay-blocked ambient request was retried",
);

// A delayed loop fallback belongs to the captured play owner, not merely the current manager generation.
const nativeSetTimeoutForDelayedSfx = globalThis.setTimeout;
const nativeClearTimeoutForDelayedSfx = globalThis.clearTimeout;
const delayedTimers = new Map<number, { callback: () => void; delay: number }>();
let nextSyntheticTimer = 1;
globalThis.setTimeout = ((handler: TimerHandler, timeout?: number) => {
  const timerId = nextSyntheticTimer++;
  delayedTimers.set(timerId, { callback: handler as () => void, delay: Number(timeout ?? 0) });
  return timerId as unknown as ReturnType<typeof setTimeout>;
}) as unknown as typeof setTimeout;
globalThis.clearTimeout = ((timerId: ReturnType<typeof setTimeout>) => {
  delayedTimers.delete(timerId as unknown as number);
}) as typeof clearTimeout;

SyntheticAudio.nextPlayError = namedError("NotSupportedError");
audioManager.playSfx("sfx:menu-hover", undefined, 2);
await flushPromises();
const delayedOldSfx = [...delayedTimers.entries()];
expect(delayedOldSfx.length === 2, `loopCount=2 should queue two fallback timers, got ${delayedOldSfx.length}`);
expect(
  delayedOldSfx.map(([, timer]) => timer.delay).join(",") === "0,350",
  `loopCount=2 should queue fallback delays 0,350ms, got ${delayedOldSfx.map(([, timer]) => timer.delay).join(",")}`,
);
for (let index = 0; index < 7; index++) audioManager.playSfx(`sfx:replacement-${index}`);
SyntheticAudio.nextPlayError = namedError("NotSupportedError");
audioManager.playSfx("sfx:menu-hover");
await flushPromises();
const currentSfxTimer = [...delayedTimers.entries()].at(-1);
expect(Boolean(currentSfxTimer), "the current SFX failure did not queue its procedural fallback");
const syntheticContext = SyntheticAudioContext.instances[0]!;
const oscillatorCountBeforeTimers = syntheticContext.oscillatorsStarted;
for (const [, timer] of delayedOldSfx) timer.callback();
currentSfxTimer?.[1].callback();
const proceduralStarts = syntheticContext.oscillatorsStarted - oscillatorCountBeforeTimers;
expect(
  proceduralStarts === 1,
  `expected only the current SFX fallback to play once, got ${proceduralStarts} procedural tone(s)`,
);
globalThis.setTimeout = nativeSetTimeoutForDelayedSfx;
globalThis.clearTimeout = nativeClearTimeoutForDelayedSfx;

// Exercise real buffered playback with a controllable synthetic context and response.
allowSyntheticAudioFetch = true;
const context = SyntheticAudioContext.instances[0]!;
const nativeSetInterval = globalThis.setInterval;
const nativeClearInterval = globalThis.clearInterval;
const initialCrossfadeTicks: Array<() => void> = [];
globalThis.setInterval = ((handler: TimerHandler) => {
  initialCrossfadeTicks.push(handler as () => void);
  return (9170 + initialCrossfadeTicks.length) as unknown as ReturnType<typeof setInterval>;
}) as typeof setInterval;
globalThis.clearInterval = (() => {}) as typeof clearInterval;
audioManager.setVolumes(0.4, 0.5, 0.3);
audioManager.playMusic("music:volume-check", { "music:volume-check": { path: "music/volume-check.mp3" } });
await flushPromises();
await flushPromises();
expect(initialCrossfadeTicks.length === 1, "initial buffered music did not begin its crossfade");
for (let step = 0; step < 40; step++) initialCrossfadeTicks[0]?.();
globalThis.setInterval = nativeSetInterval;
globalThis.clearInterval = nativeClearInterval;
audioManager.playAmbient("ambient:volume-check", { "ambient:volume-check": { path: "ambient/volume-check.ogg" } });
await flushPromises();
await flushPromises();
audioManager.setMuted(true);
audioManager.setVolumes(0.8, 0.5, 0.65);
const gainCountBeforeUnmute = context.gainValues.length;
audioManager.setMuted(false);
const unmutedGains = context.gainValues.slice(gainCountBeforeUnmute);
expect(unmutedGains.includes(0.8), "music volume changed while muted was not applied on unmute");
expect(unmutedGains.includes(0.65), "ambient volume changed while muted was not applied on unmute");

// A crossfade must use the latest slider value on every tick rather than a stale starting step.
let crossfadeTick: (() => void) | null = null;
globalThis.setInterval = ((handler: TimerHandler) => {
  crossfadeTick = handler as () => void;
  return 9182 as unknown as ReturnType<typeof setInterval>;
}) as typeof setInterval;
globalThis.clearInterval = (() => {}) as typeof clearInterval;
audioManager.setVolumes(0.2, 0.5, 0.65);
audioManager.playMusic("music:crossfade-next", { "music:crossfade-next": { path: "music/crossfade-next.mp3" } });
await flushPromises();
await flushPromises();
expect(Boolean(crossfadeTick), "buffered music did not start a crossfade interval");
audioManager.setVolumes(0.8, 0.5, 0.65);
const gainCountBeforeCrossfadeTick = context.gainValues.length;
crossfadeTick?.();
const crossfadeGains = context.gainValues.slice(gainCountBeforeCrossfadeTick);
expect(
  crossfadeGains.some((value) => Math.abs(value - 0.02) < 0.0001),
  "crossfade did not use the latest music volume for its incoming layer",
);
expect(
  crossfadeGains.some((value) => Math.abs(value - 0.78) < 0.0001),
  "crossfade did not use the latest music volume for its outgoing layer",
);
for (let step = 1; step < 40; step++) crossfadeTick?.();
// Stop fades remain audible layers: mute and slider updates must reach them.
audioManager.stopAmbient();
audioManager.stopMusic();
crossfadeTick?.();
const fadingGain = context.gainStates.at(-1)!;
audioManager.setMuted(true);
expect(fadingGain.value === 0, "stop fade ignored mute");
audioManager.setVolumes(0, 0.5, 0.65);
crossfadeTick?.();
audioManager.setVolumes(0.4, 0.5, 0.65);
audioManager.setMuted(false);
expect(
  Math.abs(fadingGain.value - 0.38) < 0.0001,
  "stop fade lost its remaining envelope after volume changed through zero",
);
for (let step = 2; step < 40; step++) crossfadeTick?.();
expect(fadingGain.value === 0, "stop fade did not reach silence");
globalThis.setInterval = nativeSetInterval;
globalThis.clearInterval = nativeClearInterval;
audioManager.stopMusic(true);
audioManager.stopAmbient();

// Stopping either buffered layer while resume() is pending must prevent source creation afterward.
context.state = "running";
const oneShotStartsBefore = context.bufferSourcesStarted;
const oneShot = audioManager.playOneShot("/audio/stop-one-shot.mp3", { volume: 1 });
let resolveOneShotResume!: () => void;
context.resumePromise = new Promise<void>((resolve) => {
  resolveOneShotResume = resolve;
});
context.state = "suspended";
await flushPromises();
oneShot.stop();
context.state = "running";
resolveOneShotResume();
await oneShot.ready;
expect(
  context.bufferSourcesStarted === oneShotStartsBefore,
  "a stopped one-shot created a buffer source after resume completed",
);
context.resumePromise = null;

context.state = "running";
const loopingStartsBefore = context.bufferSourcesStarted;
audioManager.playMusic("music:stop-during-resume", {
  "music:stop-during-resume": { path: "music/stop-during-resume.mp3" },
});
let resolveLoopingResume!: () => void;
context.resumePromise = new Promise<void>((resolve) => {
  resolveLoopingResume = resolve;
});
context.state = "suspended";
await flushPromises();
audioManager.stopMusic(true);
context.state = "running";
resolveLoopingResume();
await flushPromises();
await flushPromises();
expect(
  context.bufferSourcesStarted === loopingStartsBefore,
  "a stopped looping layer created a buffer source after resume completed",
);
context.resumePromise = null;

// Visible-tab recovery retries the context and falls back to a user gesture if resume is blocked.
expect(syntheticDocument.listenerCount("visibilitychange") === 1, "visibility recovery listener was not attached");
context.state = "suspended";
let resolveVisibilityResume!: () => void;
context.resumePromise = new Promise<void>((resolve) => {
  resolveVisibilityResume = resolve;
});
const resumeCallsBeforeVisibility = context.resumeCalls;
syntheticDocument.visibilityState = "visible";
syntheticDocument.dispatch("visibilitychange");
expect(
  context.resumeCalls === resumeCallsBeforeVisibility + 1,
  "visible-tab return did not try to resume the audio context",
);
context.state = "running";
resolveVisibilityResume();
await flushPromises();
let rejectBlockedResume!: (error: Error) => void;
context.resumePromise = new Promise<void>((_resolve, reject) => {
  rejectBlockedResume = reject;
});
void context.resumePromise.catch(() => {});
context.state = "suspended";
syntheticDocument.dispatch("visibilitychange");
rejectBlockedResume(new Error("synthetic resume blocked"));
await flushPromises();
expect(syntheticDocument.listenerCount("click") > 0, "blocked visibility resume did not install a gesture fallback");
syntheticDocument.dispatch("click");
await flushPromises();

// Dispose while a resume is pending; its continuation must not install listeners afterward.
let resolveDisposedResume!: () => void;
context.resumePromise = new Promise<void>((resolve) => {
  resolveDisposedResume = resolve;
});
context.state = "suspended";
syntheticDocument.dispatch("visibilitychange");
await flushPromises();
audioManager.dispose();
expect(
  syntheticDocument.listenerCount("visibilitychange") === 0,
  "dispose left the visibility recovery listener attached",
);
context.state = "running";
resolveDisposedResume();
await flushPromises();
expect(
  syntheticDocument.listenerCount("click") === 0,
  "a visibility continuation installed a gesture listener after dispose",
);
context.resumePromise = null;

// A disposed singleton stays idle, then restores visibility recovery when reused by a later scene.
context.resumePromise = null;
context.state = "running";
audioManager.playMusic("music:after-dispose", { "music:after-dispose": { path: "music/after-dispose.mp3" } });
await flushPromises();
await flushPromises();
expect(
  syntheticDocument.listenerCount("visibilitychange") === 1,
  "later playback did not reattach visibility recovery after dispose",
);

let resolveReusedResume!: () => void;
context.resumePromise = new Promise<void>((resolve) => {
  resolveReusedResume = resolve;
});
context.state = "suspended";
const resumeCallsBeforeReuse = context.resumeCalls;
syntheticDocument.visibilityState = "visible";
syntheticDocument.dispatch("visibilitychange");
expect(
  context.resumeCalls === resumeCallsBeforeReuse + 1,
  "reused audio manager did not resume after a later visible-tab return",
);
context.state = "running";
resolveReusedResume();
await flushPromises();
audioManager.dispose();
expect(
  syntheticDocument.listenerCount("visibilitychange") === 0,
  "reused audio manager leaked its visibility listener after dispose",
);
context.resumePromise = null;

assert.deepEqual(failures, [], failures.join("\n"));
console.log("game audio manager lifecycle regression passed");
