import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { isRetryableStoryboardPlannerTransportError } from "../../packages/server/src/services/game/storyboard-planner-fallback.js";
import {
  BACKGROUND_CONNECTION_IDLE_MS,
  BACKGROUND_CONNECTION_FAILURE_THRESHOLD,
  BackgroundConnectionBusyError,
  resetConnectionAdmissionForTests,
  tryBackgroundConnection,
  withConnectionAdmission,
} from "../../packages/server/src/services/generation/connection-admission.js";

assert.equal(isRetryableStoryboardPlannerTransportError(new Error("terminated")), true);
assert.equal(
  isRetryableStoryboardPlannerTransportError({ message: "request failed", cause: { code: "UND_ERR_SOCKET" } }),
  true,
);
assert.equal(isRetryableStoryboardPlannerTransportError(new Error("Storyboard returned invalid JSON")), false);
const explicitAbort = new Error("terminated");
explicitAbort.name = "AbortError";
assert.equal(
  isRetryableStoryboardPlannerTransportError(explicitAbort),
  false,
  "an explicit abort must never be retried even when its message resembles a transport termination",
);
assert.equal(
  isRetryableStoryboardPlannerTransportError(
    new SyntaxError('Unexpected token, "{ status: terminated }" is not valid JSON'),
  ),
  false,
  "malformed planner content must not become retryable because its parse error quotes a transport keyword",
);

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

const gameSurfaceSource = readFileSync(
  new URL("../../packages/client/src/components/game/GameSurface.tsx", import.meta.url),
  "utf8",
);
const gameRouteSource = readFileSync(
  new URL("../../packages/server/src/routes/game.routes.ts", import.meta.url),
  "utf8",
);
const spritesRouteSource = readFileSync(
  new URL("../../packages/server/src/routes/sprites.routes.ts", import.meta.url),
  "utf8",
);
const connectionEditorSource = readFileSync(
  new URL("../../packages/client/src/components/connections/ConnectionEditor.tsx", import.meta.url),
  "utf8",
);

const storyboardRouteStart = gameRouteSource.indexOf('app.post("/storyboard/generate"');
const storyboardRouteEnd = gameRouteSource.indexOf(
  'app.get<{ Params: { chatId: string } }>("/scene-videos/',
  storyboardRouteStart,
);
assert.notEqual(storyboardRouteStart, -1, "the storyboard generation route should exist");
assert.notEqual(storyboardRouteEnd, -1, "the storyboard generation route should have a stable end boundary");
const storyboardRouteSource = gameRouteSource.slice(storyboardRouteStart, storyboardRouteEnd);

assert.match(
  storyboardRouteSource,
  /admissionMode:\s*input\.automatic\s*\?\s*automaticGameMediaAdmissionMode\(input\.chatId\)/u,
  "automatic Storyboard images must share the chat's Game media admission group",
);
assert.ok(
  (gameRouteSource.match(/admissionMode:\s*automaticAssetAdmissionMode/g) ?? []).length >= 3,
  "automatic Game backgrounds, illustrations, and portraits must share one admission mode",
);

assert.match(
  storyboardRouteSource,
  /getAgentCallTimeoutMs\(\)/u,
  "the Storyboard planner should honor the configurable per-agent call timeout",
);
assert.doesNotMatch(
  gameRouteSource,
  /const GAME_STORYBOARD_ILLUSTRATOR_TIMEOUT_MS\s*=/u,
  "the Storyboard planner must not retain a hard-coded three-minute timeout",
);

const storyboardPlannerStart = storyboardRouteSource.indexOf("const plannerOptions = gameGenOptions");
const storyboardPlannerEnd = storyboardRouteSource.indexOf("plan = sanitizeStoryboardPlan(parsedPlan", storyboardPlannerStart);
assert.notEqual(storyboardPlannerStart, -1, "the Storyboard planner attempt should exist");
assert.notEqual(storyboardPlannerEnd, -1, "the Storyboard planner attempt should have a stable end boundary");
const storyboardPlannerSource = storyboardRouteSource.slice(storyboardPlannerStart, storyboardPlannerEnd);
assert.match(storyboardPlannerSource, /const runPlannerAttempt = async \(\) =>/u);
assert.match(
  storyboardPlannerSource,
  /reasoningEffort:\s*"low"/u,
  "the concise Storyboard JSON planner should override inherited maximum reasoning with low effort",
);

const manualStoryboardStart = gameSurfaceSource.indexOf("const handleGenerateTurnStoryboard = useCallback");
const manualStoryboardEnd = gameSurfaceSource.indexOf("\n  useEffect(() => {", manualStoryboardStart);
assert.notEqual(manualStoryboardStart, -1, "the manual Storyboard generation flow should exist");
assert.notEqual(manualStoryboardEnd, -1, "the manual Storyboard generation flow should have a stable end boundary");
const manualStoryboardSource = gameSurfaceSource.slice(manualStoryboardStart, manualStoryboardEnd);
const storyboardPreviewStart = manualStoryboardSource.indexOf(
  "if (useUIStore.getState().reviewImagePromptsBeforeSend) {",
);
const storyboardPreviewEnd = manualStoryboardSource.indexOf("\n          plannedStoryboard =", storyboardPreviewStart);
assert.notEqual(storyboardPreviewStart, -1, "the Storyboard prompt-preview flow should exist");
assert.notEqual(storyboardPreviewEnd, -1, "the Storyboard prompt-preview request should have a stable end boundary");
const storyboardPreviewRequestSource = manualStoryboardSource.slice(storyboardPreviewStart, storyboardPreviewEnd);
assert.match(
  storyboardPreviewRequestSource,
  /previewTurnStoryboardPrompts\.mutateAsync\(payload\)/u,
  "the Storyboard prompt preview should invoke its server-owned planner request",
);
assert.match(
  storyboardPreviewRequestSource,
  /withTimeout\(/u,
  "the client preview request should use its bounded asset-preview timeout",
);
assert.doesNotMatch(
  storyboardPreviewRequestSource,
  /180000/u,
  "the client must not add a second 180-second planner timer",
);

const skippedVideoClaims = Array.from(storyboardRouteSource.matchAll(/skipped video generation/gu));
assert.ok(skippedVideoClaims.length > 0, "the Storyboard fallback should still explain a requested video skip");
for (const claim of skippedVideoClaims) {
  const claimIndex = claim.index;
  const conditionalContext = storyboardRouteSource.slice(
    Math.max(0, claimIndex - 600),
    Math.min(storyboardRouteSource.length, claimIndex + 600),
  );
  assert.match(
    conditionalContext,
    /generateStoryboardVideos/u,
    "a Storyboard fallback must claim that video was skipped only when video generation was requested",
  );
}

const automaticGameStoryboardStart = gameSurfaceSource.indexOf("void generateTurnStoryboard\n      .mutateAsync({");
assert.notEqual(automaticGameStoryboardStart, -1);
assert.match(
  gameSurfaceSource.slice(automaticGameStoryboardStart, automaticGameStoryboardStart + 700),
  /generateVideos:\s*gameStoryboardAutoAnimationsEnabled/u,
  "automatic Storyboard generation should submit the current animation setting",
);
assert.match(
  connectionEditorSource,
  /const isChatGPTImageService\s*=\s*localProvider === "image_generation" && selectedImageService === "openai_chatgpt"/,
  "ChatGPT Subscription image connections must be classified explicitly",
);
assert.match(
  connectionEditorSource,
  /const supportsGptImageQuality\s*=[\s\S]{0,400}isChatGPTImageService/,
  "ChatGPT Subscription image connections must expose the GPT Image quality selector",
);
assert.match(
  connectionEditorSource,
  /imageGenerationQuality: isImageProvider \? effectiveImageGenerationQuality : "auto"/,
  "the selected image quality must be persisted with the connection",
);
assert.match(
  gameRouteSource,
  /isRetryableStoryboardPlannerTransportError\(err\)[\s\S]{0,260}parsedPlan = await runPlannerAttempt\(\);/,
  "a transient planner transport termination should receive one retry",
);
assert.match(
  gameRouteSource,
  /if \(storyboardPlanHasNoVisualBeats\(parsedPlan\)\) return skipStoryboard\("no_visual_beats"\);\s*plan = sanitizeStoryboardPlan\(parsedPlan,/,
  "the retried planner result must still pass storyboard validation and sanitization",
);
assert.match(
  spritesRouteSource,
  /withSpriteGenerationDeadline<T>[\s\S]{0,1000}reply\.raw\.once\("close", onClose\)[\s\S]{0,1000}Promise\.race\(\[run\(controller\.signal\), cancelled\]\)/u,
  "sprite generation must cancel its provider work when the client disconnects",
);
assert.ok(
  (spritesRouteSource.match(/signal: spriteSignal/g) ?? []).length >= 4,
  "still and animated sprite provider requests must receive the request-scoped cancellation signal",
);

resetConnectionAdmissionForTests();
const releaseGroupedRequests: Array<() => void> = [];
const groupedRequests = Array.from({ length: 3 }, (_, index) =>
  withConnectionAdmission(
    "storyboard-image-endpoint",
    { kind: "background", groupId: "storyboard:one" },
    () =>
      new Promise<number>((resolve) => {
        releaseGroupedRequests[index] = () => resolve(index);
      }),
  ),
);
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(releaseGroupedRequests.length, 3, "all three storyboard image requests should start concurrently");
await assert.rejects(
  withConnectionAdmission(
    "storyboard-image-endpoint",
    { kind: "background", groupId: "storyboard:two" },
    async () => "must not start",
  ),
  BackgroundConnectionBusyError,
  "an unrelated background batch must not join the active storyboard group",
);
releaseGroupedRequests.forEach((release) => release());
assert.deepEqual(await Promise.all(groupedRequests), [0, 1, 2]);

// Releasing one grouped sibling, even twice, must not admit another background
// batch while a sibling is still active.
resetConnectionAdmissionForTests();
const groupedAdmissionA = tryBackgroundConnection("reference-counted-endpoint", new Date(), "storyboard:one");
const groupedAdmissionB = tryBackgroundConnection("reference-counted-endpoint", new Date(), "storyboard:one");
assert.equal(groupedAdmissionA.acquired, true);
assert.equal(groupedAdmissionB.acquired, true);
if (!groupedAdmissionA.acquired || !groupedAdmissionB.acquired) assert.fail("group admission setup failed");
groupedAdmissionA.release("completed");
groupedAdmissionA.release("completed");
assert.equal(
  tryBackgroundConnection("reference-counted-endpoint", new Date(), "storyboard:two").acquired,
  false,
  "an idempotent sibling release must not clear the active group early",
);
groupedAdmissionB.release("completed");
const afterGroupedRelease = tryBackgroundConnection(
  "reference-counted-endpoint",
  new Date(Date.now() + BACKGROUND_CONNECTION_IDLE_MS),
  "storyboard:two",
);
assert.equal(afterGroupedRelease.acquired, true);
if (afterGroupedRelease.acquired) afterGroupedRelease.release("completed");

// Abort-ignoring adapters must not retain their lifecycle boundary indefinitely.
const { withImageGenerationDeadline } = await import("../../packages/server/src/services/image/image-generation.js");
const imageController = new AbortController();
const imageGate = deferred<string>();
let imageSignal: AbortSignal | null = null;
const imageJob = withImageGenerationDeadline({ signal: imageController.signal }, 60_000, (signal) => {
  imageSignal = signal;
  return imageGate.promise;
});
await waitUntil(() => imageSignal !== null, "the image lifecycle boundary did not start");
imageController.abort(new Error("image caller disconnected"));
await assert.rejects(imageJob, /image caller disconnected/u);
assert.equal(imageSignal?.aborted, true);
imageGate.resolve("late image result");

const { withVideoGenerationDeadline } = await import("../../packages/server/src/services/video/video-generation.js");
const videoController = new AbortController();
const videoGate = deferred<string>();
let videoSignal: AbortSignal | null = null;
const videoJob = withVideoGenerationDeadline(videoController.signal, 60_000, (signal) => {
  videoSignal = signal;
  return videoGate.promise;
});
await waitUntil(() => videoSignal !== null, "the video lifecycle boundary did not start");
videoController.abort(new Error("video caller disconnected"));
await assert.rejects(videoJob, /video caller disconnected/u);
assert.equal(videoSignal?.aborted, true);
videoGate.resolve("late video result");

const preAbortedVideo = new AbortController();
preAbortedVideo.abort(new Error("cancelled before dispatch"));
let preAbortedVideoStarted = false;
await assert.rejects(
  withVideoGenerationDeadline(preAbortedVideo.signal, 60_000, async () => {
    preAbortedVideoStarted = true;
    return "must not run";
  }),
  /cancelled before dispatch/u,
);
assert.equal(preAbortedVideoStarted, false);

const ignoredImageDeadline = withImageGenerationDeadline({}, 10, () => new Promise<never>(() => undefined));
const ignoredVideoDeadline = withVideoGenerationDeadline(undefined, 10, () => new Promise<never>(() => undefined));
const ignoredDeadlineRejections = Promise.all([
  assert.rejects(ignoredImageDeadline, /Image generation timed out/u),
  assert.rejects(ignoredVideoDeadline, /Video generation timed out/u),
]);
await new Promise<void>((resolve) => setTimeout(resolve, 25));
await ignoredDeadlineRejections;

const { withSpriteGenerationDeadline } = await import("../../packages/server/src/routes/sprites.routes.js");
const disconnectEvents = new EventEmitter();
const disconnectedSprite = withSpriteGenerationDeadline(
  { raw: disconnectEvents } as never,
  () => new Promise<never>(() => undefined),
  60_000,
);
disconnectEvents.emit("close");
await assert.rejects(disconnectedSprite, /client disconnected/u);
assert.equal(disconnectEvents.listenerCount("close"), 0);

const timeoutEvents = new EventEmitter();
const timedOutSprite = withSpriteGenerationDeadline(
  { raw: timeoutEvents } as never,
  () => new Promise<never>(() => undefined),
  10,
);
const timeoutRejection = assert.rejects(timedOutSprite, /timed out/u);
await new Promise<void>((resolve) => setTimeout(resolve, 25));
await timeoutRejection;
assert.equal(timeoutEvents.listenerCount("close"), 0);

console.log("generation lifecycle regression passed");
