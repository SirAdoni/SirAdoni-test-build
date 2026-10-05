import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "marinara-memory-controls-"));
process.env.DATA_DIR = dir;
process.env.FILE_STORAGE_DIR = join(dir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
process.env.LOG_LEVEL = "silent";

const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify") as typeof import("fastify").default;
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { gameContinuityRoutes } = await import("../../packages/server/src/routes/game-continuity.routes.js");
const { chatsRoutes } = await import("../../packages/server/src/routes/chats.routes.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { applyFeatureSettingsValue } = await import("../../packages/server/src/services/features/feature-settings.js");
const { isCampaignMemoryRecallEnabled, wasOptionalMemoryPromptDisabled } =
  await import("../../packages/server/src/services/features/campaign-opt-in.js");
const { appendGameGmCampaignMemoryIfEnabled, limitGameGmSessionSummaries, projectGameGmSessionSummaries } =
  await import("../../packages/server/src/services/generation/game-gm-prompt-runtime.js");
const { keeperDisabledByContinuity } = await import("../../packages/server/src/services/game/continuity-ownership.js");

function setFeatureSettings(settings: Record<string, boolean>): void {
  applyFeatureSettingsValue(JSON.stringify(settings));
}

const db = await getDB();
const chats = createChatsStorage(db);
const app = Fastify();
app.decorate("db", db);
await app.register(gameContinuityRoutes, { prefix: "/api/game" });
await app.register(chatsRoutes, { prefix: "/api/chats" });

try {
  const chat = (await chats.create({
    name: "Memory controls fixture",
    mode: "game",
    characterIds: [],
    connectionId: null,
    promptPresetId: null,
  }))!;
  setFeatureSettings({ gameContinuity: true });
  const savedPrompt = "Historical GM prompt bytes\n  preserve spacing exactly.  ";
  const originalSummaries = [
    { sessionNumber: 3, summary: "third" },
    { sessionNumber: 1, summary: "first" },
    { sessionNumber: 2, summary: "second" },
  ];
  await chats.patchMetadata(chat.id, {
    customGmPrompt: savedPrompt,
    gamePreviousSessionSummaries: originalSummaries,
    gameContinuity: { mode: "active" },
  });
  const message = await chats.createMessage({ chatId: chat.id, role: "system", content: savedPrompt });
  const originalMetadata = JSON.parse((await chats.getById(chat.id))!.metadata as string);

  const controlsOffOwnershipResponse = await app.inject({
    method: "PATCH",
    url: `/api/game/${chat.id}/continuity`,
    payload: { ownership: { lorebook: "continuity", fromSession: 2 } },
  });
  assert.equal(controlsOffOwnershipResponse.statusCode, 403);
  assert.deepEqual(JSON.parse((await chats.getById(chat.id))!.metadata as string), originalMetadata);
  const controlsOffNestedOwnershipResponse = await app.inject({
    method: "PATCH",
    url: `/api/chats/${chat.id}/metadata`,
    payload: { gameContinuity: { mode: "active", ownership: { lorebook: "continuity", fromSession: 2 } } },
  });
  assert.equal(controlsOffNestedOwnershipResponse.statusCode, 403);
  assert.deepEqual(JSON.parse((await chats.getById(chat.id))!.metadata as string), originalMetadata);
  const controlsOffMetadataResponse = await app.inject({
    method: "PATCH",
    url: `/api/chats/${chat.id}/metadata`,
    payload: { gamePromptRecentSessionLimit: 2 },
  });
  assert.equal(controlsOffMetadataResponse.statusCode, 403);
  assert.deepEqual(JSON.parse((await chats.getById(chat.id))!.metadata as string), originalMetadata);

  setFeatureSettings({ gameContinuity: true, gameMemoryControls: true });
  const invalidPayloads = [
    { ownership: { lorebook: "unknown", fromSession: 2 } },
    { ownership: { lorebook: "keeper", fromSession: 0 } },
    { ownership: { lorebook: "keeper", fromSession: 2 }, extra: true },
  ];
  for (const payload of invalidPayloads) {
    const response = await app.inject({ method: "PATCH", url: `/api/game/${chat.id}/continuity`, payload });
    assert.equal(response.statusCode, 400, response.body);
    assert.deepEqual(JSON.parse((await chats.getById(chat.id))!.metadata as string), originalMetadata);
  }
  const missingChatResponse = await app.inject({
    method: "PATCH",
    url: "/api/game/missing-memory-controls-chat/continuity",
    payload: { ownership: { lorebook: "keeper", fromSession: 2 } },
  });
  assert.equal(missingChatResponse.statusCode, 404);
  const nonGameChat = await chats.create({
    name: "Not a game",
    mode: "roleplay",
    characterIds: [],
    connectionId: null,
    promptPresetId: null,
  });
  assert.ok(nonGameChat);
  const nonGameMetadataBefore = JSON.parse((await chats.getById(nonGameChat.id))!.metadata as string);
  setFeatureSettings({ gameContinuity: true, gameMemoryControls: true });
  const wrongModeResponse = await app.inject({
    method: "PATCH",
    url: `/api/game/${nonGameChat.id}/continuity`,
    payload: { ownership: { lorebook: "keeper", fromSession: 2 } },
  });
  assert.equal(wrongModeResponse.statusCode, 400);
  assert.deepEqual(JSON.parse((await chats.getById(nonGameChat.id))!.metadata as string), nonGameMetadataBefore);

  setFeatureSettings({ gameMemoryControls: true });
  const continuityOffResponse = await app.inject({
    method: "PATCH",
    url: `/api/game/${chat.id}/continuity`,
    payload: { ownership: { lorebook: "continuity", fromSession: 2 } },
  });
  assert.equal(continuityOffResponse.statusCode, 403);
  assert.deepEqual(JSON.parse((await chats.getById(chat.id))!.metadata as string), originalMetadata);
  const continuityOffNestedOwnershipResponse = await app.inject({
    method: "PATCH",
    url: `/api/chats/${chat.id}/metadata`,
    payload: { gameContinuity: { mode: "active", ownership: { lorebook: "continuity", fromSession: 2 } } },
  });
  assert.equal(continuityOffNestedOwnershipResponse.statusCode, 403);
  assert.deepEqual(JSON.parse((await chats.getById(chat.id))!.metadata as string), originalMetadata);

  setFeatureSettings({ gameContinuity: true, gameMemoryControls: true });
  const controlsOnMetadataResponse = await app.inject({
    method: "PATCH",
    url: `/api/chats/${chat.id}/metadata`,
    payload: { gamePromptRecentSessionLimit: 2, gameCampaignMemoryScope: "session" },
  });
  assert.equal(controlsOnMetadataResponse.statusCode, 200, controlsOnMetadataResponse.body);
  const controlsOnMetadata = JSON.parse((await chats.getById(chat.id))!.metadata as string);
  assert.equal(controlsOnMetadata.gamePromptRecentSessionLimit, 2);
  assert.equal(controlsOnMetadata.gameCampaignMemoryScope, "session");

  const ownershipResponse = await app.inject({
    method: "PATCH",
    url: `/api/game/${chat.id}/continuity`,
    payload: { ownership: { lorebook: "continuity", fromSession: 2 } },
  });
  assert.equal(ownershipResponse.statusCode, 200, ownershipResponse.body);
  assert.equal(
    (await chats.getById(chat.id))?.metadata &&
      JSON.parse((await chats.getById(chat.id))!.metadata as string).customGmPrompt,
    savedPrompt,
  );
  assert.deepEqual(
    JSON.parse((await chats.getById(chat.id))!.metadata as string).gamePreviousSessionSummaries,
    originalSummaries,
  );
  assert.equal((await chats.listMessages(chat.id)).find((row) => row.id === message.id)?.content, savedPrompt);

  const statusResponse = await app.inject({ method: "GET", url: `/api/game/${chat.id}/continuity` });
  assert.equal(statusResponse.statusCode, 200, statusResponse.body);
  assert.deepEqual(statusResponse.json().config.ownership, { lorebook: "continuity", fromSession: 2 });
  assert.equal(statusResponse.json().config.mode, "active");
  applyFeatureSettingsValue(JSON.stringify({ gameContinuity: true }));
  const baselineMetadataResponse = await app.inject({
    method: "PATCH",
    url: `/api/chats/${chat.id}/metadata`,
    payload: { unrelatedExistingMetadata: "still writable" },
  });
  assert.equal(baselineMetadataResponse.statusCode, 200, baselineMetadataResponse.body);
  assert.equal(
    JSON.parse((await chats.getById(chat.id))!.metadata as string).unrelatedExistingMetadata,
    "still writable",
  );

  assert.equal(
    keeperDisabledByContinuity({
      continuityActive: true,
      ownership: { lorebook: "continuity", fromSession: 2 },
      sessionNumber: 1,
    }),
    false,
  );
  assert.equal(
    keeperDisabledByContinuity({
      continuityActive: true,
      ownership: { lorebook: "continuity", fromSession: 2 },
      sessionNumber: 2,
    }),
    true,
  );
  assert.equal(
    keeperDisabledByContinuity({
      continuityActive: true,
      ownership: { lorebook: "keeper", fromSession: 2 },
      sessionNumber: 3,
    }),
    false,
  );

  const beforeProjection = structuredClone(originalSummaries);
  const promptSummaries = limitGameGmSessionSummaries(originalSummaries, 2);
  assert.deepEqual(
    promptSummaries.map((summary) => summary.sessionNumber),
    [2, 3],
  );
  assert.deepEqual(originalSummaries, beforeProjection, "prompt recap limit must not mutate persisted history");
  assert.equal(limitGameGmSessionSummaries(originalSummaries, null), originalSummaries);
  setFeatureSettings({});
  const controlsOffProjection = projectGameGmSessionSummaries(originalSummaries, 2);
  assert.equal(controlsOffProjection.applied, false, "saved recap limit is ignored while controls are off");
  assert.equal(controlsOffProjection.summaries, originalSummaries);
  setFeatureSettings({ gameMemoryControls: true });
  const controlsOnProjection = projectGameGmSessionSummaries(originalSummaries, 2);
  assert.equal(controlsOnProjection.applied, true);
  assert.deepEqual(
    controlsOnProjection.summaries.map((summary) => summary.sessionNumber),
    [2, 3],
  );

  const campaignMemoryContext = {
    text: "private campaign fact",
    includedIds: ["memory-1"],
    exclusions: [],
    degraded: false,
  } as Parameters<typeof appendGameGmCampaignMemoryIfEnabled>[1];
  const disabledMemoryMessages: Array<{ role: "system"; content: string }> = [];
  setFeatureSettings({ campaignMemory: true });
  assert.equal(appendGameGmCampaignMemoryIfEnabled(disabledMemoryMessages, campaignMemoryContext), false);
  assert.equal(disabledMemoryMessages.length, 0, "recall OFF omits both the projection and its warning block");

  setFeatureSettings({ gameMemoryControls: true, campaignMemoryRecall: true });
  assert.equal(isCampaignMemoryRecallEnabled(), false, "recall requires the independent campaign memory switch");
  assert.equal(wasOptionalMemoryPromptDisabled({ memoryControlsApplied: false, campaignMemoryApplied: true }), true);
  setFeatureSettings({ gameMemoryControls: true, campaignMemory: true, campaignMemoryRecall: true });
  assert.equal(isCampaignMemoryRecallEnabled(), true);
  const enabledMemoryMessages: Array<{ role: "system"; content: string }> = [];
  assert.equal(appendGameGmCampaignMemoryIfEnabled(enabledMemoryMessages, campaignMemoryContext), true);
  assert.equal(enabledMemoryMessages.length, 1);
  assert.equal(wasOptionalMemoryPromptDisabled({ memoryControlsApplied: false, campaignMemoryApplied: true }), false);
  setFeatureSettings({ campaignMemory: true, campaignMemoryRecall: true });
  assert.equal(
    wasOptionalMemoryPromptDisabled({ memoryControlsApplied: true, campaignMemoryApplied: true }),
    true,
    "turning off controls cancels a request only when its capped recap was already applied",
  );
  const schema = await import("../../packages/server/src/db/schema/index.js");
  for (const request of [
    { url: `/api/game/${chat.id}/continuity`, payload: { ownership: { lorebook: "keeper", fromSession: 9 } } },
    { url: `/api/chats/${chat.id}/metadata`, payload: { gamePromptRecentSessionLimit: 9 } },
    {
      url: `/api/chats/${chat.id}/metadata`,
      payload: { gamePromptRecentSessionLimit: 9, hideSummarisedMessages: true },
    },
  ]) {
    setFeatureSettings({ gameContinuity: true, gameMemoryControls: true });
    const before = (await chats.getById(chat.id))!.metadata;
    const originalSelect = db.select;
    let reads = 0;
    // Disable after the actual queued metadata read, beyond the route's initial gate.
    db.select = ((...args: unknown[]) => {
      const query = (originalSelect as Function)(...args);
      const from = query.from.bind(query);
      query.from = (table: unknown) => {
        const selection = from(table);
        if (table === schema.chats) {
          const then = selection.then.bind(selection);
          selection.then = (resolve: Function, reject: Function) =>
            then((rows: unknown) => {
              if (++reads === 2) setFeatureSettings({ gameContinuity: true });
              return resolve(rows);
            }, reject);
        }
        return selection;
      };
      return query;
    }) as typeof db.select;
    try {
      const response = await app.inject({ method: "PATCH", ...request });
      assert.ok(reads >= 2, "Reached actual metadata write admission after an awaited read");
      assert.equal(response.statusCode, 403, response.body);
    } finally {
      db.select = originalSelect;
    }
    assert.equal((await chats.getById(chat.id))!.metadata, before, "Late OFF leaves all metadata bytes intact");
  }
} finally {
  await app.close();
  await closeDB();
  rmSync(dir, { recursive: true, force: true });
}

console.log(
  "Memory controls update only future prompt projection and ownership metadata; saved prompt/history bytes remain unchanged.",
);
