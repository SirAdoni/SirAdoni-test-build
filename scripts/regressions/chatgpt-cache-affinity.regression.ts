import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FEATURE_SWITCH_DEFAULTS,
  featureSettingsSchema,
  resolveFeatureEnabled,
} from "../../packages/shared/src/index.js";
import {
  applyFeatureSettingsValue,
  getFeatureSettings,
  isFeatureEnabled,
} from "../../packages/server/src/services/features/feature-settings.js";
import {
  applyOpenAIChatGPTCacheSessionHeader,
  OPENAI_CHATGPT_CACHE_AFFINITY_METADATA_KEY,
  prepareOpenAIChatGPTCacheAffinityMessages,
  resolveOpenAIChatGPTCacheIdentity,
} from "../../packages/server/src/services/llm/providers/openai-chatgpt-cache.js";
import { OpenAIProvider } from "../../packages/server/src/services/llm/providers/openai.provider.js";
import type { ChatMessage } from "../../packages/server/src/services/llm/base-provider.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const loreSentinel = "fixture-lore-only-not-cache-identity";
const chatId = "fixture-chat-private-id";
const received: Array<{ headers: IncomingHttpHeaders; body: Record<string, unknown> }> = [];

const server = createServer(async (request, response) => {
  let rawBody = "";
  for await (const chunk of request) rawBody += chunk;
  received.push({
    headers: request.headers,
    body: JSON.parse(rawBody) as Record<string, unknown>,
  });
  const body = received.at(-1)!.body;
  const responseBody = {
    id: "resp_fixture",
    status: "completed",
    output: [
      {
        id: "msg_fixture",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Fixture narration" }],
      },
    ],
    usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
  };
  if (body.stream === true) {
    const events = [
      { type: "response.output_text.delta", delta: "Fixture narration" },
      { type: "response.completed", response: responseBody },
    ];
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  } else {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(responseBody));
  }
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");
const fixturePort = address.port;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const target = new URL(input instanceof Request ? input.url : String(input));
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || target.port !== String(fixturePort)) {
    throw new Error(`Blocked non-fixture network request: ${target.origin}`);
  }
  return originalFetch(input, init);
};

const makeMessages = (lore = loreSentinel): ChatMessage[] => [
  { role: "system", content: lore, providerMetadata: { retainedFixtureMetadata: true } },
  { role: "user", content: "Continue the scene." },
];

async function send(messages: ChatMessage[], providerKind: "openai-chatgpt" | "openai") {
  const headers = applyOpenAIChatGPTCacheSessionHeader({ "x-fixture-auth": "synthetic-only" }, messages);
  const provider = new OpenAIProvider(
    `http://127.0.0.1:${fixturePort}/v1`,
    "synthetic-cache-affinity-fixture-token",
    undefined,
    undefined,
    undefined,
    providerKind,
    headers,
  );
  const result = await provider.chatComplete(messages, { model: "gpt-5.5-fixture", stream: false, maxTokens: 16 });
  assert.equal(result.content, "Fixture narration");
  return received.at(-1)!;
}

const originalFeatureSettings = JSON.stringify(getFeatureSettings());
const routeMessages: ChatMessage[][] = [];
const routeEnvKeys = ["DATA_DIR", "FILE_STORAGE_DIR", "NODE_ENV", "MARINARA_LITE", "LOG_LEVEL"] as const;
const originalRouteEnv = new Map(routeEnvKeys.map((key) => [key, process.env[key]]));
let routeDataDir: string | undefined;
let routeApp: { close(): Promise<unknown> } | undefined;
let closeRouteDB: (() => Promise<void>) | undefined;
let chatGPTProviderPrototype: { chat: unknown } | undefined;
let originalChatMethod: unknown;

try {
  assert.equal(FEATURE_SWITCH_DEFAULTS.chatgptCacheAffinity, false);
  assert.equal(resolveFeatureEnabled({}, "chatgptCacheAffinity"), false);
  assert.equal(featureSettingsSchema.parse({ chatgptCacheAffinity: true }).chatgptCacheAffinity, true);

  const english = JSON.parse(
    readFileSync(path.join(repositoryRoot, "packages/client/src/localization/locales/en.json"), "utf8"),
  ) as Record<string, string>;
  assert.ok(english["settings.features.chatgptCacheAffinity.label"]);
  assert.ok(english["settings.features.chatgptCacheAffinity.help"]);
  assert.match(
    readFileSync(
      path.join(repositoryRoot, "packages/client/src/components/panels/settings/FeatureSwitchesSettings.tsx"),
      "utf8",
    ),
    /"chatgptCacheAffinity"/,
  );

  applyFeatureSettingsValue(null);
  assert.equal(isFeatureEnabled("chatgptCacheAffinity"), false);
  const defaultMessages = makeMessages();
  const defaultOff = prepareOpenAIChatGPTCacheAffinityMessages(defaultMessages, "openai_chatgpt", chatId);
  assert.strictEqual(defaultOff, defaultMessages, "default-off producer must leave the original messages untouched");
  const defaultRequest = await send(defaultOff, "openai-chatgpt");
  assert.equal(defaultRequest.headers["session-id"], undefined);
  assert.equal(defaultRequest.body.prompt_cache_key, undefined);

  applyFeatureSettingsValue(JSON.stringify({ chatgptCacheAffinity: false }));
  assert.equal(isFeatureEnabled("chatgptCacheAffinity"), false);
  const explicitlyOff = prepareOpenAIChatGPTCacheAffinityMessages(makeMessages(), "openai_chatgpt", chatId);
  assert.equal(resolveOpenAIChatGPTCacheIdentity(explicitlyOff), undefined);
  const explicitOffRequest = await send(explicitlyOff, "openai-chatgpt");
  assert.equal(explicitOffRequest.headers["session-id"], undefined);
  assert.equal(explicitOffRequest.body.prompt_cache_key, undefined);

  applyFeatureSettingsValue(JSON.stringify({ chatgptCacheAffinity: true }));
  assert.equal(isFeatureEnabled("chatgptCacheAffinity"), true);
  const firstMessages = prepareOpenAIChatGPTCacheAffinityMessages(makeMessages(), "openai_chatgpt", chatId);
  assert.notStrictEqual(firstMessages, defaultMessages);
  assert.equal(firstMessages[0]?.role, defaultMessages[0]?.role);
  assert.equal(firstMessages[0]?.content, defaultMessages[0]?.content);
  assert.equal(firstMessages[0]?.providerMetadata?.retainedFixtureMetadata, true);
  assert.match(
    String(firstMessages[0]?.providerMetadata?.[OPENAI_CHATGPT_CACHE_AFFINITY_METADATA_KEY]),
    /^[a-f0-9]{40}$/u,
  );

  const firstRequest = await send(firstMessages, "openai-chatgpt");
  const sessionId = firstRequest.headers["session-id"];
  const cacheKey = firstRequest.body.prompt_cache_key;
  assert.equal(typeof sessionId, "string");
  assert.match(String(cacheKey), /^me-chat-[a-f0-9]{40}$/u);
  assert.ok(!String(sessionId).includes(chatId));
  assert.ok(!String(cacheKey).includes(chatId));
  assert.ok(!String(sessionId).includes(loreSentinel));
  assert.ok(!String(cacheKey).includes(loreSentinel));

  const preparedSnapshot = structuredClone(firstMessages);
  applyFeatureSettingsValue(JSON.stringify({ chatgptCacheAffinity: false }));
  assert.equal(resolveOpenAIChatGPTCacheIdentity(firstMessages), undefined);
  const disabledAfterPreparation = await send(firstMessages, "openai-chatgpt");
  assert.equal(disabledAfterPreparation.headers["session-id"], undefined);
  assert.equal(disabledAfterPreparation.body.prompt_cache_key, undefined);
  assert.deepEqual(firstMessages, preparedSnapshot);
  applyFeatureSettingsValue(JSON.stringify({ chatgptCacheAffinity: true }));
  const reenabledRequest = await send(firstMessages, "openai-chatgpt");
  assert.equal(reenabledRequest.headers["session-id"], sessionId);
  assert.equal(reenabledRequest.body.prompt_cache_key, cacheKey);
  assert.deepEqual(firstMessages, preparedSnapshot);

  const editedLoreMessages = prepareOpenAIChatGPTCacheAffinityMessages(
    makeMessages("updated lore text, deliberately different"),
    "openai_chatgpt",
    chatId,
  );
  const editedLoreRequest = await send(editedLoreMessages, "openai-chatgpt");
  assert.equal(editedLoreRequest.headers["session-id"], sessionId);
  assert.equal(editedLoreRequest.body.prompt_cache_key, cacheKey);

  const differentChatMessages = prepareOpenAIChatGPTCacheAffinityMessages(
    makeMessages(),
    "openai_chatgpt",
    "fixture-chat-another-private-id",
  );
  const differentChatRequest = await send(differentChatMessages, "openai-chatgpt");
  assert.notEqual(differentChatRequest.headers["session-id"], sessionId);
  assert.notEqual(differentChatRequest.body.prompt_cache_key, cacheKey);

  const directUnmarked = makeMessages();
  const directRequest = await send(directUnmarked, "openai-chatgpt");
  assert.equal(directRequest.headers["session-id"], undefined);
  assert.equal(directRequest.body.prompt_cache_key, undefined);

  const malformedMarker = makeMessages();
  malformedMarker[0]!.providerMetadata = {
    [OPENAI_CHATGPT_CACHE_AFFINITY_METADATA_KEY]: chatId,
  };
  const malformedRequest = await send(malformedMarker, "openai-chatgpt");
  assert.equal(malformedRequest.headers["session-id"], undefined);
  assert.equal(malformedRequest.body.prompt_cache_key, undefined);

  const nonChatGptSource = makeMessages();
  const nonChatGptMessages = prepareOpenAIChatGPTCacheAffinityMessages(nonChatGptSource, "openai", chatId);
  assert.strictEqual(nonChatGptMessages, nonChatGptSource);
  const nonChatGptRequest = await send(nonChatGptMessages, "openai");
  assert.equal(nonChatGptRequest.headers["session-id"], undefined);
  assert.equal(nonChatGptRequest.body.prompt_cache_key, undefined);

  const baselineBody = structuredClone(defaultRequest.body);
  const affinityBody = structuredClone(firstRequest.body);
  delete affinityBody.prompt_cache_key;
  assert.deepEqual(affinityBody, baselineBody, "affinity must not alter ordinary Responses prompt composition");

  routeDataDir = mkdtempSync(path.join(tmpdir(), "marinara-cache-affinity-route-"));
  process.env.DATA_DIR = routeDataDir;
  process.env.FILE_STORAGE_DIR = path.join(routeDataDir, "storage");
  process.env.NODE_ENV = "test";
  process.env.MARINARA_LITE = "true";
  process.env.LOG_LEVEL = "silent";

  const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
  const Fastify = requireServer("fastify") as typeof import("fastify").default;
  const dbModule = await import("../../packages/server/src/db/connection.js");
  closeRouteDB = dbModule.closeDB;
  const { generateRoutes } = await import("../../packages/server/src/routes/generate.routes.js");
  const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
  const { createConnectionsStorage } =
    await import("../../packages/server/src/services/storage/connections.storage.js");
  const { createGameStateStorage } = await import("../../packages/server/src/services/storage/game-state.storage.js");
  const { OpenAIChatGPTProvider } =
    await import("../../packages/server/src/services/llm/providers/openai-chatgpt.provider.js");
  chatGPTProviderPrototype = OpenAIChatGPTProvider.prototype;
  originalChatMethod = chatGPTProviderPrototype.chat;
  chatGPTProviderPrototype.chat = async function* (messages: ChatMessage[]) {
    routeMessages.push(messages);
    yield "Synthetic route narrator response.";
  };

  const db = await dbModule.getDB();
  const chats = createChatsStorage(db);
  const connections = createConnectionsStorage(db);
  const states = createGameStateStorage(db);
  const routeServer = Fastify();
  routeApp = routeServer;
  routeServer.decorate("db", db);
  await routeServer.register(generateRoutes, { prefix: "/api/generate" });
  const routeConnection = await connections.create({
    name: "Cache affinity route fixture",
    provider: "openai_chatgpt",
    model: "gpt-5.6",
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "synthetic-only",
    maxContext: 128_000,
  });
  const routeChat = await chats.create({
    name: "Cache affinity route fixture",
    mode: "game",
    characterIds: [],
    connectionId: routeConnection.id,
  });
  await chats.patchMetadata(routeChat.id, {
    enableAgents: false,
    activeAgentIds: [],
    gameOneRequestDice: true,
    gameIntroPresented: true,
    gameActiveState: "dialogue",
  });
  const previous = await chats.createMessage({
    chatId: routeChat.id,
    role: "assistant",
    content: "Seeded route fixture history.",
  });
  const stateId = await states.create({
    chatId: routeChat.id,
    messageId: previous.id,
    swipeIndex: 0,
    date: "Day 1",
    time: "10:00",
    location: "Cache Fixture Room",
    weather: "Clear",
    temperature: "Mild",
    presentCharacters: [],
    recentEvents: [],
    fieldLocks: {},
    hiddenTrackerFields: [],
  } as Parameters<typeof states.create>[0]);
  await states.commit(stateId, routeChat.id);
  const routeResult = await routeServer.inject({
    method: "POST",
    url: "/api/generate/",
    payload: { chatId: routeChat.id, userMessage: "Generate a synthetic test reply." },
  });
  assert.equal(routeResult.statusCode, 200, routeResult.body);
  assert.equal(routeMessages.length, 1, "the actual generate route reached the mocked ChatGPT provider");
  const routeIdentity = resolveOpenAIChatGPTCacheIdentity(routeMessages[0]!);
  assert.match(String(routeIdentity), /^[a-f0-9]{40}$/u, "the initial narrator send carries the route-produced scope");
  assert.ok(!String(routeIdentity).includes(routeChat.id), "the route does not expose its raw chat ID");
  process.stdout.write(
    "PASS: wire fixture and actual initial narrator route producer; rebuilt narrator send remains source-traced.",
  );
} finally {
  if (chatGPTProviderPrototype) chatGPTProviderPrototype.chat = originalChatMethod;
  globalThis.fetch = originalFetch;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await routeApp?.close();
  await closeRouteDB?.();
  if (routeDataDir) rmSync(routeDataDir, { recursive: true, force: true });
  for (const key of routeEnvKeys) {
    const value = originalRouteEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  applyFeatureSettingsValue(originalFeatureSettings);
}
