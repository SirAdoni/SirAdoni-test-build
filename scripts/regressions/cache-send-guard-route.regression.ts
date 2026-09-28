import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-cache-guard-route-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";

const generateRouteSource = readFileSync(
  fileURLToPath(new URL("../../packages/server/src/routes/generate.routes.ts", import.meta.url)),
  "utf8",
);
assert.match(generateRouteSource, /let toolPlannerAttempted = false/u);
assert.match(
  generateRouteSource,
  /toolPlannerAttempted = true[\s\S]{0,120}planGameToolCalls/u,
  "tool planner dispatch records that later narrator guards must not pause",
);
assert.match(
  generateRouteSource,
  /if \(!input\.impersonate && cacheGuardApplies\(conn\.provider, narratorMessages\)\)[\s\S]{0,700}if \(!toolPlannerAttempted && guard\.enabled && !input\.cacheGuardAcknowledged\)/u,
  "narrator cache guard hold is skipped after tool planner side effects, but its fingerprint is still recorded",
);

let app: {
  ready(): Promise<void>;
  close(): Promise<void>;
  inject(options: Record<string, unknown>): Promise<any>;
} | null = null;
let pendingNpcSyncRequests = new Set<Promise<unknown>>();
let resetSdk = () => {};
let resetOpenAIProvider = () => {};
const originalCodexHome = process.env.CODEX_HOME;
try {
  const { buildApp } = await import("../../packages/server/src/app.js");
  const guard = await import("../../packages/server/src/services/generation/cache-send-guard.js");
  const heldTurns = await import("../../packages/server/src/services/generation/cache-held-turn.js");
  const { __setSdkForTesting } =
    await import("../../packages/server/src/services/llm/providers/claude-subscription.provider.js");
  const { getDB } = await import("../../packages/server/src/db/connection.js");
  const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
  const { OpenAIProvider } = await import("../../packages/server/src/services/llm/providers/openai.provider.js");
  const db = await getDB();
  const chats = createChatsStorage(db);
  const heldTurnFixture = {
    id: "held-user",
    chatId: "held-chat",
    role: "user",
    content: "selected user swipe",
    activeSwipeIndex: 1,
    extra: JSON.stringify({
      submissionId: "held-submission",
      attachments: [{ type: "image", url: "/held.png" }],
      replyTo: { messageId: "quoted", name: "A", content: "quoted content" },
    }),
  };
  const heldTurnDescriptor = heldTurns.createCacheGuardHeldTurnDescriptor(heldTurnFixture)!;
  assert.ok(heldTurns.resolveCacheGuardHeldTurn([heldTurnFixture], "held-chat", heldTurnDescriptor));
  assert.equal(heldTurns.resolveCacheGuardHeldTurn([], "held-chat", heldTurnDescriptor), null);
  assert.equal(heldTurns.resolveCacheGuardHeldTurn([heldTurnFixture], "other-chat", heldTurnDescriptor), null);
  assert.equal(
    heldTurns.resolveCacheGuardHeldTurn(
      [heldTurnFixture, { ...heldTurnFixture, id: "new-user", activeSwipeIndex: 0 }],
      "held-chat",
      heldTurnDescriptor,
    ),
    null,
    "a newer user turn invalidates acknowledgement",
  );
  assert.equal(
    heldTurns.resolveCacheGuardHeldTurn(
      [heldTurnFixture, { ...heldTurnFixture, id: "new-assistant", role: "assistant" }],
      "held-chat",
      heldTurnDescriptor,
    ),
    null,
    "a newer assistant turn invalidates acknowledgement",
  );
  assert.equal(
    heldTurns.resolveCacheGuardHeldTurn(
      [{ ...heldTurnFixture, content: "edited user swipe" }],
      "held-chat",
      heldTurnDescriptor,
    ),
    null,
    "edited held content invalidates acknowledgement",
  );
  assert.equal(
    heldTurns.resolveCacheGuardHeldTurn([{ ...heldTurnFixture, activeSwipeIndex: 0 }], "held-chat", heldTurnDescriptor),
    null,
    "a changed active swipe invalidates acknowledgement",
  );
  assert.equal(
    heldTurns.resolveCacheGuardHeldTurn(
      [{ ...heldTurnFixture, extra: JSON.stringify({ ...JSON.parse(heldTurnFixture.extra), replyTo: null }) }],
      "held-chat",
      heldTurnDescriptor,
    ),
    null,
    "changed reply metadata is rejected",
  );
  assert.equal(
    heldTurns.resolveCacheGuardHeldTurn(
      [{ ...heldTurnFixture, extra: JSON.stringify({ ...JSON.parse(heldTurnFixture.extra), attachments: [] }) }],
      "held-chat",
      heldTurnDescriptor,
    ),
    null,
    "changed attachment metadata is rejected",
  );
  resetSdk = () => __setSdkForTesting(null);

  let providerCalls = 0;
  __setSdkForTesting({
    query: ((...args: unknown[]) => {
      providerCalls += 1;
      return (async function* () {
        yield {
          type: "result",
          subtype: "success",
          result: JSON.stringify({
            publicScene: [{ beat: 0, text: "The isolated scene continues.", perceivedBy: [] }],
            actorRequests: [],
          }),
          usage: { input_tokens: 10, output_tokens: 4 },
        };
      })();
    }) as never,
  });

  app = await buildApp();
  await app.ready();
  const originalInject = app.inject.bind(app);
  pendingNpcSyncRequests = new Set<Promise<unknown>>();
  app.inject = (async (options: Record<string, unknown>) => {
    const isNpcSync = typeof options.url === "string" && options.url === "/api/game/npc-characters/sync";
    const request = originalInject(options);
    if (isNpcSync) {
      pendingNpcSyncRequests.add(request);
      request.then(
        () => pendingNpcSyncRequests.delete(request),
        () => pendingNpcSyncRequests.delete(request),
      );
    }
    return request;
  }) as typeof app.inject;
  const createCharacter = await app.inject({
    method: "POST",
    url: "/api/characters",
    payload: { data: { name: "Cache narrator", description: "A test narrator character" } },
  });
  assert.equal(createCharacter.statusCode, 200);
  const character = createCharacter.json();

  const createChat = await app.inject({
    method: "POST",
    url: "/api/chats",
    payload: { name: "Cache guard route fixture", mode: "roleplay", characterIds: [character.id] },
  });
  assert.equal(createChat.statusCode, 200);
  const chat = createChat.json();

  const createConnection = await app.inject({
    method: "POST",
    url: "/api/connections",
    payload: {
      name: "Cache guard Claude fixture",
      provider: "claude_subscription",
      model: "claude-opus-5",
      isDefault: false,
    },
  });
  assert.equal(createConnection.statusCode, 200);
  const connection = createConnection.json();

  const scope = {
    provider: "claude_subscription",
    model: "claude-opus-5",
    connectionId: connection.id,
    requestKind: "narrator" as const,
  };
  const currentPrompt = guard.fingerprintPrompt(
    [{ role: "user", content: "ordinary narrator request" }],
    Date.now(),
    scope,
  );
  await guard.recordSentPrompt(chat.id, {
    ...currentPrompt,
    at: Date.now() - 2 * 60 * 60_000,
  });

  const held = await app.inject({
    method: "POST",
    url: "/api/generate",
    payload: {
      chatId: chat.id,
      connectionId: connection.id,
      userMessage: "ordinary narrator request",
      submissionId: "ordinary-held-turn",
      streaming: true,
    },
  });
  assert.equal(held.statusCode, 200);
  assert.match(held.body, /cache_warning/u);
  assert.equal(providerCalls, 0, "expired cache hold must happen before the narrator provider call");
  const heldMessages = await app.inject({ method: "GET", url: `/api/chats/${chat.id}/messages` });
  assert.equal(heldMessages.statusCode, 200);
  assert.match(heldMessages.body, /ordinary narrator request/u, "cache hold must preserve the saved user message");
  const heldWarning = held.body
    .split("\n")
    .filter((line: string) => line.startsWith("data: "))
    .map((line: string) => JSON.parse(line.slice(6)))
    .find((event: { type?: string }) => event.type === "cache_warning");
  assert.ok(heldWarning?.data?.heldTurn, "warning carries the saved-turn descriptor");

  const acknowledged = await app.inject({
    method: "POST",
    url: "/api/generate",
    payload: {
      chatId: chat.id,
      connectionId: connection.id,
      cacheGuardAcknowledged: true,
      cacheGuardHeldTurn: heldWarning.data.heldTurn,
      streaming: true,
    },
  });
  assert.equal(acknowledged.statusCode, 200);
  assert.match(acknowledged.body, /isolated scene continues/u);
  assert.equal(providerCalls, 1, "acknowledgement must release the send to the provider");
  const resumedMessages = (await app.inject({ method: "GET", url: `/api/chats/${chat.id}/messages` })).json();
  assert.equal(
    resumedMessages.filter(
      (message: { role: string; content: string }) =>
        message.role === "user" && message.content === "ordinary narrator request",
    ).length,
    1,
    "acknowledgement reuses the saved row without inserting a duplicate",
  );
  const resumedAssistant = resumedMessages.find((message: { role: string }) => message.role === "assistant");
  const mixedReplay = await app.inject({
    method: "POST",
    url: "/api/generate",
    payload: {
      chatId: chat.id,
      connectionId: connection.id,
      regenerateMessageId: resumedAssistant?.id,
      cacheGuardAcknowledged: true,
      cacheGuardHeldTurn: heldWarning.data.heldTurn,
      streaming: true,
    },
  });
  assert.equal(mixedReplay.statusCode, 400, "a held-turn descriptor cannot authorize a regenerate request");
  const descriptorlessRegenerate = await app.inject({
    method: "POST",
    url: "/api/generate",
    payload: {
      chatId: chat.id,
      connectionId: connection.id,
      regenerateMessageId: resumedAssistant?.id,
      cacheGuardAcknowledged: true,
      streaming: true,
    },
  });
  assert.equal(descriptorlessRegenerate.statusCode, 200, "descriptorless acknowledgement still permits regeneration");
  assert.match(descriptorlessRegenerate.body, /isolated scene continues/u);
  assert.equal(providerCalls, 2, "descriptorless regeneration reaches the provider");
  const unacknowledgedDescriptor = await app.inject({
    method: "POST",
    url: "/api/generate",
    payload: {
      chatId: chat.id,
      connectionId: connection.id,
      cacheGuardHeldTurn: heldWarning.data.heldTurn,
      streaming: true,
    },
  });
  assert.equal(unacknowledgedDescriptor.statusCode, 400, "a held-turn descriptor requires explicit acknowledgement");
  const duplicateWithoutDescriptor = await app.inject({
    method: "POST",
    url: "/api/generate",
    payload: {
      chatId: chat.id,
      connectionId: connection.id,
      userMessage: "ordinary narrator request",
      cacheGuardAcknowledged: true,
      streaming: true,
    },
  });
  assert.equal(
    duplicateWithoutDescriptor.statusCode,
    400,
    "an acknowledged new user turn cannot be resent without its saved-turn descriptor",
  );
  const recorded = await guard.readLastSentPrompt(chat.id, scope);
  assert.ok((recorded?.entries.length ?? 0) > 0, "accepted send records a non-empty sent fingerprint");
  assert.ok((recorded?.at ?? 0) > Date.now() - 60_000, "accepted send refreshes the fingerprint timestamp");

  const isolatedChat = await chats.create({
    name: "Cache isolated route fixture",
    mode: "game",
    characterIds: [],
    connectionId: connection.id,
  } as any);
  await chats.updateMetadata(isolatedChat.id, {
    gameSceneTimelineEnabled: false,
    gameAutoSceneMediaEnabled: false,
    gameNpcKnowledgeMode: "isolated",
    gameNpcs: [],
    gameJournal: { entries: [], quests: [], locations: [], npcLog: [], inventoryLog: [] },
  } as any);
  const isolatedScope = {
    provider: "claude_subscription",
    model: "claude-opus-5",
    connectionId: connection.id,
    requestKind: "isolated-planner" as const,
  };
  await guard.recordSentPrompt(
    isolatedChat.id,
    guard.fingerprintPrompt([{ role: "user", content: "different prior planner" }], Date.now(), isolatedScope),
  );
  const isolatedProviderCallsBefore = providerCalls;
  const isolatedHeld = await app.inject({
    method: "POST",
    url: "/api/generate",
    payload: {
      chatId: isolatedChat.id,
      connectionId: connection.id,
      userMessage: "I enter the isolated scene.",
      submissionId: "isolated-held-turn",
      streaming: true,
    },
  });
  assert.equal(isolatedHeld.statusCode, 200);
  assert.match(isolatedHeld.body, /cache_warning/u, "isolated planner hold must reach SSE");
  const isolatedWarning = isolatedHeld.body
    .split("\n")
    .filter((line: string) => line.startsWith("data: "))
    .map((line: string) => JSON.parse(line.slice(6)))
    .find((event: { type?: string }) => event.type === "cache_warning");
  assert.ok(isolatedWarning?.data?.heldTurn, "isolated planner warning carries the saved-turn descriptor");
  assert.equal(
    providerCalls,
    isolatedProviderCallsBefore,
    "isolated planner hold must happen before the paid provider call",
  );
  const isolatedHeldMessages = await app.inject({ method: "GET", url: `/api/chats/${isolatedChat.id}/messages` });
  assert.match(
    isolatedHeldMessages.body,
    /I enter the isolated scene/u,
    "isolated hold preserves the saved user message",
  );
  const isolatedAccepted = await app.inject({
    method: "POST",
    url: "/api/generate",
    payload: {
      chatId: isolatedChat.id,
      connectionId: connection.id,
      cacheGuardAcknowledged: true,
      cacheGuardHeldTurn: isolatedWarning.data.heldTurn,
      streaming: true,
    },
  });
  assert.equal(isolatedAccepted.statusCode, 200);
  assert.match(isolatedAccepted.body, /The isolated scene continues/u);
  assert.ok(providerCalls > isolatedProviderCallsBefore, "isolated acknowledgement releases the planner provider call");
  const isolatedResumedMessages = (await app.inject({ method: "GET", url: `/api/chats/${isolatedChat.id}/messages` })).json();
  assert.equal(
    isolatedResumedMessages.filter(
      (message: { role: string; content: string }) =>
        message.role === "user" && message.content === "I enter the isolated scene.",
    ).length,
    1,
    "isolated acknowledgement reuses the original user row",
  );
  assert.ok(await guard.readLastSentPrompt(isolatedChat.id, isolatedScope), "isolated planner success is recorded");

  const originalOpenAIChat = OpenAIProvider.prototype.chat;
  const originalOpenAIChatComplete = OpenAIProvider.prototype.chatComplete;
  let chatGptProviderCalls = 0;
  const chatGptPrompts: Array<Array<{ role: string; content: unknown }>> = [];
  const captureChatGptPrompt = (messages: Array<{ role: string; content: unknown }>) => {
    chatGptProviderCalls += 1;
    chatGptPrompts.push(messages.map(({ role, content }) => ({ role, content })));
  };
  (OpenAIProvider.prototype as any).chat = async function* (messages: Array<{ role: string; content: unknown }>) {
    captureChatGptPrompt(messages);
    yield "The held Game action reaches the narrator.";
    return { promptTokens: 50000, completionTokens: 10, totalTokens: 50010, cachedPromptTokens: 18000 };
  };
  (OpenAIProvider.prototype as any).chatComplete = async function (
    messages: Array<{ role: string; content: unknown }>,
  ) {
    captureChatGptPrompt(messages);
    return {
      content: "The held Game action reaches the narrator.",
      toolCalls: [],
      finishReason: "stop",
      usage: { promptTokens: 50000, completionTokens: 10, totalTokens: 50010, cachedPromptTokens: 18000 },
    };
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (requestUrl.startsWith("https://chatgpt.com/") || requestUrl.startsWith("https://auth.openai.com/")) {
      throw new Error("Unexpected external OpenAI request in cache guard route regression");
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  resetOpenAIProvider = () => {
    OpenAIProvider.prototype.chat = originalOpenAIChat;
    OpenAIProvider.prototype.chatComplete = originalOpenAIChatComplete;
    globalThis.fetch = originalFetch;
  };
  const codexHome = join(dataDir, "codex-home");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(
    join(codexHome, "auth.json"),
    JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "synthetic-access-token", account_id: "fixture" } }),
    "utf8",
  );
  process.env.CODEX_HOME = codexHome;

  const createChatGptConnection = await app.inject({
    method: "POST",
    url: "/api/connections",
    payload: {
      name: "Cache guard ChatGPT fixture",
      provider: "openai_chatgpt",
      model: "gpt-5.6-sol",
      isDefault: false,
    },
  });
  assert.equal(createChatGptConnection.statusCode, 200);
  const chatGptConnection = createChatGptConnection.json();
  const createChatGptGame = await app.inject({
    method: "POST",
    url: "/api/chats",
    payload: {
      name: "Cache guard ChatGPT Game fixture",
      mode: "game",
      characterIds: [character.id],
      connectionId: chatGptConnection.id,
    },
  });
  assert.equal(createChatGptGame.statusCode, 200);
  const chatGptGame = createChatGptGame.json();
  const { createLorebooksStorage } = await import("../../packages/server/src/services/storage/lorebooks.storage.js");
  const lorebooks = createLorebooksStorage(db);
  const fixtureLore = await lorebooks.create({ name: "Stable fixture lore", isGlobal: true } as any);
  await lorebooks.createEntry({
    lorebookId: fixtureLore!.id,
    name: "Fixture setting",
    content: "Stable campaign setting for cache replay verification. ".repeat(800),
    enabled: true,
    constant: true,
  } as any);

  await chats.updateMetadata(chatGptGame.id, {
    gameSceneTimelineEnabled: false,
    gameAutoSceneMediaEnabled: false,
    fullLorebookContext: true,
    gameNpcs: [],
    gameJournal: { entries: [], quests: [], locations: [], npcLog: [], inventoryLog: [] },
  } as any);
  const chatGptScope = {
    provider: "openai_chatgpt",
    model: "gpt-5.6-sol",
    connectionId: chatGptConnection.id,
    requestKind: "narrator" as const,
  };
  const baselineGameSend = await app.inject({
    method: "POST",
    url: "/api/generate",
    payload: {
      chatId: chatGptGame.id,
      connectionId: chatGptConnection.id,
      userMessage: "[To the GM] The gate is blue.",
      submissionId: "chatgpt-baseline-turn",
      streaming: true,
    },
  });
  assert.equal(baselineGameSend.statusCode, 200);
  assert.equal(chatGptProviderCalls, 1, "baseline ChatGPT Game send uses only the stub provider");
  await guard.recordSentPrompt(
    chatGptGame.id,
    guard.fingerprintPrompt([{ role: "user", content: "different prior full-lore prompt" }], Date.now(), chatGptScope),
  );
  const heldChatGptGameSend = await app.inject({
    method: "POST",
    url: "/api/generate",
    payload: {
      chatId: chatGptGame.id,
      connectionId: chatGptConnection.id,
      userMessage: "The held ChatGPT Game action must appear in the resumed prompt.",
      submissionId: "chatgpt-held-turn",
      streaming: true,
    },
  });
  assert.equal(heldChatGptGameSend.statusCode, 200);
  const chatGptWarning = heldChatGptGameSend.body
    .split("\n")
    .filter((line: string) => line.startsWith("data: "))
    .map((line: string) => JSON.parse(line.slice(6)))
    .find((event: { type?: string }) => event.type === "cache_warning");
  assert.ok(chatGptWarning?.data?.heldTurn, "ChatGPT Game hold returns the saved-turn descriptor");
  assert.equal(chatGptProviderCalls, 1, "the held ChatGPT Game turn is stopped before the stub provider");
  const acknowledgedChatGptGameSend = await app.inject({
    method: "POST",
    url: "/api/generate",
    payload: {
      chatId: chatGptGame.id,
      connectionId: chatGptConnection.id,
      cacheGuardAcknowledged: true,
      cacheGuardHeldTurn: chatGptWarning.data.heldTurn,
      streaming: true,
    },
  });
  assert.equal(acknowledgedChatGptGameSend.statusCode, 200);
  assert.equal(chatGptProviderCalls, 2, "descriptor-only acknowledgement reaches the stub ChatGPT provider");
  assert.equal(
    chatGptPrompts.at(-1)?.filter(
      (message) =>
        message.role === "user" &&
        message.content === "The held ChatGPT Game action must appear in the resumed prompt.",
    ).length,
    1,
    "the ChatGPT Game provider prompt contains the held user turn exactly once",
  );
  const chatGptMessages = (await app.inject({ method: "GET", url: `/api/chats/${chatGptGame.id}/messages` })).json();
  assert.equal(
    chatGptMessages.filter(
      (message: { role: string; id: string }) =>
        message.role === "user" && message.id === chatGptWarning.data.heldTurn.messageId,
    ).length,
    1,
    "acknowledgement retains exactly one original saved user row",
  );
  assert.equal(chatGptMessages.filter((message: { role: string }) => message.role === "user").length, 2);
  const chatGptAssistant = [...chatGptMessages].reverse().find((message: { role: string }) => message.role === "assistant");
  const chatGptAssistantExtra =
    typeof chatGptAssistant?.extra === "string"
      ? JSON.parse(chatGptAssistant.extra)
      : (chatGptAssistant?.extra ?? {});
  assert.ok(chatGptAssistantExtra.promptHistoryReplay?.helper, "acknowledgement persists the restored Game replay descriptor");
  assert.equal(chatGptAssistantExtra.promptHistoryReplay?.sourceCount, 3);
  assert.equal(chatGptAssistantExtra.promptHistoryReplay?.responseId, chatGptAssistant.id);
  assert.equal(chatGptAssistantExtra.promptHistoryReplay?.scope?.provider, "openai_chatgpt");

  const nextGameSend = await app.inject({
    method: "POST",
    url: "/api/generate",
    payload: {
      chatId: chatGptGame.id,
      connectionId: chatGptConnection.id,
      userMessage: "[To the GM] Correction: the gate is green.",
      submissionId: "chatgpt-after-ack",
      streaming: true,
    },
  });
  assert.equal(nextGameSend.statusCode, 200);
  assert.equal(chatGptProviderCalls, 3, "following normal turn reaches the mocked provider");
  const afterMessages = await chats.listMessages(chatGptGame.id);
  const afterAssistant = afterMessages.filter((message) => message.role === "assistant").at(-1)!;
  const afterExtra = typeof afterAssistant.extra === "string" ? JSON.parse(afterAssistant.extra) : afterAssistant.extra;
  assert.equal(
    afterExtra.promptHistoryReplay?.replayed,
    true,
    "the next real Game route reuses the acknowledged replay descriptor",
  );
  const correctionFollowUp = await app.inject({
    method: "POST",
    url: "/api/generate",
    payload: {
      chatId: chatGptGame.id,
      connectionId: chatGptConnection.id,
      userMessage: "Describe the corrected gate.",
      submissionId: "chatgpt-after-correction",
      streaming: true,
    },
  });
  assert.equal(correctionFollowUp.statusCode, 200);
  assert.equal(chatGptProviderCalls, 4);
  const priorPrompt = chatGptPrompts[2]!;
  const correctedPrompt = chatGptPrompts[3]!;
  assert.deepEqual(correctedPrompt.slice(0, priorPrompt.length), priorPrompt);
  const newestAuthorial = priorPrompt
    .slice(chatGptPrompts[1]!.length)
    .find((message) => String(message.content).includes("<authorial_continuity>"));
  assert.ok(newestAuthorial, "the correction turn emits the changed authorial snapshot");
  const correctionText = String(newestAuthorial.content);
  assert.ok(correctionText.includes("[To the GM] The gate is blue."));
  assert.ok(correctionText.includes("[To the GM] Correction: the gate is green."));
  assert.ok(correctionText.indexOf("The gate is blue.") < correctionText.indexOf("Correction: the gate is green."));
  assert.match(correctionText, /a newer correction supersedes the older claim/u);
  assert.ok(
    correctedPrompt
      .slice(priorPrompt.length)
      .some((message) => String(message.content).includes("The newest snapshot replaces prior snapshots")),
  );
  const correctionSnapshotId = /^<marinara_replay_snapshot id="([a-f0-9]{64})">/.exec(correctionText)?.[1];
  assert.ok(correctionSnapshotId);
  assert.ok(
    correctedPrompt
      .slice(priorPrompt.length)
      .some(
        (message) =>
          String(message.content) ===
          `<marinara_replay_snapshot_ref id="${correctionSnapshotId}">${correctionSnapshotId}</marinara_replay_snapshot_ref>`,
      ),
  );

  console.log("cache-send-guard route regression passed");
} finally {
  resetSdk();
  resetOpenAIProvider();
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  if (app) {
    await Promise.allSettled([...pendingNpcSyncRequests]);
    await app.close();
  }
  rmSync(dataDir, { recursive: true, force: true });
}
