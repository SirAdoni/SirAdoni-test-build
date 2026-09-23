import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Every Game session is its own chat and continuity writes each session's memory into that chat, so a new session
// used to start with an empty memory (Session 12: 48 entities, 0 facts) although ten sessions of verified facts sat
// in the earlier chats. The campaign projection merges every earlier session of the same game into a read-only
// view of the current chat: one entity per person, earlier facts tagged with their session, presence only from the
// current session, never a later session's memory, and an opt-out per chat.
const root = mkdtempSync(join(tmpdir(), "marinara-campaign-scope-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";

let db: any = null;
try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const schema = await import("../../packages/server/src/db/schema/index.js");
  const { readCampaignMemoryProjection, listCampaignSessionChats } = await import(
    "../../packages/server/src/services/game/campaign-memory-campaign-scope.js"
  );
  const { buildCampaignMemoryContextFromStorage } = await import(
    "../../packages/server/src/services/game/campaign-memory-context.js"
  );
  db = await createFileNativeDB();
  const game = "game-1";
  const at = (day: number) => `2026-09-${String(day).padStart(2, "0")}T00:00:00.000Z`;
  const order = (day: number) => `m1|${at(day)}|m${day}`;
  const provenance = JSON.stringify({ source: "regression", sourceRevision: "r1", actor: "system" });
  const chat = (id: string, session: number, day: number, extra: Record<string, unknown> = {}) => ({
    id,
    name: `Session ${session}`,
    mode: "game",
    groupId: game,
    characterIds: "[]",
    metadata: JSON.stringify({ gameId: game, gameSessionNumber: session, ...extra }),
    createdAt: at(day),
    updatedAt: at(day),
  });
  await db.insert(schema.chats).values([chat("s1", 1, 1), chat("s2", 2, 2), chat("s3", 3, 3)]);
  const entity = (entityId: string, chatId: string, store: string, recordId: string, alias: string) => ({
    entityId,
    chatId,
    kind: "character",
    owner: JSON.stringify({ type: "existing", store, recordId }),
    aliases: JSON.stringify([alias]),
    tags: "[]",
    attributes: "{}",
    status: "active",
    manualLock: 0,
    provenance,
    revision: 1,
    createdAt: at(1),
    updatedAt: at(1),
  });
  await db.insert(schema.campaignMemoryEntities).values([
    entity("s1-mira", "s1", "characters", "card-mira", "Mira"),
    entity("s2-mira", "s2", "characters", "card-mira", "Mira"),
    entity("s3-mira", "s3", "characters", "card-mira", "Mira"),
    entity("s1-quenby", "s1", "characters", "card-quenby", "Quenby"),
    entity("s2-quenby-npc", "s2", "game-npcs", "npc:quenby", "Quenby"),
    // The NPC tracker registered a card character a second time in the same session (Countess Maritza, S7 to S9).
    entity("s1-maritza-card", "s1", "characters", "card-maritza", "Countess Maritza"),
    entity("s1-maritza-npc", "s1", "game-npcs", "npc:maritza", "Countess Maritza"),
    entity("s1-quilla", "s1", "game-npcs", "npc:quilla", "Quilla"),
    entity("s2-quilla-tallis", "s2", "game-npcs", "npc:quilla-tallis", "Quilla Tallis"),
    { ...entity("s1-tavern", "s1", "campaign-memory", "s1-tavern", "The Tavern"), kind: "location",
      owner: JSON.stringify({ type: "registry", store: "campaign-memory", recordId: "s1-tavern" }) },
  ]);
  const fact = (factId: string, chatId: string, subject: string, text: string, day: number) => ({
    factId,
    chatId,
    subjectEntityId: subject,
    predicate: "decision",
    value: JSON.stringify({ text }),
    conditions: "[]",
    status: "verified",
    validFromOrder: order(day),
    sourceRevision: "r1",
    evidence: "[]",
    author: "system",
    provenance,
    manualLock: 0,
    revision: 1,
    createdAt: at(day),
    updatedAt: at(day),
  });
  await db.insert(schema.campaignMemoryFacts).values([
    fact("f-s1", "s1", "s1-mira", "Mira swore to guard the vault.", 1),
    fact("f-dup-s1", "s1", "s1-mira", "Mira keeps a dagger in her boot.", 1),
    fact("f-dup-s2", "s2", "s2-mira", "Mira keeps a dagger in her boot.", 2),
    fact("f-quenby-s2", "s2", "s2-quenby-npc", "Quenby repaired the bridge.", 2),
    fact("f-s3", "s3", "s3-mira", "Mira left the city.", 3),
    // The player retracted and locked an invented past in S1; S2 read the same line again.
    { ...fact("f-child-s1", "s1", "s1-mira", "Mira has a daughter.", 1), status: "retracted", manualLock: 1 },
    fact("f-child-s2", "s2", "s2-mira", "Mira has a daughter.", 2),
    // Pinned canon: a locked fact whose value carries pinned: true.
    {
      ...fact("f-pin", "s1", "s1-quenby", "Quenby is sworn to the Crown.", 1),
      manualLock: 1,
      value: JSON.stringify({ text: "Quenby is sworn to the Crown.", pinned: true }),
    },
  ]);
  const event = (eventId: string, chatId: string, participant: string, day: number) => ({
    eventId, chatId, occurrenceOrder: order(day), campaignTime: null, participantEntityIds: JSON.stringify([participant]),
    locationEntityId: null, sourceRevision: "r1", transitions: "[]", evidence: "[]", provenance, immutable: 1, createdAt: at(day),
  });
  await db.insert(schema.campaignMemoryEvents).values([event("e-s1", "s1", "s1-mira", 1)]);
  const state = (stateId: string, chatId: string, entityId: string, property: string, value: unknown, day: number) => ({
    stateId, chatId, entityId, property, value: JSON.stringify(value), sourceEventId: "e-s1", validAtOrder: order(day),
    protected: 0, provenance, manualLock: 0, revision: 1, createdAt: at(day), updatedAt: at(day),
  });
  await db.insert(schema.campaignMemoryCurrentState).values([
    state("st-loc", "s1", "s1-mira", "location", "s1-tavern", 1),
    state("st-presence", "s1", "s1-mira", "presence", "present", 1),
  ]);

  // Session list: earlier sessions and the current one, never a later session.
  assert.deepEqual((await listCampaignSessionChats(db, "s2")).map((item: { id: string }) => item.id), ["s1", "s2"]);

  const projection = await readCampaignMemoryProjection(db, "s2");
  const mira = projection.entities.filter((item: any) => item.aliases[0] === "Mira");
  assert.equal(mira.length, 1, "the same person across sessions is one entity");
  assert.equal(mira[0].entityId, "s2-mira", "the current session's entity id represents the person");
  assert.deepEqual(mira[0].sessionNumbers, [1, 2]);
  const quenby = projection.entities.filter((item: any) => item.aliases[0] === "Quenby");
  assert.equal(quenby.length, 1, "a tracked NPC folds into the library card of the same name");
  assert.equal(quenby[0].owner.store, "characters", "the library card is the canonical owner");
  const maritza = projection.entities.filter((item: any) => item.aliases.includes("Countess Maritza"));
  assert.equal(maritza.length, 1, "a tracked NPC with a card's exact name in the same session is the same person");
  assert.equal(maritza[0].owner.store, "characters");
  const quilla = projection.entities.filter((item: any) => item.aliases.some((alias: string) => alias.startsWith("Quilla")));
  assert.equal(quilla.length, 1, "a one-word NPC name folds into the unique full name that starts with it");
  assert.deepEqual(quilla[0].sessionNumbers, [1, 2]);
  const s1Fact = projection.facts.find((item: any) => item.factId === "f-s1");
  assert.equal(s1Fact.subjectEntityId, "s2-mira", "earlier facts attach to the merged entity");
  assert.equal(s1Fact.chatId, "s2", "projected records read as the current chat");
  assert.equal(s1Fact.originChatId, "s1", "edits go to the chat that owns the record");
  assert.equal(s1Fact.originSessionNumber, 1);
  assert.equal(projection.facts.find((item: any) => item.factId === "f-quenby-s2").subjectEntityId, quenby[0].entityId);
  assert.equal(
    projection.facts.filter((item: any) => JSON.stringify(item.value).includes("dagger")).length,
    1,
    "an identical statement re-read in a later session is kept once",
  );
  assert.equal(projection.facts.some((item: any) => item.factId === "f-s3"), false, "no memory from a later session");
  assert.equal(projection.currentState.some((item: any) => item.property === "presence"), false, "presence is per scene");
  const location = projection.currentState.find((item: any) => item.property === "location");
  assert.equal(location.value, "s1-tavern", "location values keep pointing at a projected entity");

  const context = await buildCampaignMemoryContextFromStorage(db, {
    chatId: "s2",
    audience: { kind: "gm" },
    maxCharacters: 10_000,
  });
  assert.match(context.text, /\[fact f-s1 S1\] Mira, decision: Mira swore to guard the vault\./u);
  assert.match(context.text, /Mira: last known location = The Tavern \(S1\)/u);
  assert.doesNotMatch(context.text, /s1-mira|s2-mira|s1-tavern/u, "the GM reads names, never raw entity ids");
  assert.doesNotMatch(context.text, /daughter/u, "a statement the user retracted and locked is hidden in every session");
  const factLines = context.text.split("\n").filter((line: string) => line.startsWith("[fact "));
  assert.match(factLines[0] ?? "", /^\[fact f-pin S1 canon\] Quenby, decision: Quenby is sworn to the Crown\./u, "pinned canon comes first");

  // Opt-out: a chat can read only its own memory.
  await db.update(schema.chats).set({ metadata: JSON.stringify({ gameId: game, gameSessionNumber: 2, gameCampaignMemoryScope: "session" }) })
    .where((await import("../../packages/server/src/db/file-query.js")).eq(schema.chats.id, "s2"));
  const sessionOnly = await readCampaignMemoryProjection(db, "s2");
  assert.deepEqual(sessionOnly.sessionChatIds, ["s2"]);
  assert.equal(sessionOnly.facts.some((item: any) => item.factId === "f-s1"), false);
  console.log("campaign-memory-campaign-scope regression passed");
} finally {
  await db?._fileStore?.close?.();
  rmSync(root, { recursive: true, force: true });
}
