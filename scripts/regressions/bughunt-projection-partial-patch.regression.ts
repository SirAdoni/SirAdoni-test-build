import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Bug hunt: the wiki sends partial patches (only changed fields, CampaignWikiEditor.tsx), but the route's patch
// schemas reuse the create shapes: required create fields stay required (a fact edit of the value alone is refused)
// and `.default()` fields are filled in, so an entity edit of one field silently resets the others.
const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify");
const root = mkdtempSync(join(tmpdir(), "marinara-bughunt-patch-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";

let db: any = null;
let app: any = null;
try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const schema = await import("../../packages/server/src/db/schema/index.js");
  const { campaignMemoryWriteRoutes } = await import("../../packages/server/src/routes/campaign-memory-write.routes.js");
  const { createCampaignMemoryStorage } = await import("../../packages/server/src/services/storage/campaign-memory.storage.js");
  db = await createFileNativeDB();
  const at = "2026-09-01T00:00:00.000Z";
  const provenance = JSON.stringify({ source: "regression", sourceRevision: "r1", actor: "system" });
  await db.insert(schema.chats).values([{ id: "c1", name: "S1", mode: "game", characterIds: "[]", metadata: "{}", createdAt: at, updatedAt: at }]);
  await db.insert(schema.campaignMemoryEntities).values([{
    entityId: "note-1", chatId: "c1", kind: "note",
    owner: JSON.stringify({ type: "registry", store: "campaign-memory", recordId: "note-1" }),
    aliases: JSON.stringify(["Old Ledger"]), tags: JSON.stringify(["debt"]), attributes: JSON.stringify({ owes: 40 }),
    status: "archived", manualLock: 1, provenance, revision: 1, createdAt: at, updatedAt: at,
  }]);
  await db.insert(schema.campaignMemoryFacts).values([{
    factId: "f1", chatId: "c1", subjectEntityId: "note-1", predicate: "decision",
    value: JSON.stringify({ text: "Paid in full." }), conditions: "[]", status: "verified",
    sourceRevision: "r1", evidence: "[]", author: "system", provenance, manualLock: 0, revision: 1, createdAt: at, updatedAt: at,
  }]);
  app = Fastify();
  app.decorate("db", db);
  await app.register(campaignMemoryWriteRoutes);
  await app.ready();
  const post = (payload: unknown) => app.inject({ method: "POST", url: "/c1/memory/mutations", payload });

  const factEdit = await post({
    operationId: "fact-value", action: "update", recordType: "fact", recordId: "f1", expectedRevision: 1,
    reason: "fix", patch: { value: { text: "Paid half." } },
  });
  const entityEdit = await post({
    operationId: "entity-summary", action: "update", recordType: "entity", recordId: "note-1", expectedRevision: 1,
    reason: "summary", patch: { summary: "The harbour ledger." },
  });
  const entity = await createCampaignMemoryStorage(db).getEntity({ chatId: "c1" }, "note-1");
  assert.deepEqual(
    {
      factEdit: factEdit.statusCode,
      entityEdit: entityEdit.statusCode,
      aliases: entity?.aliases,
      tags: entity?.tags,
      attributes: entity?.attributes,
      status: entity?.status,
      manualLock: entity?.manualLock,
    },
    {
      factEdit: 200,
      entityEdit: 200,
      aliases: ["Old Ledger"],
      tags: ["debt"],
      attributes: { owes: 40 },
      status: "archived",
      manualLock: true,
    },
    `a partial patch changes only the fields it names:\n${factEdit.body}`,
  );
  console.log("bughunt projection partial patch regression passed");
} finally {
  await app?.close().catch(() => undefined);
  await db?._fileStore?.close().catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
}
