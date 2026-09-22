import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Bug hunt: a projected entity takes its id and originChatId from the anchor (library card, newest session), but
// spreads every other field (revision, owner, manualLock, attributes, status) from `best` = the newest active copy.
//  A. Vigil's library card lives in S1; S2 tracked him as a game NPC. The page shows the NPC's owner and revision,
//     and the wiki edit (recordId = anchor id, expectedRevision = projected revision, sent to S1) is refused.
//  B. Archiving a page archives the anchor row, but any earlier-session copy is still active, so the projected
//     status stays "active": the archive never shows.
const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify");
const root = mkdtempSync(join(tmpdir(), "marinara-bughunt-entity-fields-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";

let db: any = null;
let app: any = null;
try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const schema = await import("../../packages/server/src/db/schema/index.js");
  const { campaignMemoryRoutes } = await import("../../packages/server/src/routes/campaign-memory.routes.js");
  const { campaignMemoryWriteRoutes } = await import("../../packages/server/src/routes/campaign-memory-write.routes.js");
  db = await createFileNativeDB();
  const game = "game-1";
  const at = (day: number) => `2026-09-${String(day).padStart(2, "0")}T00:00:00.000Z`;
  const provenance = JSON.stringify({ source: "regression", sourceRevision: "r1", actor: "system" });
  // Storage re-checks an entity's owner on every update, so the library cards must exist and be in the session.
  const chat = (id: string, session: number, day: number) => ({
    id, name: `Session ${session}`, mode: "game", groupId: game, characterIds: JSON.stringify(["card-vigil", "card-mira"]),
    metadata: JSON.stringify({ gameId: game, gameSessionNumber: session }), createdAt: at(day), updatedAt: at(day),
  });
  await db.insert(schema.chats).values([chat("s1", 1, 1), chat("s2", 2, 2)]);
  await db.insert(schema.characters).values([
    { id: "card-vigil", data: JSON.stringify({ name: "Vigil" }), comment: "", createdAt: at(1), updatedAt: at(1) },
    { id: "card-mira", data: JSON.stringify({ name: "Mira" }), comment: "", createdAt: at(1), updatedAt: at(1) },
  ]);
  const entity = (entityId: string, chatId: string, store: string, recordId: string, alias: string, day: number, extra = {}) => ({
    entityId, chatId, kind: "character", owner: JSON.stringify({ type: "existing", store, recordId }),
    aliases: JSON.stringify([alias]), tags: "[]", attributes: "{}", status: "active", manualLock: 0, provenance,
    revision: 1, createdAt: at(day), updatedAt: at(day), ...extra,
  });
  await db.insert(schema.campaignMemoryEntities).values([
    entity("s1-vigil", "s1", "characters", "card-vigil", "Vigil", 1, { revision: 2 }),
    entity("s2-vigil-npc", "s2", "game-npcs", "npc:vigil", "Vigil", 2),
    entity("s1-mira", "s1", "characters", "card-mira", "Mira", 1),
    entity("s2-mira", "s2", "characters", "card-mira", "Mira", 2, { status: "archived", revision: 2, updatedAt: at(3) }),
  ]);

  app = Fastify();
  app.decorate("db", db);
  await app.register(campaignMemoryRoutes);
  await app.register(campaignMemoryWriteRoutes);
  await app.ready();

  const list = (await app.inject({ method: "GET", url: "/s2/memory/entities" })).json();
  const vigil = list.items.find((item: any) => item.aliases[0] === "Vigil");
  const mira = list.items.find((item: any) => item.aliases[0] === "Mira");
  // What CampaignWikiEditor sends for an entity edit (full field set, so the partial-patch bug is not in play).
  const edit = await app.inject({
    method: "POST",
    url: `/${vigil.originChatId}/memory/mutations`,
    payload: {
      operationId: "edit-vigil", action: "update", recordType: "entity", recordId: vigil.entityId,
      expectedRevision: vigil.revision, reason: "summary",
      patch: { aliases: vigil.aliases, tags: [], attributes: {}, status: "active", manualLock: false, summary: "Captain of the watch." },
    },
  });
  assert.deepEqual(
    {
      vigilId: vigil.entityId,
      vigilOwner: vigil.owner.store,
      vigilRevision: vigil.revision,
      vigilEdit: edit.statusCode,
      miraStatus: mira.status,
    },
    { vigilId: "s1-vigil", vigilOwner: "characters", vigilRevision: 2, vigilEdit: 200, miraStatus: "archived" },
    `projected entity fields must describe the anchor row the wiki writes to:\n${edit.body}`,
  );
  console.log("bughunt projection entity fields regression passed");
} finally {
  await app?.close().catch(() => undefined);
  await db?._fileStore?.close().catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
}
