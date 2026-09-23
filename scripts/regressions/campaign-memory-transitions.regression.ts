import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = mkdtempSync(join(tmpdir(), "marinara-campaign-memory-transitions-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { chats, messages, characters, campaignMemoryMutationJournal } = await import("../../packages/server/src/db/schema/index.js");
  const { eq } = await import("../../packages/server/src/db/file-query.js");
  const { createCampaignMemoryStorage } = await import("../../packages/server/src/services/storage/campaign-memory.storage.js");
  const { applyCampaignMemoryTransition, compensateCampaignMemoryTransition } = await import("../../packages/server/src/services/game/campaign-memory-transitions.js");
  const db = await createFileNativeDB();
  const chatId = "transition-chat";
  const now = new Date().toISOString();
  await db.insert(chats).values({ id: chatId, name: "Transitions", mode: "game", characterIds: JSON.stringify(["alice", "bob", "duke"]), createdAt: now, updatedAt: now });
  await db.insert(characters).values([
    { id: "alice", data: "{}", createdAt: now, updatedAt: now },
    { id: "bob", data: "{}", createdAt: now, updatedAt: now },
    { id: "duke", data: "{}", createdAt: now, updatedAt: now },
  ]);
  const texts: Record<string, string> = {
    m0: "Alice lingered at the gate before dawn.",
    m1: "Alice stood at the gate. Bob counted five coins.",
    m2: "Alice walked to the tower. Bob gave Alice two coins. Bob offered Alice a place in his company. The duke offered Alice a job hauling stone.",
    m3: "Bob wandered to the market. Alice accepted the job.",
    m4: "Whispers said the duke was possibly poisoned.",
    m5: "Alice finished hauling the stone. Bob climbed the tower.",
  };
  await db.insert(messages).values(Object.entries(texts).map(([id, content], index) => ({ id, chatId, role: "assistant", content, createdAt: `2026-09-15T10:0${index}:00.000Z` })));

  const kinds: Record<string, "character" | "location" | "item" | "quest"> = { alice: "character", bob: "character", duke: "character", gate: "location", tower: "location", market: "location", coin: "item", job: "quest" };
  const stores: Record<string, string> = { character: "characters", location: "spatial-context", item: "game-state", quest: "game-state" };
  const ownerReader = {
    async readChatScope(id: string) { return { chatId: id, characterIds: ["alice", "bob", "duke"], questEntryIds: ["job"], itemIds: ["coin"], spatialDefinition: { locations: [{ id: "gate" }, { id: "tower" }, { id: "market" }] } } as never; },
    async readExistingOwner(owner: { store: string; recordId: string }) { const kind = kinds[owner.recordId]; return kind && stores[kind] === owner.store ? { store: owner.store, recordId: owner.recordId, kind } : null; },
  };
  const storage = createCampaignMemoryStorage(db, ownerReader);
  const provenance = { source: "regression", sourceRevision: "r1", actor: "user" as const };
  for (const [entityId, kind] of Object.entries(kinds)) {
    await storage.createEntity({ entityId, chatId, kind, owner: { type: "existing", store: stores[kind]!, recordId: entityId }, aliases: [entityId], tags: [], attributes: {}, status: "active", manualLock: false, provenance });
  }

  const scope = { chatId };
  const ev = (messageId: string, quote: string) => ({ messageId, quote });
  const cmd = (messageId: string, quote: string, rest: Record<string, unknown>) => ({ chatId, actor: "system" as const, reason: quote, source: { messageId }, evidence: [ev(messageId, quote)], basis: "observed" as const, ...rest }) as never;
  const journalCount = async () => (await db.select().from(campaignMemoryMutationJournal).where(eq(campaignMemoryMutationJournal.chatId, chatId))).length;
  const state = async (entityId: string, property: string) => (await storage.listCurrentState(scope)).find((s) => s.entityId === entityId && s.property === property);
  const code = (expected: string) => (e: unknown) => (e as { code?: string })?.code === expected;

  // Item transfer: acquisition seeds the giver, then a two-sided transfer repeated with the same source has exactly one effect.
  const seed = await applyCampaignMemoryTransition(db, cmd("m1", "Bob counted five coins", { class: "item-transfer", receiverEntityId: "bob", itemEntityId: "coin", quantity: 5 }));
  assert.equal(seed.status, "applied");
  assert.equal((await state("bob", "holding:coin"))!.value, 5);
  const transfer = cmd("m2", "Bob gave Alice two coins", { class: "item-transfer", giverEntityId: "bob", receiverEntityId: "alice", itemEntityId: "coin", quantity: 2 });
  const transferred = await applyCampaignMemoryTransition(db, transfer);
  assert.equal(transferred.status, "applied");
  assert.equal(transferred.replayed, false);
  assert.equal(transferred.operations.map((op) => op.recordType).join(","), "event,current-state,current-state");
  const journalAfterTransfer = await journalCount();
  const transferReplay = await applyCampaignMemoryTransition(db, transfer);
  assert.equal(transferReplay.replayed, true);
  assert.equal(transferReplay.transitionId, transferred.transitionId);
  assert.equal(await journalCount(), journalAfterTransfer);
  assert.equal((await state("bob", "holding:coin"))!.value, 3);
  assert.equal((await state("alice", "holding:coin"))!.value, 2);
  assert.equal((await state("alice", "holding:coin"))!.revision, 1);
  await assert.rejects(() => applyCampaignMemoryTransition(db, cmd("m2", "Bob gave Alice two coins", { class: "item-transfer", giverEntityId: "bob", receiverEntityId: "alice", itemEntityId: "coin", quantity: 3 })), code("CAMPAIGN_MEMORY_IDEMPOTENCY_CONFLICT"));
  const overdraw = await applyCampaignMemoryTransition(db, cmd("m3", "Bob wandered", { class: "item-transfer", giverEntityId: "bob", receiverEntityId: "alice", itemEntityId: "coin", quantity: 9 }));
  assert.equal(overdraw.status, "pending");
  assert.equal((await state("bob", "holding:coin"))!.value, 3);

  // Movement: repeat has one effect; an older movement delivered after a newer one keeps the newer location.
  const toGate = await applyCampaignMemoryTransition(db, cmd("m1", "Alice stood at the gate", { class: "movement", entityId: "alice", locationEntityId: "gate" }));
  assert.equal(toGate.status, "applied");
  const toTower = cmd("m2", "Alice walked to the tower", { class: "movement", entityId: "alice", locationEntityId: "tower" });
  const moved = await applyCampaignMemoryTransition(db, toTower);
  assert.equal(moved.status, "applied");
  assert.equal(moved.operations.find((op) => op.recordType === "current-state")!.action, "update");
  const journalAfterMove = await journalCount();
  assert.equal((await applyCampaignMemoryTransition(db, toTower)).replayed, true);
  assert.equal(await journalCount(), journalAfterMove);
  const aliceLocation = await state("alice", "location");
  assert.equal(aliceLocation!.value, "tower");
  assert.equal(aliceLocation!.revision, 2);
  const stale = await applyCampaignMemoryTransition(db, cmd("m0", "Alice lingered at the gate", { class: "movement", entityId: "alice", locationEntityId: "gate" }));
  assert.equal(stale.status, "stale");
  assert.equal(stale.operations.map((op) => op.recordType).join(","), "event");
  assert.match(stale.reasons.join(" "), /newer order/u);
  assert.equal((await state("alice", "location"))!.value, "tower");
  assert.equal((await state("alice", "location"))!.revision, 2);

  // Rumor: recorded only as an attributed claim; never a fact, state, or movement.
  const rumor = cmd("m4", "possibly poisoned", { class: "knowledge", basis: "rumor", holderEntityId: "alice", claim: { subjectEntityId: "duke", predicate: "poisoned", value: true }, epistemicState: "rumor" });
  const heard = await applyCampaignMemoryTransition(db, rumor);
  assert.equal(heard.status, "applied");
  const knowledge = (await storage.listKnowledge(scope)).filter((k) => k.holderEntityId === "alice");
  assert.equal(knowledge.length, 1);
  assert.equal(knowledge[0]!.epistemicState, "rumor");
  assert.equal(knowledge[0]!.attributedClaim?.predicate, "poisoned");
  assert.equal(knowledge[0]!.factId, undefined);
  assert.equal((await storage.listFacts(scope)).length, 0);
  assert.equal((await storage.listCurrentState(scope)).filter((s) => s.entityId === "duke").length, 0);
  assert.equal((await applyCampaignMemoryTransition(db, rumor)).replayed, true);
  await assert.rejects(() => applyCampaignMemoryTransition(db, cmd("m4", "possibly poisoned", { class: "knowledge", basis: "rumor", holderEntityId: "alice", claim: { subjectEntityId: "duke", predicate: "poisoned", value: true }, epistemicState: "knows" })), code("CAMPAIGN_MEMORY_INVALID_VALUE"));
  const rumoredMove = await applyCampaignMemoryTransition(db, cmd("m4", "Whispers said", { class: "movement", basis: "rumor", entityId: "duke", locationEntityId: "tower" }));
  assert.equal(rumoredMove.status, "pending");
  assert.equal(rumoredMove.operations.length, 0);
  assert.equal(await state("duke", "location"), undefined);

  // Offer: does not add a party member; relationship stays proposed until an observed acceptance.
  const offerActive = await applyCampaignMemoryTransition(db, cmd("m2", "Bob offered Alice a place in his company", { class: "relationship", basis: "offer", sourceEntityId: "alice", targetEntityId: "bob", type: "member-of-company", inverseLabel: "has-member", status: "active" }));
  assert.equal(offerActive.status, "pending");
  assert.equal((await storage.listRelationships(scope)).length, 0);
  const offer = cmd("m2", "Bob offered Alice a place in his company", { class: "relationship", basis: "offer", sourceEntityId: "alice", targetEntityId: "bob", type: "member-of-company", inverseLabel: "has-member", status: "proposed" });
  const proposed = await applyCampaignMemoryTransition(db, offer);
  assert.equal(proposed.status, "applied");
  assert.equal((await applyCampaignMemoryTransition(db, offer)).replayed, true);
  let edges = await storage.listRelationships(scope);
  assert.equal(edges.length, 1);
  assert.equal(edges[0]!.status, "proposed");
  const accept = cmd("m3", "Alice accepted", { class: "relationship", sourceEntityId: "alice", targetEntityId: "bob", type: "member-of-company", inverseLabel: "has-member", status: "active" });
  const accepted = await applyCampaignMemoryTransition(db, accept);
  assert.equal(accepted.status, "applied");
  assert.equal(accepted.operations[0]!.action, "update");
  assert.equal((await applyCampaignMemoryTransition(db, accept)).replayed, true);
  edges = await storage.listRelationships(scope);
  assert.equal(edges.length, 1);
  assert.equal(edges[0]!.status, "active");
  assert.equal(edges[0]!.revision, 2);
  const backlinks = await storage.listBacklinks(scope, "bob");
  assert.equal(backlinks.length, 1);
  assert.equal(backlinks[0]!.direction, "incoming");
  assert.equal(backlinks[0]!.label, "has-member");

  // Offer: does not complete employment; quest completion repeats once and illegal jumps stay pending.
  const offeredComplete = await applyCampaignMemoryTransition(db, cmd("m2", "The duke offered Alice a job", { class: "quest", basis: "offer", questEntityId: "job", status: "completed" }));
  assert.equal(offeredComplete.status, "pending");
  assert.equal(await state("job", "quest.status"), undefined);
  const questOffer = await applyCampaignMemoryTransition(db, cmd("m2", "The duke offered Alice a job", { class: "quest", basis: "offer", questEntityId: "job", status: "proposed" }));
  assert.equal(questOffer.status, "applied");
  assert.equal((await state("job", "quest.status"))!.value, "proposed");
  const jump = await applyCampaignMemoryTransition(db, cmd("m3", "Alice accepted the job", { class: "quest", questEntityId: "job", status: "completed" }));
  assert.equal(jump.status, "pending");
  assert.equal((await state("job", "quest.status"))!.value, "proposed");
  assert.equal((await applyCampaignMemoryTransition(db, cmd("m3", "Alice accepted the job", { class: "quest", questEntityId: "job", status: "accepted" }))).status, "applied");
  const complete = cmd("m5", "Alice finished hauling the stone", { class: "quest", questEntityId: "job", status: "completed", outcome: "stone hauled" });
  const completed = await applyCampaignMemoryTransition(db, complete);
  assert.equal(completed.status, "applied");
  const journalAfterComplete = await journalCount();
  assert.equal((await applyCampaignMemoryTransition(db, complete)).replayed, true);
  assert.equal(await journalCount(), journalAfterComplete);
  assert.equal((await state("job", "quest.status"))!.value, "completed");
  assert.equal((await state("job", "quest.status"))!.revision, 3);
  assert.equal((await state("job", "quest.outcome"))!.value, "stone hauled");
  assert.equal((await storage.listEvents(scope)).filter((e) => e.transitions.includes(completed.transitionId)).length, 1);

  // Rollback one operation with revision protection while an unrelated later change survives.
  const bobMove = await applyCampaignMemoryTransition(db, cmd("m3", "Bob wandered to the market", { class: "movement", entityId: "bob", locationEntityId: "market" }));
  assert.equal(bobMove.status, "applied");
  const undo = { chatId, transitionId: moved.transitionId, actor: "user" as const, reason: "the tower line was a misread" };
  const undone = await compensateCampaignMemoryTransition(db, undo);
  assert.equal(undone.operations.length, 1);
  assert.deepEqual(undone.skippedEventIds, [moved.operations[0]!.recordId]);
  const restored = await state("alice", "location");
  assert.equal(restored!.value, "gate");
  assert.equal(restored!.revision, 3);
  assert.equal((await state("bob", "location"))!.value, "market");
  assert.deepEqual(await compensateCampaignMemoryTransition(db, undo), { ...undone, replayed: true });
  await assert.rejects(() => compensateCampaignMemoryTransition(db, { chatId, transitionId: toGate.transitionId, actor: "user", reason: "stale undo" }), code("CAMPAIGN_MEMORY_CAS_MISMATCH"));
  assert.equal((await state("alice", "location"))!.value, "gate");
  const undoRow = (await storage.listMutationJournal(scope)).find((row) => row.operationId === undone.operationId);
  assert.equal(undoRow?.compensationOperationId, moved.transitionId);

  // Post-commit uncertainty: the commit lands, the caller sees a failure, and the retry discovers the operation.
  const flaky = new Proxy(db, { get(target, key, receiver) {
    if (key !== "transaction") return Reflect.get(target, key, receiver);
    return async (fn: (tx: typeof db) => Promise<unknown>, options?: { durable?: boolean }) => { await target.transaction(fn, options); throw new Error("connection lost after commit"); };
  } }) as typeof db;
  const bobClimb = cmd("m5", "Bob climbed the tower", { class: "movement", entityId: "bob", locationEntityId: "tower" });
  await assert.rejects(() => applyCampaignMemoryTransition(flaky, bobClimb), /connection lost after commit/u);
  const retried = await applyCampaignMemoryTransition(db, bobClimb);
  assert.equal(retried.replayed, true);
  assert.equal(retried.status, "applied");
  assert.equal((await state("bob", "location"))!.value, "tower");
  assert.equal((await storage.listEvents(scope)).filter((e) => e.transitions.includes(retried.transitionId)).length, 1);

  // Every transition needs evidence and a known source.
  await assert.rejects(() => applyCampaignMemoryTransition(db, { ...(cmd("m5", "Bob climbed the tower", { class: "movement", entityId: "bob", locationEntityId: "tower" }) as object), evidence: [] } as never), code("CAMPAIGN_MEMORY_INVALID_VALUE"));
  await assert.rejects(() => applyCampaignMemoryTransition(db, cmd("missing", "nothing", { class: "movement", entityId: "bob", locationEntityId: "tower" })), code("CAMPAIGN_MEMORY_INVALID_REFERENCE"));

  await db._fileStore.close();
  console.log("campaign memory transitions regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
