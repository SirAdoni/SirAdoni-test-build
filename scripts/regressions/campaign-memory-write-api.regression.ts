import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify");
const root = mkdtempSync(join(tmpdir(), "marinara-campaign-memory-write-api-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");

try {
  const { resetFeatureSettingsForTests } =
    await import("../../packages/server/src/services/features/feature-settings.js");
  resetFeatureSettingsForTests({ campaignMemory: true, campaignWiki: true });
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { chats, characters } = await import("../../packages/server/src/db/schema/index.js");
  const { eq } = await import("../../packages/server/src/db/file-query.js");
  const { createCampaignMemoryStorage } =
    await import("../../packages/server/src/services/storage/campaign-memory.storage.js");
  const { campaignMemoryWriteRoutes } =
    await import("../../packages/server/src/routes/campaign-memory-write.routes.js");
  const db = await createFileNativeDB();
  const now = new Date().toISOString();
  await db.insert(chats).values({
    id: "write-chat",
    name: "Write API",
    mode: "game",
    characterIds: JSON.stringify(["write-character"]),
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(chats).values({
    id: "other-write-chat",
    name: "Other",
    mode: "game",
    characterIds: JSON.stringify(["import-character"]),
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(characters).values([
    { id: "write-character", data: "{}", createdAt: now, updatedAt: now },
    { id: "import-character", data: JSON.stringify({ name: "Imported character" }), createdAt: now, updatedAt: now },
  ]);

  const app = Fastify();
  app.decorate("db", db);
  await app.register(campaignMemoryWriteRoutes, { prefix: "/api/game" });
  await app.ready();
  const post = (url: string, payload: unknown) => app.inject({ method: "POST", url, payload });
  const { applyFeatureSettingsValue } = await import("../../packages/server/src/services/features/feature-settings.js");
  applyFeatureSettingsValue(null);
  const base = {
    action: "create",
    recordType: "entity",
    operationId: "write-create-1",
    reason: "register a user-owned note",
    input: {
      entityId: "write-entity",
      kind: "character",
      owner: { type: "existing", store: "characters", recordId: "write-character" },
      aliases: ["A note"],
      tags: [],
      attributes: {},
      status: "active",
      manualLock: false,
    },
  };
  let response = await post("/api/game/write-chat/memory/mutations", base);
  assert.equal(response.statusCode, 403, "Campaign Memory writes are off by default");
  assert.equal(await createCampaignMemoryStorage(db).getEntity({ chatId: "write-chat" }, "write-entity"), null);
  applyFeatureSettingsValue(JSON.stringify({ campaignMemory: true, campaignWiki: true }));

  response = await post("/api/game/write-chat/memory/mutations/preview", base);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().persisted, false);
  assert.equal(
    await createCampaignMemoryStorage(db).getEntity({ chatId: "write-chat" }, "write-entity"),
    null,
    "preview must not persist",
  );

  response = await post("/api/game/write-chat/memory/mutations", { ...base, actor: "system" });
  assert.equal(response.statusCode, 400, "actor is server-derived");
  response = await post("/api/game/write-chat/memory/mutations", {
    ...base,
    chatId: "other-write-chat",
    input: { ...base.input, provenance: { actor: "system" } },
  });
  assert.equal(response.statusCode, 400, "path scope is authoritative and body scope is rejected");
  response = await post("/api/game/write-chat/memory/mutations", base);
  assert.equal(response.statusCode, 200);
  const created = response.json();
  assert.equal(created.provenance.actor, "user");
  assert.equal(created.provenance.source, "user-source");
  await new Promise((resolve) => setTimeout(resolve, 25));
  response = await post("/api/game/write-chat/memory/mutations", base);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), created, "same operation replays exactly once");

  const update = {
    operationId: "write-update-1",
    action: "update",
    recordType: "entity",
    recordId: "write-entity",
    expectedRevision: 1,
    reason: "rename note",
    patch: { aliases: ["Renamed"] },
  };
  response = await post("/api/game/write-chat/memory/mutations", update);
  assert.equal(response.statusCode, 200);
  response = await post("/api/game/write-chat/memory/mutations", { ...update, operationId: "write-update-stale" });
  assert.equal(response.statusCode, 409);
  response = await post("/api/game/write-chat/memory/mutations", {
    operationId: "write-forged-event",
    action: "update",
    recordType: "event",
    recordId: "event-1",
    expectedRevision: 1,
    reason: "edit",
    patch: {},
  });
  assert.equal(response.statusCode, 400, "immutable event is outside the authoring DTO");
  response = await app.inject({ method: "GET", url: "/api/game/write-chat/memory/audit?limit=10" });
  assert.equal(response.statusCode, 200);
  assert.ok(response.json().items.some((item: { operationId: string }) => item.operationId === "write-update-1"));
  response = await app.inject({
    method: "GET",
    url: "/api/game/write-chat/memory/audit?recordId=write-entity&limit=10",
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.ok(response.json().items.some((item: { operationId: string }) => item.operationId === "write-update-1"));
  assert.ok(response.json().items.every((item: { recordId: string }) => item.recordId === "write-entity"));

  // Entity prose notes (body): trimmed on create, revision-checked on update, capped at 20,000, restored by compensation.
  const noteBody = "First draft notes.\nSecond line keeps its newline.";
  const bodyCreate = {
    operationId: "write-body-create",
    action: "create",
    recordType: "entity",
    reason: "register a note with prose",
    input: {
      entityId: "write-body-entity",
      kind: "note",
      owner: { type: "registry", store: "campaign-memory", recordId: "write-body-entity" },
      aliases: ["Body note"],
      tags: [],
      attributes: {},
      status: "active",
      manualLock: false,
      body: `  ${noteBody}  `,
    },
  };
  response = await post("/api/game/write-chat/memory/mutations", bodyCreate);
  assert.equal(response.statusCode, 200, "entity create accepts body");
  assert.equal(response.json().body, noteBody, "body is trimmed and keeps inner newlines");
  assert.equal(
    (await createCampaignMemoryStorage(db).getEntity({ chatId: "write-chat" }, "write-body-entity"))?.body,
    noteBody,
    "body is persisted",
  );
  const bodyUpdate = {
    operationId: "write-body-update",
    action: "update",
    recordType: "entity",
    recordId: "write-body-entity",
    expectedRevision: 1,
    reason: "revise notes",
    patch: { body: "Revised notes." },
  };
  response = await post("/api/game/write-chat/memory/mutations", bodyUpdate);
  assert.equal(response.statusCode, 200, "entity update accepts body");
  assert.equal(response.json().body, "Revised notes.");
  assert.equal(response.json().revision, 2);
  response = await post("/api/game/write-chat/memory/mutations", {
    ...bodyUpdate,
    operationId: "write-body-stale",
    patch: { body: "Stale write." },
  });
  assert.equal(response.statusCode, 409, "body update is revision checked");
  response = await post("/api/game/write-chat/memory/mutations", {
    ...bodyUpdate,
    operationId: "write-body-over-cap",
    expectedRevision: 2,
    patch: { body: "x".repeat(20_001) },
  });
  assert.equal(response.statusCode, 400, "body over 20,000 characters is rejected");
  response = await post("/api/game/write-chat/memory/mutations", {
    ...bodyCreate,
    operationId: "write-body-create-over-cap",
    input: {
      ...bodyCreate.input,
      entityId: "write-body-entity-2",
      owner: { type: "registry", store: "campaign-memory", recordId: "write-body-entity-2" },
      body: "x".repeat(20_001),
    },
  });
  assert.equal(response.statusCode, 400, "body over the cap is rejected on create");
  response = await post("/api/game/write-chat/memory/mutations", {
    ...bodyUpdate,
    operationId: "write-body-at-cap",
    expectedRevision: 2,
    patch: { body: "y".repeat(20_000) },
  });
  assert.equal(response.statusCode, 200, "body at exactly 20,000 characters is accepted");
  assert.equal(response.json().revision, 3);
  response = await app.inject({ method: "GET", url: "/api/game/write-chat/memory/audit?limit=20" });
  const bodyJournal = response
    .json()
    .items.find((item: { operationId: string }) => item.operationId === "write-body-update");
  assert.equal(bodyJournal?.before?.body, noteBody, "journal before carries the previous body");
  assert.equal(bodyJournal?.after?.body, "Revised notes.", "journal after carries the new body");
  response = await post("/api/game/write-chat/memory/mutations/compensate", {
    operationId: "write-body-undo-cap",
    originalOperationId: "write-body-at-cap",
    reason: "undo cap write",
  });
  assert.equal(response.statusCode, 200, "compensation restores the previous body");
  assert.equal(response.json().body, "Revised notes.");
  response = await post("/api/game/write-chat/memory/mutations/compensate", {
    operationId: "write-body-undo",
    originalOperationId: "write-body-update",
    reason: "undo revision",
  });
  assert.equal(response.statusCode, 409, "compensating an older revision is CAS protected");
  assert.equal(
    (await createCampaignMemoryStorage(db).getEntity({ chatId: "write-chat" }, "write-body-entity"))?.body,
    "Revised notes.",
    "compensation restored body persists",
  );

  const importPreview = await post("/api/game/other-write-chat/memory/import/preview", {
    operationId: "legacy-import-1",
  });
  assert.equal(importPreview.statusCode, 200);
  const importManifest = importPreview.json();
  assert.equal(importManifest.manifest.counts.planned, 1);
  assert.equal("commands" in importManifest, false, "preview never exposes executable commands");
  assert.equal(
    (await createCampaignMemoryStorage(db).listEntities({ chatId: "other-write-chat" })).length,
    0,
    "import preview is read-only",
  );
  const imported = await post("/api/game/other-write-chat/memory/import", {
    operationId: "legacy-import-1",
    expectedSourceHash: importManifest.manifest.legacySourceHash,
  });
  assert.equal(imported.statusCode, 200);
  assert.equal(imported.json().createdEntityIds.length, 1);
  const entityCount = (await createCampaignMemoryStorage(db).listEntities({ chatId: "other-write-chat" })).length;
  const retriedImport = await post("/api/game/other-write-chat/memory/import", {
    operationId: "legacy-import-1",
    expectedSourceHash: importManifest.manifest.legacySourceHash,
  });
  assert.equal(retriedImport.statusCode, 200);
  assert.equal(
    (await createCampaignMemoryStorage(db).listEntities({ chatId: "other-write-chat" })).length,
    entityCount,
    "same import operation does not duplicate",
  );
  await db
    .update(characters)
    .set({ data: JSON.stringify({ name: "Changed source" }) })
    .where(eq(characters.id, "import-character"));
  const staleImport = await post("/api/game/other-write-chat/memory/import", {
    operationId: "legacy-import-1",
    expectedSourceHash: importManifest.manifest.legacySourceHash,
  });
  assert.equal(staleImport.statusCode, 409);
  assert.equal(staleImport.json().error.code, "CAMPAIGN_MEMORY_IMPORT_SOURCE_CHANGED");
  const unknownImport = await post("/api/game/missing-write-chat/memory/import/preview", {
    operationId: "legacy-import-missing",
  });
  assert.equal(unknownImport.statusCode, 404);
  const registryNote = await post("/api/game/write-chat/memory/mutations", {
    operationId: "write-registry-note-1",
    action: "create",
    recordType: "entity",
    reason: "register organization note",
    input: {
      entityId: "write-registry-note",
      kind: "note",
      owner: { type: "registry", store: "campaign-memory", recordId: "write-registry-note" },
      aliases: ["Registry note"],
      tags: [],
      attributes: {},
      status: "active",
      manualLock: false,
    },
  });
  assert.equal(registryNote.statusCode, 200);

  // Relationship endpoint validation: chat scope and entity kind.
  const importedEntityId = imported.json().createdEntityIds[0] as string;
  const relationship = (operationId: string, input: Record<string, unknown>) =>
    post("/api/game/write-chat/memory/mutations", {
      operationId,
      action: "create",
      recordType: "relationship",
      reason: "link",
      input: {
        sourceEntityId: "write-entity",
        targetEntityId: "write-entity",
        type: "knows",
        inverseLabel: "known-by",
        status: "active",
        evidence: [],
        manualLock: false,
        ...input,
      },
    });
  const crossChat = await relationship("write-rel-cross-chat", { targetEntityId: importedEntityId });
  assert.equal(crossChat.statusCode, 404, "cross-chat relationship target is rejected");
  assert.equal(crossChat.json().error.code, "CAMPAIGN_MEMORY_INVALID_REFERENCE");
  const wrongKind = await relationship("write-rel-wrong-kind", {
    sourceEntityId: "write-registry-note",
    type: "friend-of",
    inverseLabel: "friend-of",
  });
  assert.equal(wrongKind.statusCode, 400, "a note cannot be the source of a personal relationship");
  assert.equal(wrongKind.json().error.code, "CAMPAIGN_MEMORY_INVALID_ENDPOINT_KIND");
  const wrongDefault = await relationship("write-rel-wrong-default", {
    targetEntityId: "write-registry-note",
    type: "custom-link",
    inverseLabel: "custom-link",
  });
  assert.equal(wrongDefault.statusCode, 400, "unknown types only allow character/location/lore endpoints");
  const validRelationship = await relationship("write-rel-valid", {});
  assert.equal(validRelationship.statusCode, 200, "character-to-character personal relationship is accepted");
  const relationshipId = validRelationship.json().relationshipId as string;
  const retype = await post("/api/game/write-chat/memory/mutations", {
    operationId: "write-rel-retype",
    action: "update",
    recordType: "relationship",
    recordId: relationshipId,
    expectedRevision: 1,
    reason: "retype",
    patch: { type: "part-of" },
  });
  assert.equal(retype.statusCode, 400, "retyping to a type the endpoints do not permit is rejected");
  assert.equal(
    (await createCampaignMemoryStorage(db).getRelationship({ chatId: "write-chat" }, relationshipId))?.revision,
    1,
  );

  await app.close();
  await db._fileStore.close();
  console.log("campaign memory write API regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
