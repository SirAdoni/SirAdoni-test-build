import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GameContinuityReceipt } from "@marinara-engine/shared";

const root = mkdtempSync(join(tmpdir(), "marinara-continuity-memory-knowledge-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
let db: any;

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const schema = await import("../../packages/server/src/db/schema/index.js");
  const { eq } = await import("../../packages/server/src/db/file-query.js");
  const { createGameContinuityStorage } = await import("../../packages/server/src/services/storage/game-continuity.storage.js");
  const { prepareContinuitySources } = await import("../../packages/server/src/services/game/continuity-sources.js");
  const { createGameContinuityRecordId } = await import("../../packages/server/src/services/game/continuity-review.js");
  const { readContinuityConfig } = await import("../../packages/server/src/services/game/continuity-provider.js");
  const { publishContinuityReceipt } = await import("../../packages/server/src/services/game/continuity-publication.js");
  const { publishContinuityMemory } = await import("../../packages/server/src/services/game/continuity-memory-publication.js");
  const { readCampaignMemorySources } = await import("../../packages/server/src/services/game/campaign-memory-sources.js");

  let armed = false;
  db = await createFileNativeDB({ beforeTableWrite: (table) => {
    if (armed && table.startsWith("campaign_memory_knowledge")) {
      armed = false;
      throw new Error("injected knowledge publication failure");
    }
  } });
  const now = "2026-09-13T00:00:00.000Z";
  await db.insert(schema.apiConnections).values({ id: "conn", name: "Knowledge test", provider: "custom", model: "test", createdAt: now, updatedAt: now });
  await db.insert(schema.characters).values({ id: "char-1", data: JSON.stringify({ name: "Renamed Holder" }), createdAt: now, updatedAt: now });
  await db.insert(schema.chats).values({ id: "chat", name: "Knowledge", mode: "game", connectionId: "conn", characterIds: JSON.stringify(["char-1"]), metadata: JSON.stringify({ gameContinuity: { mode: "active" } }), createdAt: now, updatedAt: now });
  await db.insert(schema.messages).values({ id: "m1", chatId: "chat", role: "user", content: "Renamed Holder knows the gate is open.", createdAt: now });
  await db.insert(schema.lorebooks).values({ id: "book", name: "Keeper", chatId: "chat", enabled: "false", sourceAgentId: "game-lorebook-keeper", createdAt: now, updatedAt: now });
  await db.insert(schema.campaignMemoryEntities).values({ entityId: "holder-entity", chatId: "chat", kind: "character", owner: JSON.stringify({ type: "existing", store: "characters", recordId: "char-1" }), aliases: JSON.stringify(["Original Holder"]), tags: "[]", attributes: "{}", status: "active", manualLock: 0, provenance: JSON.stringify({ source: "test", sourceRevision: "fixture", actor: "user", origin: { sourceChatId: "chat", sourceRecordId: "char-1" } }), createdAt: now, updatedAt: now });

  const messages = await db.select().from(schema.messages).where(eq(schema.messages.chatId, "chat"));
  const prepared = prepareContinuitySources(messages, { gameContinuity: { mode: "active" } });
  const source = prepared[0]!;
  const config = await readContinuityConfig(db, "chat");
  const raw = { kind: "learning" as const, text: "The gate is open.", subjects: ["Renamed Holder"], conditions: [], status: "accepted" as const, keys: ["gate"], evidence: [{ messageId: "m1", quote: "Renamed Holder knows the gate is open." }], knowledge: { scope: "belief" as const, holders: ["Original Holder"], holderRefs: ["holder-entity"] } };
  const record = { ...raw, id: createGameContinuityRecordId("r1", raw) };
  const receipt: GameContinuityReceipt = { id: "r1", chatId: "chat", sessionNumber: 1, sourceHash: hash({ source: "r1" }), sources: prepared, context: [], configHash: config.hash, config: config.frozen, status: "verified", attempts: 1, repairAttempts: 0, records: [record], dispositions: prepared.map((item) => ({ messageId: item.messageId, status: "covered" as const, reason: "explicit source" })), review: { findings: [], dispositions: prepared.map((item) => ({ messageId: item.messageId, status: "covered" as const, reason: "clean" })) }, entryIds: [], knowledgeHolders: [{ entityId: "holder-entity", kind: "character", store: "characters", recordId: "char-1", name: "Original Holder" }], createdAt: now, updatedAt: now };
  await createGameContinuityStorage(db).enqueue(receipt);
  const counts = async () => ({ entries: (await db.select().from(schema.lorebookEntries)).length, entities: (await db.select().from(schema.campaignMemoryEntities)).length, facts: (await db.select().from(schema.campaignMemoryFacts)).length, knowledge: (await db.select().from(schema.campaignMemoryKnowledge)).length, journal: (await db.select().from(schema.campaignMemoryMutationJournal)).length });
  const before = await counts();
  armed = true;
  await assert.rejects(() => publishContinuityReceipt(db, receipt.id), /injected knowledge publication failure/u);
  assert.equal((await createGameContinuityStorage(db).get(receipt.id))?.status, "verified");
  assert.deepEqual(await counts(), before);
  await db._fileStore.close();
  db = await createFileNativeDB();
  assert.equal((await createGameContinuityStorage(db).get(receipt.id))?.status, "verified");
  assert.deepEqual(await counts(), before);

  const published = await publishContinuityReceipt(db, receipt.id);
  assert.equal(published?.status, "published");
  const entryId = `gce_${hash(receipt.id).slice(0, 32)}`;
  const knowledgeId = `cmk_${hash({ chatId: "chat", receiptId: "r1", recordId: record.id, holderRef: "holder-entity", sourceRevision: receipt.sourceHash }).slice(0, 32)}`;
  const factId = `cmf_${hash({ chatId: "chat", receiptId: "r1", recordId: record.id, sourceRevision: receipt.sourceHash }).slice(0, 32)}`;
  assert.equal((await db.select().from(schema.lorebookEntries).where(eq(schema.lorebookEntries.id, entryId))).length, 1);
  assert.equal((await db.select().from(schema.campaignMemoryFacts).where(eq(schema.campaignMemoryFacts.factId, factId))).length, 1);
  const knowledge = (await db.select().from(schema.campaignMemoryKnowledge).where(eq(schema.campaignMemoryKnowledge.knowledgeId, knowledgeId))).at(0)!;
  assert.ok(knowledge);
  assert.equal(knowledge.holderEntityId, "holder-entity");
  assert.equal(knowledge.factId, factId);
  assert.equal(knowledge.epistemicState, "believes");
  const canonicalSource = (await readCampaignMemorySources(db, { chatId: "chat" })).get("m1")!;
  assert.deepEqual(JSON.parse(knowledge.learnedFrom), [{ messageId: "m1", quote: raw.evidence[0]!.quote, sourceHash: canonicalSource.sourceHash }]);
  assert.equal((await db.select().from(schema.campaignMemoryMutationJournal)).filter((row: any) => row.recordType === "knowledge").length, 1);

  await db.update(schema.campaignMemoryKnowledge).set({ epistemicState: "manual-belief", manualLock: 1 }).where(eq(schema.campaignMemoryKnowledge.knowledgeId, knowledgeId));
  const entry = (await db.select().from(schema.lorebookEntries).where(eq(schema.lorebookEntries.id, entryId))).at(0)!;
  await db.transaction((tx: any) => publishContinuityMemory(tx, receipt, entry, messages, prepared));
  const replayed = (await db.select().from(schema.campaignMemoryKnowledge).where(eq(schema.campaignMemoryKnowledge.knowledgeId, knowledgeId))).at(0)!;
  assert.equal(replayed.epistemicState, "manual-belief");
  assert.equal(replayed.manualLock, 1);

  const denied = async (id: string, holder: any, mutate: () => Promise<void>) => {
    const variant = { ...receipt, id, records: [{ ...record, id: createGameContinuityRecordId(id, raw) }], knowledgeHolders: [holder] } as GameContinuityReceipt;
    await db.update(schema.lorebookEntries).set({ dynamicState: JSON.stringify({ receiptId: id, publishedContentHash: hash(entry.content) }) }).where(eq(schema.lorebookEntries.id, entryId));
    await mutate();
    const beforeKnowledge = (await db.select().from(schema.campaignMemoryKnowledge)).length;
    await publishContinuityMemory(db, variant, entry, messages, prepared);
    assert.equal((await db.select().from(schema.campaignMemoryKnowledge)).length, beforeKnowledge);
  };
  await denied("cross-chat", receipt.knowledgeHolders![0]!, async () => { await db.update(schema.campaignMemoryEntities).set({ chatId: "other-chat" }).where(eq(schema.campaignMemoryEntities.entityId, "holder-entity")); });
  await db.update(schema.campaignMemoryEntities).set({ chatId: "chat" }).where(eq(schema.campaignMemoryEntities.entityId, "holder-entity"));
  await denied("archived", receipt.knowledgeHolders![0]!, async () => { await db.update(schema.campaignMemoryEntities).set({ status: "archived" }).where(eq(schema.campaignMemoryEntities.entityId, "holder-entity")); });
  await db.update(schema.campaignMemoryEntities).set({ status: "active" }).where(eq(schema.campaignMemoryEntities.entityId, "holder-entity"));
  await denied("deleted", receipt.knowledgeHolders![0]!, async () => { await db.delete(schema.characters).where(eq(schema.characters.id, "char-1")); });

  // Belief/listener contract: being told a speaker's assessment grants the
  // listener awareness of the communication, never the speaker's belief.
  await db.insert(schema.characters).values([
    { id: "belief-speaker", data: JSON.stringify({ name: "Edmund" }), createdAt: now, updatedAt: now },
    { id: "belief-listener", data: JSON.stringify({ name: "Zerah" }), createdAt: now, updatedAt: now },
  ]);
  await db.insert(schema.chats).values({ id: "belief-chat", name: "Belief Listener", mode: "game", connectionId: "conn", characterIds: JSON.stringify(["belief-speaker", "belief-listener"]), metadata: JSON.stringify({ gameContinuity: { mode: "active" } }), createdAt: now, updatedAt: now });
  const beliefQuote = "Edmund tells Zerah: Tilda is brilliant.";
  await db.insert(schema.messages).values({ id: "belief-m1", chatId: "belief-chat", role: "assistant", content: beliefQuote, createdAt: now });
  await db.insert(schema.lorebooks).values({ id: "belief-book", name: "Belief Keeper", chatId: "belief-chat", enabled: "false", sourceAgentId: "game-lorebook-keeper", createdAt: now, updatedAt: now });
  await db.insert(schema.campaignMemoryEntities).values([
    { entityId: "belief-speaker-entity", chatId: "belief-chat", kind: "character", owner: JSON.stringify({ type: "existing", store: "characters", recordId: "belief-speaker" }), aliases: "[]", tags: "[]", attributes: "{}", status: "active", manualLock: 0, provenance: JSON.stringify({ source: "test", sourceRevision: "belief", actor: "user" }), createdAt: now, updatedAt: now },
    { entityId: "belief-listener-entity", chatId: "belief-chat", kind: "character", owner: JSON.stringify({ type: "existing", store: "characters", recordId: "belief-listener" }), aliases: "[]", tags: "[]", attributes: "{}", status: "active", manualLock: 0, provenance: JSON.stringify({ source: "test", sourceRevision: "belief", actor: "user" }), createdAt: now, updatedAt: now },
  ]);
  const beliefMessages = await db.select().from(schema.messages).where(eq(schema.messages.chatId, "belief-chat"));
  const beliefPrepared = prepareContinuitySources(beliefMessages, { gameContinuity: { mode: "active" } });
  const beliefSource = beliefPrepared[0]!;
  const beliefConfig = await readContinuityConfig(db, "belief-chat");
  const beliefRaw = {
    kind: "reaction" as const,
    text: "Edmund believes Tilda is brilliant.",
    subjects: ["Tilda"],
    conditions: [],
    status: "asserted" as const,
    keys: ["Tilda", "brilliant"],
    evidence: [{ messageId: "belief-m1", quote: beliefQuote }],
    knowledge: { scope: "belief" as const, holders: ["Edmund"], holderRefs: ["belief-speaker-entity"] },
  };
  const communicationRaw = {
    kind: "event" as const,
    text: "Edmund communicated his assessment of Tilda to Zerah.",
    subjects: ["Edmund", "Zerah", "Tilda"],
    conditions: [],
    status: "completed" as const,
    keys: ["communication", "assessment"],
    evidence: [{ messageId: "belief-m1", quote: beliefQuote }],
    knowledge: { scope: "private" as const, holders: ["Edmund", "Zerah"], holderRefs: ["belief-speaker-entity", "belief-listener-entity"] },
  };
  const beliefRecord = { ...beliefRaw, id: createGameContinuityRecordId("belief-receipt", beliefRaw) };
  const communicationRecord = { ...communicationRaw, id: createGameContinuityRecordId("belief-receipt", communicationRaw) };
  const beliefReceipt: GameContinuityReceipt = {
    id: "belief-receipt", chatId: "belief-chat", sessionNumber: 1, sourceHash: hash({ beliefQuote }), sources: beliefPrepared, context: [], configHash: beliefConfig.hash, config: beliefConfig.frozen, status: "verified", attempts: 1, repairAttempts: 0,
    records: [beliefRecord, communicationRecord],
    dispositions: [{ messageId: "belief-m1", status: "covered", reason: "speaker assessment and communication" }],
    review: { findings: [], dispositions: [{ messageId: "belief-m1", status: "covered", reason: "clean" }] }, entryIds: [],
    knowledgeHolders: [
      { entityId: "belief-speaker-entity", kind: "character", store: "characters", recordId: "belief-speaker", name: "Edmund" },
      { entityId: "belief-listener-entity", kind: "character", store: "characters", recordId: "belief-listener", name: "Zerah" },
    ], createdAt: now, updatedAt: now,
  };
  await createGameContinuityStorage(db).enqueue(beliefReceipt);
  const publishedBelief = await publishContinuityReceipt(db, beliefReceipt.id);
  assert.equal(publishedBelief?.status, "published");
  const beliefKnowledge = await db.select().from(schema.campaignMemoryKnowledge).where(eq(schema.campaignMemoryKnowledge.chatId, "belief-chat"));
  assert.equal(beliefKnowledge.filter((row: any) => row.holderEntityId === "belief-speaker-entity" && row.epistemicState === "believes").length, 1);
  assert.equal(beliefKnowledge.filter((row: any) => row.holderEntityId === "belief-speaker-entity" && row.epistemicState === "knows").length, 1);
  assert.equal(beliefKnowledge.filter((row: any) => row.holderEntityId === "belief-listener-entity" && row.epistemicState === "knows").length, 1);
  assert.equal(beliefKnowledge.filter((row: any) => row.holderEntityId === "belief-listener-entity" && row.epistemicState === "believes").length, 0);
  const { buildCampaignMemoryContext } = await import("../../packages/server/src/services/game/campaign-memory-context.js");
  const { createCampaignMemoryStorage } = await import("../../packages/server/src/services/storage/campaign-memory.storage.js");
  const memoryStorage = createCampaignMemoryStorage(db);
  const sourceRows = await readCampaignMemorySources(db, { chatId: "belief-chat" });
  const sourceContents = Object.fromEntries([...sourceRows].map(([id, source]) => [id, { chatId: "belief-chat", content: source.content, sourceHash: source.sourceHash, captureOrder: source.captureOrder }]));
  const listenerContext = buildCampaignMemoryContext({
    chatId: "belief-chat",
    audience: { kind: "character", entityId: "belief-listener-entity" },
    entities: await memoryStorage.listEntities({ chatId: "belief-chat" }),
    facts: await memoryStorage.listFacts({ chatId: "belief-chat" }),
    knowledge: await memoryStorage.listKnowledge({ chatId: "belief-chat" }),
    events: await memoryStorage.listEvents({ chatId: "belief-chat" }),
    currentState: await memoryStorage.listCurrentState({ chatId: "belief-chat" }),
    relationships: await memoryStorage.listRelationships({ chatId: "belief-chat" }),
    maxCharacters: 10_000,
    sourceContents,
  });
  assert.match(listenerContext.text, /knows/);
  assert.doesNotMatch(listenerContext.text, /believes/);

  // A later, independently evidenced agreement is the explicit authorization
  // for Zerah's own belief; hearing Edmund's assessment remains insufficient.
  const agreementQuote = "Zerah agrees: Tilda is brilliant.";
  await db.insert(schema.messages).values({ id: "belief-m2", chatId: "belief-chat", role: "assistant", content: agreementQuote, createdAt: "2026-09-13T00:01:00.000Z" });
  const agreementMessages = await db.select().from(schema.messages).where(eq(schema.messages.chatId, "belief-chat"));
  const agreementPrepared = prepareContinuitySources(agreementMessages, { gameContinuity: { mode: "active" } });
  const agreementRaw = {
    kind: "reaction" as const,
    text: "Zerah agrees that Tilda is brilliant.",
    subjects: ["Zerah", "Tilda"],
    conditions: [],
    status: "asserted" as const,
    keys: ["agreement", "Tilda"],
    evidence: [{ messageId: "belief-m2", quote: agreementQuote }],
    knowledge: { scope: "belief" as const, holders: ["Zerah"], holderRefs: ["belief-listener-entity"] },
  };
  const agreementRecord = { ...agreementRaw, id: createGameContinuityRecordId("agreement-receipt", agreementRaw) };
  const agreementReceipt: GameContinuityReceipt = {
    id: "agreement-receipt", chatId: "belief-chat", sessionNumber: 2, sourceHash: hash({ agreementQuote }), sources: agreementPrepared, context: [], configHash: beliefConfig.hash, config: beliefConfig.frozen, status: "verified", attempts: 1, repairAttempts: 0,
    records: [agreementRecord],
    dispositions: agreementPrepared.map((item) => ({ messageId: item.messageId, status: item.messageId === "belief-m2" ? "covered" as const : "no_durable_facts" as const, reason: item.messageId === "belief-m2" ? "explicit agreement source" : "already reviewed in prior receipt" })),
    review: { findings: [], dispositions: agreementPrepared.map((item) => ({ messageId: item.messageId, status: item.messageId === "belief-m2" ? "covered" as const : "no_durable_facts" as const, reason: item.messageId === "belief-m2" ? "explicit agreement" : "already reviewed in prior receipt" })) }, entryIds: [],
    knowledgeHolders: beliefReceipt.knowledgeHolders, createdAt: now, updatedAt: now,
  };
  await createGameContinuityStorage(db).enqueue(agreementReceipt);
  const publishedAgreement = await publishContinuityReceipt(db, agreementReceipt.id);
  assert.equal(publishedAgreement?.status, "published");
  const agreementKnowledge = await db.select().from(schema.campaignMemoryKnowledge).where(eq(schema.campaignMemoryKnowledge.chatId, "belief-chat"));
  assert.equal(agreementKnowledge.filter((row: any) => row.holderEntityId === "belief-listener-entity" && row.epistemicState === "believes").length, 1);

  const allMemoryEntities = await memoryStorage.listEntities({ chatId: "belief-chat" });
  const allMemoryFacts = await memoryStorage.listFacts({ chatId: "belief-chat" });
  const allMemoryKnowledge = await memoryStorage.listKnowledge({ chatId: "belief-chat" });
  const allMemoryEvents = await memoryStorage.listEvents({ chatId: "belief-chat" });
  const allMemoryState = await memoryStorage.listCurrentState({ chatId: "belief-chat" });
  const allMemoryRelationships = await memoryStorage.listRelationships({ chatId: "belief-chat" });
  const currentSourceRows = await readCampaignMemorySources(db, { chatId: "belief-chat" });
  const currentSourceContents = Object.fromEntries([...currentSourceRows].map(([id, source]) => [id, { chatId: "belief-chat", content: source.content, sourceHash: source.sourceHash, captureOrder: source.captureOrder }]));
  const currentListenerContext = buildCampaignMemoryContext({
    chatId: "belief-chat", audience: { kind: "character", entityId: "belief-listener-entity" }, entities: allMemoryEntities,
    facts: allMemoryFacts, knowledge: allMemoryKnowledge, events: allMemoryEvents, currentState: allMemoryState,
    relationships: allMemoryRelationships, maxCharacters: 10_000, sourceContents: currentSourceContents,
  });
  assert.match(currentListenerContext.text, /believes/);
  const beforeAgreement = buildCampaignMemoryContext({
    chatId: "belief-chat", audience: { kind: "character", entityId: "belief-listener-entity" }, entities: allMemoryEntities,
    facts: allMemoryFacts, knowledge: allMemoryKnowledge, events: allMemoryEvents, currentState: allMemoryState,
    relationships: allMemoryRelationships, maxCharacters: 10_000, cutoffOrder: "m1|2026-09-13T00:00:00.000Z|belief-m1", sourceContents: currentSourceContents,
  });
  assert.match(beforeAgreement.text, /knows/);
  assert.doesNotMatch(beforeAgreement.text, /believes/);

  await db._fileStore.close(); db = undefined;
  console.log("continuity-memory-knowledge-publication regression passed");
} finally {
  if (db) await db._fileStore.close();
  rmSync(root, { recursive: true, force: true });
}
