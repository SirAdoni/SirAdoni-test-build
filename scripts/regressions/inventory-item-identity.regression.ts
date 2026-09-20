import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeInventoryTrackerRows, type PlayerStats } from "../../packages/shared/src/index.js";

const fixtureDir = mkdtempSync(join(tmpdir(), "marinara-inventory-item-identity-"));
const previousDataDir = process.env.DATA_DIR;
const previousFileStorageDir = process.env.FILE_STORAGE_DIR;
process.env.DATA_DIR = fixtureDir;
process.env.FILE_STORAGE_DIR = join(fixtureDir, "storage");

const baseStats = (inventory: PlayerStats["inventory"]): PlayerStats => ({
  stats: [],
  attributes: null,
  skills: {},
  inventory,
  activeQuests: [],
  status: "",
});

try {
  const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
  const { gameStateSnapshots } = await import("../../packages/server/src/db/schema/index.js");
  const { eq } = await import("../../packages/server/src/db/file-query.js");
  const { messages } = await import("../../packages/server/src/db/schema/index.js");
  const { createGameStateStorage } = await import("../../packages/server/src/services/storage/game-state.storage.js");
  const db = await getDB();
  const storage = createGameStateStorage(db);

  const normalizedDistinct = normalizeInventoryTrackerRows([
    { itemId: "item-a", name: "Sword" },
    { itemId: "item-b", name: "Sword" },
  ]);
  assert.deepEqual(
    normalizedDistinct.map((row) => row.itemId),
    ["item-a", "item-b"],
    "ID-bearing same-name rows remain distinct",
  );
  assert.deepEqual(normalizeInventoryTrackerRows([{ name: "Sword" }, { name: "sword", qty: 2 }]), [
    { name: "Sword", qty: 3 },
  ]);

  const firstId = await storage.create({
    chatId: "identity-chat",
    messageId: "message-0",
    swipeIndex: 0,
    date: null,
    time: null,
    location: null,
    weather: null,
    temperature: null,
    worldCustomFields: [],
    presentCharacters: [],
    recentEvents: [],
    playerStats: baseStats([
      { itemId: "client-first", name: "Sword", description: "", quantity: 1, location: "on_person" },
    ]),
    personaStats: null,
    fieldLocks: null,
    hiddenTrackerFields: null,
    committed: true,
  });
  const first = await storage.getById(firstId);
  const firstStats = JSON.parse(String(first?.playerStats)) as PlayerStats;
  const itemId = firstStats.inventory[0]?.itemId;
  assert.ok(itemId, "new item receives a host ID");
  assert.notEqual(itemId, "client-first", "first snapshot never trusts an incoming client ID");

  const seamId = await storage.create({
    chatId: "seam-chat",
    messageId: "seam-message",
    swipeIndex: 0,
    date: null,
    time: null,
    location: null,
    weather: null,
    temperature: null,
    worldCustomFields: [],
    presentCharacters: [],
    recentEvents: [],
    playerStats: baseStats([]),
    personaStats: null,
    fieldLocks: null,
    hiddenTrackerFields: null,
    committed: true,
  });
  let seam = await storage.getById(seamId);
  const minted = await storage.updatePlayerStatsAtSnapshot(
    seamId,
    "seam-chat",
    baseStats([{ itemId: "client-seam", name: "Spear", description: "", quantity: 1, location: "on_person" }]),
    null,
    { playerStats: seam!.playerStats, fieldLocks: seam!.fieldLocks },
  );
  const mintedStats = JSON.parse(String(minted?.playerStats)) as PlayerStats;
  const mintedId = mintedStats.inventory[0]?.itemId;
  assert.ok(mintedId && mintedId !== "client-seam", "seam mints IDs at the storage boundary");
  seam = await storage.getById(seamId);
  const preserved = await storage.updatePlayerStatsAtSnapshot(
    seamId,
    "seam-chat",
    baseStats([{ itemId: mintedId, name: "Renamed spear", description: "", quantity: 1, location: "on_person" }]),
    null,
    { playerStats: seam!.playerStats, fieldLocks: seam!.fieldLocks },
  );
  assert.equal((JSON.parse(String(preserved?.playerStats)) as PlayerStats).inventory[0]?.itemId, mintedId);
  seam = await storage.getById(seamId);
  await db
    .update(gameStateSnapshots)
    .set({
      playerStats: JSON.stringify({ ...JSON.parse(String(seam!.playerStats)), status: "concurrent change" }),
      fieldLocks: '{"player":{"status":{"locked":true}}}',
    })
    .where(eq(gameStateSnapshots.id, seamId));
  await assert.rejects(
    () =>
      storage.updatePlayerStatsAtSnapshot(
        seamId,
        "seam-chat",
        baseStats([{ itemId: mintedId, name: "Stale overwrite", description: "", quantity: 1, location: "on_person" }]),
        null,
        { playerStats: seam!.playerStats, fieldLocks: seam!.fieldLocks },
      ),
    /GAME_STATE_INVENTORY_CONFLICT/,
  );
  const afterConflict = await storage.getById(seamId);
  assert.equal((JSON.parse(String(afterConflict?.playerStats)) as PlayerStats).status, "concurrent change");
  assert.equal(afterConflict?.fieldLocks, '{"player":{"status":{"locked":true}}}');
  assert.equal(
    await storage.updatePlayerStatsAtSnapshot(seamId, "wrong-chat", baseStats([]), null),
    null,
    "wrong chat cannot write through the seam",
  );

  const renamed = await storage.updateLatest("identity-chat", {
    playerStats: baseStats([{ itemId, name: "Named Sword", description: "", quantity: 2, location: "on_person" }]),
  });
  const renamedStats = JSON.parse(String(renamed?.playerStats)) as PlayerStats;
  assert.equal(renamedStats.inventory[0]?.itemId, itemId, "explicit known ID preserves rename identity");

  const replaced = await storage.updateLatest("identity-chat", {
    playerStats: baseStats([{ name: "Apple", description: "", quantity: 1, location: "on_person" }]),
  });
  const replacedStats = JSON.parse(String(replaced?.playerStats)) as PlayerStats;
  const replacementId = replacedStats.inventory[0]?.itemId;
  assert.ok(replacementId && replacementId !== itemId, "one-row replacement cannot inherit the old identity");

  await storage.updateByMessage("message-1", 0, "identity-chat", {
    playerStats: baseStats([]),
  });
  const historical = await storage.getByMessage("message-0", 0);
  assert.equal((JSON.parse(String(historical?.playerStats)) as PlayerStats).inventory[0]?.itemId, replacementId);
  const removed = await storage.getByMessage("message-1", 0);
  assert.deepEqual((JSON.parse(String(removed?.playerStats)) as PlayerStats).inventory, []);

  const branch = await storage.create(
    {
      chatId: "identity-branch",
      messageId: "message-0",
      swipeIndex: 0,
      date: null,
      time: null,
      location: null,
      weather: null,
      temperature: null,
      worldCustomFields: [],
      presentCharacters: [],
      recentEvents: [],
      playerStats: baseStats([
        { itemId: replacementId, name: "Apple", description: "", quantity: 1, location: "on_person" },
      ]),
      personaStats: null,
      fieldLocks: null,
      hiddenTrackerFields: null,
      committed: true,
    },
    null,
    { trustedInventoryIdentitySource: { snapshotId: String(historical?.id), chatId: "identity-chat" } },
  );
  assert.equal(
    (JSON.parse(String((await storage.getById(branch))?.playerStats)) as PlayerStats).inventory[0]?.itemId,
    replacementId,
  );

  await assert.rejects(
    () =>
      storage.create(
        {
          chatId: "identity-cross-chat",
          messageId: "message-0",
          swipeIndex: 0,
          date: null,
          time: null,
          location: null,
          weather: null,
          temperature: null,
          worldCustomFields: [],
          presentCharacters: [],
          recentEvents: [],
          playerStats: baseStats([
            { itemId: replacementId, name: "Apple", description: "", quantity: 1, location: "on_person" },
          ]),
          personaStats: null,
          fieldLocks: null,
          hiddenTrackerFields: null,
          committed: true,
        },
        null,
        { trustedInventoryIdentitySource: { snapshotId: String(historical?.id), chatId: "wrong-chat" } },
      ),
    /GAME_STATE_TRUSTED_INVENTORY_SOURCE_NOT_FOUND/,
    "cross-chat source cannot authorize copied IDs",
  );

  await db.insert(messages).values([
    {
      id: "identity-prior",
      chatId: "ordered-chat",
      role: "user",
      content: "",
      activeSwipeIndex: 1,
      extra: "{}",
      createdAt: "2020-01-01T00:00:00.000Z",
    },
    ...Array.from({ length: 201 }, (_, index) => ({
      id: `identity-gap-${String(index).padStart(3, "0")}`,
      chatId: "ordered-chat",
      role: "user" as const,
      content: "",
      activeSwipeIndex: 0,
      extra: "{}",
      createdAt: new Date(Date.UTC(2020, 0, 1, 0, 0, index + 1)).toISOString(),
    })),
    {
      id: "identity-target",
      chatId: "ordered-chat",
      role: "user",
      content: "",
      activeSwipeIndex: 0,
      extra: "{}",
      createdAt: new Date(Date.UTC(2020, 0, 1, 0, 0, 202)).toISOString(),
    },
  ]);
  const orderedSourceId = await storage.create({
    chatId: "ordered-chat",
    messageId: "identity-prior",
    swipeIndex: 1,
    date: null,
    time: null,
    location: null,
    weather: null,
    temperature: null,
    worldCustomFields: [],
    presentCharacters: [],
    recentEvents: [],
    playerStats: baseStats([{ name: "Ordered relic", description: "", quantity: 1, location: "on_person" }]),
    personaStats: null,
    fieldLocks: null,
    hiddenTrackerFields: null,
    committed: true,
  });
  const orderedSource = JSON.parse(String((await storage.getById(orderedSourceId))?.playerStats)) as PlayerStats;
  const orderedId = orderedSource.inventory[0]?.itemId;
  const orderedTargetId = await storage.create({
    chatId: "ordered-chat",
    messageId: "identity-target",
    swipeIndex: 0,
    date: null,
    time: null,
    location: null,
    weather: null,
    temperature: null,
    worldCustomFields: [],
    presentCharacters: [],
    recentEvents: [],
    playerStats: baseStats([{ name: "Ordered relic", description: "", quantity: 1, location: "on_person" }]),
    personaStats: null,
    fieldLocks: null,
    hiddenTrackerFields: null,
    committed: true,
  });
  const orderedTarget = JSON.parse(String((await storage.getById(orderedTargetId))?.playerStats)) as PlayerStats;
  assert.equal(orderedTarget.inventory[0]?.itemId, orderedId, "predecessor search uses active swipe beyond empty gaps");

  const futureId = await storage.create({
    chatId: "bootstrap-chat",
    messageId: "future-message",
    swipeIndex: 0,
    date: null,
    time: null,
    location: null,
    weather: null,
    temperature: null,
    worldCustomFields: [],
    presentCharacters: [],
    recentEvents: [],
    playerStats: baseStats([{ name: "Future item", description: "", quantity: 1, location: "on_person" }]),
    personaStats: null,
    fieldLocks: null,
    hiddenTrackerFields: null,
    committed: true,
  });
  const futureStats = JSON.parse(String((await storage.getById(futureId))?.playerStats)) as PlayerStats;
  const futureItemId = futureStats.inventory[0]?.itemId;
  const bootstrapId = await storage.create({
    chatId: "bootstrap-chat",
    messageId: "",
    swipeIndex: 0,
    date: null,
    time: null,
    location: null,
    weather: null,
    temperature: null,
    worldCustomFields: [],
    presentCharacters: [],
    recentEvents: [],
    playerStats: baseStats([{ name: "Future item", description: "", quantity: 1, location: "on_person" }]),
    personaStats: null,
    fieldLocks: null,
    hiddenTrackerFields: null,
    committed: true,
  });
  const bootstrapStats = JSON.parse(String((await storage.getById(bootstrapId))?.playerStats)) as PlayerStats;
  assert.ok(
    bootstrapStats.inventory[0]?.itemId && bootstrapStats.inventory[0]?.itemId !== futureItemId,
    "bootstrap never inherits a future message item",
  );

  const duplicate = await storage.create({
    chatId: "duplicate-chat",
    messageId: "message-0",
    swipeIndex: 0,
    date: null,
    time: null,
    location: null,
    weather: null,
    temperature: null,
    worldCustomFields: [],
    presentCharacters: [],
    recentEvents: [],
    playerStats: baseStats([
      { name: "Twin", description: "", quantity: 1, location: "on_person" },
      { name: " twin ", description: "", quantity: 1, location: "stored" },
    ]),
    personaStats: null,
    fieldLocks: null,
    hiddenTrackerFields: null,
    committed: true,
  });
  const duplicateStats = JSON.parse(String((await storage.getById(duplicate))?.playerStats)) as PlayerStats;
  assert.equal(duplicateStats.inventory[0]?.itemId, undefined, "ambiguous legacy rows remain held");
  assert.equal(duplicateStats.inventory[1]?.itemId, undefined, "ambiguous legacy rows remain held");

  const foreign = await storage.updateLatest("duplicate-chat", {
    playerStats: baseStats([
      { itemId: "client-forged", name: "New Name", description: "", quantity: 1, location: "on_person" },
    ]),
  });
  const foreignStats = JSON.parse(String(foreign?.playerStats)) as PlayerStats;
  assert.notEqual(foreignStats.inventory[0]?.itemId, "client-forged", "unknown client ID is never accepted");
  assert.ok(foreignStats.inventory[0]?.itemId, "new row receives a host ID");

  await closeDB();
  console.info("Inventory item identity regression passed");
} finally {
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  if (previousFileStorageDir === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousFileStorageDir;
  rmSync(fixtureDir, { recursive: true, force: true });
}
