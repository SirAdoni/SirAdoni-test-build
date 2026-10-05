import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "marinara-faction-web-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { chats } = await import("../../packages/server/src/db/schema/index.js");
  const { campaignMemoryRoutes } = await import("../../packages/server/src/routes/campaign-memory.routes.js");
  const { campaignMemoryWriteRoutes } =
    await import("../../packages/server/src/routes/campaign-memory-write.routes.js");
  const { createCampaignMemoryStorage } =
    await import("../../packages/server/src/services/storage/campaign-memory.storage.js");
  const { applyFeatureSettingsValue } = await import("../../packages/server/src/services/features/feature-settings.js");
  const { requireCampaignSurface } =
    await import("../../packages/server/src/services/features/campaign-surface-opt-in.js");
  const { applyCampaignMemoryMutation, compensateCampaignMemoryMutation } =
    await import("../../packages/server/src/services/game/campaign-memory-mutations.js");
  const { campaignMemoryRelationshipKindError } =
    await import("../../packages/server/src/services/game/campaign-memory-relationship-kinds.js");
  for (const type of [
    "stranger-to",
    "acquaintance-of",
    "neutral-toward",
    "suspicious-of",
    "arch-nemesis-of",
    "eternal-ally-of",
    "adoptive-parent-of",
    "guardian-of",
    "partner-of",
    "relative-of",
  ]) {
    assert.equal(campaignMemoryRelationshipKindError(type, "character", "persona"), null);
    assert.notEqual(campaignMemoryRelationshipKindError(type, "organization", "organization"), null);
    assert.notEqual(campaignMemoryRelationshipKindError(type, "character", "location"), null);
  }
  assert.equal(campaignMemoryRelationshipKindError("neutral-faction-toward", "organization", "organization"), null);
  assert.notEqual(campaignMemoryRelationshipKindError("neutral-faction-toward", "character", "persona"), null);
  const db = await createFileNativeDB();
  const now = new Date().toISOString();
  for (const id of ["factions", "other"])
    await db.insert(chats).values({ id, name: id, mode: "game", characterIds: "[]", createdAt: now, updatedAt: now });
  const storage = createCampaignMemoryStorage(db);
  for (const [id, chatId] of [
    ["north", "factions"],
    ["south", "factions"],
    ["foreign", "other"],
  ]) {
    await storage.createEntity({
      chatId,
      entityId: id,
      kind: "organization",
      owner: { type: "registry", store: "campaign-memory", recordId: id },
      aliases: [id],
      tags: [],
      attributes: {},
      status: "active",
      manualLock: false,
      provenance: { actor: "user", source: "fixture", sourceRevision: "1" },
    });
  }
  const app = requireServer("fastify")();
  app.decorate("db", db);
  await app.register(campaignMemoryRoutes, { prefix: "/api/game" });
  await app.register(campaignMemoryWriteRoutes, { prefix: "/api/game" });
  const post = (payload: unknown) =>
    app.inject({ method: "POST", url: "/api/game/factions/memory/mutations", payload });
  const create = {
    action: "create",
    recordType: "relationship",
    operationId: "create",
    reason: "explicit alliance",
    input: {
      sourceEntityId: "north",
      targetEntityId: "south",
      type: "allied-with",
      inverseLabel: "allied-with",
      status: "active",
      notes: "Trade treaty",
      manualLock: false,
    },
  };
  applyFeatureSettingsValue("{}");
  let response = await post(create);
  assert.equal(response.statusCode, 403, "Campaign memory is off by default");
  applyFeatureSettingsValue(JSON.stringify({ campaignMemory: true, campaignWiki: true }));
  response = await post(create);
  assert.equal(response.statusCode, 403, "Wiki writes cannot create faction data without Faction Web enabled");
  applyFeatureSettingsValue(JSON.stringify({ campaignMemory: true, campaignWiki: true, factionWeb: true }));
  response = await post(create);
  assert.equal(response.statusCode, 200, response.body);
  const relation = response.json();
  assert.equal(relation.notes, "Trade treaty");
  assert.equal(relation.provenance.actor, "user");
  assert.equal((await storage.getRelationship({ chatId: "factions" }, relation.relationshipId))?.notes, "Trade treaty");
  const get = (query = "") =>
    app.inject({ method: "GET", url: `/api/game/factions/memory/factions?entityId=north${query}` });
  response = await get();
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().relationships.total, 1);
  assert.equal(response.json().relationships.items[0].sourceEntityId, "north");
  assert.deepEqual(
    response
      .json()
      .entities.map((e: { entityId: string }) => e.entityId)
      .sort(),
    ["north", "south"],
  );
  assert.equal((await get("&offset=1")).json().relationships.items.length, 0);
  assert.equal((await get("&limit=999")).statusCode, 400);
  assert.equal(
    (await app.inject({ method: "GET", url: "/api/game/other/memory/factions?entityId=north" })).statusCode,
    404,
  );
  assert.equal(
    (await post({ ...create, operationId: "foreign", input: { ...create.input, targetEntityId: "foreign" } }))
      .statusCode,
    404,
    "Out-of-scope endpoints are not visible to authoring",
  );
  assert.equal(
    (await post({ ...create, operationId: "oversize", input: { ...create.input, notes: "x".repeat(20001) } }))
      .statusCode,
    400,
  );
  const update = {
    action: "update",
    recordType: "relationship",
    recordId: relation.relationshipId,
    expectedRevision: 1,
    operationId: "edit",
    reason: "Treaty ended",
    patch: { notes: "No longer trading", status: "ended", manualLock: true },
  };
  const escapeFactionSurface = {
    ...update,
    operationId: "escape",
    patch: { type: "part-of" },
  };
  applyFeatureSettingsValue(JSON.stringify({ campaignMemory: true, campaignWiki: true }));
  response = await post(escapeFactionSurface);
  assert.equal(response.statusCode, 403, "The generic Wiki route cannot edit a faction record when Faction Web is off");
  applyFeatureSettingsValue(JSON.stringify({ campaignMemory: true, factionWeb: true }));
  response = await app.inject({
    method: "POST",
    url: "/api/game/factions/memory/factions/mutations",
    payload: escapeFactionSurface,
  });
  assert.equal(
    response.statusCode,
    400,
    "The Faction Web route cannot convert a faction record to generic organization/location data",
  );
  const unchangedFaction = await storage.getRelationship({ chatId: "factions" }, relation.relationshipId);
  assert.equal(unchangedFaction?.type, "allied-with");
  assert.equal(unchangedFaction?.targetEntityId, "south");
  applyFeatureSettingsValue(JSON.stringify({ campaignMemory: true, campaignWiki: true, factionWeb: true }));
  response = await post(update);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().manualLock, true, "Explicit manual editing protects the relationship");
  assert.equal((await post({ ...update, operationId: "stale" })).statusCode, 409);
  assert.equal((await get()).json().relationships.total, 0);
  assert.equal((await get("&includeEnded=true")).json().relationships.items[0].notes, "No longer trading");
  response = await app.inject({
    method: "GET",
    url: `/api/game/factions/memory/audit?recordId=${relation.relationshipId}`,
  });
  const edit = response.json().items.find((row: { operationId: string }) => row.operationId === "edit");
  assert.equal(response.json().items[0].operationId, "edit", "History shows the latest change first");
  assert.equal(edit.before.notes, "Trade treaty");
  assert.equal(edit.after.notes, "No longer trading");
  assert.ok(response.json().items.every((row: { recordId: string }) => row.recordId === relation.relationshipId));
  applyFeatureSettingsValue(JSON.stringify({ campaignMemory: true, campaignWiki: true, factionWeb: true }));
  const blockedCompensation = compensateCampaignMemoryMutation(
    db,
    {
      chatId: "factions",
      operationId: "undo-disabled-during-validation",
      originalOperationId: "edit",
      actor: "user",
      reason: "Compensation write-admission race regression",
    },
    () => {
      applyFeatureSettingsValue("{}");
      requireCampaignSurface("campaignMemory", "campaignWiki", "factionWeb");
    },
  );
  await assert.rejects(blockedCompensation, { code: "FEATURE_DISABLED" });
  assert.equal(
    (await storage.getRelationship({ chatId: "factions" }, relation.relationshipId))?.notes,
    "No longer trading",
  );
  assert.equal(
    (await storage.listMutationJournal({ chatId: "factions" })).some(
      (row: { operationId: string }) => row.operationId === "undo-disabled-during-validation",
    ),
    false,
    "A disabled feature leaves neither the compensated record nor its journal entry",
  );
  applyFeatureSettingsValue(JSON.stringify({ campaignMemory: true, campaignWiki: true, factionWeb: true }));

  response = await app.inject({
    method: "POST",
    url: "/api/game/factions/memory/mutations/compensate",
    payload: { operationId: "undo", originalOperationId: "edit", reason: "Restore treaty" },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().notes, "Trade treaty");
  assert.equal(response.json().manualLock, false, "Undo restores the previous lock state");
  for (const type of ["rival-faction-of", "subordinate-to", "neutral-faction-toward"]) {
    response = await post({ ...create, operationId: type, input: { ...create.input, type, status: "proposed" } });
    assert.equal(response.statusCode, 200, response.body);
  }
  assert.equal((await get()).json().relationships.total, 4, "Explicit types remain separate directed records");
  const { notes: _notes, ...legacyInput } = create.input;
  response = await post({ ...create, operationId: "legacy", input: legacyInput });
  const legacy = response.json();
  assert.equal(legacy.notes, undefined, "Old records need no notes migration");
  response = await post({
    ...update,
    operationId: "legacy-add-note",
    recordId: legacy.relationshipId,
    patch: { notes: "New note" },
  });
  assert.equal(response.statusCode, 200, response.body);
  response = await app.inject({
    method: "POST",
    url: "/api/game/factions/memory/mutations/compensate",
    payload: { operationId: "legacy-undo", originalOperationId: "legacy-add-note", reason: "Remove added note" },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal((await storage.getRelationship({ chatId: "factions" }, legacy.relationshipId))?.notes, undefined);
  applyFeatureSettingsValue(JSON.stringify({ campaignMemory: true, campaignWiki: true }));
  const raceWrite = applyCampaignMemoryMutation(
    db,
    {
      chatId: "factions",
      operationId: "disabled-during-validation",
      actor: "user",
      reason: "Write-admission race regression",
      recordType: "entity",
      action: "create",
      input: {
        chatId: "factions",
        entityId: "race-blocked",
        kind: "note",
        owner: { type: "registry", store: "campaign-memory", recordId: "race-blocked" },
        aliases: ["race-blocked"],
        tags: [],
        attributes: {},
        status: "active",
        manualLock: false,
        provenance: { actor: "user", source: "fixture", sourceRevision: "1" },
      },
    },
    () => requireCampaignSurface("campaignMemory", "campaignWiki"),
  );
  applyFeatureSettingsValue("{}");
  await assert.rejects(raceWrite, { code: "FEATURE_DISABLED" });
  assert.equal(await storage.getEntity({ chatId: "factions" }, "race-blocked"), null);
  assert.equal(
    (await storage.listMutationJournal({ chatId: "factions" })).some(
      (row: { operationId: string }) => row.operationId === "disabled-during-validation",
    ),
    false,
    "A disabled feature leaves neither the record nor its journal entry",
  );

  await app.close();
  console.log(
    "Faction web persistence, write-time feature admission, direction, scope, notes, CAS, history and compensation passed",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
