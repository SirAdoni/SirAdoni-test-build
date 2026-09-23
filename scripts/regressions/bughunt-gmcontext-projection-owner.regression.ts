import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The campaign projection folds a tracked Game NPC into the library card of the same name, and keeps the card's
// entity id as the anchor. But every other field (owner, kind) is spread from the NEWEST entity of the group. When the
// NPC row was updated after the card row, the projected entity carries owner=game-npcs, so owner-based identity
// (party-speaker resolution, scene presence) can no longer find the library card.
const root = mkdtempSync(join(tmpdir(), "marinara-bughunt-owner-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";

let db: any = null;
const failures: string[] = [];
try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const schema = await import("../../packages/server/src/db/schema/index.js");
  const { readCampaignMemoryProjection } = await import(
    "../../packages/server/src/services/game/campaign-memory-campaign-scope.js"
  );
  const { resolvePresentEntityIds } = await import("../../packages/server/src/services/game/campaign-memory-context.js");
  const { resolveCanonicalPartyMemoryEntity } = await import("../../packages/server/src/routes/game.routes.js");
  db = await createFileNativeDB();
  const game = "game-1";
  const at = (day: number) => `2026-09-${String(day).padStart(2, "0")}T00:00:00.000Z`;
  const provenance = JSON.stringify({ source: "regression", sourceRevision: "r1", actor: "system" });
  const chat = (id: string, session: number, day: number) => ({
    id, name: `Session ${session}`, mode: "game", groupId: game, characterIds: "[]",
    metadata: JSON.stringify({ gameId: game, gameSessionNumber: session }), createdAt: at(day), updatedAt: at(day),
  });
  await db.insert(schema.chats).values([chat("s1", 1, 1), chat("s2", 2, 2)]);
  const entity = (entityId: string, chatId: string, store: string, recordId: string, alias: string, day: number) => ({
    entityId, chatId, kind: "character", owner: JSON.stringify({ type: "existing", store, recordId }),
    aliases: JSON.stringify([alias]), tags: "[]", attributes: "{}", status: "active", manualLock: 0, provenance,
    revision: 1, createdAt: at(day), updatedAt: at(day),
  });
  await db.insert(schema.campaignMemoryEntities).values([
    entity("s1-quenby", "s1", "characters", "card-quenby", "Quenby", 1),
    // Session 2 tracked the same person as a Game NPC; its row is newer.
    entity("s2-quenby-npc", "s2", "game-npcs", "npc:quenby", "Quenby", 2),
  ]);
  const projection = await readCampaignMemoryProjection(db, "s2");
  const quenby = projection.entities.filter((item: any) => item.aliases[0] === "Quenby");
  assert.equal(quenby.length, 1, "folded into one entity");
  assert.equal(quenby[0].entityId, "s1-quenby", "the library card anchors the id");
  try {
    assert.equal(quenby[0].owner.store, "characters", `projected owner is ${JSON.stringify(quenby[0].owner)}`);
  } catch (error) { failures.push(`owner: ${(error as Error).message}`); }
  const party = resolveCanonicalPartyMemoryEntity(projection.entities, "s2", "card-quenby");
  try {
    assert.ok(party.entity, `party speaker: ${party.reason}`);
  } catch (error) { failures.push(`party speaker: ${(error as Error).message}`); }
  const present = resolvePresentEntityIds(projection.entities, { characterIds: ["card-quenby"] });
  try {
    assert.deepEqual(present, ["s1-quenby"], `presence resolved ${JSON.stringify(present)}`);
  } catch (error) { failures.push(`presence: ${(error as Error).message}`); }
} finally {
  await db?._fileStore?.close?.();
  rmSync(root, { recursive: true, force: true });
}
if (failures.length) {
  console.error(`bughunt-gmcontext-projection-owner: ${failures.length} failing check(s)\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("bughunt-gmcontext-projection-owner regression passed");
