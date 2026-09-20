import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sceneAnalysisRequestSchema, STORYBOARD_AGENT_ID } from "../../packages/shared/src/index.js";

const root = mkdtempSync(join(tmpdir(), "marinara-automatic-game-media-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";

const { buildApp } = await import("../../packages/server/src/app.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { queueAutomaticGameMedia } = await import("../../packages/server/src/services/game/automatic-game-media.js");

type RouteRequest = { method: string; url: string; payload?: Record<string, unknown> };
type RouteResponse = { statusCode: number; json: () => Record<string, unknown> };
type Inject = (request: RouteRequest) => Promise<RouteResponse>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const app = await buildApp();
try {
  const chats = createChatsStorage(app.db);
  const calls: Array<{ url: string; payload: Record<string, unknown> }> = [];
  let sceneGate = deferred<Record<string, unknown>>();
  let storyboardGate = deferred<Record<string, unknown>>();
  let holdScene = true;
  let sceneShouldFail = false;
  const injected: Inject = async (request) => {
    const payload = request.payload ?? {};
    calls.push({ url: request.url, payload });
    if (request.url === "/api/game/scene-wrap") {
      sceneAnalysisRequestSchema.parse(payload);
      if (sceneShouldFail) throw new Error("controlled scene failure");
      return {
        statusCode: 200,
        json: () => ({ result: { background: "backgrounds:chambers", locationDescription: "A dark chamber." } }),
      };
    }
    if (request.url === "/api/game/storyboard/generate") {
      return { statusCode: 200, json: () => ({ result: { accepted: true } }) };
    }
    if (request.url === "/api/game/generate-assets") {
      return { statusCode: 200, json: () => ({ ok: true }) };
    }
    throw new Error(`Unexpected injected route ${request.url}`);
  };
  const appWithInject = app as typeof app & { inject: Inject };
  appWithInject.inject = async (request) => {
    if (request.url === "/api/game/scene-wrap" && !sceneShouldFail) {
      const payload = request.payload ?? {};
      calls.push({ url: request.url, payload });
      sceneAnalysisRequestSchema.parse(payload);
      if (holdScene) {
        return sceneGate.promise.then(() => ({
          statusCode: 200,
          json: () => ({ result: { background: "backgrounds:chambers", locationDescription: "A dark chamber." } }),
        }));
      }
      return {
        statusCode: 200,
        json: () => ({ result: { background: "backgrounds:chambers", locationDescription: "A dark chamber." } }),
      };
    }
    if (request.url === "/api/game/storyboard/generate") {
      const payload = request.payload ?? {};
      calls.push({ url: request.url, payload });
      return storyboardGate.promise.then(() => ({ statusCode: 200, json: () => ({ result: { accepted: true } }) }));
    }
    if (request.url === "/api/game/scene-wrap" && sceneShouldFail) {
      calls.push({ url: request.url, payload: request.payload ?? {} });
      throw new Error("controlled scene failure");
    }
    if (request.url === "/api/game/generate-assets") {
      const payload = request.payload ?? {};
      calls.push({ url: request.url, payload });
      return { statusCode: 200, json: () => ({ ok: true }) };
    }
    return injected(request);
  };

  async function makeChat(metadata: Record<string, unknown>, content = "Robert enters the chamber.") {
    const chat = await chats.create({ name: "Automatic media proof", mode: "game", characterIds: [] });
    assert(chat);
    const merged = {
      enableAgents: true,
      activeAgentIds: [STORYBOARD_AGENT_ID],
      gameSessionStatus: "ready",
      gameStoryboardAutoIllustrationsEnabled: true,
      gameStoryboardAutoGenerationEnabled: false,
      gameStoryboardKeyframeCount: 1,
      gameImageConnectionId: "image-connection",
      gameSceneConnectionId: "scene-connection",
      enableSpriteGeneration: true,
      gameImageAutoGenerationEnabled: true,
      ...metadata,
    };
    await chats.updateMetadata(chat.id, merged);
    const message = await chats.createMessage({ chatId: chat.id, role: "assistant", characterId: null, content });
    assert(message);
    return { chat, message };
  }

  const first = await makeChat({});
  const firstPromise = queueAutomaticGameMedia(appWithInject, { chatId: first.chat.id, messageId: first.message.id });
  await firstPromise;
  assert.deepEqual(
    calls.map((call) => call.url),
    ["/api/game/scene-wrap", "/api/game/storyboard/generate"],
  );
  const sceneCall = calls.find((call) => call.url === "/api/game/scene-wrap");
  assert(sceneCall);
  sceneAnalysisRequestSchema.parse(sceneCall.payload);
  assert.equal(
    JSON.stringify(sceneCall.payload).includes("apiKey"),
    false,
    "scene payload must not persist credentials",
  );
  assert.equal(
    calls.some((call) => call.url === "/api/game/generate-assets"),
    false,
  );

  const firstMessageWhilePending = await chats.getMessage(first.message.id);
  assert(firstMessageWhilePending);
  assert.match(String(firstMessageWhilePending.extra), /"status":"running"/);
  sceneGate.resolve({});
  holdScene = false;
  await new Promise((resolve) => setTimeout(resolve, 0));

  const sceneOnly = await makeChat({
    activeAgentIds: [],
    gameStoryboardAutoIllustrationsEnabled: false,
    gameImageConnectionId: null,
    gameSceneConnectionId: "scene-connection",
  });
  const sceneOnlyPromise = queueAutomaticGameMedia(appWithInject, {
    chatId: sceneOnly.chat.id,
    messageId: sceneOnly.message.id,
  });
  await sceneOnlyPromise;
  assert.equal(calls.filter((call) => call.url === "/api/game/storyboard/generate").length, 1);

  const disabledImages = await makeChat({
    activeAgentIds: [],
    gameImageConnectionId: "image-connection",
    enableSpriteGeneration: false,
    gameSceneConnectionId: "scene-connection",
  });
  const assetsBeforeDisabled = calls.filter((call) => call.url === "/api/game/generate-assets").length;
  await queueAutomaticGameMedia(appWithInject, {
    chatId: disabledImages.chat.id,
    messageId: disabledImages.message.id,
  });
  assert.equal(calls.filter((call) => call.url === "/api/game/generate-assets").length, assetsBeforeDisabled);

  const manual = await makeChat({
    activeAgentIds: [],
    gameSceneConnectionId: null,
    gameImageConnectionId: null,
    enableSpriteGeneration: false,
  });
  await queueAutomaticGameMedia(appWithInject, { chatId: manual.chat.id, messageId: manual.message.id });
  assert.equal(calls.filter((call) => call.payload.chatId === manual.chat.id).length, 0);

  assert.equal(
    calls.filter((call) => call.url === "/api/game/generate-assets").length,
    1,
    "completed scene triggers assets while storyboard is pending",
  );

  sceneShouldFail = true;
  storyboardGate = deferred<Record<string, unknown>>();
  const failedScene = await makeChat({});
  const failedOne = queueAutomaticGameMedia(appWithInject, {
    chatId: failedScene.chat.id,
    messageId: failedScene.message.id,
  });
  const failedTwo = queueAutomaticGameMedia(appWithInject, {
    chatId: failedScene.chat.id,
    messageId: failedScene.message.id,
  });
  await Promise.all([failedOne, failedTwo]);
  assert.equal(
    calls.filter((call) => call.payload.chatId === failedScene.chat.id && call.url === "/api/game/scene-wrap").length,
    1,
  );
  assert.equal(
    calls.filter((call) => call.payload.chatId === failedScene.chat.id && call.url === "/api/game/storyboard/generate")
      .length,
    1,
  );
  storyboardGate.resolve({});
  await new Promise((resolve) => setTimeout(resolve, 0));

  const missing = queueAutomaticGameMedia(appWithInject, { chatId: "missing-chat", messageId: "missing-message" });
  await missing;
  assert.equal(
    calls.some((call) => call.payload.chatId === "missing-chat"),
    false,
  );
  const beforeWrongChat = calls.length;
  const wrongChat = queueAutomaticGameMedia(appWithInject, {
    chatId: "missing-chat",
    messageId: failedScene.message.id,
  });
  await wrongChat;
  assert.equal(calls.length, beforeWrongChat, "message from another chat is ignored");

  sceneShouldFail = false;
  const stale = await makeChat({});
  const staleChatMessage = await chats.createMessagesBatch(stale.chat.id, [
    {
      role: "assistant",
      characterId: null,
      content: "Alternate stale scene.",
      activeSwipeIndex: 1,
      swipes: [
        { index: 0, content: "Old scene." },
        { index: 1, content: "Alternate stale scene." },
      ],
    },
  ]);
  const staleMessageId = staleChatMessage[0];
  assert(staleMessageId);
  const beforeStale = calls.length;
  await queueAutomaticGameMedia(appWithInject, { chatId: stale.chat.id, messageId: staleMessageId, swipeIndex: 0 });
  assert.equal(calls.length, beforeStale, "stale swipe request is ignored");

  console.log(
    "PASS: automatic Game media admission, concurrent scene/storyboard work, asset follow-up, feature gates, errors, dedupe, payload schema and stale input handling.",
  );
} finally {
  await app.close();
  rmSync(root, { recursive: true, force: true });
}
