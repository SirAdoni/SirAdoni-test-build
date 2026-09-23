import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GameContinuityReceipt, GameContinuityRecord } from "@marinara-engine/shared";

// Reviewed continuity records reach the typed campaign-memory transitions: an event row with
// participants and location, a movement only for a completed observed arrival (never an
// invitation), a pending journal for an unregistered location, a qualitative relationship kind,
// and an idempotent republish.
const root = mkdtempSync(join(tmpdir(), "marinara-continuity-memory-transitions-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const parse = (value: unknown) => (typeof value === "string" ? JSON.parse(value) : value);
let db: any;

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const schema = await import("../../packages/server/src/db/schema/index.js");
  const { prepareContinuitySources } = await import("../../packages/server/src/services/game/continuity-sources.js");
  const { createGameContinuityRecordId } = await import("../../packages/server/src/services/game/continuity-review.js");
  const { publishContinuityMemory } = await import("../../packages/server/src/services/game/continuity-memory-publication.js");
  const { readContinuityConfig } = await import("../../packages/server/src/services/game/continuity-provider.js");
  const { eq } = await import("../../packages/server/src/db/file-query.js");

  db = await createFileNativeDB();
  const now = "2026-09-16T00:00:00.000Z";
  const chatId = "chat";
  const spatialContext = {
    schemaVersion: 1,
    ownerMode: "game",
    enabled: true,
    locations: [{ id: "ford", parentId: null, name: "The Ford", kind: "place", description: "" }],
    startingLocationId: null,
    revision: 0,
  };
  await db.insert(schema.apiConnections).values({ id: "conn", name: "Continuity test", provider: "custom", model: "test-model", createdAt: now, updatedAt: now });
  await db.insert(schema.chats).values({ id: chatId, name: "Continuity", mode: "game", connectionId: "conn", metadata: JSON.stringify({ gameContinuity: { mode: "active" }, gameNpcs: [{ id: "npc-ada", name: "Ada Vale" }, { id: "npc-cole", name: "Cole Marsh" }, { id: "npc-tilda", name: "Tilda Pennock" }], spatialContext }), createdAt: now, updatedAt: now });
  const texts: Record<string, string> = {
    m1: "Ada and Cole swore the pact at The Ford.",
    m2: "Rowan invites Tilda to come to The Ford once the vigil ends.",
    m3: "Tilda arrived at The Ford at dusk.",
    m4: "Tilda reached the Old Mill before dawn.",
    m5: "Ada and Cole are allies now.",
  };
  await db.insert(schema.messages).values(Object.entries(texts).map(([id, content], index) => ({ id, chatId, role: "assistant", content, createdAt: `2026-09-16T00:0${index}:00.000Z` })));
  await db.insert(schema.lorebooks).values({ id: "keeper", name: "Keeper", chatId, enabled: "false", sourceAgentId: "game-lorebook-keeper", createdAt: now, updatedAt: now });
  const provenance = JSON.stringify({ source: "regression", sourceRevision: "r1", actor: "user" });
  const entity = (entityId: string, kind: string, store: string, recordId: string, aliases: string[]) => ({ entityId, chatId, kind, owner: JSON.stringify({ type: "existing", store, recordId }), aliases: JSON.stringify(aliases), tags: "[]", attributes: "{}", status: "active", manualLock: 0, provenance, createdAt: now, updatedAt: now });
  await db.insert(schema.campaignMemoryEntities).values([
    entity("ent-ada", "character", "game-npcs", "npc-ada", ["Ada Vale"]),
    entity("ent-cole", "character", "game-npcs", "npc-cole", ["Cole Marsh"]),
    entity("ent-tilda", "character", "game-npcs", "npc-tilda", ["Tilda Pennock"]),
    entity("ent-ford", "location", "spatial-context", "ford", ["The Ford"]),
  ]);
  const messages = await db.select().from(schema.messages).where(eq(schema.messages.chatId, chatId));
  const prepared = prepareContinuitySources(messages, { gameContinuity: { mode: "active" } });
  const config = await readContinuityConfig(db, chatId);
  const raw = [
    { kind: "event" as const, text: "Ada Vale and Cole Marsh swore the pact at The Ford.", subjects: ["Ada Vale", "Cole Marsh"], conditions: [], status: "completed" as const, keys: ["pact"], evidence: [{ messageId: "m1", quote: "Ada and Cole swore the pact at The Ford." }] },
    { kind: "promise" as const, text: "Rowan Mercer invited Tilda Pennock to The Ford once the vigil ends.", subjects: ["Rowan Mercer", "Tilda Pennock"], conditions: ["the vigil ends"], status: "proposed" as const, keys: ["invitation", "arrival"], evidence: [{ messageId: "m2", quote: "Rowan invites Tilda to come to The Ford once the vigil ends." }] },
    { kind: "event" as const, text: "Tilda Pennock arrived at The Ford at dusk.", subjects: ["Tilda Pennock"], conditions: [], status: "completed" as const, keys: ["arrival"], evidence: [{ messageId: "m3", quote: "Tilda arrived at The Ford at dusk." }] },
    { kind: "event" as const, text: "Tilda Pennock reached the Old Mill before dawn.", subjects: ["Tilda Pennock"], conditions: [], status: "completed" as const, keys: ["arrival"], evidence: [{ messageId: "m4", quote: "Tilda reached the Old Mill before dawn." }] },
    { kind: "decision" as const, text: "Ada Vale and Cole Marsh are allies now.", subjects: ["Ada Vale", "Cole Marsh"], conditions: [], status: "completed" as const, keys: ["relationship"], evidence: [{ messageId: "m5", quote: "Ada and Cole are allies now." }] },
  ];
  const records: GameContinuityRecord[] = raw.map((record) => ({ ...record, id: createGameContinuityRecordId("receipt-1", record) }));
  const [pactRecord, invitationRecord, arrivalRecord, millRecord, allyRecord] = records as [GameContinuityRecord, GameContinuityRecord, GameContinuityRecord, GameContinuityRecord, GameContinuityRecord];
  const entryId = `gce_${hash("receipt-1").slice(0, 32)}`;
  const content = records.map((record) => record.text).join("\n");
  await db.insert(schema.lorebookEntries).values({ id: entryId, lorebookId: "keeper", name: "Game continuity 1", content, keys: "[]", dynamicState: JSON.stringify({ receiptId: "receipt-1", publishedContentHash: hash(content), source: "incremental-game-continuity" }), createdAt: now, updatedAt: now });
  const holders = [
    { entityId: "ent-ada", kind: "character" as const, store: "game-npcs" as const, recordId: "npc-ada", name: "Ada Vale" },
    { entityId: "ent-cole", kind: "character" as const, store: "game-npcs" as const, recordId: "npc-cole", name: "Cole Marsh" },
    { entityId: "ent-tilda", kind: "character" as const, store: "game-npcs" as const, recordId: "npc-tilda", name: "Tilda Pennock" },
  ];
  const receipt: GameContinuityReceipt = {
    id: "receipt-1", chatId, sessionNumber: 1, sourceHash: hash({ source: "receipt-1" }), sources: prepared, context: [], configHash: config.hash, config: config.frozen, status: "verified", attempts: 1, repairAttempts: 0, records,
    dispositions: prepared.map((item) => ({ messageId: item.messageId, status: "covered" as const, reason: "explicit source" })), review: { findings: [], dispositions: [] }, knowledgeHolders: holders, entryIds: [], createdAt: now, updatedAt: now,
  };
  const entry = { id: entryId, lorebookId: "keeper", name: "Game continuity 1" };
  const publish = () => db.transaction((tx: any) => publishContinuityMemory(tx, receipt, entry, messages, prepared));
  const rows = async () => ({
    events: await db.select().from(schema.campaignMemoryEvents),
    state: await db.select().from(schema.campaignMemoryCurrentState),
    relationships: await db.select().from(schema.campaignMemoryRelationships),
    journal: await db.select().from(schema.campaignMemoryMutationJournal),
    facts: await db.select().from(schema.campaignMemoryFacts),
  });

  const result = await publish();
  const outcomeFor = (recordId: string) => [...result.transitions.applied, ...result.transitions.pending, ...result.transitions.skipped].find((item) => item.recordId === recordId);
  assert.equal(result.transitions.skipped.length, 0, "no transition derivation failed");
  const first = await rows();
  assert.equal(first.facts.length, 8, "facts are unchanged by transitions: one per resolved subject plus one fallback for the unresolved inviter");

  // Event: one row with both participants and the exact-alias location, ordered by the evidence message.
  const pact = outcomeFor(pactRecord.id)!;
  assert.equal(pact.class, "event");
  assert.equal(pact.status, "applied");
  const pactEvents = first.events.filter((row: any) => parse(row.transitions).includes(pact.transitionId));
  assert.equal(pactEvents.length, 1);
  assert.deepEqual(parse(pactEvents[0]!.participantEntityIds).sort(), ["ent-ada", "ent-cole"]);
  assert.equal(pactEvents[0]!.locationEntityId, "ent-ford");
  assert.ok(pactEvents[0]!.occurrenceOrder.length > 0);

  // Invitation: movement-like wording with a proposed status never moves anyone.
  const invitation = outcomeFor(invitationRecord.id)!;
  assert.equal(invitation.class, "movement");
  assert.equal(invitation.status, "pending");
  assert.match(invitation.reasons.join(" "), /not completed|offer|promise/u);
  assert.equal(first.events.filter((row: any) => parse(row.transitions).includes(invitation.transitionId)).length, 0);
  assert.equal(first.journal.filter((row: any) => row.operationId === `${invitation.transitionId}/pending`).length, 1, "the refused invitation is journaled pending once");

  // Completed arrival: movement applied, the location's presence is current state.
  const arrival = outcomeFor(arrivalRecord.id)!;
  assert.equal(arrival.class, "movement");
  assert.equal(arrival.status, "applied");
  const tildaLocation = first.state.find((row: any) => row.entityId === "ent-tilda" && row.property === "location");
  assert.equal(parse(tildaLocation!.value), "ent-ford");
  assert.equal(parse(first.state.find((row: any) => row.entityId === "ent-tilda" && row.property === "presence")!.value), "present");
  assert.equal(first.state.filter((row: any) => row.entityId !== "ent-tilda").length, 0, "nobody else gained state");
  assert.equal(first.events.filter((row: any) => parse(row.transitions).includes(arrival.transitionId)).length, 1);

  // Unregistered location: journaled pending with the reason, no state change.
  const mill = outcomeFor(millRecord.id)!;
  assert.equal(mill.class, "movement");
  assert.equal(mill.status, "pending");
  assert.match(mill.reasons.join(" "), /no registered location alias/u);
  const millJournal = first.journal.find((row: any) => row.operationId === `${mill.transitionId}/pending`);
  assert.ok(millJournal, "the unresolved location is journaled pending");
  assert.match(parse(millJournal!.after).reasons.join(" "), /no registered location alias/u);
  assert.equal(parse(tildaLocation!.value), "ent-ford", "an unresolved arrival keeps the last known location");

  // Relationship: a qualitative kind between the two subjects, never a score.
  const ally = outcomeFor(allyRecord.id)!;
  assert.equal(ally.class, "relationship");
  assert.equal(ally.status, "applied");
  assert.equal(first.relationships.length, 1);
  const edge = first.relationships[0]!;
  assert.equal(edge.type, "ally");
  assert.equal(edge.inverseLabel, "ally");
  assert.equal(edge.status, "active");
  assert.deepEqual([edge.sourceEntityId, edge.targetEntityId].sort(), ["ent-ada", "ent-cole"]);
  assert.ok(!/\d/u.test(edge.type), "the relationship kind carries no numeric score");

  // Republish: same transition IDs replay, no new rows, journal unchanged.
  const again = await publish();
  const second = await rows();
  assert.equal(second.events.length, first.events.length, "republish adds no event row");
  assert.equal(second.state.length, first.state.length);
  assert.equal(second.relationships.length, first.relationships.length);
  assert.equal(second.journal.length, first.journal.length, "republish leaves the journal unchanged");
  assert.equal(second.facts.length, first.facts.length);
  assert.deepEqual(
    [...again.transitions.applied, ...again.transitions.pending].map((item) => [item.recordId, item.transitionId]).sort(),
    [...result.transitions.applied, ...result.transitions.pending].map((item) => [item.recordId, item.transitionId]).sort(),
    "republish reports the same deterministic transition ids",
  );
  assert.equal(again.transitions.skipped.length, 0);

  await db._fileStore.close();
  db = undefined;
  console.log("continuity-memory-transitions regression passed");
} finally {
  if (db) await db._fileStore.close();
  rmSync(root, { recursive: true, force: true });
}
