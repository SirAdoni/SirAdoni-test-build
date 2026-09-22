import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Bug hunt: a wiki edit of a projected record from an earlier session is written to that session's chat (the
// client's recordWriteChatId). The write bumps the table generation, so the projection is rebuilt, but the rebuild
// reads the earlier session through the 60 s memoryCache, which the mutation route never clears. The stale
// projection is then cached under the NEW generation, so it stays stale even after the 60 s TTL, until some
// unrelated write happens.
const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify");
const root = mkdtempSync(join(tmpdir(), "marinara-bughunt-stale-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";

let db: any = null;
let app: any = null;
const realNow = Date.now;
try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const schema = await import("../../packages/server/src/db/schema/index.js");
  const { campaignMemoryRoutes } = await import("../../packages/server/src/routes/campaign-memory.routes.js");
  const { campaignMemoryWriteRoutes } = await import("../../packages/server/src/routes/campaign-memory-write.routes.js");
  db = await createFileNativeDB();
  const game = "game-1";
  const at = (day: number) => `2026-09-${String(day).padStart(2, "0")}T00:00:00.000Z`;
  const provenance = JSON.stringify({ source: "regression", sourceRevision: "r1", actor: "system" });
  const chat = (id: string, session: number, day: number) => ({
    id, name: `Session ${session}`, mode: "game", groupId: game, characterIds: "[]",
    metadata: JSON.stringify({ gameId: game, gameSessionNumber: session }), createdAt: at(day), updatedAt: at(day),
  });
  await db.insert(schema.chats).values([chat("s1", 1, 1), chat("s2", 2, 2)]);
  const entity = (entityId: string, chatId: string) => ({
    entityId, chatId, kind: "character", owner: JSON.stringify({ type: "existing", store: "characters", recordId: "card-mira" }),
    aliases: JSON.stringify(["Mira"]), tags: "[]", attributes: "{}", status: "active", manualLock: 0, provenance,
    revision: 1, createdAt: at(1), updatedAt: at(1),
  });
  await db.insert(schema.campaignMemoryEntities).values([entity("s1-mira", "s1"), entity("s2-mira", "s2")]);
  await db.insert(schema.campaignMemoryFacts).values([{
    factId: "f-s1", chatId: "s1", subjectEntityId: "s1-mira", predicate: "decision",
    value: JSON.stringify({ text: "Mira swore to guard the vault." }), conditions: "[]", status: "verified",
    sourceRevision: "r1", evidence: "[]", author: "system", provenance, manualLock: 0, revision: 1,
    createdAt: at(1), updatedAt: at(1),
  }]);

  app = Fastify();
  app.decorate("db", db);
  await app.register(campaignMemoryRoutes);
  await app.register(campaignMemoryWriteRoutes);
  await app.ready();

  const readFact = async () => {
    const res = await app.inject({ method: "GET", url: "/s2/memory/entities/s2-mira" });
    assert.equal(res.statusCode, 200, res.body);
    const fact = res.json().facts.items.find((item: any) => item.factId === "f-s1");
    assert.ok(fact, "the session 1 fact is projected into session 2");
    return fact;
  };
  const before = await readFact();
  assert.equal(before.originChatId, "s1");

  // The wiki editor sends the edit to the record's own session.
  const write = await app.inject({
    method: "POST",
    url: `/${before.originChatId}/memory/mutations`,
    payload: {
      operationId: "edit-old-fact", action: "update", recordType: "fact", recordId: "f-s1",
      expectedRevision: before.revision, reason: "fix wording",
      // Full patch: the fact patch schema requires predicate and value (see bughunt-projection-partial-patch).
      patch: { predicate: "decision", value: { text: "Mira swore to guard the gate." }, status: "verified" },
    },
  });
  assert.equal(write.statusCode, 200, write.body);

  const after = await readFact();

  // Even long after the earlier-session TTL the cached projection must not keep the old text.
  Date.now = () => realNow() + 10 * 60_000;
  const later = await readFact();
  assert.deepEqual(
    { immediately: after.value.text, tenMinutesLater: later.value.text },
    { immediately: "Mira swore to guard the gate.", tenMinutesLater: "Mira swore to guard the gate." },
    "an edit of an earlier-session fact shows at once and the stale projection is never pinned to the new generation",
  );
  console.log("bughunt projection stale earlier session regression passed");
} finally {
  Date.now = realNow;
  await app?.close().catch(() => undefined);
  await db?._fileStore?.close().catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
}
