import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = mkdtempSync(join(tmpdir(), "marinara-campaign-memory-item-owner-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { chats, gameStateSnapshots, messages } = await import("../../packages/server/src/db/schema/index.js");
  const { createCampaignMemoryStorage } =
    await import("../../packages/server/src/services/storage/campaign-memory.storage.js");
  const { applyCampaignMemoryLegacyImport, collectCampaignMemoryLegacySource, planCampaignMemoryLegacyImport } =
    await import("../../packages/server/src/services/game/campaign-memory-import.js");
  const { createCampaignMemoryOwnerReader, resolveCampaignMemoryOwner } =
    await import("../../packages/server/src/services/game/campaign-memory-owners.js");
  const db = await createFileNativeDB();
  const now = new Date().toISOString();
  await db.insert(chats).values({
    id: "item-owner-chat",
    name: "Item owner",
    mode: "game",
    characterIds: "[]",
    personaId: null,
    metadata: JSON.stringify({ gameJournal: { quests: [{ id: "item-sword-a", name: "Colliding quest" }] } }),
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(messages).values([
    {
      id: "item-owner-message",
      chatId: "item-owner-chat",
      role: "user",
      content: "",
      activeSwipeIndex: 0,
      extra: "{}",
      createdAt: "2020-01-01T00:00:00.000Z",
    },
    {
      id: "item-owner-removal",
      chatId: "item-owner-chat",
      role: "user",
      content: "",
      activeSwipeIndex: 0,
      extra: "{}",
      createdAt: "2020-01-01T00:01:00.000Z",
    },
  ]);
  await db.insert(gameStateSnapshots).values({
    id: "item-owner-bootstrap-state",
    chatId: "item-owner-chat",
    messageId: "",
    swipeIndex: 0,
    playerStats: JSON.stringify({ inventory: [{ itemId: "item-sword-b", name: "Old bootstrap name" }] }),
    presentCharacters: "[]",
    committed: 1,
    createdAt: "2019-12-31T23:59:00.000Z",
  });
  await db.insert(gameStateSnapshots).values({
    id: "item-owner-state",
    chatId: "item-owner-chat",
    messageId: "item-owner-message",
    swipeIndex: 0,
    playerStats: JSON.stringify({
      inventory: [
        { itemId: "item-sword-a", name: "Sword", description: "first sword", quantity: 1, location: "on_person" },
        { itemId: "item-sword-b", name: "Sword", description: "second sword", quantity: 2, location: "stored" },
      ],
      activeQuests: [{ questEntryId: "item-sword-a", name: "Colliding quest" }],
    }),
    presentCharacters: "[]",
    committed: 1,
    createdAt: now,
  });
  await db.insert(gameStateSnapshots).values([
    {
      id: "item-owner-removal-state",
      chatId: "item-owner-chat",
      messageId: "item-owner-removal",
      swipeIndex: 0,
      playerStats: JSON.stringify({ inventory: [], activeQuests: [] }),
      presentCharacters: "[]",
      committed: 1,
      createdAt: new Date(Date.now() + 1000).toISOString(),
    },
    {
      id: "item-owner-inactive",
      chatId: "item-owner-chat",
      messageId: "item-owner-message",
      swipeIndex: 1,
      playerStats: JSON.stringify({ inventory: [{ itemId: "inactive-item", name: "Inactive" }] }),
      presentCharacters: "[]",
      committed: 1,
      createdAt: new Date(Date.now() + 2000).toISOString(),
    },
    {
      id: "item-owner-uncommitted",
      chatId: "item-owner-chat",
      messageId: "item-owner-removal",
      swipeIndex: 0,
      playerStats: JSON.stringify({ inventory: [{ itemId: "future-item", name: "Future" }] }),
      presentCharacters: "[]",
      committed: 0,
      createdAt: new Date(Date.now() + 3000).toISOString(),
    },
  ]);
  await db.insert(chats).values({
    id: "item-owner-sibling",
    name: "Sibling",
    mode: "game",
    characterIds: "[]",
    personaId: null,
    metadata: "{}",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(gameStateSnapshots).values({
    id: "item-owner-sibling-state",
    chatId: "item-owner-sibling",
    messageId: "sibling-message",
    swipeIndex: 0,
    playerStats: JSON.stringify({ inventory: [{ itemId: "sibling-item", name: "Sibling" }] }),
    presentCharacters: "[]",
    committed: 1,
    createdAt: now,
  });

  const reader = createCampaignMemoryOwnerReader(db);
  const first = await resolveCampaignMemoryOwner(
    {
      chatId: "item-owner-chat",
      kind: "item",
      owner: { type: "existing", store: "game-state", recordId: "item-sword-b" },
    },
    reader,
  );
  assert.equal(first.selected?.recordId, "item-sword-b");
  const collision = await resolveCampaignMemoryOwner(
    {
      chatId: "item-owner-chat",
      kind: "item",
      owner: { type: "existing", store: "game-state", recordId: "item-sword-a" },
    },
    reader,
  );
  assert.equal(collision.selected, null, "item/quest game-state ID collisions are held unresolved");
  const crossChat = await resolveCampaignMemoryOwner(
    { chatId: "other-chat", kind: "item", owner: { type: "existing", store: "game-state", recordId: "item-sword-a" } },
    reader,
  );
  assert.equal(crossChat.reason, "chat_not_visible");
  for (const recordId of ["inactive-item", "future-item", "sibling-item"]) {
    const denied = await resolveCampaignMemoryOwner(
      { chatId: "item-owner-chat", kind: "item", owner: { type: "existing", store: "game-state", recordId } },
      reader,
    );
    assert.equal(denied.selected, null, `${recordId} is outside committed active chat history`);
  }

  const collected = await collectCampaignMemoryLegacySource(db, "item-owner-chat");
  const itemEntities = collected.entities.filter((entity) => entity.kind === "item");
  assert.equal(itemEntities.length, 2, "only ID-bearing inventory rows become owners");
  assert.deepEqual(
    itemEntities.map((entity) => entity.owner.recordId).sort(),
    ["item-sword-a", "item-sword-b"],
  );
  assert.deepEqual(
    itemEntities.find((entity) => entity.owner.recordId === "item-sword-b")?.aliases,
    ["Sword"],
    "later active history supersedes an older bootstrap name",
  );
  const plan = await planCampaignMemoryLegacyImport(db, collected);
  assert.equal(plan.commands.length, 1, "colliding item/quest ID is held");
  const applied = await applyCampaignMemoryLegacyImport(db, plan);
  assert.equal(applied.manifest.counts.created, 1);

  const storage = createCampaignMemoryStorage(db);
  const entities = await storage.listEntities({ chatId: "item-owner-chat" });
  assert.equal(entities.filter((entity) => entity.kind === "item").length, 1);
  const edited = entities.find((entity) => entity.owner.recordId === "item-sword-b")!;
  await storage.updateEntity(
    { chatId: "item-owner-chat" },
    edited.entityId,
    { summary: "manual preservation" },
    { expectedRevision: edited.revision, actor: "user", reason: "edit" },
  );
  const replay = await planCampaignMemoryLegacyImport(db, collected);
  assert.equal(replay.commands.length, 0, "replay is idempotent by stable item owner ID");
  await applyCampaignMemoryLegacyImport(db, replay);
  assert.equal(
    (await storage.getEntity({ chatId: "item-owner-chat" }, edited.entityId))?.summary,
    "manual preservation",
  );

  await db._fileStore.close();
  console.log("campaign memory item owner integration regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
