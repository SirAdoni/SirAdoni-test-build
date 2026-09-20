import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CampaignMemoryEntityKind,
  CampaignMemoryExistingOwnerRef,
  CampaignMemoryOwnerRef,
  SpatialContextDefinition,
} from "@marinara-engine/shared";
import {
  resolveCampaignMemoryOwner,
  validateCampaignMemoryEntityOwner,
  type CampaignMemoryOwnerChatScope,
  type CampaignMemoryOwnerReader,
} from "../../packages/server/src/services/game/campaign-memory-owners.js";

const spatialDefinition: SpatialContextDefinition = {
  schemaVersion: 1,
  ownerMode: "game",
  enabled: true,
  revision: 4,
  startingLocationId: "loc-moonrise",
  locations: [
    {
      id: "loc-moonrise",
      parentId: null,
      name: "Moonrise",
      kind: "building",
      description: "",
      lorebookEntryIds: [],
      childPresentation: "list",
      links: [],
      status: "active",
      sortOrder: 0,
    },
  ],
};

const scopes = new Map<string, CampaignMemoryOwnerChatScope>([
  [
    "chat-a",
    {
      chatId: "chat-a",
      characterIds: ["char-player"],
      linkedCharacterIds: ["char-mirah"],
      npcIds: ["npc-ash"],
      personaId: "persona-player",
      lorebookEntryIds: ["lore-entry-1"],
      questEntryIds: ["quest-entry-1"],
      spatialDefinition,
    },
  ],
]);

const records = new Map<string, { store: string; recordId: string; kind?: CampaignMemoryEntityKind }>([
  ["characters:char-player", { store: "characters", recordId: "char-player", kind: "character" }],
  ["characters:char-mirah", { store: "characters", recordId: "char-mirah", kind: "character" }],
  ["game-npcs:npc-ash", { store: "game-npcs", recordId: "npc-ash", kind: "character" }],
  ["personas:persona-player", { store: "personas", recordId: "persona-player", kind: "persona" }],
  ["spatial-context:loc-moonrise", { store: "spatial-context", recordId: "loc-moonrise", kind: "location" }],
  ["lorebook-entries:lore-entry-1", { store: "lorebook-entries", recordId: "lore-entry-1", kind: "lore" }],
  ["game-state:quest-entry-1", { store: "game-state", recordId: "quest-entry-1", kind: "quest" }],
]);

const reader: CampaignMemoryOwnerReader = {
  async readChatScope(chatId) {
    return scopes.get(chatId) ?? null;
  },
  async readExistingOwner(owner: CampaignMemoryExistingOwnerRef) {
    return records.get(`${owner.store}:${owner.recordId}`) ?? null;
  },
};

const existing = (store: string, recordId: string): CampaignMemoryExistingOwnerRef => ({
  type: "existing",
  store,
  recordId,
});

const resolvedCharacter = await resolveCampaignMemoryOwner(
  { chatId: "chat-a", kind: "character", owner: existing("characters", "char-player") },
  reader,
);
assert.equal(resolvedCharacter.selected?.recordId, "char-player");

const resolvedNpc = await resolveCampaignMemoryOwner(
  { chatId: "chat-a", kind: "character", owner: existing("game-npcs", "npc-ash") },
  reader,
);
assert.equal(resolvedNpc.selected?.recordId, "npc-ash");

const originalEntity = {
  chatId: "chat-a",
  kind: "character" as const,
  owner: existing("characters", "char-player"),
  aliases: ["Rowan", "the wizard"],
};
const originalOwner = originalEntity.owner;
await validateCampaignMemoryEntityOwner(originalEntity, reader);
assert.deepEqual(originalEntity.owner, originalOwner, "read validation preserves the original owner");

const missing = await resolveCampaignMemoryOwner(
  { chatId: "chat-a", kind: "character", owner: existing("characters", "char-missing") },
  reader,
);
assert.equal(missing.selected, null);
assert.equal(missing.reason, "owner_not_visible_in_chat");

const crossChat = await resolveCampaignMemoryOwner(
  { chatId: "chat-b", kind: "character", owner: existing("characters", "char-player") },
  reader,
);
assert.equal(crossChat.reason, "chat_not_visible");

const duplicateAlias = await resolveCampaignMemoryOwner(
  { chatId: "chat-a", kind: "character", aliases: ["Rowan", "Rowan"] },
  reader,
);
assert.equal(duplicateAlias.selected, null);
assert.equal(duplicateAlias.reason, "aliases_are_not_identity");

const absentSpatialMap = await resolveCampaignMemoryOwner(
  { chatId: "chat-a", kind: "location", owner: existing("spatial-context", "loc-moonrise") },
  { ...reader, readChatScope: async () => ({ ...scopes.get("chat-a")!, spatialDefinition: null }) },
);
assert.equal(absentSpatialMap.reason, "spatial_definition_unavailable");

const location = await resolveCampaignMemoryOwner(
  { chatId: "chat-a", kind: "location", owner: existing("spatial-context", "loc-moonrise") },
  reader,
);
assert.equal(location.selected?.recordId, "loc-moonrise");

const quest = await resolveCampaignMemoryOwner(
  { chatId: "chat-a", kind: "quest", owner: existing("game-state", "quest-entry-1") },
  reader,
);
assert.equal(quest.selected?.recordId, "quest-entry-1");

const unownedItem = await resolveCampaignMemoryOwner(
  { chatId: "chat-a", kind: "item", candidateOwnerRefs: [] },
  reader,
);
assert.equal(unownedItem.reason, "stable_owner_id_required");

const registry = await resolveCampaignMemoryOwner(
  { chatId: "chat-a", kind: "organization", owner: { type: "registry", store: "campaign-memory", recordId: "org-1" } },
  { ...reader, readRegistryOwner: async () => true },
);
assert.equal(registry.selected?.recordId, "org-1");

console.log("campaign-memory-owners regression passed");

// A disposable file-store fixture exercises the production reader without touching the live store.
const fixtureDir = mkdtempSync(join(tmpdir(), "marinara-campaign-memory-owners-"));
const previousDataDir = process.env.DATA_DIR;
const previousFileStorageDir = process.env.FILE_STORAGE_DIR;
process.env.DATA_DIR = fixtureDir;
process.env.FILE_STORAGE_DIR = join(fixtureDir, "storage");
try {
  const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
  const { chats, characters, personas, lorebooks, lorebookEntries, gameStateSnapshots } =
    await import("../../packages/server/src/db/schema/index.js");
  const { createCampaignMemoryOwnerReader } =
    await import("../../packages/server/src/services/game/campaign-memory-owners.js");
  const db = await getDB();
  const stamp = new Date().toISOString();
  await db.insert(characters).values({
    id: "fixture-char",
    data: JSON.stringify({ name: "Fixture Character" }),
    comment: "",
    createdAt: stamp,
    updatedAt: stamp,
  });
  await db
    .insert(personas)
    .values({ id: "fixture-persona", name: "Fixture Persona", createdAt: stamp, updatedAt: stamp });
  await db.insert(lorebooks).values({ id: "fixture-book", name: "Fixture Book", createdAt: stamp, updatedAt: stamp });
  await db.insert(lorebookEntries).values({
    id: "fixture-lore",
    lorebookId: "fixture-book",
    name: "Fixture Lore",
    content: "",
    description: "",
    keys: "[]",
    secondaryKeys: "[]",
    createdAt: stamp,
    updatedAt: stamp,
  });
  const spatialMeta = JSON.stringify({
    activeLorebookIds: ["fixture-book"],
    gameNpcs: [
      { id: "fixture-npc", characterId: "fixture-linked-npc", name: "Linked NPC" },
      { id: "fixture-npc-duplicate", name: "Duplicate NPC" },
      { id: "fixture-npc-duplicate-2", name: "Duplicate NPC" },
      { id: "fixture-npc-unique", name: "Unique NPC" },
    ],
    spatialContext: spatialDefinition,
    gameJournal: {
      quests: [
        {
          id: "fixture-completed-quest",
          name: "Completed Fixture Quest",
          status: "completed",
          description: "Done",
          objectives: [],
          discoveredAt: stamp,
          completedAt: stamp,
        },
      ],
    },
  });
  await db.insert(chats).values({
    id: "fixture-chat",
    name: "Fixture Game",
    mode: "game",
    characterIds: JSON.stringify(["fixture-char"]),
    personaId: "fixture-persona",
    metadata: spatialMeta,
    createdAt: stamp,
    updatedAt: stamp,
  });
  await db.insert(gameStateSnapshots).values({
    id: "fixture-state",
    chatId: "fixture-chat",
    messageId: "fixture-message",
    swipeIndex: 0,
    playerStats: JSON.stringify({ activeQuests: [{ questEntryId: "fixture-quest", name: "Fixture Quest" }] }),
    presentCharacters: JSON.stringify([{ characterId: "fixture-linked-npc" }]),
    committed: 1,
    createdAt: stamp,
  });
  const productionReader = createCampaignMemoryOwnerReader(db);
  const { createCampaignMemoryStorage } =
    await import("../../packages/server/src/services/storage/campaign-memory.storage.js");
  const { captureContinuityHolderSnapshot } =
    await import("../../packages/server/src/services/game/continuity-holder-snapshot.js");
  const memoryStorage = createCampaignMemoryStorage(db);
  for (const npcId of ["fixture-npc", "fixture-npc-duplicate", "fixture-npc-duplicate-2", "fixture-npc-unique"]) {
    await memoryStorage.createEntity({
      entityId: `entity-${npcId}`,
      chatId: "fixture-chat",
      kind: "character",
      owner: { type: "existing", store: "game-npcs", recordId: npcId },
      aliases: [],
      tags: ["regression"],
      attributes: {},
      status: "active",
      manualLock: false,
      provenance: { source: "regression", sourceRevision: "npc", actor: "user" },
    });
  }
  const npcSnapshot = await captureContinuityHolderSnapshot(db, "fixture-chat");
  assert.equal(
    npcSnapshot.holders.some((holder) => holder.store === "game-npcs" && holder.recordId === "fixture-npc-unique"),
    true,
    "unique NPC identity is captured by canonical id",
  );
  assert.equal(
    npcSnapshot.holders.some((holder) => holder.store === "game-npcs" && holder.recordId === "fixture-npc-duplicate"),
    false,
    "duplicate NPC names remain ambiguous",
  );
  const productionCharacter = await resolveCampaignMemoryOwner(
    { chatId: "fixture-chat", kind: "character", owner: existing("characters", "fixture-char") },
    productionReader,
  );
  assert.equal(productionCharacter.selected?.recordId, "fixture-char");
  const productionPersona = await resolveCampaignMemoryOwner(
    { chatId: "fixture-chat", kind: "persona", owner: existing("personas", "fixture-persona") },
    productionReader,
  );
  assert.equal(productionPersona.selected?.recordId, "fixture-persona");
  const productionLocation = await resolveCampaignMemoryOwner(
    { chatId: "fixture-chat", kind: "location", owner: existing("spatial-context", "loc-moonrise") },
    productionReader,
  );
  assert.equal(productionLocation.selected?.recordId, "loc-moonrise");
  const linkedNpc = await resolveCampaignMemoryOwner(
    { chatId: "fixture-chat", kind: "character", owner: existing("characters", "fixture-linked-npc") },
    productionReader,
  );
  assert.equal(linkedNpc.selected, null, "linked NPC metadata is visible but has no character card owner");
  assert.equal(linkedNpc.reason, "owner_record_missing");
  const exactNpc = await resolveCampaignMemoryOwner(
    { chatId: "fixture-chat", kind: "character", owner: existing("game-npcs", "fixture-npc") },
    productionReader,
  );
  assert.equal(exactNpc.selected?.recordId, "fixture-npc");
  const forgedNpc = await resolveCampaignMemoryOwner(
    { chatId: "missing-chat", kind: "character", owner: existing("game-npcs", "fixture-npc") },
    productionReader,
  );
  assert.equal(forgedNpc.selected, null, "NPC ids are scoped to their owning chat");
  assert.equal(forgedNpc.reason, "chat_not_visible");
  const productionLore = await resolveCampaignMemoryOwner(
    { chatId: "fixture-chat", kind: "lore", owner: existing("lorebook-entries", "fixture-lore") },
    productionReader,
  );
  assert.equal(productionLore.selected?.recordId, "fixture-lore");
  const productionQuest = await resolveCampaignMemoryOwner(
    { chatId: "fixture-chat", kind: "quest", owner: existing("game-state", "fixture-quest") },
    productionReader,
  );
  assert.equal(productionQuest.selected?.recordId, "fixture-quest");
  const completedQuest = await resolveCampaignMemoryOwner(
    { chatId: "fixture-chat", kind: "quest", owner: existing("game-state", "fixture-completed-quest") },
    productionReader,
  );
  assert.equal(completedQuest.selected?.recordId, "fixture-completed-quest");
  const crossChatReader = createCampaignMemoryOwnerReader(db);
  const crossChatProduction = await resolveCampaignMemoryOwner(
    { chatId: "missing-chat", kind: "character", owner: existing("characters", "fixture-char") },
    crossChatReader,
  );
  assert.equal(crossChatProduction.reason, "chat_not_visible");
  await closeDB();
} finally {
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  if (previousFileStorageDir === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousFileStorageDir;
  rmSync(fixtureDir, { recursive: true, force: true });
}
