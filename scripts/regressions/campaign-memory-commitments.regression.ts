import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Pulse 8 commitments: continuity-published offer facts project as commitments, the value schema is
// validated, transitions follow the quest machine, stale revisions conflict, and history is preserved.
const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify");
const root = mkdtempSync(join(tmpdir(), "marinara-campaign-memory-commitments-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { chats, messages } = await import("../../packages/server/src/db/schema/index.js");
  const { createCampaignMemoryStorage } = await import("../../packages/server/src/services/storage/campaign-memory.storage.js");
  const { campaignMemoryCommitmentsRoutes } = await import("../../packages/server/src/routes/campaign-memory-commitments.routes.js");
  const { projectCampaignMemoryCommitments, validateCampaignMemoryCommitmentValue, canTransitionCampaignMemoryCommitment } =
    await import("../../packages/server/src/services/game/campaign-memory-commitments.js");
  const db = await createFileNativeDB();
  const chatId = "commit-chat";
  const t0 = new Date("2026-09-15T10:00:00.000Z");
  const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000).toISOString();
  await db.insert(chats).values({ id: chatId, name: "Commitments", mode: "game", characterIds: "[]", createdAt: at(0), updatedAt: at(0) });
  await db.insert(messages).values([
    { id: "msg-offer", chatId, role: "assistant", content: "The duchess offers Mira a post at court.", createdAt: at(1) },
    { id: "msg-accept", chatId, role: "user", content: "Mira accepts the offer.", createdAt: at(2) },
    { id: "msg-done", chatId, role: "assistant", content: "Mira takes up her post at court.", createdAt: at(3) },
  ]);
  const storage = createCampaignMemoryStorage(db);
  const provenance = { source: "commitments-regression", sourceRevision: "r1", actor: "system" as const };
  const entity = (entityId: string, alias: string) =>
    storage.createEntity({ entityId, chatId, kind: "note", owner: { type: "registry", store: "campaign-memory", recordId: entityId }, aliases: [alias], tags: [], attributes: {}, status: "active", manualLock: false, provenance });
  await entity("mira", "Mira");
  await entity("duchess", "The Duchess");
  const offerEvidence = [{ messageId: "msg-offer", quote: "offers Mira a post", sourceHash: hash("The duchess offers Mira a post at court.") }];
  // Shape published by continuity-memory-publication.ts for a per-subject offer record (predicate = record kind).
  await storage.createFact({
    factId: "fact-offer", chatId, subjectEntityId: "mira", predicate: "offer",
    value: { text: "A post at court", status: "proposed", conditions: ["Arrive before the feast"], evidence: offerEvidence, subject: "Mira", kind: "offer", keys: [], receiptId: "gch_1", historical: true, recordId: "rec-1" },
    conditions: [{ kind: "continuity.condition", value: "Arrive before the feast" }], status: "verified", validFromOrder: "m1|2026-09-15T10:01:00.000Z|msg-offer",
    sourceRevision: "r1", evidence: offerEvidence, author: "import", provenance: { ...provenance, actor: "import" }, manualLock: false,
  });
  await storage.createFact({
    factId: "fact-plain", chatId, subjectEntityId: "mira", predicate: "title", value: "Courtier", conditions: [], status: "verified",
    sourceRevision: "r1", evidence: [], author: "system", provenance, manualLock: false,
  });

  // Pure projection and validation.
  const facts = await storage.listFacts({ chatId });
  const entities = await storage.listEntities({ chatId });
  const projectedItems = projectCampaignMemoryCommitments(facts, entities);
  assert.equal(projectedItems.length, 1, "only commitment-like facts project");
  assert.deepEqual(
    { kind: projectedItems[0]!.kind, state: projectedItems[0]!.state, title: projectedItems[0]!.title, historical: projectedItems[0]!.historical, conditions: projectedItems[0]!.conditions },
    { kind: "offer", state: "proposed", title: "A post at court", historical: true, conditions: ["Arrive before the feast"] },
  );
  assert.deepEqual(projectedItems[0]!.participants, [{ entityId: "mira", role: "subject", alias: "Mira" }]);
  assert.equal(projectedItems[0]!.openSince, "m1|2026-09-15T10:01:00.000Z|msg-offer");
  assert.throws(() => validateCampaignMemoryCommitmentValue({ kind: "quest", title: "x", state: "done", conditions: [], deadline: null, participants: [], notes: "" }), /state is invalid/);
  assert.throws(() => validateCampaignMemoryCommitmentValue({ kind: "quest", title: "x", state: "active", conditions: [], deadline: null, participants: [], notes: "", extra: 1 }), /forbidden/);
  assert.equal(canTransitionCampaignMemoryCommitment("completed", "active"), false, "completed is terminal");
  assert.equal(canTransitionCampaignMemoryCommitment("unresolved", "active"), true, "unresolved may resolve anywhere");

  const app = Fastify();
  app.decorate("db", db);
  await app.register(campaignMemoryCommitmentsRoutes, { prefix: "/api/game" });
  await app.ready();
  const get = (url: string) => app.inject({ method: "GET", url });
  const post = (url: string, payload: unknown) => app.inject({ method: "POST", url, payload });

  let response = await get(`/api/game/${chatId}/memory/commitments`);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().items[0].commitmentId, "fact-offer", "continuity offer fact lists as a commitment");
  assert.equal(response.json().nextCursor, null);

  // Create: schema validation, evidence rule, user-authored without evidence.
  const questValue = { kind: "quest", title: "Recover the seal", state: "proposed", conditions: ["Before the moot"], deadline: "the autumn moot", participants: [{ entityId: "mira", role: "bearer" }, { entityId: "duchess", role: "patron" }], notes: "" };
  response = await post(`/api/game/${chatId}/memory/commitments`, { value: { ...questValue, state: "finished" }, author: "user" });
  assert.equal(response.statusCode, 400, "invalid state is rejected");
  response = await post(`/api/game/${chatId}/memory/commitments`, { value: questValue });
  assert.equal(response.statusCode, 400, "evidence is required unless user-authored");
  response = await post(`/api/game/${chatId}/memory/commitments`, { operationId: "commit-create-1", value: questValue, author: "user", reason: "GM records the quest" });
  assert.equal(response.statusCode, 201, response.body);
  const quest = response.json();
  assert.equal(quest.kind, "quest");
  assert.equal(quest.participants[1].alias, "The Duchess");
  assert.equal(quest.transitions.length, 1);
  const created = await storage.getFact({ chatId }, quest.commitmentId);
  assert.equal(created?.author, "user");
  assert.equal(created?.predicate, "commitment");

  // Transition: legal, with evidence; history is a new fact and the old value is untouched.
  const acceptEvidence = [{ messageId: "msg-accept", quote: "Mira accepts the offer.", sourceHash: hash("Mira accepts the offer.") }];
  response = await post(`/api/game/${chatId}/memory/commitments/fact-offer/transition`, { state: "accepted", expectedRevision: 1, evidence: acceptEvidence, operationId: "commit-accept-1", reason: "Mira accepted" });
  assert.equal(response.statusCode, 200, response.body);
  const accepted = response.json();
  assert.notEqual(accepted.commitmentId, "fact-offer", "a transition creates a new head fact");
  assert.equal(accepted.state, "accepted");
  assert.equal(accepted.kind, "offer");
  assert.equal(accepted.historical, true, "continuity origin stays visible through the chain");
  assert.deepEqual(accepted.transitions.map((x: { factId: string; state: string }) => [x.factId, x.state]), [["fact-offer", "proposed"], [accepted.commitmentId, "accepted"]]);
  assert.deepEqual(accepted.transitions[1].evidenceMessageIds, ["msg-accept"]);
  assert.equal(accepted.transitions[1].sourceOrder, "m1|2026-09-15T10:02:00.000Z|msg-accept");
  const original = await storage.getFact({ chatId }, "fact-offer");
  assert.equal((original?.value as { status: string }).status, "proposed", "the original value is never mutated");
  assert.equal(original?.status, "superseded", "the original row is linked as the previous version");
  const head = await storage.getFact({ chatId }, accepted.commitmentId);
  assert.equal(head?.supersedesFactId, "fact-offer");

  // Stale revision and non-head conflicts, illegal transition.
  response = await post(`/api/game/${chatId}/memory/commitments/fact-offer/transition`, { state: "declined", expectedRevision: 1, operationId: "commit-stale" });
  assert.equal(response.statusCode, 409, "stale revision conflicts");
  response = await post(`/api/game/${chatId}/memory/commitments/fact-offer/transition`, { state: "declined", expectedRevision: 2, operationId: "commit-nonhead" });
  assert.equal(response.statusCode, 409, "an already superseded head conflicts");
  response = await post(`/api/game/${chatId}/memory/commitments/${accepted.commitmentId}/transition`, { state: "proposed", expectedRevision: 1, operationId: "commit-illegal" });
  assert.equal(response.statusCode, 400, "accepted cannot go back to proposed");
  assert.equal(response.json().error.code, "CAMPAIGN_MEMORY_ILLEGAL_TRANSITION");
  response = await post(`/api/game/${chatId}/memory/commitments/missing/transition`, { state: "accepted", expectedRevision: 1 });
  assert.equal(response.statusCode, 404);
  response = await post(`/api/game/${chatId}/memory/commitments/${accepted.commitmentId}/transition`, { state: "completed", expectedRevision: 1, operationId: "commit-done", evidence: [{ messageId: "msg-done", quote: "takes up her post", sourceHash: hash("Mira takes up her post at court.") }], deadline: "", notes: "Sworn in at court" });
  assert.equal(response.statusCode, 200, response.body);
  const completed = response.json();
  assert.equal(completed.transitions.length, 3, "history keeps every transition");
  assert.equal(completed.openSince, null, "closed commitments have no open-since order");
  assert.equal(completed.deadline, null);

  // Listing: order by newest transition, filters, paging.
  response = await get(`/api/game/${chatId}/memory/commitments`);
  assert.deepEqual(response.json().items.map((x: { commitmentId: string }) => x.commitmentId), [completed.commitmentId, quest.commitmentId], "newest transition order first");
  response = await get(`/api/game/${chatId}/memory/commitments?state=proposed`);
  assert.deepEqual(response.json().items.map((x: { commitmentId: string }) => x.commitmentId), [quest.commitmentId]);
  response = await get(`/api/game/${chatId}/memory/commitments?entityId=duchess`);
  assert.deepEqual(response.json().items.map((x: { commitmentId: string }) => x.commitmentId), [quest.commitmentId], "participant filter");
  response = await get(`/api/game/${chatId}/memory/commitments?limit=1`);
  assert.equal(response.json().items.length, 1);
  assert.equal(response.json().nextCursor, completed.commitmentId);
  response = await get(`/api/game/${chatId}/memory/commitments?limit=1&cursor=${completed.commitmentId}`);
  assert.equal(response.json().items[0].commitmentId, quest.commitmentId);
  assert.equal(response.json().nextCursor, null);
  response = await get(`/api/game/${chatId}/memory/commitments?cursor=nope`);
  assert.equal(response.statusCode, 400);
  response = await get(`/api/game/no-such-chat/memory/commitments`);
  assert.equal(response.statusCode, 404);

  await app.close();
  await db._fileStore.close();
  console.log("campaign-memory-commitments regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
