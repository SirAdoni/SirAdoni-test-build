import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Bug hunt: the campaign wiki shows projected ids (the merged entity's anchor id, facts of every session) and the
// client sends each write to one chat (recordWriteChatId). Any write that combines ids from two sessions is rejected
// by storage, because every reference must live in the write chat:
//  A. correction of an earlier-session fact: goes to the fact's chat with subjectEntityId = the page's anchor id
//     (CampaignWikiEditor.tsx correction request);
//  B. "who knows it" on a page: goes to the page's chat with a fact picked from the projected facts
//     (CampaignWikiCreateRecord.tsx knowledge request);
//  C. relationship to a page anchored in another session (target picked from the projected entity list).
const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify");
const root = mkdtempSync(join(tmpdir(), "marinara-bughunt-cross-write-"));
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
  const chat = (id: string, session: number, day: number) => ({
    id, name: `Session ${session}`, mode: "game", groupId: game, characterIds: "[]",
    metadata: JSON.stringify({ gameId: game, gameSessionNumber: session }), createdAt: at(day), updatedAt: at(day),
  });
  await db.insert(schema.chats).values([chat("s1", 1, 1), chat("s2", 2, 2)]);
  const entity = (entityId: string, chatId: string, recordId: string, alias: string) => ({
    entityId, chatId, kind: "character", owner: JSON.stringify({ type: "existing", store: "characters", recordId }),
    aliases: JSON.stringify([alias]), tags: "[]", attributes: "{}", status: "active", manualLock: 0, provenance,
    revision: 1, createdAt: at(1), updatedAt: at(1),
  });
  await db.insert(schema.campaignMemoryEntities).values([
    entity("s1-mira", "s1", "card-mira", "Mira"),
    entity("s2-mira", "s2", "card-mira", "Mira"),
    entity("s1-vigil", "s1", "card-vigil", "Vigil"),
  ]);
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

  // What the wiki shows on Mira's page in session 2.
  const detail = (await app.inject({ method: "GET", url: "/s2/memory/entities/s2-mira" })).json();
  const page = detail.entity;
  const oldFact = detail.facts.items.find((item: any) => item.factId === "f-s1");
  const list = (await app.inject({ method: "GET", url: "/s2/memory/entities" })).json();
  const vigil = list.items.find((item: any) => item.aliases[0] === "Vigil");
  assert.equal(page.originChatId, "s2");
  assert.equal(oldFact.originChatId, "s1");
  assert.equal(vigil.originChatId, "s1");
  const writeChat = (record: any) => record.originChatId ?? "s2";
  const post = (chatId: string, payload: unknown) =>
    app.inject({ method: "POST", url: `/${chatId}/memory/mutations`, payload });

  const correction = await post(writeChat(oldFact), {
    operationId: "correct-old", action: "create", recordType: "fact", reason: "correct",
    input: {
      subjectEntityId: page.entityId, predicate: "decision", value: "Mira swore to guard the gate.", conditions: [],
      status: "verified", evidence: [], supersedesFactId: oldFact.factId, manualLock: true,
    },
  });
  const knowledge = await post(writeChat(page), {
    operationId: "who-knows", action: "create", recordType: "knowledge", reason: "Vigil knows",
    input: { holderEntityId: page.entityId, factId: oldFact.factId, epistemicState: "knows", learnedFrom: [], manualLock: false },
  });
  const relationship = await post(writeChat(page), {
    operationId: "rel", action: "create", recordType: "relationship", reason: "allies",
    input: { sourceEntityId: page.entityId, targetEntityId: vigil.entityId, type: "ally-of", inverseLabel: "ally of", status: "active", evidence: [], manualLock: false },
  });
  // A: the page's anchor id (s2-mira) is swapped for Mira's row in session 1 (same library card), so it succeeds.
  // B and C cannot be mapped: session 2 holds no copy of the session 1 fact and no page for Vigil, and a record
  // written into a chat must reference that chat's rows. They are refused with a clear 409 instead of the storage
  // layer's bare INVALID_REFERENCE, so the wiki can tell the user to write it in the other session.
  assert.deepEqual(
    {
      correction: correction.statusCode,
      knowledge: knowledge.statusCode,
      knowledgeCode: knowledge.json().error?.code,
      relationship: relationship.statusCode,
      relationshipCode: relationship.json().error?.code,
    },
    {
      correction: 200,
      knowledge: 409,
      knowledgeCode: "CAMPAIGN_MEMORY_CROSS_SESSION_REFERENCE",
      relationship: 409,
      relationshipCode: "CAMPAIGN_MEMORY_CROSS_SESSION_REFERENCE",
    },
    `wiki writes that combine projected ids map to the write chat or fail clearly:\n${correction.body}\n${knowledge.body}\n${relationship.body}`,
  );
  assert.equal(correction.json().subjectEntityId, "s1-mira", "the correction's subject is mapped into session 1");
  assert.match(relationship.json().error.message, /Vigil has no page in that session yet/);

  // Once session 2 has its own page for Vigil, the same relationship write maps the session 1 id and succeeds.
  await db.insert(schema.campaignMemoryEntities).values([entity("s2-vigil", "s2", "card-vigil", "Vigil")]);
  const mapped = await post("s2", {
    operationId: "rel-2", action: "create", recordType: "relationship", reason: "allies",
    input: { sourceEntityId: page.entityId, targetEntityId: "s1-vigil", type: "ally-of", inverseLabel: "ally of", status: "active", evidence: [], manualLock: false },
  });
  assert.equal(mapped.statusCode, 200, mapped.body);
  assert.equal(mapped.json().targetEntityId, "s2-vigil");
  console.log("bughunt projection cross-session write regression passed");
} finally {
  await app?.close().catch(() => undefined);
  await db?._fileStore?.close().catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
}
