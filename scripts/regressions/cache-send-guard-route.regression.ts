import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  /if \(!toolPlannerAttempted && !input\.impersonate && cacheGuardApplies\(conn\.provider, narratorMessages\)\)/u,
  "narrator cache guard is skipped after tool planner side effects",
);

let app: {
  ready(): Promise<void>;
  close(): Promise<void>;
  inject(options: Record<string, unknown>): Promise<any>;
} | null = null;
let pendingNpcSyncRequests = new Set<Promise<unknown>>();
let resetSdk = () => {};
try {
  const { buildApp } = await import("../../packages/server/src/app.js");
  const guard = await import("../../packages/server/src/services/generation/cache-send-guard.js");
  const { __setSdkForTesting } =
    await import("../../packages/server/src/services/llm/providers/claude-subscription.provider.js");
  const { getDB } = await import("../../packages/server/src/db/connection.js");
  const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
  const db = await getDB();
  const chats = createChatsStorage(db);
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
      streaming: true,
    },
  });
  assert.equal(held.statusCode, 200);
  assert.match(held.body, /cache_warning/u);
  assert.equal(providerCalls, 0, "expired cache hold must happen before the narrator provider call");
  const heldMessages = await app.inject({ method: "GET", url: `/api/chats/${chat.id}/messages` });
  assert.equal(heldMessages.statusCode, 200);
  assert.match(heldMessages.body, /ordinary narrator request/u, "cache hold must preserve the saved user message");

  const acknowledged = await app.inject({
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
  assert.equal(acknowledged.statusCode, 200);
  assert.match(acknowledged.body, /isolated scene continues/u);
  assert.equal(providerCalls, 1, "acknowledgement must release the send to the provider");
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
    gameNpcKnowledgeMode: "isolated",
    gameNpcs: [],
    gameJournal: { entries: [], quests: [], locations: [], npcLog: [], inventoryLog: [] },
  } as any);
  await chats.createMessage({ chatId: isolatedChat.id, role: "user", content: "I enter the isolated scene." } as any);
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
      streaming: true,
    },
  });
  assert.equal(isolatedHeld.statusCode, 200);
  assert.match(isolatedHeld.body, /cache_warning/u, "isolated planner hold must reach SSE");
  assert.equal(
    providerCalls,
    isolatedProviderCallsBefore,
    "isolated planner hold must happen before the paid provider call",
  );
  const isolatedMessages = await app.inject({ method: "GET", url: `/api/chats/${isolatedChat.id}/messages` });
  assert.match(isolatedMessages.body, /I enter the isolated scene/u, "isolated hold preserves the saved user message");
  const isolatedAccepted = await app.inject({
    method: "POST",
    url: "/api/generate",
    payload: {
      chatId: isolatedChat.id,
      connectionId: connection.id,
      userMessage: "I enter the isolated scene.",
      cacheGuardAcknowledged: true,
      streaming: true,
    },
  });
  assert.equal(isolatedAccepted.statusCode, 200);
  assert.match(isolatedAccepted.body, /The isolated scene continues/u);
  assert.ok(providerCalls > isolatedProviderCallsBefore, "isolated acknowledgement releases the planner provider call");
  assert.ok(await guard.readLastSentPrompt(isolatedChat.id, isolatedScope), "isolated planner success is recorded");

  console.log("cache-send-guard route regression passed");
} finally {
  resetSdk();
  if (app) {
    await Promise.allSettled([...pendingNpcSyncRequests]);
    await app.close();
  }
  rmSync(dataDir, { recursive: true, force: true });
}
