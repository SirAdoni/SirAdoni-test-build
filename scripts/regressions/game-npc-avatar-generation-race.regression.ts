import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-npc-avatar-generation-race-"));
const fileStorageDir = join(dataDir, "file-storage");
const previousEnv = {
  DATA_DIR: process.env.DATA_DIR,
  FILE_STORAGE_DIR: process.env.FILE_STORAGE_DIR,
  MARINARA_FILE_STORAGE_DIR: process.env.MARINARA_FILE_STORAGE_DIR,
  NODE_ENV: process.env.NODE_ENV,
  MARINARA_LITE: process.env.MARINARA_LITE,
  LOG_LEVEL: process.env.LOG_LEVEL,
};
let app: { close(): Promise<void>; ready(): Promise<unknown>; inject(options: Record<string, unknown>): Promise<any> } | null = null;
let closeDB: (() => Promise<void>) | null = null;
const originalFetch = globalThis.fetch;
let releasePendingImageResponse: ((response: Response) => void) | undefined;
let providerWaitTimer: ReturnType<typeof setTimeout> | undefined;

async function withDeadline<T>(promise: PromiseLike<T>, stage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out at ${stage}`)), 5000); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

try {
  process.env.DATA_DIR = dataDir;
  process.env.FILE_STORAGE_DIR = fileStorageDir;
  process.env.MARINARA_FILE_STORAGE_DIR = fileStorageDir;
  process.env.NODE_ENV = "test";
  process.env.MARINARA_LITE = "true";
  process.env.LOG_LEVEL = "silent";
  console.info("race fixture: importing isolated server");

  const [{ buildApp }, dbModule, { createCharactersStorage }, { createConnectionsStorage }, { chats }, { eq }] =
    await Promise.all([
      import("../../packages/server/src/app.js"),
      import("../../packages/server/src/db/connection.js"),
      import("../../packages/server/src/services/storage/characters.storage.js"),
      import("../../packages/server/src/services/storage/connections.storage.js"),
      import("../../packages/server/src/db/schema/index.js"),
      import("../../packages/server/src/db/file-query.js"),
    ]);
  closeDB = dbModule.closeDB;
  console.info("race fixture: building isolated app");
  app = await buildApp();
  await app.ready();
  console.info("race fixture: isolated app ready");

  const db = await dbModule.getDB();
  const charactersStorage = createCharactersStorage(db);
  const connectionsStorage = createConnectionsStorage(db);
  const card = await charactersStorage.create({
    name: "Race Test NPC",
    description: "A traveler in a weathered blue coat, calm and alert.",
    personality: "",
    scenario: "",
    first_mes: "",
    mes_example: "",
    creator_notes: "",
    system_prompt: "",
    post_history_instructions: "",
    tags: [],
    creator: "",
    character_version: "1.0",
    alternate_greetings: [],
    extensions: {},
    character_book: null,
  } as never) as { id: string };
  assert.ok(card?.id);

  const plannerConnection = await connectionsStorage.create({
    name: "Local fixture planner",
    provider: "openai",
    model: "gpt-4o-mini",
    baseUrl: "http://127.0.0.1:18766/v1",
    apiKey: "local-test-only",
    isDefault: true,
  } as never) as { id: string };
  const imageConnection = await connectionsStorage.create({
    name: "Local deferred image fixture",
    provider: "image_generation",
    model: "dall-e-3",
    imageGenerationSource: "openai",
    baseUrl: "http://127.0.0.1:18765/v1",
    apiKey: "local-test-only",
  } as never) as { id: string };

  const chatId = "npc-avatar-generation-race";
  const npcId = "npc-race-test";
  const timestamp = "2026-09-30T00:00:00.000Z";
  await db.insert(chats).values({
    id: chatId,
    name: "NPC avatar generation race",
    mode: "game",
    groupId: "avatar-race-campaign",
    connectionId: plannerConnection.id,
    personaId: null,
    characterIds: JSON.stringify([card.id]),
    metadata: JSON.stringify({
      gameSessionNumber: 1,
      enableSpriteGeneration: true,
      gameImageConnectionId: imageConnection.id,
      gameNpcs: [{ id: npcId, characterId: card.id, name: "Race Test NPC", observedDescription: "A traveler in a weathered blue coat, calm and alert.", avatarUrl: null }],
      gameSettings: { portraitReviewEnabled: false },
    }),
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a2cAAAAASUVORK5CYII=";
  const providerUrl = "http://127.0.0.1:18765/v1/images/generations";
  const plannerUrl = "http://127.0.0.1:18766/v1/chat/completions";
  type DeferredImageRequest = { started: Promise<void>; release(response: Response): void };
  let nextDeferredImageRequest: { signalStarted(): void; response: Promise<Response> } | null = null;
  const deferNextImageRequest = (): DeferredImageRequest => {
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => (signalStarted = resolve));
    let release!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => (release = resolve));
    nextDeferredImageRequest = { signalStarted, response };
    releasePendingImageResponse = release;
    return {
      started,
      release: (providerResponse) => {
        release(providerResponse);
        if (releasePendingImageResponse === release) releasePendingImageResponse = undefined;
      },
    };
  };
  let requestCount = 0;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (url === plannerUrl && method === "POST") {
      const body = typeof init?.body === "string" ? init.body : "";
      const isVisualReview = body.includes("independent NPC visual acceptance reviewer");
      const content = isVisualReview
        ? JSON.stringify({ accepted: true, observed: "A clearly visible traveler in a weathered blue coat.", issues: [] })
        : "A clear portrait of a traveler in a weathered blue coat, calm and alert.";
      return new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url !== providerUrl || method !== "POST")
      throw new Error(`Unexpected outbound fetch in regression: ${method} ${url}`);
    requestCount++;
    if (nextDeferredImageRequest) {
      const deferred = nextDeferredImageRequest;
      nextDeferredImageRequest = null;
      console.info(`race fixture: image request ${requestCount} paused`);
      deferred.signalStarted();
      return deferred.response;
    }
    return new Response(JSON.stringify({ data: [{ b64_json: pngBase64 }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const generationBody = {
    chatId,
    imageConnectionId: imageConnection.id,
    forceNpcAvatarNames: ["Race Test NPC"],
    npcsNeedingAvatars: [{ npcId, characterId: card.id, name: "Race Test NPC", description: "A traveler in a weathered blue coat, calm and alert." }],
    queueImageGenerationRequests: false,
  };
  const firstImageRequest = deferNextImageRequest();
  const generationInFlight = app.inject({ method: "POST", url: "/api/game/generate-assets", payload: generationBody });
  console.info("race fixture: waiting for provider or early HTTP response");
  const providerGate = await Promise.race([
    firstImageRequest.started.then(() => ({ kind: "provider" as const })),
    generationInFlight.then((response) => ({ kind: "response" as const, response })),
    new Promise<{ kind: "timeout" }>((resolve) => {
      providerWaitTimer = setTimeout(() => resolve({ kind: "timeout" }), 15000);
    }),
  ]);
  if (providerWaitTimer) clearTimeout(providerWaitTimer);
  if (providerGate.kind === "response") {
    throw new Error(
      `generation route completed before reaching the mocked image provider (HTTP ${providerGate.response.statusCode}): ${providerGate.response.body}`,
    );
  }
  assert.equal(providerGate.kind, "provider", "image provider was not reached before timeout");

  console.info("race fixture: clearing portrait while image request is paused");
  const deleted = await withDeadline(app.inject({ method: "DELETE", url: `/api/characters/${card.id}/avatar` }), "DELETE during image request");
  console.info("race fixture: DELETE completed");
  assert.equal(deleted.statusCode, 200, deleted.body);
  assert.deepEqual(deleted.json().avatarState, { revision: 1, removed: true });
  firstImageRequest.release(
    new Response(JSON.stringify({ data: [{ b64_json: pngBase64 }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  const staleGeneration = await withDeadline(generationInFlight, "stale generation completion");
  assert.equal(staleGeneration.statusCode, 200, staleGeneration.body);
  assert.deepEqual(staleGeneration.json().generatedNpcAvatars, [], "generation started before clear cannot return/resurrect a portrait");
  const clearedCard = await charactersStorage.getById(card.id);
  assert.equal(clearedCard?.avatarPath, null, "old generation leaves the card avatar cleared");

  console.info("race fixture: starting post-clear generation");
  const freshGeneration = await withDeadline(app.inject({ method: "POST", url: "/api/game/generate-assets", payload: generationBody }), "post-clear generation completion");
  assert.equal(freshGeneration.statusCode, 200, freshGeneration.body);
  const freshPortraits = freshGeneration.json().generatedNpcAvatars as Array<{ characterId?: string; avatarState?: { revision: number; removed: boolean } }>;
  assert.equal(requestCount, 2, "both requests reached only the mocked image provider");
  assert.equal(freshPortraits.length, 1, "generation begun after clear can assign a new portrait");
  assert.equal(freshPortraits[0]?.characterId, card.id);
  assert.deepEqual(freshPortraits[0]?.avatarState, { revision: 2, removed: false });
  const finalCard = await charactersStorage.getById(card.id);
  assert.ok(finalCard?.avatarPath, "post-clear generation assigns the new card avatar");
  const finalData = JSON.parse(finalCard!.data) as { extensions?: { marinara?: { avatarState?: unknown } } };
  assert.deepEqual(finalData.extensions?.marinara?.avatarState, { revision: 2, removed: false });

  console.info("race fixture: pausing background generation before NPC authority capture");
  const earlyStageBody = {
    ...generationBody,
    backgroundTag: "race-deferred-background-stage",
    backgroundDescription: "A quiet stone courtyard at dusk.",
    forceBackground: true,
  };
  const backgroundImageRequest = deferNextImageRequest();
  const earlyStageGeneration = app.inject({ method: "POST", url: "/api/game/generate-assets", payload: earlyStageBody });
  const backgroundProviderGate = await withDeadline(Promise.race([
    backgroundImageRequest.started.then(() => ({ kind: "provider" as const })),
    earlyStageGeneration.then((response) => ({ kind: "response" as const, response })),
  ]), "background provider start before NPC generation");
  if (backgroundProviderGate.kind === "response") {
    throw new Error(
      `generation completed before reaching the mocked background provider (HTTP ${backgroundProviderGate.response.statusCode}): ${backgroundProviderGate.response.body}`,
    );
  }
  const deletedDuringBackground = await withDeadline(
    app.inject({ method: "DELETE", url: `/api/characters/${card.id}/avatar` }),
    "DELETE during background generation",
  );
  assert.equal(deletedDuringBackground.statusCode, 200, deletedDuringBackground.body);
  assert.deepEqual(deletedDuringBackground.json().avatarState, { revision: 3, removed: true });
  backgroundImageRequest.release(new Response(JSON.stringify({ data: [{ b64_json: pngBase64 }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  const staleAfterBackground = await withDeadline(earlyStageGeneration, "generation after background-stage clear");
  assert.equal(staleAfterBackground.statusCode, 200, staleAfterBackground.body);
  assert.deepEqual(staleAfterBackground.json().generatedNpcAvatars, [], "a pre-background snapshot cannot adopt a later card revision");
  assert.equal((await charactersStorage.getById(card.id))?.avatarPath, null);
  const postBackgroundClearGeneration = await withDeadline(
    app.inject({ method: "POST", url: "/api/game/generate-assets", payload: generationBody }),
    "post-background-clear generation completion",
  );
  assert.equal(postBackgroundClearGeneration.statusCode, 200, postBackgroundClearGeneration.body);
  assert.deepEqual(postBackgroundClearGeneration.json().generatedNpcAvatars[0]?.avatarState, { revision: 4, removed: false });
  const latestLinkedCard = await charactersStorage.getById(card.id);
  assert.ok(latestLinkedCard?.avatarPath);

  const unlinkedNpcId = "npc-unlinked-race-test";
  const unlinkedChatId = "npc-avatar-generation-race-unlinked";
  const unrelatedCardAvatarPath = latestLinkedCard!.avatarPath;
  await db.insert(chats).values({
    id: unlinkedChatId,
    name: "Unlinked NPC avatar generation race",
    mode: "game",
    groupId: "avatar-race-campaign-unlinked",
    connectionId: plannerConnection.id,
    personaId: null,
    characterIds: JSON.stringify([card.id]),
    metadata: JSON.stringify({
      gameSessionNumber: 1,
      enableSpriteGeneration: true,
      gameImageConnectionId: imageConnection.id,
      gameNpcs: [{
        id: unlinkedNpcId,
        name: "Race Test NPC",
        observedDescription: "A traveler in a weathered blue coat, calm and alert.",
        avatarUrl: `/api/avatars/npc/${unlinkedChatId}/previous.png`,
      }],
    }),
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const unlinkedGenerationBody = {
    chatId: unlinkedChatId,
    imageConnectionId: imageConnection.id,
    forceNpcAvatarNames: ["Race Test NPC"],
    npcsNeedingAvatars: [{ npcId: unlinkedNpcId, name: "Race Test NPC", description: "A traveler in a weathered blue coat, calm and alert." }],
    queueImageGenerationRequests: false,
  };
  const unlinkedImageRequest = deferNextImageRequest();
  const staleUnlinkedGeneration = app.inject({ method: "POST", url: "/api/game/generate-assets", payload: unlinkedGenerationBody });
  const unlinkedProviderGate = await withDeadline(Promise.race([
    unlinkedImageRequest.started.then(() => ({ kind: "provider" as const })),
    staleUnlinkedGeneration.then((response) => ({ kind: "response" as const, response })),
  ]), "unlinked image provider start");
  if (unlinkedProviderGate.kind === "response") {
    throw new Error(
      `unlinked generation completed before reaching the mocked image provider (HTTP ${unlinkedProviderGate.response.statusCode}): ${unlinkedProviderGate.response.body}`,
    );
  }
  const clearedUnlinked = await withDeadline(app.inject({
    method: "PATCH",
    url: `/api/chats/${unlinkedChatId}/metadata`,
    payload: {
      gameNpcs: [{
        id: unlinkedNpcId,
        name: "Race Test NPC",
        observedDescription: "A traveler in a weathered blue coat, calm and alert.",
      }],
    },
  }), "explicit unlinked NPC clear");
  assert.equal(clearedUnlinked.statusCode, 200, clearedUnlinked.body);
  const clearMetadata = JSON.parse((await db.select().from(chats).where(eq(chats.id, unlinkedChatId)))[0]!.metadata) as {
    gameNpcs: Array<{ id: string; avatarUrl?: string | null; avatarState?: { revision: number; removed: boolean } }>;
  };
  assert.equal(clearMetadata.gameNpcs[0]?.avatarUrl, null, "explicit unlinked omission clears the saved portrait URL");
  assert.deepEqual(clearMetadata.gameNpcs[0]?.avatarState, { revision: 1, removed: true });
  unlinkedImageRequest.release(new Response(JSON.stringify({ data: [{ b64_json: pngBase64 }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  const staleUnlinkedResponse = await withDeadline(staleUnlinkedGeneration, "stale unlinked generation completion");
  assert.equal(staleUnlinkedResponse.statusCode, 200, staleUnlinkedResponse.body);
  assert.deepEqual(staleUnlinkedResponse.json().generatedNpcAvatars, [], "unlinked generation begun before clear cannot return/resurrect a portrait");
  const afterStaleUnlinked = JSON.parse((await db.select().from(chats).where(eq(chats.id, unlinkedChatId)))[0]!.metadata) as typeof clearMetadata;
  assert.equal(afterStaleUnlinked.gameNpcs[0]?.avatarUrl, null, "stale unlinked generation leaves the NPC cleared");
  assert.deepEqual(afterStaleUnlinked.gameNpcs[0]?.avatarState, { revision: 1, removed: true });

  const freshUnlinkedGeneration = await withDeadline(app.inject({
    method: "POST",
    url: "/api/game/generate-assets",
    payload: unlinkedGenerationBody,
  }), "post-clear unlinked generation completion");
  assert.equal(freshUnlinkedGeneration.statusCode, 200, freshUnlinkedGeneration.body);
  const unlinkedPortraits = freshUnlinkedGeneration.json().generatedNpcAvatars as Array<{
    npcId?: string;
    characterId?: string;
    avatarState?: { revision: number; removed: boolean };
  }>;
  assert.equal(unlinkedPortraits.length, 1, "post-clear unlinked generation can assign a fresh portrait");
  assert.equal(unlinkedPortraits[0]?.npcId, unlinkedNpcId);
  assert.equal(unlinkedPortraits[0]?.characterId, undefined, "same-name library card is not linked by name");
  assert.deepEqual(unlinkedPortraits[0]?.avatarState, { revision: 2, removed: false });
  assert.equal((await charactersStorage.getById(card.id))?.avatarPath, unrelatedCardAvatarPath, "unrelated same-name library card avatar remains unchanged");

  const uploadNpcId = "npc-upload-stub-race-test";
  const uploadedStub = await withDeadline(app.inject({
    method: "POST",
    url: `/api/avatars/npc/${unlinkedChatId}`,
    payload: {
      npcId: uploadNpcId,
      name: "Upload Stub NPC",
      avatar: `data:image/png;base64,${pngBase64}`,
    },
  }), "unlinked stub avatar upload");
  assert.equal(uploadedStub.statusCode, 200, uploadedStub.body);
  assert.equal(uploadedStub.json().npcUpdated, true);
  assert.deepEqual(uploadedStub.json().avatarState, { revision: 1, removed: false });
  const afterStubUpload = JSON.parse((await db.select().from(chats).where(eq(chats.id, unlinkedChatId)))[0]!.metadata) as {
    gameNpcs: Array<{ id: string; name: string; observedDescription?: string; avatarUrl?: string | null; avatarState?: { revision: number; removed: boolean } }>;
  };
  const preservedGeneratedNpc = afterStubUpload.gameNpcs.find((npc) => npc.id === unlinkedNpcId)!;
  assert.deepEqual(afterStubUpload.gameNpcs.find((npc) => npc.id === uploadNpcId)?.avatarState, { revision: 1, removed: false });
  const clearedStub = await withDeadline(app.inject({
    method: "PATCH",
    url: `/api/chats/${unlinkedChatId}/metadata`,
    payload: {
      gameNpcs: [
        preservedGeneratedNpc,
        { id: uploadNpcId, name: "Upload Stub NPC", observedDescription: "A traveler in a weathered blue coat, calm and alert." },
      ],
    },
  }), "clear uploaded stub avatar");
  assert.equal(clearedStub.statusCode, 200, clearedStub.body);
  const afterStubClear = JSON.parse((await db.select().from(chats).where(eq(chats.id, unlinkedChatId)))[0]!.metadata) as typeof afterStubUpload;
  assert.equal(afterStubClear.gameNpcs.find((npc) => npc.id === uploadNpcId)?.avatarUrl, null);
  assert.deepEqual(afterStubClear.gameNpcs.find((npc) => npc.id === uploadNpcId)?.avatarState, { revision: 2, removed: true });
  const postClearUpload = await withDeadline(app.inject({
    method: "POST",
    url: `/api/avatars/npc/${unlinkedChatId}`,
    payload: {
      npcId: uploadNpcId,
      name: "Upload Stub NPC",
      avatar: `data:image/png;base64,${pngBase64}`,
    },
  }), "post-clear unlinked avatar upload");
  assert.equal(postClearUpload.statusCode, 200, postClearUpload.body);
  assert.deepEqual(postClearUpload.json().avatarState, { revision: 3, removed: false });
  assert.equal(requestCount, 7, "all linked and unlinked generation races use only the strict mocked image endpoint");

  console.log("game-npc-avatar-generation-race regression passed");
} finally {
  if (providerWaitTimer) clearTimeout(providerWaitTimer);
  releasePendingImageResponse?.(new Response(JSON.stringify({ error: { message: "fixture cleanup" } }), { status: 500 }));
  globalThis.fetch = originalFetch;
  console.info("race fixture: closing app");
  await app?.close();
  console.info("race fixture: closing database");
  await closeDB?.();
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dataDir, { recursive: true, force: true });
  console.info("race fixture: cleanup complete", process.getActiveResourcesInfo());
}
