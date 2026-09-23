import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Bug hunt: the one-word fold ("Quilla" -> "Quilla Tallis") also runs when both entities were tracked side by side
// in the SAME session chat, where they are demonstrably two people (the tracker kept them apart). Because every
// wiki read goes through the projection, even a single-session game merges them: one page, the other's facts
// attributed to it, and the relationship between them dropped as a self-loop.
const root = mkdtempSync(join(tmpdir(), "marinara-bughunt-oneword-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";

let db: any = null;
try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const schema = await import("../../packages/server/src/db/schema/index.js");
  const { readCampaignMemoryProjection } = await import(
    "../../packages/server/src/services/game/campaign-memory-campaign-scope.js"
  );
  db = await createFileNativeDB();
  const game = "game-1";
  const at = "2026-09-01T00:00:00.000Z";
  const provenance = JSON.stringify({ source: "regression", sourceRevision: "r1", actor: "system" });
  await db.insert(schema.chats).values([{
    id: "s1", name: "Session 1", mode: "game", groupId: game, characterIds: "[]",
    metadata: JSON.stringify({ gameId: game, gameSessionNumber: 1 }), createdAt: at, updatedAt: at,
  }]);
  const npc = (entityId: string, recordId: string, alias: string) => ({
    entityId, chatId: "s1", kind: "character", owner: JSON.stringify({ type: "existing", store: "game-npcs", recordId }),
    aliases: JSON.stringify([alias]), tags: "[]", attributes: "{}", status: "active", manualLock: 0, provenance,
    revision: 1, createdAt: at, updatedAt: at,
  });
  await db.insert(schema.campaignMemoryEntities).values([
    npc("ash", "npc:ash", "Ash"),
    npc("ash-vale", "npc:ash-vale", "Ash Vale"),
  ]);
  await db.insert(schema.campaignMemoryRelationships).values([{
    relationshipId: "rel-1", chatId: "s1", sourceEntityId: "ash-vale", targetEntityId: "ash", type: "parent-of",
    inverseLabel: "child of", status: "active", evidence: "[]", provenance, manualLock: 0, revision: 1,
    createdAt: at, updatedAt: at,
  }]);
  const projection = await readCampaignMemoryProjection(db, "s1");
  assert.deepEqual(
    {
      entities: projection.entities.map((item: any) => item.entityId).sort(),
      relationships: projection.relationships.map((item: any) => item.relationshipId),
    },
    { entities: ["ash", "ash-vale"], relationships: ["rel-1"] },
    "two people tracked separately in one session stay two pages",
  );
  console.log("bughunt projection one-word fold regression passed");
} finally {
  await db?._fileStore?.close?.().catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
}
