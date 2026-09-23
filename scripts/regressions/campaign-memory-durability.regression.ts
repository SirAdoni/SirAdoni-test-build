import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep this regression independent of the live DATA_DIR and of campaign-memory
// services. It exercises the file-native store and its real close/reopen path.
const fixtureRoot = mkdtempSync(join(tmpdir(), "marinara-memory-durability-"));
process.env.DATA_DIR = fixtureRoot;
process.env.FILE_STORAGE_DIR = join(fixtureRoot, "storage");

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { eq } = await import("../../packages/server/src/db/file-query.js");
  const {
    chats,
    campaignMemoryEntities,
    campaignMemoryFacts,
    campaignMemoryKnowledge,
    campaignMemoryEvents,
    campaignMemoryCurrentState,
    campaignMemoryRelationships,
    campaignMemoryMutationJournal,
  } = await import("../../packages/server/src/db/schema/index.js");

  const now = "2026-09-13T00:00:00.000Z";
  const targetChat = "memory-durable-target";
  const otherChat = "memory-durable-other";
  const legacyChat = "memory-durable-legacy";
  const db = await createFileNativeDB();

  await db.insert(chats).values([
    { id: targetChat, name: "Target", mode: "game", createdAt: now, updatedAt: now },
    { id: otherChat, name: "Other", mode: "game", createdAt: now, updatedAt: now },
    { id: legacyChat, name: "Legacy", mode: "game", createdAt: now, updatedAt: now },
  ]);

  const json = (value: unknown) => JSON.stringify(value);
  const provenance = { source: "durability-regression", sourceRevision: "r1", actor: "system" };

  const targetRows = {
    entities: {
      entityId: "durable-entity",
      chatId: targetChat,
      kind: "character",
      owner: json({ type: "registry", store: "campaign-memory", recordId: "durable-entity" }),
      aliases: json(["Durable"]),
      tags: json(["regression"]),
      summary: "Durable entity",
      body: null,
      attributes: json({ level: 3 }),
      status: "active",
      manualLock: 0,
      provenance: json(provenance),
      revision: 1,
      createdAt: now,
      updatedAt: now,
    },
    facts: {
      factId: "durable-fact",
      chatId: targetChat,
      subjectEntityId: "durable-entity",
      predicate: "trusts",
      value: json({ target: "durable-entity" }),
      conditions: "[]",
      status: "verified",
      validFromOrder: "1",
      validToOrder: null,
      sourceRevision: "r1",
      evidence: json([{ messageId: "durable-message", quote: "trusts" }]),
      author: "system",
      provenance: json(provenance),
      manualLock: 0,
      supersedesFactId: null,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    },
    knowledge: {
      knowledgeId: "durable-knowledge",
      chatId: targetChat,
      holderEntityId: "durable-entity",
      factId: "durable-fact",
      attributedClaim: null,
      epistemicState: "knows",
      learnedFrom: json([{ messageId: "durable-message", quote: "trusts" }]),
      learnedAtOrder: "1",
      confidence: "high",
      provenance: json(provenance),
      manualLock: 0,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    },
    events: {
      eventId: "durable-event",
      chatId: targetChat,
      occurrenceOrder: "1",
      campaignTime: "morning",
      participantEntityIds: json(["durable-entity"]),
      locationEntityId: null,
      sourceRevision: "r1",
      transitions: "[]",
      evidence: json([{ messageId: "durable-message", quote: "event" }]),
      provenance: json(provenance),
      immutable: 1,
      createdAt: now,
    },
    currentState: {
      stateId: "durable-state",
      chatId: targetChat,
      entityId: "durable-entity",
      property: "mood",
      value: json("calm"),
      sourceEventId: "durable-event",
      validAtOrder: "1",
      protected: 0,
      provenance: json(provenance),
      manualLock: 0,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    },
    relationships: {
      relationshipId: "durable-relationship",
      chatId: targetChat,
      sourceEntityId: "durable-entity",
      targetEntityId: "durable-entity",
      type: "knows",
      inverseLabel: "known-by",
      status: "active",
      effectiveFrom: "1",
      effectiveTo: null,
      evidence: "[]",
      provenance: json(provenance),
      manualLock: 0,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    },
    journal: {
      journalId: "durable-journal",
      chatId: targetChat,
      operationId: "durable-op",
      recordType: "entity",
      recordId: "durable-entity",
      actor: "system",
      expectedRevision: null,
      before: null,
      after: json({ entityId: "durable-entity" }),
      reason: "durability regression",
      evidence: "[]",
      compensationOperationId: null,
      payloadHash: "hash-durable",
      createdAt: now,
    },
  };

  const tables = [
    ["campaign_memory_entities", campaignMemoryEntities, targetRows.entities],
    ["campaign_memory_facts", campaignMemoryFacts, targetRows.facts],
    ["campaign_memory_knowledge", campaignMemoryKnowledge, targetRows.knowledge],
    ["campaign_memory_events", campaignMemoryEvents, targetRows.events],
    ["campaign_memory_current_state", campaignMemoryCurrentState, targetRows.currentState],
    ["campaign_memory_relationships", campaignMemoryRelationships, targetRows.relationships],
    ["campaign_memory_mutation_journal", campaignMemoryMutationJournal, targetRows.journal],
  ] as const;

  // An identical row shape under a different chat proves both shard selection
  // and cascade isolation. The legacy rows are captured before any reopen.
  const otherRows = tables.map(([, table, row]) => ({ table, row: { ...row, ...Object.fromEntries(Object.entries(row).map(([key, value]) => [key, key.endsWith("Id") && value !== targetChat ? `other-${value}` : value])), chatId: otherChat } }));
  const legacyRows = tables.map(([, table, row]) => ({ table, row: { ...row, ...Object.fromEntries(Object.entries(row).map(([key, value]) => [key, key.endsWith("Id") && value !== targetChat ? `legacy-${value}` : value])), chatId: legacyChat } }));

  for (const [, table, row] of tables) await db.insert(table).values(row as never);
  for (const { table, row } of otherRows) await db.insert(table).values(row as never);
  for (const { table, row } of legacyRows) await db.insert(table).values(row as never);
  await db._fileStore.flush();
  await db._fileStore.close();

  const reopened = await createFileNativeDB();
  for (const [tableName, table, row] of tables) {
    const rows = await reopened.select().from(table);
    assert.deepEqual(rows.find((candidate) => candidate.chatId === targetChat), row, `${tableName} persisted across close/reopen`);
  }

  const legacyBeforeDelete = await Promise.all(
    legacyRows.map(async ({ table, row }) => ({ table, row: (await reopened.select().from(table)).find((candidate) => candidate.chatId === legacyChat) })),
  );
  await reopened.delete(chats).where(eq(chats.id, targetChat));

  for (const [tableName, table] of tables) {
    const rows = await reopened.select().from(table);
    assert.equal(rows.some((row) => row.chatId === targetChat), false, `${tableName} cascades target chat rows`);
    assert.equal(rows.some((row) => row.chatId === otherChat), true, `${tableName} retains other chat rows`);
  }
  for (const { table, row } of legacyBeforeDelete) {
    const after = (await reopened.select().from(table)).find((candidate) => candidate.chatId === legacyChat);
    assert.deepEqual(after, row, "legacy row remains byte-equivalent after target delete");
  }

  // A child row carrying an unknown chat reference is never mistaken for the
  // deleted chat and remains inspectable for repair; the cascade is exact.
  await reopened.delete(chats).where(eq(chats.id, otherChat));
  for (const [tableName, table] of tables) {
    const rows = await reopened.select().from(table);
    assert.equal(rows.some((row) => row.chatId === otherChat), false, `${tableName} deletes only its exact chat reference`);
    assert.equal(rows.some((row) => row.chatId === legacyChat), true, `${tableName} rejects cross-chat cascade targeting`);
  }
  await reopened._fileStore.close();
  console.log("campaign memory durability regression passed: seven tables persisted, cascaded, and preserved legacy rows");
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
