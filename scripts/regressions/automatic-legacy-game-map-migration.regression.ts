import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chats, spatialContextSnapshots } from "../../packages/server/src/db/schema/index.js";
import { createFileNativeDB } from "../../packages/server/src/db/file-backed-store.js";
import { eq } from "../../packages/server/src/db/file-query.js";
import {
  registerCapabilityService,
  resetCapabilityServices,
} from "../../packages/server/src/services/capability-packages/capability-service-registry.service.js";
import { migrateLegacyGameMapsAtBoot } from "../../packages/server/src/services/capability-packages/automatic-legacy-game-map-migration.js";

const root = mkdtempSync(join(tmpdir(), "marinara-legacy-map-migration-"));
const rollbackRoot = mkdtempSync(join(tmpdir(), "marinara-legacy-map-rollback-"));
process.env.FILE_STORAGE_DIR = root;
const now = new Date().toISOString();
const nodeMap = {
  id: "ashline",
  type: "node" as const,
  name: "Ashline",
  description: "Legacy source",
  nodes: [
    { id: "hidden", label: "Hidden", description: "Hidden node", emoji: "🌑", x: 1, y: 2, discovered: false },
    { id: "current", label: "Current Room", description: "Current", emoji: "🚪", x: 3, y: 4, discovered: true },
  ],
  edges: [{ from: "hidden", to: "current", label: "door" }],
  partyPosition: "current",
};

try {
  const db = await createFileNativeDB();
  const release = registerCapabilityService("hierarchical-maps:storage", { create: () => ({}) });
  await db.insert(chats).values([
    {
      id: "legacy",
      name: "Legacy",
      mode: "game",
      metadata: JSON.stringify({ gameMap: nodeMap, activeAgentIds: ["combat"], unrelated: "keep" }),
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "grid-active",
      name: "Grid active",
      mode: "game",
      metadata: JSON.stringify({ gameMap: { ...nodeMap, type: "grid", cells: [] }, gameMaps: [nodeMap] }),
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "malformed",
      name: "Malformed",
      mode: "game",
      metadata: JSON.stringify({ gameMap: { ...nodeMap, nodes: [nodeMap.nodes[0], nodeMap.nodes[0]] } }),
      createdAt: now,
      updatedAt: now,
    },
    { id: "conversation", name: "Conversation", mode: "conversation", metadata: "{}", createdAt: now, updatedAt: now },
  ]);
  await db.insert(spatialContextSnapshots).values({
    id: "existing-snapshot",
    chatId: "grid-active",
    messageId: "",
    swipeIndex: 0,
    currentLocationId: "current",
    definitionRevision: 1,
    source: "bootstrap",
    transitionCommandId: null,
    transitionPayloadHash: null,
    createdAt: now,
  });

  const first = await migrateLegacyGameMapsAtBoot(db);
  assert.equal(first.migrated, 1);
  assert.equal(first.failed, 1, "malformed chat is isolated");
  const migrated = (await db.select().from(chats).where(eq(chats.id, "legacy")))[0]!;
  const metadata = JSON.parse(migrated.metadata) as Record<string, any>;
  assert.deepEqual(metadata.gameMap, nodeMap, "legacy source map is retained");
  assert.equal(metadata.unrelated, "keep");
  assert.equal(metadata.gameSetupConfig.gameWorldMapMode, "hierarchical");
  assert.deepEqual(metadata.activeAgentIds, ["combat", "hierarchical-maps"]);
  const snapshot = (await db.select().from(spatialContextSnapshots).where(eq(spatialContextSnapshots.chatId, "legacy")))[0]!;
  assert.equal(snapshot.currentLocationId, "current");
  assert.equal(snapshot.source, "bootstrap");
  const definition = metadata.spatialContext;
  assert.equal(definition.locations.find((location: any) => location.id === "hidden").status, "archived");
  assert.deepEqual(definition.locations.find((location: any) => location.id === "hidden").links, [
    { targetId: "current", label: "door", bidirectional: true, state: "available" },
  ]);
  assert.equal((await migrateLegacyGameMapsAtBoot(db)).migrated, 0, "repeat boot is a no-op");
  assert.equal((await db.select().from(chats).where(eq(chats.id, "grid-active")))[0]!.metadata.includes("spatialContext"), false);
  release();
  await db._fileStore.close();

  // A snapshot write failure rolls the metadata write back with it.
  resetCapabilityServices();
  process.env.FILE_STORAGE_DIR = rollbackRoot;
  const rollbackDb = await createFileNativeDB();
  const rollbackRelease = registerCapabilityService("hierarchical-maps:storage", { create: () => ({}) });
  await rollbackDb.insert(chats).values({
    id: "rollback",
    name: "Rollback",
    mode: "game",
    metadata: JSON.stringify({ gameMap: nodeMap }),
    createdAt: now,
    updatedAt: now,
  });
  const rollbackResult = await migrateLegacyGameMapsAtBoot(rollbackDb, {
    beforeSnapshotInsert: () => {
      throw new Error("forced snapshot failure");
    },
  });
  assert.equal(rollbackResult.failed, 1);
  const rollbackChat = (await rollbackDb.select().from(chats).where(eq(chats.id, "rollback")))[0]!;
  assert.equal(JSON.parse(rollbackChat.metadata).spatialContext, undefined, "metadata rolls back with snapshot failure");
  assert.equal((await rollbackDb.select().from(spatialContextSnapshots)).length, 0);
  rollbackRelease();
  await rollbackDb._fileStore.close();
} finally {
  resetCapabilityServices();
  rmSync(root, { recursive: true, force: true });
  rmSync(rollbackRoot, { recursive: true, force: true });
}

console.info("Automatic legacy game map migration regressions passed.");
