import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCampaignPortraitBatches,
  buildMissingSceneAssetGenerationPayload,
} from "../../packages/client/src/components/game/game-asset-generation-payload.js";
import { normalizeSceneAssetNameForGeneration } from "../../packages/client/src/components/game/game-asset-generation-payload.js";
import { resolveGameSetupArtStylePrompt } from "../../packages/shared/src/utils/game-art-style.js";

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
let app: {
  close(): Promise<void>;
  ready(): Promise<unknown>;
  inject(options: Record<string, unknown>): Promise<any>;
} | null = null;
let closeDB: (() => Promise<void>) | null = null;
const originalFetch = globalThis.fetch;
let releasePendingImageResponse: ((response: Response) => void) | undefined;

async function withDeadline<T>(promise: PromiseLike<T>, stage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out at ${stage}`)), 5000);
      }),
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

  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    throw new Error(`Unexpected outbound fetch during regression setup: ${url}`);
  };
  console.info("avatar race: importing isolated server");
  const { buildApp } = await import("../../packages/server/src/app.js");
  console.info("avatar race: app module loaded");
  const dbModule = await import("../../packages/server/src/db/connection.js");
  console.info("avatar race: database module loaded");
  const { createCharactersStorage } = await import("../../packages/server/src/services/storage/characters.storage.js");
  const { createConnectionsStorage } =
    await import("../../packages/server/src/services/storage/connections.storage.js");
  const { chats } = await import("../../packages/server/src/db/schema/index.js");
  const { eq } = await import("../../packages/server/src/db/file-query.js");
  const { logger } = await import("../../packages/server/src/lib/logger.js");
  closeDB = dbModule.closeDB;
  console.info("avatar race: building isolated app");
  app = await buildApp();
  await app.ready();
  console.info("avatar race: isolated app ready");

  const db = await dbModule.getDB();
  const charactersStorage = createCharactersStorage(db);
  const connectionsStorage = createConnectionsStorage(db);
  const imageConnection = (await connectionsStorage.create({
    name: "Local deferred image fixture",
    provider: "image_generation",
    model: "dall-e-3",
    imageGenerationSource: "openai",
    baseUrl: "http://127.0.0.1:18765/v1",
    apiKey: "local-test-only",
  } as never)) as { id: string };

  const createCard = async (name: string) =>
    charactersStorage.create({
      name,
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
    } as never) as Promise<{ id: string }>;
  const timestamp = "2026-09-30T00:00:00.000Z";
  const createChat = async (id: string, characterIds: string[], gameNpcs: Array<Record<string, unknown>>) => {
    await db.insert(chats).values({
      id,
      name: id,
      mode: "game",
      groupId: `campaign-${id}`,
      connectionId: null,
      personaId: null,
      characterIds: JSON.stringify(characterIds),
      metadata: JSON.stringify({
        gameSessionNumber: 1,
        enableSpriteGeneration: true,
        gameImageConnectionId: imageConnection.id,
        gameNpcs,
      }),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  };
  const patchMetadata = async (chatId: string, payload: Record<string, unknown>) => {
    const response = await withDeadline(
      app!.inject({
        method: "PATCH",
        url: `/api/chats/${chatId}/metadata`,
        payload,
      }),
      `metadata patch for ${chatId}`,
    );
    assert.equal(response.statusCode, 200, response.body);
  };
  const portraitFiles = (chatId: string): string[] => {
    const directory = join(dataDir, "avatars", "npc", chatId);
    return existsSync(directory) ? readdirSync(directory).sort() : [];
  };
  const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a2cAAAAASUVORK5CYII=";
  const providerUrl = "http://127.0.0.1:18765/v1/images/generations";
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
  let lastImagePrompt = "";
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (url !== providerUrl || method !== "POST")
      throw new Error(`Unexpected outbound fetch in regression: ${method} ${url}`);
    requestCount++;
    const requestBody = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
    if (typeof requestBody === "string") {
      const payload = JSON.parse(requestBody) as { prompt?: unknown };
      if (typeof payload.prompt === "string") lastImagePrompt = payload.prompt;
    }
    if (nextDeferredImageRequest) {
      const deferred = nextDeferredImageRequest;
      nextDeferredImageRequest = null;
      deferred.signalStarted();
      return deferred.response;
    }
    return new Response(JSON.stringify({ data: [{ b64_json: pngBase64 }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const card = await createCard("Race Test NPC");
  const otherCard = await createCard("Relink Target NPC");
  const chatId = "npc-avatar-generation-race-linked";
  const npcId = "npc-race-test";
  const initialNpc = {
    id: npcId,
    characterId: card.id,
    name: "Race Test NPC",
    description: "A traveler in a weathered blue coat, calm and alert.",
    avatarUrl: null,
  };
  await createChat(chatId, [card.id, otherCard.id], [initialNpc]);
  const generationBody = {
    chatId,
    forceNpcAvatarNames: [`id:${npcId}`],
    npcsNeedingAvatars: [
      {
        npcId,
        characterId: card.id,
        name: "Race Test NPC",
        description: "A traveler in a weathered blue coat, calm and alert.",
      },
    ],
    queueImageGenerationRequests: false,
  };
  const imageResponse = () =>
    new Response(JSON.stringify({ data: [{ b64_json: pngBase64 }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const awaitProvider = async (pending: Promise<any>, request: DeferredImageRequest, stage: string) => {
    const result = await withDeadline(
      Promise.race([
        request.started.then(() => ({ kind: "provider" as const })),
        pending.then((response) => ({ kind: "response" as const, response })),
      ]),
      stage,
    );
    if (result.kind === "response")
      throw new Error(`${stage}: route completed before mocked image provider (HTTP ${result.response.statusCode})`);
    assert.equal(result.kind, "provider", `${stage}: mocked provider was not reached`);
  };

  const firstRequest = deferNextImageRequest();
  console.info("avatar race: waiting for linked portrait provider");
  const staleLinked = app.inject({ method: "POST", url: "/api/game/generate-assets", payload: generationBody });
  await awaitProvider(staleLinked, firstRequest, "linked generation start");
  let queuedAuthorityCaptured!: () => void;
  const queuedAuthority = new Promise<void>((resolve) => (queuedAuthorityCaptured = resolve));
  const loggerWithInfo = logger as unknown as { info: (...args: unknown[]) => unknown };
  const originalInfo = loggerWithInfo.info;
  loggerWithInfo.info = (...args) => {
    if (typeof args[0] === "string" && args[0].includes("waiting for in-flight asset generation"))
      queuedAuthorityCaptured();
    return originalInfo.apply(logger, args);
  };
  const queuedLinked = app.inject({ method: "POST", url: "/api/game/generate-assets", payload: generationBody });
  await withDeadline(queuedAuthority, "queued request authority snapshot");
  loggerWithInfo.info = originalInfo;
  const cleared = await withDeadline(
    app.inject({ method: "DELETE", url: `/api/characters/${card.id}/avatar` }),
    "clear during linked generation",
  );
  assert.equal(cleared.statusCode, 200, cleared.body);
  assert.deepEqual(cleared.json().avatarState, { revision: 1, removed: true });
  firstRequest.release(imageResponse());
  const staleLinkedResponse = await withDeadline(staleLinked, "stale linked generation completion");
  console.info("avatar race: linked clear race settled");
  assert.equal(staleLinkedResponse.statusCode, 200, staleLinkedResponse.body);
  assert.deepEqual(staleLinkedResponse.json().generatedNpcAvatars, []);
  const staleQueuedResponse = await withDeadline(queuedLinked, "stale queued generation completion");
  assert.equal(staleQueuedResponse.statusCode, 200, staleQueuedResponse.body);
  assert.deepEqual(
    staleQueuedResponse.json().generatedNpcAvatars,
    [],
    "a request queued before clear keeps its original revision snapshot",
  );
  assert.equal((await charactersStorage.getById(card.id))?.avatarPath, null);
  assert.deepEqual(portraitFiles(chatId), [], "rejected generation removes only its own unique output");

  const fresh = await withDeadline(
    app.inject({ method: "POST", url: "/api/game/generate-assets", payload: generationBody }),
    "fresh linked generation",
  );
  assert.equal(fresh.statusCode, 200, fresh.body);
  assert.equal(fresh.json().generatedNpcAvatars.length, 1);
  assert.deepEqual(fresh.json().generatedNpcAvatars[0]?.avatarState, { revision: 2, removed: false });
  const preservedFile = portraitFiles(chatId)[0];
  assert.ok(
    preservedFile && /-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.png$/iu.test(preservedFile),
  );
  const preservedAvatarPath = (await charactersStorage.getById(card.id))?.avatarPath;

  const staleAfterHumanAssignRequest = deferNextImageRequest();
  const staleAfterHumanAssign = app.inject({
    method: "POST",
    url: "/api/game/generate-assets",
    payload: generationBody,
  });
  await awaitProvider(staleAfterHumanAssign, staleAfterHumanAssignRequest, "generation before human avatar assignment");
  const humanAssignment = await withDeadline(
    app.inject({
      method: "PATCH",
      url: `/api/characters/${card.id}`,
      payload: { data: {}, avatarPath: preservedAvatarPath },
    }),
    "human avatar assignment during generation",
  );
  assert.equal(humanAssignment.statusCode, 200, humanAssignment.body);
  assert.equal((await charactersStorage.getById(card.id))?.avatarPath, preservedAvatarPath);
  const humanAssignedChat = await db.select().from(chats).where(eq(chats.id, chatId));
  const humanAssignedMetadata = JSON.parse(humanAssignedChat[0]!.metadata) as {
    gameNpcs: Array<{ avatarState?: unknown }>;
  };
  assert.deepEqual(
    humanAssignedMetadata.gameNpcs[0]?.avatarState,
    { revision: 3, removed: false },
    "human assignment advances the linked NPC avatar revision",
  );
  staleAfterHumanAssignRequest.release(imageResponse());
  const staleAfterHumanAssignResponse = await withDeadline(
    staleAfterHumanAssign,
    "generation after human avatar assignment",
  );
  assert.equal(staleAfterHumanAssignResponse.statusCode, 200, staleAfterHumanAssignResponse.body);
  assert.deepEqual(
    staleAfterHumanAssignResponse.json().generatedNpcAvatars,
    [],
    "a later human avatar assignment wins over an older generated result",
  );
  assert.equal(
    (await charactersStorage.getById(card.id))?.avatarPath,
    preservedAvatarPath,
    "the human-selected avatar path remains assigned",
  );
  assert.deepEqual(
    portraitFiles(chatId),
    [preservedFile],
    "the stale generated file is cleaned without deleting the human-selected file",
  );

  const deferredAuthorityCases = [
    {
      label: "ignored identity",
      prepare: async () =>
        patchMetadata(chatId, { gameNpcs: [initialNpc], gameIgnoredNpcIds: [], gamePartyCharacterIds: [] }),
      update: async () => patchMetadata(chatId, { gameIgnoredNpcIds: [npcId] }),
      verify: async () => assert.equal((await charactersStorage.getById(card.id))?.avatarPath, preservedAvatarPath),
    },
    {
      label: "relinked identity",
      prepare: async () =>
        patchMetadata(chatId, { gameNpcs: [initialNpc], gameIgnoredNpcIds: [], gamePartyCharacterIds: [] }),
      update: async () => patchMetadata(chatId, { gameNpcs: [{ ...initialNpc, characterId: otherCard.id }] }),
      verify: async () => assert.equal((await charactersStorage.getById(otherCard.id))?.avatarPath, null),
    },
    {
      label: "party membership",
      prepare: async () =>
        patchMetadata(chatId, { gameNpcs: [initialNpc], gameIgnoredNpcIds: [], gamePartyCharacterIds: [] }),
      update: async () =>
        patchMetadata(chatId, {
          gameNpcs: [initialNpc],
          gameIgnoredNpcIds: [],
          gamePartyCharacterIds: [card.id],
        }),
      verify: async () => assert.equal((await charactersStorage.getById(card.id))?.avatarPath, preservedAvatarPath),
    },
  ];
  for (const testCase of deferredAuthorityCases) {
    await testCase.prepare();
    const request = deferNextImageRequest();
    const pending = app.inject({ method: "POST", url: "/api/game/generate-assets", payload: generationBody });
    await awaitProvider(pending, request, `${testCase.label} generation start`);
    await testCase.update();
    request.release(imageResponse());
    const rejected = await withDeadline(pending, `${testCase.label} generation completion`);
    assert.equal(rejected.statusCode, 200, rejected.body);
    assert.deepEqual(rejected.json().generatedNpcAvatars, [], `${testCase.label} change rejects an in-flight result`);
    await testCase.verify();
    assert.deepEqual(
      portraitFiles(chatId),
      [preservedFile],
      `${testCase.label} rejection leaves the prior owned portrait intact`,
    );
  }

  const staleMissingCard = await createCard("Stale Missing Portrait NPC");
  const manuallyAssignedAvatar = "/api/avatars/file/manually-assigned.png";
  assert.ok(await charactersStorage.updateAvatar(staleMissingCard.id, manuallyAssignedAvatar));
  const staleMissingChatId = "npc-avatar-generation-stale-missing";
  const staleMissingNpc = {
    id: "npc-stale-missing",
    characterId: staleMissingCard.id,
    name: "Stale Missing Portrait NPC",
    description: "A traveler with a manually assigned portrait.",
    avatarUrl: null,
  };
  await createChat(staleMissingChatId, [staleMissingCard.id], [staleMissingNpc]);
  const { applyFeatureSettingsValue } = await import("../../packages/server/src/services/features/feature-settings.js");
  applyFeatureSettingsValue(JSON.stringify({ gameContactBook: true, campaignPortraits: true }));
  const providerRequestsBeforeStaleMissing = requestCount;
  const staleMissingResponse = await withDeadline(
    app.inject({
      method: "POST",
      url: "/api/game/generate-assets",
      payload: {
        chatId: staleMissingChatId,
        campaignPortraitBatch: true,
        npcsNeedingAvatars: [
          {
            npcId: staleMissingNpc.id,
            characterId: staleMissingCard.id,
            sourceChatId: staleMissingChatId,
            name: staleMissingNpc.name,
            description: staleMissingNpc.description,
          },
        ],
      },
    }),
    "stale missing-contact portrait request",
  );
  assert.equal(staleMissingResponse.statusCode, 200, staleMissingResponse.body);
  assert.deepEqual(staleMissingResponse.json().generatedNpcAvatars, []);
  assert.equal(
    requestCount,
    providerRequestsBeforeStaleMissing,
    "a linked-card portrait skips the stale request before provider work",
  );
  assert.equal(
    (await charactersStorage.getById(staleMissingCard.id))?.avatarPath,
    manuallyAssignedAvatar,
    "the newer manually assigned portrait remains untouched",
  );

  const unlinkedChatId = "npc-avatar-generation-race-unlinked";
  const unlinkedNpcId = "npc-unlinked-race-test";
  const unlinkedNpc = {
    id: unlinkedNpcId,
    name: "Unlinked Race Test NPC",
    description: "A traveler in a weathered blue coat, calm and alert.",
    avatarUrl: `/api/avatars/npc/${unlinkedChatId}/previous.png`,
  };
  await createChat(unlinkedChatId, [], [unlinkedNpc]);
  const unlinkedBody = {
    chatId: unlinkedChatId,
    forceNpcAvatarNames: [`id:${unlinkedNpcId}`],
    npcsNeedingAvatars: [
      {
        npcId: unlinkedNpcId,
        name: unlinkedNpc.name,
        description: unlinkedNpc.description,
      },
    ],
    queueImageGenerationRequests: false,
  };
  const unlinkedRequest = deferNextImageRequest();
  const staleUnlinked = app.inject({ method: "POST", url: "/api/game/generate-assets", payload: unlinkedBody });
  await awaitProvider(staleUnlinked, unlinkedRequest, "unlinked generation start");
  await patchMetadata(unlinkedChatId, { gameNpcs: [{ ...unlinkedNpc, avatarUrl: undefined }] });
  const clearChat = await db.select().from(chats).where(eq(chats.id, unlinkedChatId));
  const clearState = JSON.parse(clearChat[0]!.metadata) as {
    gameNpcs: Array<{ avatarUrl?: string | null; avatarState?: unknown }>;
  };
  assert.equal(clearState.gameNpcs[0]?.avatarUrl, null);
  assert.deepEqual(clearState.gameNpcs[0]?.avatarState, { revision: 1, removed: true });
  unlinkedRequest.release(imageResponse());
  const staleUnlinkedResponse = await withDeadline(staleUnlinked, "stale unlinked generation completion");
  assert.equal(staleUnlinkedResponse.statusCode, 200, staleUnlinkedResponse.body);
  assert.deepEqual(staleUnlinkedResponse.json().generatedNpcAvatars, []);
  assert.deepEqual(portraitFiles(unlinkedChatId), []);

  const freshUnlinked = await withDeadline(
    app.inject({
      method: "POST",
      url: "/api/game/generate-assets",
      payload: {
        ...unlinkedBody,
        npcsNeedingAvatars: [{ ...unlinkedBody.npcsNeedingAvatars[0], npcId: "  " + unlinkedNpcId + "  " }],
      },
    }),
    "fresh unlinked generation with padded NPC ID",
  );
  assert.equal(freshUnlinked.statusCode, 200, freshUnlinked.body);
  assert.deepEqual(freshUnlinked.json().generatedNpcAvatars[0]?.avatarState, { revision: 2, removed: false });

  const syncFailureCard = await createCard("Sync Failure Race NPC");
  const syncFailureChatId = "npc-avatar-generation-race-sync-failure";
  const syncFailureNpcId = "npc-sync-failure-race-test";
  const syncFailureNpc = {
    id: syncFailureNpcId,
    characterId: syncFailureCard.id,
    name: "Sync Failure Race NPC",
    description: "A traveler in a weathered blue coat, calm and alert.",
    avatarUrl: null,
  };
  await createChat(syncFailureChatId, [syncFailureCard.id], [syncFailureNpc]);
  const syncFailureBody = {
    chatId: syncFailureChatId,
    forceNpcAvatarNames: [`id:${syncFailureNpcId}`],
    npcsNeedingAvatars: [
      {
        npcId: syncFailureNpcId,
        characterId: syncFailureCard.id,
        name: syncFailureNpc.name,
        description: syncFailureNpc.description,
      },
    ],
    queueImageGenerationRequests: false,
  };
  const syncFailureRequest = deferNextImageRequest();
  const syncFailureGeneration = app.inject({
    method: "POST",
    url: "/api/game/generate-assets",
    payload: syncFailureBody,
  });
  await awaitProvider(syncFailureGeneration, syncFailureRequest, "linked generation before chat-sync failure");
  const databaseWithUpdate = db as unknown as { update: (table: unknown) => unknown };
  const originalDatabaseUpdate = databaseWithUpdate.update;
  let threwDuringChatSync = false;
  databaseWithUpdate.update = function (table: unknown) {
    if (!threwDuringChatSync && table === chats) {
      threwDuringChatSync = true;
      throw new Error("injected one-shot linked-chat sync failure");
    }
    return originalDatabaseUpdate.call(db, table);
  };
  let syncFailureResponse: Awaited<typeof syncFailureGeneration>;
  try {
    syncFailureRequest.release(imageResponse());
    syncFailureResponse = await withDeadline(syncFailureGeneration, "linked generation after chat-sync failure");
  } finally {
    databaseWithUpdate.update = originalDatabaseUpdate;
  }
  assert.equal(threwDuringChatSync, true, "the one-shot storage fault reaches linked-chat synchronization");
  assert.equal(syncFailureResponse.statusCode, 200, syncFailureResponse.body);
  assert.deepEqual(
    syncFailureResponse.json().generatedNpcAvatars,
    [],
    "a generation with ambiguous post-commit sync failure is not reported as delivered",
  );
  const committedSyncFailureAvatar = (await charactersStorage.getById(syncFailureCard.id))?.avatarPath;
  assert.ok(committedSyncFailureAvatar, "the character assignment committed before linked-chat synchronization failed");
  assert.ok(committedSyncFailureAvatar.startsWith(`/api/avatars/npc/${syncFailureChatId}/`));
  assert.equal(
    portraitFiles(syncFailureChatId).length,
    1,
    "the generated file remains available for the committed character reference",
  );

  const cachedCard = await createCard("Cached Clear Test NPC");
  const cachedChatId = "npc-avatar-generation-race-cached-clear";
  const cachedNpcId = "npc-cached-clear";
  const cachedDescription = "A traveler in a weathered green coat, calm and alert.";
  const campaignArtStyle = {
    useCampaignArtStyle: true,
    artStylePrompt: "Stylized 2.5D painterly fantasy portrait with visible brushwork and warm rim light.",
  };
  const configuredPortraitStyle = resolveGameSetupArtStylePrompt(campaignArtStyle);
  const cachedNpc = {
    id: cachedNpcId,
    characterId: cachedCard.id,
    name: "Cached Clear Test NPC",
    description: cachedDescription,
    descriptionSource: "user",
    avatarUrl: null,
  };
  await createChat(cachedChatId, [cachedCard.id], [cachedNpc]);
  const cachedGenerationBody = {
    chatId: cachedChatId,
    imageConnectionId: imageConnection.id,
    npcsNeedingAvatars: [
      {
        npcId: cachedNpcId,
        characterId: cachedCard.id,
        name: cachedNpc.name,
        description: cachedDescription,
      },
    ],
    queueImageGenerationRequests: false,
  };
  const cachedCampaignGenerationBody = {
    ...cachedGenerationBody,
    campaignPortraitBatch: true,
    npcPortraitStylePrompt: configuredPortraitStyle,
    npcsNeedingAvatars: cachedGenerationBody.npcsNeedingAvatars.map((npc) => ({
      ...npc,
      sourceChatId: cachedChatId,
    })),
  };
  const cachedRequestCount = requestCount;
  const initialCachedPortrait = await withDeadline(
    app.inject({
      method: "POST",
      url: "/api/game/generate-assets",
      payload: { ...cachedGenerationBody, forceNpcAvatarNames: [cachedNpc.name] },
    }),
    "initial cached portrait generation",
  );
  assert.equal(initialCachedPortrait.statusCode, 200, initialCachedPortrait.body);
  assert.equal(requestCount, cachedRequestCount + 1, "initial portrait reaches the mocked image provider");
  assert.ok((await charactersStorage.getById(cachedCard.id))?.avatarPath);
  await patchMetadata(cachedChatId, {
    gameId: "portrait-campaign-current",
    gameSetupConfig: campaignArtStyle,
    gameNpcs: [{ ...cachedNpc, descriptionSource: "observed", observedDescription: cachedDescription }],
  });
  const unremovedPreview = await app.inject({
    method: "POST",
    url: "/api/game/generate-assets/preview",
    payload: cachedCampaignGenerationBody,
  });
  assert.equal(unremovedPreview.statusCode, 200, unremovedPreview.body);
  assert.equal(
    unremovedPreview.json().items.some((item: { kind?: string }) => item.kind === "portrait"),
    false,
  );

  const cachedDeletion = await withDeadline(
    app.inject({
      method: "DELETE",
      url: "/api/characters/" + cachedCard.id + "/avatar",
    }),
    "cached portrait clear",
  );
  assert.equal(cachedDeletion.statusCode, 200, cachedDeletion.body);
  assert.deepEqual(cachedDeletion.json().avatarState, { revision: 2, removed: true });
  assert.equal((await charactersStorage.getById(cachedCard.id))?.avatarPath, null);
  const regeneratedCandidate = {
    ...cachedGenerationBody.npcsNeedingAvatars[0],
    sourceChatId: cachedChatId,
    avatarState: cachedDeletion.json().avatarState,
  };
  const explicitBatches = buildCampaignPortraitBatches(
    [regeneratedCandidate],
    new Map([
      [`id:${cachedNpcId}`, `/api/avatars/npc/${cachedChatId}/stale.png`],
      [normalizeSceneAssetNameForGeneration(cachedNpc.name), `/api/avatars/npc/${cachedChatId}/stale.png`],
    ]),
    configuredPortraitStyle,
  );
  assert.equal(explicitBatches.length, 1, "explicit Generate missing includes a tombstoned current-campaign portrait");
  const regeneratedCampaignBody = {
    ...cachedCampaignGenerationBody,
    npcPortraitStylePrompt: explicitBatches[0]!.stylePrompt,
    npcsNeedingAvatars: explicitBatches[0]!.candidates,
  };
  assert.equal(
    buildMissingSceneAssetGenerationPayload({
      gameImageGenerationEnabled: true,
      activeChatId: cachedChatId,
      currentBackground: null,
      savedSceneBackground: undefined,
      assetMap: null,
      sceneAssetNpcs: [regeneratedCandidate],
      npcAvatarLookup: new Map([
        [normalizeSceneAssetNameForGeneration(cachedNpc.name), `/api/avatars/npc/${cachedChatId}/stale.png`],
      ]),
      npcsNeedingAvatars: [regeneratedCandidate],
    }),
    null,
    "the same cleared portrait remains suppressed in passive missing-asset recovery",
  );
  const removedPreview = await app.inject({
    method: "POST",
    url: "/api/game/generate-assets/preview",
    payload: regeneratedCampaignBody,
  });
  assert.equal(removedPreview.statusCode, 200, removedPreview.body);
  assert.equal(
    removedPreview.json().items.some((item: { kind?: string }) => item.kind === "portrait"),
    true,
  );

  const regeneratedCachedPortrait = await withDeadline(
    app.inject({
      method: "POST",
      url: "/api/game/generate-assets",
      payload: regeneratedCampaignBody,
    }),
    "post-clear cached portrait generation",
  );
  assert.equal(regeneratedCachedPortrait.statusCode, 200, regeneratedCachedPortrait.body);
  assert.equal(
    requestCount,
    cachedRequestCount + 2,
    "a cleared canonical portrait bypasses the retained identity cache and reaches the provider again",
  );
  assert.ok(
    lastImagePrompt.includes(configuredPortraitStyle.replace(/[.,;:]+$/u, "")),
    "provider prompt retains the campaign's configured art style",
  );
  const regeneratedCachedUrl = regeneratedCachedPortrait.json().generatedNpcAvatars[0]?.avatarUrl as string;
  assert.ok(regeneratedCachedUrl);
  assert.equal(
    (await charactersStorage.getById(cachedCard.id))?.avatarPath,
    regeneratedCachedUrl,
    "the linked card stores the same versioned URL returned to the NPC",
  );
  const cachedAvatarResponse = await app.inject({ method: "GET", url: regeneratedCachedUrl });
  assert.equal(cachedAvatarResponse.statusCode, 200, cachedAvatarResponse.body);
  assert.match(cachedAvatarResponse.headers["cache-control"] ?? "", /no-cache.*must-revalidate/u);

  const unrelatedCampaignChatId = "npc-avatar-generation-race-unrelated-campaign";
  const unrelatedCampaignNpc = {
    id: "npc-unrelated-campaign",
    name: "Unrelated Campaign NPC",
    description: "A traveler in a weathered green coat, calm and alert.",
  };
  await createChat(unrelatedCampaignChatId, [], [unrelatedCampaignNpc]);
  await patchMetadata(unrelatedCampaignChatId, { gameId: "portrait-campaign-unrelated" });
  const beforeUnrelatedCampaignExecution = requestCount;
  const unrelatedCampaignResponse = await app.inject({
    method: "POST",
    url: "/api/game/generate-assets",
    payload: {
      ...regeneratedCampaignBody,
      npcsNeedingAvatars: [
        {
          npcId: unrelatedCampaignNpc.id,
          sourceChatId: unrelatedCampaignChatId,
          name: unrelatedCampaignNpc.name,
          description: unrelatedCampaignNpc.description,
        },
      ],
    },
  });
  assert.equal(unrelatedCampaignResponse.statusCode, 400, unrelatedCampaignResponse.body);
  assert.equal(
    requestCount,
    beforeUnrelatedCampaignExecution,
    "another campaign's portrait never reaches the provider",
  );

  const foreignRemovedCard = await createCard("Foreign Removed Card");
  const foreignClear = await app.inject({
    method: "DELETE",
    url: "/api/characters/" + foreignRemovedCard.id + "/avatar",
  });
  assert.equal(foreignClear.statusCode, 200, foreignClear.body);
  assert.deepEqual(foreignClear.json().avatarState, { revision: 1, removed: true });
  const foreignCandidateChatId = "npc-avatar-preview-foreign-card";
  const foreignCandidateNpc = {
    id: "npc-foreign-card-candidate",
    name: "Unlinked Foreign Candidate",
    description: "A traveler in a weathered blue coat, calm and alert.",
    descriptionSource: "user",
    avatarUrl: null,
  };
  await createChat(foreignCandidateChatId, [], [foreignCandidateNpc]);
  const foreignCandidateBody = {
    chatId: foreignCandidateChatId,
    imageConnectionId: imageConnection.id,
    campaignPortraitBatch: true,
    queueImageGenerationRequests: false,
    npcsNeedingAvatars: [
      {
        npcId: foreignCandidateNpc.id,
        sourceChatId: foreignCandidateChatId,
        characterId: foreignRemovedCard.id,
        name: foreignCandidateNpc.name,
        description: foreignCandidateNpc.description,
      },
    ],
  };
  const foreignCandidatePreview = await app.inject({
    method: "POST",
    url: "/api/game/generate-assets/preview",
    payload: foreignCandidateBody,
  });
  assert.equal(foreignCandidatePreview.statusCode, 400, foreignCandidatePreview.body);
  assert.match(foreignCandidatePreview.body, /identity does not match the current campaign/i);
  const beforeForeignCandidateExecution = requestCount;
  const foreignCandidateExecution = await app.inject({
    method: "POST",
    url: "/api/game/generate-assets",
    payload: foreignCandidateBody,
  });
  assert.equal(foreignCandidateExecution.statusCode, 400, foreignCandidateExecution.body);
  assert.match(foreignCandidateExecution.body, /identity does not match the current campaign/i);
  assert.equal(
    requestCount,
    beforeForeignCandidateExecution,
    "execution rejects the same foreign linked-card identity",
  );

  const duplicateNameChatId = "npc-avatar-preview-duplicate-name";
  const duplicateName = "Duplicate Name NPC";
  await createChat(
    duplicateNameChatId,
    [],
    [
      {
        id: "npc-duplicate-name-first",
        name: duplicateName,
        description: "A traveler in a weathered blue coat, calm and alert.",
        descriptionSource: "user",
        avatarUrl: null,
        avatarState: { revision: 1, removed: true },
      },
      {
        id: "npc-duplicate-name-second",
        name: duplicateName,
        description: "A traveler in a weathered blue coat, calm and alert.",
        descriptionSource: "user",
        avatarUrl: null,
      },
    ],
  );
  const duplicateNameBody = {
    chatId: duplicateNameChatId,
    imageConnectionId: imageConnection.id,
    queueImageGenerationRequests: false,
    npcsNeedingAvatars: [
      {
        name: duplicateName,
        description: "A traveler in a weathered blue coat, calm and alert.",
      },
    ],
  };
  const duplicateNamePreview = await app.inject({
    method: "POST",
    url: "/api/game/generate-assets/preview",
    payload: duplicateNameBody,
  });
  assert.equal(duplicateNamePreview.statusCode, 200, duplicateNamePreview.body);
  assert.equal(
    duplicateNamePreview.json().items.some((item: { kind?: string }) => item.kind === "portrait"),
    false,
    "preview skips an ambiguous name just as execution does",
  );
  const beforeDuplicateNameExecution = requestCount;
  const duplicateNameExecution = await app.inject({
    method: "POST",
    url: "/api/game/generate-assets",
    payload: duplicateNameBody,
  });
  assert.equal(duplicateNameExecution.statusCode, 200, duplicateNameExecution.body);
  assert.deepEqual(duplicateNameExecution.json().generatedNpcAvatars, []);
  assert.equal(requestCount, beforeDuplicateNameExecution, "execution skips ambiguous duplicate NPC names");

  assert.equal(requestCount, 12, "all generation requests reached only the strict mocked image endpoint");
  console.log("game-npc-avatar-generation-race regression passed");
} finally {
  releasePendingImageResponse?.(
    new Response(JSON.stringify({ error: { message: "fixture cleanup" } }), { status: 500 }),
  );
  globalThis.fetch = originalFetch;
  await app?.close();
  await closeDB?.();
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dataDir, { recursive: true, force: true });
}
