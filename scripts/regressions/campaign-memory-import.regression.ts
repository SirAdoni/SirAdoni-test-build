import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = mkdtempSync(join(tmpdir(), "marinara-campaign-memory-import-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const {
    chats,
    characters,
    personas,
    lorebooks,
    lorebookEntries,
    gameStateSnapshots,
    campaignMemoryMutationJournal,
    messages,
  } = await import("../../packages/server/src/db/schema/index.js");
  const { createCampaignMemoryStorage } =
    await import("../../packages/server/src/services/storage/campaign-memory.storage.js");
  const {
    collectCampaignMemoryLegacySource,
    previewCampaignMemoryLegacyImport,
    planCampaignMemoryLegacyImport,
    applyCampaignMemoryLegacyImport,
    legacyCampaignMemoryEntityId,
  } = await import("../../packages/server/src/services/game/campaign-memory-import.js");
  const { applyFeatureSettingsValue } = await import("../../packages/server/src/services/features/feature-settings.js");
  applyFeatureSettingsValue(JSON.stringify({ campaignMemory: true }));
  const { requireCampaignSurface } =
    await import("../../packages/server/src/services/features/campaign-surface-opt-in.js");
  const db = await createFileNativeDB();
  const now = new Date().toISOString();
  await db.insert(characters).values({
    id: "char-a",
    data: JSON.stringify({ name: "Same Name", description: "wiki character" }),
    createdAt: now,
    updatedAt: now,
  });
  await db
    .insert(characters)
    .values({ id: "char-b", data: JSON.stringify({ name: "Same Name" }), createdAt: now, updatedAt: now });
  await db.insert(personas).values({ id: "persona-a", name: "Private", createdAt: now, updatedAt: now });
  await db.insert(lorebooks).values({ id: "book-a", name: "Book", createdAt: now, updatedAt: now });
  await db.insert(lorebookEntries).values({
    id: "lore-a",
    lorebookId: "book-a",
    name: "Lore",
    content: "old lore",
    description: "old",
    keys: "[]",
    secondaryKeys: "[]",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(chats).values({
    id: "import-chat",
    name: "Import",
    mode: "game",
    characterIds: JSON.stringify(["char-a", "char-b"]),
    personaId: "persona-a",
    metadata: JSON.stringify({
      activeLorebookIds: ["book-a"],
      gameNpcs: [{ id: "npc-a", characterId: "char-a", name: "Historical NPC" }],
      gameJournal: {
        quests: [
          {
            id: "quest-done",
            name: "Completed Quest",
            status: "completed",
            description: "completed description",
            objectives: [],
            discoveredAt: "2026-01-01",
          },
        ],
      },
      spatialContext: {
        schemaVersion: 1,
        ownerMode: "game",
        enabled: true,
        revision: 1,
        startingLocationId: "loc-a",
        locations: [
          {
            id: "loc-a",
            parentId: null,
            name: "Same Name",
            kind: "building",
            description: "old",
            lorebookEntryIds: [],
            childPresentation: "list",
            links: [],
            status: "active",
            sortOrder: 0,
          },
        ],
      },
    }),
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(gameStateSnapshots).values({
    id: "state-a",
    chatId: "import-chat",
    messageId: "msg-a",
    swipeIndex: 0,
    playerStats: JSON.stringify({ activeQuests: [{ questEntryId: "quest-a", name: "Quest" }] }),
    presentCharacters: "[]",
    committed: 1,
    createdAt: now,
  });

  await db.insert(messages).values([
    { id: "msg-a", chatId: "import-chat", role: "assistant", content: "active", activeSwipeIndex: 0 },
    { id: "msg-sibling", chatId: "sibling-chat", role: "assistant", content: "sibling", activeSwipeIndex: 0 },
  ]);
  await db.insert(chats).values({ id: "sibling-chat", name: "Sibling", mode: "game", createdAt: now, updatedAt: now });
  await db
    .update(gameStateSnapshots)
    .set({
      playerStats: JSON.stringify({
        activeQuests: [{ questEntryId: "quest-a", name: "Quest" }],
        inventory: [
          { itemId: "inventory-a", name: "Current name", quantity: 3 },
          { itemId: "quest-done", name: "Collision", quantity: 1 },
        ],
      }),
    })
    .where((await import("../../packages/server/src/db/file-query.js")).eq(gameStateSnapshots.id, "state-a"));
  await db.insert(gameStateSnapshots).values([
    {
      id: "state-old",
      chatId: "import-chat",
      messageId: "",
      swipeIndex: 0,
      playerStats: JSON.stringify({ inventory: [{ itemId: "inventory-a", name: "Old name", quantity: 1 }] }),
      presentCharacters: "[]",
      committed: 1,
      createdAt: "2025-01-01T00:00:00.000Z",
    },
    {
      id: "state-inactive",
      chatId: "import-chat",
      messageId: "msg-a",
      swipeIndex: 1,
      playerStats: JSON.stringify({ inventory: [{ itemId: "inactive-item", name: "Inactive" }] }),
      presentCharacters: "[]",
      committed: 1,
      createdAt: "2026-01-02T00:00:00.000Z",
    },
    {
      id: "state-uncommitted",
      chatId: "import-chat",
      messageId: "msg-a",
      swipeIndex: 0,
      playerStats: JSON.stringify({ inventory: [{ itemId: "uncommitted-item", name: "Uncommitted" }] }),
      presentCharacters: "[]",
      committed: 0,
      createdAt: "2026-01-03T00:00:00.000Z",
    },
    {
      id: "state-sibling",
      chatId: "sibling-chat",
      messageId: "msg-sibling",
      swipeIndex: 0,
      playerStats: JSON.stringify({ inventory: [{ itemId: "sibling-item", name: "Sibling" }] }),
      presentCharacters: "[]",
      committed: 1,
      createdAt: "2026-01-04T00:00:00.000Z",
    },
  ]);
  const collected = await collectCampaignMemoryLegacySource(db, "import-chat");
  const source = {
    ...collected,
    entities: [
      ...collected.entities,
      { kind: "character" as const, owner: { type: "existing" as const, store: "characters", recordId: "removed" } },
      {
        kind: "character" as const,
        candidateOwnerRefs: [
          { type: "existing" as const, store: "characters", recordId: "char-a" },
          { type: "existing" as const, store: "characters", recordId: "char-b" },
        ],
        aliases: ["Same Name"],
      },
    ],
  };

  const preview = await previewCampaignMemoryLegacyImport(db, source);
  assert.equal(preview.manifest.counts.planned, 7);
  assert.equal(preview.manifest.counts.held, 4);
  assert.equal(
    preview.held.some((item) => item.reason === "owner_not_visible_in_chat" || item.reason === "owner_record_missing"),
    true,
  );
  assert.equal(
    preview.held.some((item) => item.reason === "ambiguous_owner_candidates"),
    true,
  );
  assert.equal(
    preview.commands.some((command) => command.recordType === "knowledge"),
    false,
  );
  assert.equal((await db.select().from(campaignMemoryMutationJournal)).length, 0, "preview must not journal");
  const originalMetadata = (await db.select().from(chats))[0]!.metadata;
  const changedMetadata = JSON.parse(originalMetadata) as {
    gameJournal: { quests: Array<{ description: string }> };
    gameNpcs: Array<{ name: string }>;
  };
  changedMetadata.gameJournal.quests[0]!.description = "changed completed description";
  changedMetadata.gameNpcs[0]!.name = "Renamed Historical NPC";
  await db
    .update(chats)
    .set({ metadata: JSON.stringify(changedMetadata) })
    .where((await import("../../packages/server/src/db/file-query.js")).eq(chats.id, "import-chat"));
  await assert.rejects(() => applyCampaignMemoryLegacyImport(db, preview), /CAMPAIGN_MEMORY_IMPORT_SOURCE_CHANGED/u);
  await db
    .update(chats)
    .set({ metadata: originalMetadata })
    .where((await import("../../packages/server/src/db/file-query.js")).eq(chats.id, "import-chat"));

  const { requireCampaignOptIn } = await import("../../packages/server/src/services/features/campaign-opt-in.js");
  applyFeatureSettingsValue(JSON.stringify({ campaignMemory: true, campaignIndex: true }));
  let admissions = 0;
  await assert.rejects(
    applyCampaignMemoryLegacyImport(db, preview, () => {
      if (++admissions === 6) applyFeatureSettingsValue(JSON.stringify({ campaignMemory: true, campaignIndex: false }));
      requireCampaignOptIn("campaignIndex");
    }),
    /FEATURE_DISABLED:campaignIndex/,
  );
  assert.equal(admissions, 6, "disable after the first import command and its journal have completed");
  assert.equal(
    (await createCampaignMemoryStorage(db).listEntities({ chatId: "import-chat" })).length,
    0,
    "late Index OFF rolls back the partial import",
  );
  assert.equal(
    (await db.select().from(campaignMemoryMutationJournal)).length,
    0,
    "late OFF retains no partial mutation journal",
  );
  applyFeatureSettingsValue(JSON.stringify({ campaignMemory: true, campaignIndex: true }));
  applyFeatureSettingsValue(JSON.stringify({ campaignMemory: true, campaignWiki: true }));
  const blockedImport = applyCampaignMemoryLegacyImport(db, preview, () => {
    applyFeatureSettingsValue("{}");
    requireCampaignSurface("campaignMemory", "campaignWiki");
  });
  await assert.rejects(blockedImport, { code: "FEATURE_DISABLED" });
  assert.equal((await createCampaignMemoryStorage(db).listEntities({ chatId: "import-chat" })).length, 0);
  assert.equal((await db.select().from(campaignMemoryMutationJournal)).length, 0);
  applyFeatureSettingsValue(JSON.stringify({ campaignMemory: true, campaignWiki: true }));
  const applied = await applyCampaignMemoryLegacyImport(db, preview);
  assert.equal(applied.manifest.counts.created, 7);
  const storage = createCampaignMemoryStorage(db);
  const entities = await storage.listEntities({ chatId: "import-chat" });
  assert.equal(entities.length, 7);
  assert.equal(new Set(entities.map((entity) => entity.entityId)).size, 7);
  assert.equal(
    entities.some((entity) => entity.owner.type === "existing" && entity.owner.store === "game-npcs"),
    false,
    "linked NPC uses its canonical Character owner",
  );
  assert.equal(
    entities.some((entity) => entity.owner.type === "existing" && entity.owner.recordId === "quest-done"),
    false,
    "item/quest owner collision is held instead of conflated",
  );
  assert.deepEqual(
    entities.find((entity) => entity.owner.type === "existing" && entity.owner.recordId === "inventory-a")?.aliases,
    ["Current name"],
  );
  assert.equal(
    entities.some(
      (entity) =>
        entity.owner.type === "existing" &&
        ["inactive-item", "uncommitted-item", "sibling-item"].includes(entity.owner.recordId),
    ),
    false,
    "inactive, uncommitted, and sibling inventory are excluded",
  );
  assert.equal(
    entities.find((entity) => entity.owner.type === "existing" && entity.owner.recordId === "char-a")?.summary,
    "wiki character",
  );
  assert.equal(
    entities.find((entity) => entity.owner.type === "existing" && entity.owner.recordId === "persona-a")?.summary,
    undefined,
  );
  assert.equal(
    entities.some((entity) => entity.kind === "character" && entity.owner.type === "registry"),
    false,
  );
  assert.equal(
    entities.some((entity) => entity.kind === "character" && entity.attributes.knowledge),
    false,
    "private bio creates no NPC knowledge",
  );
  assert.equal(
    entities.find((entity) => entity.owner.type === "existing" && entity.owner.recordId === "char-a")?.provenance
      .sourceRevision,
    collected.legacySourceHash,
  );

  const userEdited = entities.find((entity) => entity.owner.type === "existing" && entity.owner.recordId === "char-a")!;
  await storage.updateEntity(
    { chatId: "import-chat" },
    userEdited.entityId,
    { summary: "user edit" },
    { expectedRevision: userEdited.revision, actor: "user", reason: "edit" },
  );
  const replay = await planCampaignMemoryLegacyImport(db, source);
  assert.equal(replay.commands.length, 0);
  assert.equal(replay.manifest.counts.skippedExisting, 7);
  assert.equal((await applyCampaignMemoryLegacyImport(db, replay)).manifest.counts.created, 0);
  assert.equal((await storage.getEntity({ chatId: "import-chat" }, userEdited.entityId))?.summary, "user edit");
  await db
    .delete(characters)
    .where((await import("../../packages/server/src/db/file-query.js")).eq(characters.id, "char-a"));
  const afterOwnerDeletion = (await storage.getEntity({ chatId: "import-chat" }, userEdited.entityId))!;
  const editedAfterOwnerDeletion = await storage.updateEntity(
    { chatId: "import-chat" },
    userEdited.entityId,
    { summary: "edited after owner deletion" },
    { expectedRevision: afterOwnerDeletion.revision, actor: "user", reason: "owner disappeared" },
  );
  const archivedAfterOwnerDeletion = await storage.updateEntity(
    { chatId: "import-chat" },
    userEdited.entityId,
    { status: "archived" },
    { expectedRevision: editedAfterOwnerDeletion.revision, actor: "user", reason: "archive orphaned entity" },
  );
  assert.equal(archivedAfterOwnerDeletion.status, "archived");
  assert.equal(archivedAfterOwnerDeletion.summary, "edited after owner deletion");
  assert.equal((await db.select().from(campaignMemoryMutationJournal)).length, 7);
  assert.equal(legacyCampaignMemoryEntityId("import-chat", "character", "char-a"), userEdited.entityId);

  // Planning is read-only, so the chat scope is read once per plan, not once per entity. Rebuilding it for every
  // entity held the Engine's only thread for seconds on a real campaign and froze the browser tab.
  const { createCampaignMemoryOwnerReader } =
    await import("../../packages/server/src/services/game/campaign-memory-owners.js");
  const realReader = createCampaignMemoryOwnerReader(db);
  let scopeReads = 0;
  const countingReader = {
    ...realReader,
    readChatScope(chatId: string) {
      scopeReads += 1;
      return realReader.readChatScope(chatId);
    },
  };
  const counted = await planCampaignMemoryLegacyImport(db, source, { ownerReader: countingReader });
  assert.equal(counted.manifest.counts.skippedExisting, 6, "the cached scope resolves the same owners");
  assert.ok(source.entities.length > 1);
  assert.equal(scopeReads, 1, `chat scope read once for ${source.entities.length} entities (read ${scopeReads} times)`);
  await db._fileStore.close();
  console.log("campaign memory import regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
