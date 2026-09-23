import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GameContinuityReceipt } from "@marinara-engine/shared";

const root = mkdtempSync(join(tmpdir(), "marinara-continuity-memory-publication-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
let db: any;

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const schema = await import("../../packages/server/src/db/schema/index.js");
  const { createGameContinuityStorage } = await import("../../packages/server/src/services/storage/game-continuity.storage.js");
  const { prepareContinuitySources } = await import("../../packages/server/src/services/game/continuity-sources.js");
  const { createGameContinuityRecordId } = await import("../../packages/server/src/services/game/continuity-review.js");
  const { publishContinuityReceipt } = await import("../../packages/server/src/services/game/continuity-publication.js");
  const { publishContinuityMemory, assertContinuityMemoryEntry } = await import("../../packages/server/src/services/game/continuity-memory-publication.js");
  const { readCampaignMemorySources } = await import("../../packages/server/src/services/game/campaign-memory-sources.js");
  const { readContinuityConfig } = await import("../../packages/server/src/services/game/continuity-provider.js");
  const { eq } = await import("../../packages/server/src/db/file-query.js");

  let armed = false;
  db = await createFileNativeDB({ beforeTableWrite: (table) => {
    if (armed && table.startsWith("campaign_memory_facts")) { armed = false; throw new Error("injected publication fact write failure"); }
  } });
  const now = "2026-09-13T00:00:00.000Z";
  await db.insert(schema.apiConnections).values({ id: "conn", name: "Continuity test", provider: "custom", model: "test-model", createdAt: now, updatedAt: now });
  await db.insert(schema.chats).values({ id: "chat", name: "Continuity", mode: "game", connectionId: "conn", metadata: JSON.stringify({ gameContinuity: { mode: "active" }, gameNpcs: [{ id: "npc-tilda", name: "Tilda Pennock" }] }), createdAt: now, updatedAt: now });
  await db.insert(schema.messages).values([
    { id: "m1", chatId: "chat", role: "user", content: "Rowan offers Tilda a place if she completes the vigil.", createdAt: now },
    { id: "m2", chatId: "chat", role: "assistant", content: "Tilda has not arrived; the offer remains open.", createdAt: "2026-09-13T00:00:01.000Z" },
  ]);
  await db.insert(schema.lorebooks).values({ id: "keeper", name: "Keeper", chatId: "chat", enabled: "false", sourceAgentId: "game-lorebook-keeper", createdAt: now, updatedAt: now });
  const messages = await db.select().from(schema.messages);
  const prepared = prepareContinuitySources(messages, { gameContinuity: { mode: "active" } });
  const config = await readContinuityConfig(db, "chat");
  const source = prepared[0]!;
  const rawRecords = [
    { kind: "promise" as const, text: "Rowan Mercer offered Tilda Pennock a place if she completed the vigil.", subjects: ["Rowan Mercer", "Tilda Pennock"], conditions: ["Tilda Pennock completes the vigil"], status: "proposed" as const, keys: ["offer", "quenby"], evidence: [{ messageId: source.messageId, quote: "Rowan offers Tilda a place if she completes the vigil." }], knowledge: { scope: "world" as const, holders: ["Tilda Pennock"] } },
    { kind: "event" as const, text: "Tilda Pennock has not arrived and the offer remains open.", subjects: ["Tilda Pennock"], conditions: ["before arrival"], status: "asserted" as const, keys: ["non-arrival"], evidence: [{ messageId: "m2", quote: "Tilda has not arrived; the offer remains open." }] },
  ];
  const records = rawRecords.map((record) => ({ ...record, id: createGameContinuityRecordId("receipt-good", record) }));
  const entryId = `gce_${hash("receipt-good").slice(0, 32)}`;
  const entryContent = records.map((record) => [`[${record.kind}/${record.status}] ${record.text}`, `Subjects: ${record.subjects.join(", ")}`, `Conditions: ${record.conditions.join("; ")}`, `Evidence: ${record.evidence.map((item) => `[${item.messageId}] ${item.quote}`).join(" | ")}`].filter(Boolean).join("\n")).join("\n\n");
  await db.insert(schema.lorebookEntries).values({ id: entryId, lorebookId: "keeper", name: "Game continuity 1", content: entryContent, keys: JSON.stringify(["offer", "quenby", "non-arrival"]), dynamicState: JSON.stringify({ receiptId: "receipt-good", publishedContentHash: hash(entryContent), source: "incremental-game-continuity" }), createdAt: now, updatedAt: now });
  await db.insert(schema.campaignMemoryEntities).values({ entityId: "npc-owner", chatId: "chat", kind: "character", owner: JSON.stringify({ type: "existing", store: "game-npcs", recordId: "npc-tilda" }), aliases: JSON.stringify(["Tilda Pennock"]), tags: JSON.stringify(["npc"]), attributes: "{}", status: "active", manualLock: 0, provenance: JSON.stringify({ source: "regression", sourceRevision: "npc", actor: "user" }), createdAt: now, updatedAt: now });
  await db.insert(schema.campaignMemoryEntities).values({ entityId: "imported-owner", chatId: "chat", kind: "lore", owner: JSON.stringify({ type: "existing", store: "lorebook-entries", recordId: entryId }), aliases: "[]", tags: JSON.stringify(["imported"]), summary: "Imported locked owner", attributes: "{}", status: "active", manualLock: 1, provenance: JSON.stringify({ source: "imported", sourceRevision: "legacy", actor: "import", origin: { sourceChatId: "chat", sourceRecordId: entryId } }), createdAt: now, updatedAt: now });
  const receipt: GameContinuityReceipt = {
    id: "receipt-good", chatId: "chat", sessionNumber: 1, sourceHash: hash({ source: "receipt-good" }), sources: prepared, context: [], configHash: config.hash, config: config.frozen, status: "verified", attempts: 1, repairAttempts: 0, records,
    dispositions: prepared.map((item) => ({ messageId: item.messageId, status: "covered" as const, reason: "explicit source" })), review: { findings: [], dispositions: prepared.map((item) => ({ messageId: item.messageId, status: "covered" as const, reason: "clean" })) }, knowledgeHolders: [{ entityId: "npc-owner", kind: "character", store: "game-npcs", recordId: "npc-tilda", name: "Tilda Pennock" }], entryIds: [], createdAt: now, updatedAt: now,
  };
  await createGameContinuityStorage(db).enqueue(receipt);
  const counts = async () => ({ loreEntries: (await db.select().from(schema.lorebookEntries)).length, entities: (await db.select().from(schema.campaignMemoryEntities)).length, facts: (await db.select().from(schema.campaignMemoryFacts)).length, journal: (await db.select().from(schema.campaignMemoryMutationJournal)).length });
  const before = await counts();
  armed = true;
  await assert.rejects(() => publishContinuityReceipt(db, receipt.id), /injected publication fact write failure/u);
  assert.equal((await createGameContinuityStorage(db).get(receipt.id))?.status, "verified");
  assert.deepEqual(await counts(), before);
  await db._fileStore.close();
  db = await createFileNativeDB();
  assert.equal((await createGameContinuityStorage(db).get(receipt.id))?.status, "verified");
  assert.deepEqual(await counts(), before);

  const published = await publishContinuityReceipt(db, receipt.id);
  assert.equal(published?.status, "published");
  const entry = (await db.select().from(schema.lorebookEntries).where(eq(schema.lorebookEntries.id, entryId))).at(0)!;
  assert.ok(entry);
  const entityId = "imported-owner";
  const entity = (await db.select().from(schema.campaignMemoryEntities).where(eq(schema.campaignMemoryEntities.entityId, entityId))).at(0)!;
  assert.ok(entity);
  assert.equal(entity.manualLock, 1);
  assert.deepEqual(JSON.parse(entity.owner), { type: "existing", store: "lorebook-entries", recordId: entryId });
  // Record 1 names "Rowan Mercer" (no entity) and "Tilda Pennock" (npc-owner): one
  // per-subject fact plus the lore fallback. Record 2 names only Tilda: one per-subject fact.
  assert.equal((await db.select().from(schema.campaignMemoryFacts)).length, 3);
  assert.equal((await db.select().from(schema.campaignMemoryMutationJournal)).length, 4);
  const factRows = await db.select().from(schema.campaignMemoryFacts);
  const canonicalSources = await readCampaignMemorySources(db, { chatId: "chat" });
  const expectedByRecord = new Map(records.map((record) => [record.id, record]));
  for (const row of factRows) {
    const value = JSON.parse(row.value);
    const record = expectedByRecord.get(value.recordId)!;
    assert.ok(record);
    assert.equal(row.sourceRevision, receipt.sourceHash);
    if (row.subjectEntityId === entityId) {
      assert.equal(row.predicate, `continuity.${record.kind}`);
      assert.deepEqual(value.subjects, record.subjects);
      assert.deepEqual(value.unresolvedSubjects, [{ name: "Rowan Mercer", reason: "no-candidate" }], "the fallback reports every unresolved subject");
      assert.deepEqual(value.resolvedSubjects, [{ name: "Tilda Pennock", entityId: "npc-owner" }]);
    } else {
      assert.equal(row.subjectEntityId, "npc-owner", "resolved subjects publish on the subject entity");
      assert.equal(row.predicate, record.kind, "per-subject facts use the record kind as predicate");
      assert.equal(value.subject, "Tilda Pennock");
      assert.deepEqual(value.conditions, record.conditions);
      assert.deepEqual(value.evidence, JSON.parse(row.evidence));
    }
    assert.equal(value.text, record.text); assert.equal(value.status, record.status); assert.deepEqual(value.keys, record.keys);
    assert.deepEqual(JSON.parse(row.conditions), record.conditions.map((condition) => ({ kind: "continuity.condition", value: condition })));
    assert.deepEqual(JSON.parse(row.evidence), record.evidence.map((item) => ({ ...item, sourceHash: canonicalSources.get(item.messageId)?.sourceHash })));
  }
  assert.equal(factRows.filter((row) => row.subjectEntityId === entityId).length, 1, "a fully resolved record publishes no lore fallback");
  assert.equal(factRows.filter((row) => JSON.parse(row.value).recordId === records[1]!.id).length, 1);
  const knowledgeRows = await db.select().from(schema.campaignMemoryKnowledge);
  assert.equal(knowledgeRows.length, 1);
  assert.equal(knowledgeRows[0]!.holderEntityId, "npc-owner", "reviewed knowledge is granted to the exact NPC entity");
  const promiseFact = factRows.find((row) => JSON.parse(row.value).recordId === records[0]!.id && row.subjectEntityId === entityId)!;
  assert.equal(knowledgeRows[0]!.factId, promiseFact.factId, "knowledge attaches to the record's fallback fact when one exists");
  assert.deepEqual(JSON.parse(promiseFact.value).knowledge.holderRefs, ["npc-owner"], "name-only reviewed knowledge receives the deterministic holder ref");
  const oldPromiseValue = JSON.parse(promiseFact.value);
  delete oldPromiseValue.knowledge.holderRefs;
  await db.delete(schema.campaignMemoryKnowledge).where(eq(schema.campaignMemoryKnowledge.factId, promiseFact.factId));
  await db.update(schema.campaignMemoryFacts).set({ value: JSON.stringify(oldPromiseValue) }).where(eq(schema.campaignMemoryFacts.factId, promiseFact.factId));
  await db.transaction((tx: any) => publishContinuityMemory(tx, receipt, { id: entryId, lorebookId: entry.lorebookId, name: entry.name }, messages, prepared));
  assert.equal((await db.select().from(schema.campaignMemoryKnowledge)).length, 1, "replay recreates missing knowledge for an unchanged old fact");
  assert.equal((await db.select().from(schema.campaignMemoryFacts).where(eq(schema.campaignMemoryFacts.factId, promiseFact.factId))).at(0)?.value, JSON.stringify(oldPromiseValue), "replay preserves the original fact payload");
  await db.transaction((tx: any) => publishContinuityMemory(tx, receipt, { id: entryId, lorebookId: entry.lorebookId, name: entry.name }, messages, prepared));
  assert.equal((await db.select().from(schema.campaignMemoryKnowledge)).length, 1, "replay remains duplicate-free");

  await db.insert(schema.campaignMemoryEntities).values({ entityId: "npc-owner-2", chatId: "chat", kind: "character", owner: JSON.stringify({ type: "existing", store: "game-npcs", recordId: "npc-tilda" }), aliases: JSON.stringify(["Tilda Pennock"]), tags: JSON.stringify(["npc"]), attributes: "{}", status: "active", manualLock: 0, provenance: JSON.stringify({ source: "regression", sourceRevision: "npc-2", actor: "user" }), createdAt: now, updatedAt: now });
  await db.delete(schema.campaignMemoryKnowledge).where(eq(schema.campaignMemoryKnowledge.factId, promiseFact.factId));
  const ambiguousReceipt = { ...receipt, knowledgeHolders: [...receipt.knowledgeHolders!, { entityId: "npc-owner-2", kind: "character" as const, store: "game-npcs" as const, recordId: "npc-tilda", name: "Tilda Pennock" }] };
  await db.transaction((tx: any) => publishContinuityMemory(tx, ambiguousReceipt, { id: entryId, lorebookId: entry.lorebookId, name: entry.name }, messages, prepared));
  assert.equal((await db.select().from(schema.campaignMemoryKnowledge)).length, 0, "ambiguous holder names do not grant knowledge");
  const ambiguousFallback = (await db.select().from(schema.campaignMemoryFacts)).filter((row) => row.subjectEntityId === entityId && JSON.parse(row.value).recordId === records[1]!.id);
  assert.equal(ambiguousFallback.length, 1, "an ambiguous subject keeps the record on the lore-entity fallback");
  assert.deepEqual(JSON.parse(ambiguousFallback[0]!.value).unresolvedSubjects, [{ name: "Tilda Pennock", reason: "ambiguous-candidates" }], "the ambiguous subject is reported on the fallback");
  assert.equal((await db.select().from(schema.campaignMemoryFacts)).filter((row) => row.subjectEntityId === "npc-owner-2").length, 0, "ambiguous candidates never receive a per-subject fact");
  await db.insert(schema.campaignMemoryEntities).values({ entityId: "npc-other", chatId: "chat", kind: "character", owner: JSON.stringify({ type: "existing", store: "game-npcs", recordId: "npc-tilda" }), aliases: JSON.stringify(["Other Holder"]), tags: JSON.stringify(["npc"]), attributes: "{}", status: "active", manualLock: 0, provenance: JSON.stringify({ source: "regression", sourceRevision: "npc-other", actor: "user" }), createdAt: now, updatedAt: now });
  const invalidPairReceipt = { ...receipt, knowledgeHolders: [...receipt.knowledgeHolders!, { entityId: "npc-other", kind: "character" as const, store: "game-npcs" as const, recordId: "npc-tilda", name: "Other Holder" }], records: receipt.records.map((record, index) => index === 0 ? { ...record, knowledge: { ...record.knowledge!, holderRefs: ["npc-other"] } } : record) };
  await db.transaction((tx: any) => publishContinuityMemory(tx, invalidPairReceipt, { id: entryId, lorebookId: entry.lorebookId, name: entry.name }, messages, prepared));
  assert.equal((await db.select().from(schema.campaignMemoryKnowledge)).length, 0, "invalid explicit holder/name pairing does not grant knowledge");
  await db.update(schema.campaignMemoryFacts).set({ manualLock: 1 }).where(eq(schema.campaignMemoryFacts.factId, promiseFact.factId));
  await db.transaction((tx: any) => publishContinuityMemory(tx, receipt, { id: entryId, lorebookId: entry.lorebookId, name: entry.name }, messages, prepared));
  assert.equal((await db.select().from(schema.campaignMemoryKnowledge)).length, 0, "locked facts do not receive newly granted knowledge");
  assert.equal((await db.select().from(schema.campaignMemoryEvents)).length, 0);
  assert.equal((await db.select().from(schema.campaignMemoryCurrentState)).length, 0);
  const firstFact = factRows[0]!;
  const editedValue = JSON.stringify({ text: "MANUAL FACT EDIT", status: "held" });
  await db.update(schema.campaignMemoryFacts).set({ value: editedValue, manualLock: 1 }).where(eq(schema.campaignMemoryFacts.factId, firstFact.factId));
  await assert.rejects(() => assertContinuityMemoryEntry(db, { id: receipt.id, chatId: "other-chat" }, entryId), /CONTINUITY_MEMORY_ENTRY_CHAT_MISMATCH/u);
  await db.update(schema.lorebookEntries).set({ content: "MANUAL ENTRY EDIT" }).where(eq(schema.lorebookEntries.id, entryId));
  await assert.rejects(() => assertContinuityMemoryEntry(db, { id: receipt.id, chatId: "chat" }, entryId), /CONTINUITY_MEMORY_ENTRY_MANUALLY_EDITED/u);
  await db.update(schema.lorebookEntries).set({ content: entry.content }).where(eq(schema.lorebookEntries.id, entryId));
  await db.transaction((tx: any) => publishContinuityMemory(tx, receipt, { id: entryId, lorebookId: entry.lorebookId, name: entry.name }, messages, prepared));
  assert.equal((await db.select().from(schema.campaignMemoryFacts).where(eq(schema.campaignMemoryFacts.factId, firstFact.factId))).at(0)?.value, editedValue);
  assert.equal((await db.select().from(schema.campaignMemoryEntities).where(eq(schema.campaignMemoryEntities.entityId, entityId))).at(0)?.manualLock, 1);
  await assert.rejects(() => assertContinuityMemoryEntry(db, { id: "wrong-receipt", chatId: "chat" }, entryId), /CONTINUITY_MEMORY_ENTRY_RECEIPT_MISMATCH/u);
  await assert.rejects(() => assertContinuityMemoryEntry(db, { id: receipt.id, chatId: "chat" }, "missing-entry"), /CONTINUITY_MEMORY_ENTRY_MISSING/u);
  await db._fileStore.close();
  let freshArmed = false;
  db = await createFileNativeDB({ beforeTableWrite: (table) => {
    if (freshArmed && table.startsWith("campaign_memory_facts")) { freshArmed = false; throw new Error("injected fresh publication fact write failure"); }
  } });
  await db.insert(schema.chats).values({ id: "fresh-chat", name: "Fresh continuity", mode: "game", connectionId: "conn", metadata: JSON.stringify({ gameContinuity: { mode: "active" } }), createdAt: now, updatedAt: now });
  await db.insert(schema.messages).values([{ id: "fm1", chatId: "fresh-chat", role: "assistant", content: "A fresh source establishes a distinct condition.", createdAt: now }]);
  await db.insert(schema.lorebooks).values({ id: "fresh-keeper", name: "Fresh Keeper", chatId: "fresh-chat", enabled: "false", sourceAgentId: "game-lorebook-keeper", createdAt: now, updatedAt: now });
  const freshMessages = await db.select().from(schema.messages).where(eq(schema.messages.chatId, "fresh-chat"));
  const freshPrepared = prepareContinuitySources(freshMessages, { gameContinuity: { mode: "active" } });
  const freshConfig = await readContinuityConfig(db, "fresh-chat");
  const freshRaw = { kind: "condition" as const, text: "The fresh condition remains unresolved.", subjects: ["Fresh subject"], conditions: ["before the next bell"], status: "unresolved" as const, keys: ["fresh-condition"], evidence: [{ messageId: "fm1", quote: "A fresh source establishes a distinct condition." }] };
  const freshReceipt: GameContinuityReceipt = {
    id: "fresh-receipt", chatId: "fresh-chat", sessionNumber: 1, sourceHash: hash({ source: "fresh-receipt" }), sources: freshPrepared, context: [], configHash: freshConfig.hash, config: freshConfig.frozen, status: "verified", attempts: 1, repairAttempts: 0,
    records: [{ ...freshRaw, id: createGameContinuityRecordId("fresh-receipt", freshRaw) }], dispositions: freshPrepared.map((item) => ({ messageId: item.messageId, status: "covered" as const, reason: "explicit source" })), review: { findings: [], dispositions: freshPrepared.map((item) => ({ messageId: item.messageId, status: "covered" as const, reason: "clean" })) }, entryIds: [], createdAt: now, updatedAt: now,
  };
  await createGameContinuityStorage(db).enqueue(freshReceipt);
  const freshBefore = await counts();
  freshArmed = true;
  await assert.rejects(() => publishContinuityReceipt(db, freshReceipt.id), /injected fresh publication fact write failure/u);
  assert.equal((await createGameContinuityStorage(db).get(freshReceipt.id))?.status, "verified");
  assert.deepEqual(await counts(), freshBefore);
  await db._fileStore.close();
  db = await createFileNativeDB();
  assert.equal((await createGameContinuityStorage(db).get(freshReceipt.id))?.status, "verified");
  assert.deepEqual(await counts(), freshBefore);

  // Two resolvable subjects: one structured fact per subject, sharing evidence, no fallback;
  // republishing the same receipt is idempotent.
  await db.insert(schema.chats).values({ id: "pair-chat", name: "Pair continuity", mode: "game", connectionId: "conn", metadata: JSON.stringify({ gameContinuity: { mode: "active" }, gameNpcs: [{ id: "npc-ada", name: "Ada Vale" }, { id: "npc-cole", name: "Cole Marsh" }] }), createdAt: now, updatedAt: now });
  await db.insert(schema.messages).values([{ id: "pm1", chatId: "pair-chat", role: "assistant", content: "Ada and Cole swore the pact at the ford.", createdAt: now }]);
  await db.insert(schema.lorebooks).values({ id: "pair-keeper", name: "Pair Keeper", chatId: "pair-chat", enabled: "false", sourceAgentId: "game-lorebook-keeper", createdAt: now, updatedAt: now });
  await db.insert(schema.campaignMemoryEntities).values([
    { entityId: "pair-ada", chatId: "pair-chat", kind: "character", owner: JSON.stringify({ type: "existing", store: "game-npcs", recordId: "npc-ada" }), aliases: JSON.stringify(["Ada Vale"]), tags: "[]", attributes: "{}", status: "active", manualLock: 0, provenance: JSON.stringify({ source: "regression", sourceRevision: "pair", actor: "user" }), createdAt: now, updatedAt: now },
    { entityId: "pair-cole", chatId: "pair-chat", kind: "character", owner: JSON.stringify({ type: "existing", store: "game-npcs", recordId: "npc-cole" }), aliases: JSON.stringify(["Cole Marsh"]), tags: "[]", attributes: "{}", status: "active", manualLock: 0, provenance: JSON.stringify({ source: "regression", sourceRevision: "pair", actor: "user" }), createdAt: now, updatedAt: now },
  ]);
  const pairMessages = await db.select().from(schema.messages).where(eq(schema.messages.chatId, "pair-chat"));
  const pairPrepared = prepareContinuitySources(pairMessages, { gameContinuity: { mode: "active" } });
  const pairConfig = await readContinuityConfig(db, "pair-chat");
  const pairRaw = { kind: "event" as const, text: "Ada Vale and Cole Marsh swore the pact at the ford.", subjects: ["Ada Vale", "Cole Marsh"], conditions: ["until the ford floods"], status: "completed" as const, keys: ["pact", "ford"], evidence: [{ messageId: "pm1", quote: "Ada and Cole swore the pact at the ford." }], knowledge: { scope: "world" as const, holders: ["Ada Vale"] } };
  const pairRecord = { ...pairRaw, id: createGameContinuityRecordId("pair-receipt", pairRaw) };
  const pairReceipt: GameContinuityReceipt = {
    id: "pair-receipt", chatId: "pair-chat", sessionNumber: 1, sourceHash: hash({ source: "pair-receipt" }), sources: pairPrepared, context: [], configHash: pairConfig.hash, config: pairConfig.frozen, status: "verified", attempts: 1, repairAttempts: 0,
    records: [pairRecord], dispositions: pairPrepared.map((item) => ({ messageId: item.messageId, status: "covered" as const, reason: "explicit source" })), review: { findings: [], dispositions: pairPrepared.map((item) => ({ messageId: item.messageId, status: "covered" as const, reason: "clean" })) },
    knowledgeHolders: [{ entityId: "pair-ada", kind: "character", store: "game-npcs", recordId: "npc-ada", name: "Ada Vale" }, { entityId: "pair-cole", kind: "character", store: "game-npcs", recordId: "npc-cole", name: "Cole Marsh" }], entryIds: [], createdAt: now, updatedAt: now,
  };
  await createGameContinuityStorage(db).enqueue(pairReceipt);
  assert.equal((await publishContinuityReceipt(db, pairReceipt.id))?.status, "published");
  const pairFacts = (await db.select().from(schema.campaignMemoryFacts)).filter((row: any) => row.chatId === "pair-chat");
  assert.deepEqual(pairFacts.map((row: any) => row.subjectEntityId).sort(), ["pair-ada", "pair-cole"], "two resolvable subjects yield exactly two per-subject facts and no fallback");
  assert.ok(pairFacts.every((row: any) => row.predicate === "event" && row.status === "verified" && row.sourceRevision === pairReceipt.sourceHash));
  assert.equal(new Set(pairFacts.map((row: any) => row.evidence)).size, 1, "both subject facts carry the same evidence");
  assert.equal(new Set(pairFacts.map((row: any) => row.validFromOrder)).size, 1);
  assert.deepEqual(pairFacts.map((row: any) => JSON.parse(row.value).subject).sort(), ["Ada Vale", "Cole Marsh"]);
  assert.ok(pairFacts.every((row: any) => { const value = JSON.parse(row.value); return value.text === pairRaw.text && value.status === "completed" && value.conditions[0] === "until the ford floods" && value.evidence.length === 1 && value.recordId === pairRecord.id; }));
  const pairKnowledge = (await db.select().from(schema.campaignMemoryKnowledge)).filter((row: any) => row.chatId === "pair-chat");
  assert.equal(pairKnowledge.length, 1);
  assert.equal(pairKnowledge[0]!.holderEntityId, "pair-ada");
  assert.ok(pairFacts.some((row: any) => row.factId === pairKnowledge[0]!.factId), "knowledge links to one of the record's published facts");
  const pairEntry = (await db.select().from(schema.lorebookEntries)).find((row: any) => JSON.parse(row.dynamicState).receiptId === "pair-receipt")!;
  const pairCounts = async () => ({ facts: (await db.select().from(schema.campaignMemoryFacts)).length, knowledge: (await db.select().from(schema.campaignMemoryKnowledge)).length, journal: (await db.select().from(schema.campaignMemoryMutationJournal)).length, revisions: (await db.select().from(schema.campaignMemoryFacts)).map((row: any) => row.revision) });
  const pairBefore = await pairCounts();
  await db.transaction((tx: any) => publishContinuityMemory(tx, pairReceipt, pairEntry, pairMessages, pairPrepared));
  await db.transaction((tx: any) => publishContinuityMemory(tx, pairReceipt, pairEntry, pairMessages, pairPrepared));
  assert.deepEqual(await pairCounts(), pairBefore, "republishing the same receipt is idempotent");
  // Live reviewed turns are system-authored; historical backfill receipts are imported archive memory.
  assert.ok(pairFacts.every((row: any) => row.author === "system" && JSON.parse(row.provenance).actor === "system" && JSON.parse(row.value).historical === false), "live receipt facts are system-authored and not historical");
  const historicalReceipt: GameContinuityReceipt = { ...pairReceipt, id: "gch_pair-historical", sourceHash: hash({ source: "gch_pair-historical" }), config: { ...pairReceipt.config, historicalBackfill: { id: "historical-continuity-regression", fromMessageId: "pm1", toMessageId: "pm1", sessionNumber: 1 } } as any, entryIds: [] };
  historicalReceipt.records = [{ ...pairRaw, id: createGameContinuityRecordId(historicalReceipt.id, pairRaw) }];
  await createGameContinuityStorage(db).enqueue(historicalReceipt);
  const historicalEntryContent = "Historical continuity entry";
  await db.insert(schema.lorebookEntries).values({ id: "entry-historical", lorebookId: pairEntry.lorebookId, name: "Game continuity historical", content: historicalEntryContent, keys: JSON.stringify(["pact"]), dynamicState: JSON.stringify({ receiptId: historicalReceipt.id, publishedContentHash: hash(historicalEntryContent), source: "incremental-game-continuity" }), createdAt: now, updatedAt: now });
  await db.transaction((tx: any) => publishContinuityMemory(tx, historicalReceipt, { id: "entry-historical", lorebookId: pairEntry.lorebookId, name: "Game continuity historical" }, pairMessages, pairPrepared));
  const historicalFacts = (await db.select().from(schema.campaignMemoryFacts)).filter((row: any) => row.chatId === "pair-chat" && JSON.parse(row.value).receiptId === historicalReceipt.id);
  assert.equal(historicalFacts.length, 2, "the historical receipt publishes its own per-subject facts");
  assert.ok(historicalFacts.every((row: any) => row.author === "import" && JSON.parse(row.provenance).actor === "import" && JSON.parse(row.value).historical === true), "historical backfill facts carry import provenance and the historical flag");
  await db._fileStore.close(); db = undefined;
  console.log("continuity-memory-publication regression passed");
} finally {
  if (db) await db._fileStore.close();
  rmSync(root, { recursive: true, force: true });
}
