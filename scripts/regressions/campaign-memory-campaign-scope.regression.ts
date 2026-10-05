import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// A new session reads a read-only projection of earlier sessions in the same game: entities merge by identity, earlier facts retain their origin, current-scene presence stays local, later sessions remain hidden, and each chat can opt out.
const root = mkdtempSync(join(tmpdir(), "marinara-campaign-scope-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";

let db: any = null;
try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const schema = await import("../../packages/server/src/db/schema/index.js");
  const { readCampaignMemoryProjection, listCampaignSessionChats } =
    await import("../../packages/server/src/services/game/campaign-memory-campaign-scope.js");
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
  const otherGame = {
    ...chat("other-game-session", 1, 1),
    groupId: "game-2",
    metadata: JSON.stringify({ gameId: "game-2", gameSessionNumber: 1 }),
  };
  await db.insert(schema.chats).values([
    { ...chat("s1", 1, 1), groupId: null },
    { ...chat("s2", 2, 2, { gameSessionParentChatId: "s1" }), groupId: null },
    chat("s3", 3, 3, { gameSessionParentChatId: "s2-branch" }),
    chat("s2-branch", 2, 4, {
      branchParentChatId: "s2",
      branchParentMessageId: "s2-anchor",
      branchMessageId: "s2-branch-anchor",
    }),
    chat("s2-sibling", 2, 5, {
      branchParentChatId: "s2",
      branchParentMessageId: "s2-anchor",
      branchMessageId: "s2-sibling-anchor",
    }),
    otherGame,
    { ...chat("non-game", 1, 1), mode: "chat" },
    chat("other-game", 1, 1, { gameId: "another-game" }),
    { ...chat("conflicting-folder", 2, 2, { gameSessionParentChatId: "s1" }), groupId: "ui-folder" },
  ]);
  await db.insert(schema.messages).values([
    {
      id: "s2-anchor",
      chatId: "s2",
      role: "user",
      characterId: null,
      content: "source",
      activeSwipeIndex: 0,
      extra: "{}",
      createdAt: at(2),
    },
    {
      id: "s2-branch-anchor",
      chatId: "s2-branch",
      role: "user",
      characterId: null,
      content: "copied",
      activeSwipeIndex: 0,
      extra: "{}",
      createdAt: at(4),
    },
    {
      id: "s2-sibling-anchor",
      chatId: "s2-sibling",
      role: "user",
      characterId: null,
      content: "copied sibling",
      activeSwipeIndex: 0,
      extra: "{}",
      createdAt: at(5),
    },
  ]);
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
    entity("s1-person-a", "s1", "characters", "card-person-a", "Person A"),
    entity("other-game-person", "other-game-session", "campaign-memory", "other-game-person", "Foreign Person"),
    entity("s2-person-a", "s2", "characters", "card-person-a", "Person A"),
    entity("s3-person-a", "s3", "characters", "card-person-a", "Person A"),
    entity("s1-person-b", "s1", "characters", "card-person-b", "Person B"),
    entity("s2-person-b-npc", "s2", "game-npcs", "npc:person-b", "Person B"),
    // The entity tracker can encounter the same card-backed character twice in one session.
    entity("s1-example-card", "s1", "characters", "card-example", "Countess Sample"),
    entity("s1-example-npc", "s1", "game-npcs", "npc:example", "Countess Sample"),
    entity("s1-prefix", "s1", "game-npcs", "npc:prefix", "Sample"),
    entity("s2-prefix-full", "s2", "game-npcs", "npc:prefix-full", "Sample Character"),
    {
      ...entity("s1-tavern", "s1", "campaign-memory", "s1-tavern", "The Tavern"),
      kind: "location",
      owner: JSON.stringify({ type: "registry", store: "campaign-memory", recordId: "s1-tavern" }),
    },
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
    fact("f-other-game", "other-game-session", "other-game-person", "This belongs to another game.", 1),
    fact("f-s1", "s1", "s1-person-a", "Person A swore to guard the vault.", 1),
    fact("f-dup-s1", "s1", "s1-person-a", "Person A keeps a dagger in her boot.", 1),
    fact("f-dup-s2", "s2", "s2-person-a", "Person A keeps a dagger in her boot.", 2),
    fact("f-person-b-s2", "s2", "s2-person-b-npc", "Person B repaired the bridge.", 2),
    fact("f-s3", "s3", "s3-person-a", "Person A left the city.", 3),
    // The player retracted and locked an invented past in S1; S2 read the same line again.
    { ...fact("f-child-s1", "s1", "s1-person-a", "Person A has a daughter.", 1), status: "retracted", manualLock: 1 },
    fact("f-child-s2", "s2", "s2-person-a", "Person A has a daughter.", 2),
    // Pinned canon: a locked fact whose value carries pinned: true.
    {
      ...fact("f-pin", "s1", "s1-person-b", "Person B is sworn to the Crown.", 1),
      manualLock: 1,
      value: JSON.stringify({ text: "Person B is sworn to the Crown.", pinned: true }),
    },
  ]);
  const event = (eventId: string, chatId: string, participant: string, day: number) => ({
    eventId,
    chatId,
    occurrenceOrder: order(day),
    campaignTime: null,
    participantEntityIds: JSON.stringify([participant]),
    locationEntityId: null,
    sourceRevision: "r1",
    transitions: "[]",
    evidence: "[]",
    provenance,
    immutable: 1,
    createdAt: at(day),
  });
  await db.insert(schema.campaignMemoryEvents).values([event("e-s1", "s1", "s1-person-a", 1)]);
  const state = (stateId: string, chatId: string, entityId: string, property: string, value: unknown, day: number) => ({
    stateId,
    chatId,
    entityId,
    property,
    value: JSON.stringify(value),
    sourceEventId: "e-s1",
    validAtOrder: order(day),
    protected: 0,
    provenance,
    manualLock: 0,
    revision: 1,
    createdAt: at(day),
    updatedAt: at(day),
  });
  await db
    .insert(schema.campaignMemoryCurrentState)
    .values([
      state("st-loc", "s1", "s1-person-a", "location", "s1-tavern", 1),
      state("st-presence", "s1", "s1-person-a", "presence", "present", 1),
    ]);

  // Session list: earlier sessions and the current one, never a later session.
  assert.deepEqual(
    (await listCampaignSessionChats(db, "conflicting-folder")).map((row) => row.id),
    ["conflicting-folder"],
    "conflicting ownership holds cross-session history",
  );
  assert.deepEqual(
    (await listCampaignSessionChats(db, "s2")).map((item: { id: string }) => item.id),
    ["s1", "s2"],
  );
  assert.deepEqual(
    (await listCampaignSessionChats(db, "s3")).map((item: { id: string }) => item.id),
    ["s1", "s2-branch", "s3"],
    "a later session follows only its explicitly selected, message-verified branch ancestry",
  );

  await db
    .update(schema.chats)
    .set({
      metadata: JSON.stringify({ gameId: game, gameSessionNumber: 3, gameSessionParentChatId: "missing-session" }),
    })
    .where((await import("../../packages/server/src/db/file-query.js")).eq(schema.chats.id, "s3"));
  assert.deepEqual(
    (await listCampaignSessionChats(db, "s3")).map((item: { id: string }) => item.id),
    ["s3"],
    "a broken explicit edge holds ancestry instead of substituting a same-number sibling",
  );
  await db
    .update(schema.chats)
    .set({ metadata: JSON.stringify({ gameId: game, gameSessionNumber: 3, gameSessionParentChatId: "s2-branch" }) })
    .where((await import("../../packages/server/src/db/file-query.js")).eq(schema.chats.id, "s3"));

  const projection = await readCampaignMemoryProjection(db, "s2");
  const personA = projection.entities.filter((item: any) => item.aliases[0] === "Person A");
  assert.equal(personA.length, 1, "the same person across sessions is one entity");
  assert.equal(personA[0].entityId, "s2-person-a", "the current session's entity id represents the person");
  assert.deepEqual(personA[0].sessionNumbers, [1, 2]);
  const personB = projection.entities.filter((item: any) => item.aliases[0] === "Person B");
  assert.equal(personB.length, 1, "a tracked NPC folds into the library card of the same name");
  assert.equal(personB[0].owner.store, "characters", "the library card is the canonical owner");
  const exampleName = projection.entities.filter((item: any) => item.aliases.includes("Countess Sample"));
  assert.equal(exampleName.length, 1, "a tracked NPC with a card's exact name in the same session is the same person");
  assert.equal(exampleName[0].owner.store, "characters");
  const prefixMatch = projection.entities.filter((item: any) =>
    item.aliases.some((alias: string) => alias.startsWith("Sample")),
  );
  assert.equal(prefixMatch.length, 1, "a one-word NPC name folds into the unique full name that starts with it");
  assert.deepEqual(prefixMatch[0].sessionNumbers, [1, 2]);
  const s1Fact = projection.facts.find((item: any) => item.factId === "f-s1");
  assert.equal(s1Fact.subjectEntityId, "s2-person-a", "earlier facts attach to the merged entity");
  assert.equal(s1Fact.chatId, "s2", "projected records read as the current chat");
  assert.equal(s1Fact.originChatId, "s1", "edits go to the chat that owns the record");
  assert.equal(s1Fact.originSessionNumber, 1);
  assert.equal(
    projection.facts.find((item: any) => item.factId === "f-person-b-s2").subjectEntityId,
    personB[0].entityId,
  );
  assert.equal(
    projection.facts.filter((item: any) => JSON.stringify(item.value).includes("dagger")).length,
    1,
    "an identical statement re-read in a later session is kept once",
  );
  assert.equal(
    projection.facts.some((item: any) => item.factId === "f-s3"),
    false,
    "no memory from a later session",
  );
  assert.equal(
    projection.facts.some((item: any) => item.factId === "f-other-game"),
    false,
    "a matching session number from another game is never projected",
  );
  assert.equal(
    projection.currentState.some((item: any) => item.property === "presence"),
    false,
    "presence is per scene",
  );
  const location = projection.currentState.find((item: any) => item.property === "location");
  assert.equal(location.value, "s1-tavern", "location values keep pointing at a projected entity");

  await db.transaction(async (tx: any) => {
    await readCampaignMemoryProjection(tx, "s2");
    await tx
      .update(schema.campaignMemoryFacts)
      .set({ value: JSON.stringify({ text: "Changed inside transaction" }) })
      .where(
        (await import("../../packages/server/src/db/file-query.js")).eq(schema.campaignMemoryFacts.factId, "f-s1"),
      );
    const fresh = await readCampaignMemoryProjection(tx, "s2");
    assert.equal(
      fresh.facts.find((item: any) => item.factId === "f-s1").value.text,
      "Changed inside transaction",
      "native transaction writes invalidate cached memory rows",
    );
  });

  // A database adapter without write counters must bypass both projection and row caches.
  const withoutCounters = { ...db, _fileStore: undefined } as unknown as typeof db;
  await readCampaignMemoryProjection(withoutCounters, "s2");
  await db
    .update(schema.campaignMemoryFacts)
    .set({ value: JSON.stringify({ text: "Changed without counters" }) })
    .where((await import("../../packages/server/src/db/file-query.js")).eq(schema.campaignMemoryFacts.factId, "f-s1"));
  const uncached = await readCampaignMemoryProjection(withoutCounters, "s2");
  assert.equal(
    uncached.facts.find((item: any) => item.factId === "f-s1").value.text,
    "Changed without counters",
    "adapters without invalidation counters never reuse cached memory rows",
  );

  // Opt-out: a chat can read only its own memory.
  await db
    .update(schema.chats)
    .set({ metadata: JSON.stringify({ gameId: game, gameSessionNumber: 2, gameCampaignMemoryScope: "session" }) })
    .where((await import("../../packages/server/src/db/file-query.js")).eq(schema.chats.id, "s2"));
  const sessionOnly = await readCampaignMemoryProjection(db, "s2");
  assert.deepEqual(sessionOnly.sessionChatIds, ["s2"]);
  assert.equal(
    sessionOnly.facts.some((item: any) => item.factId === "f-s1"),
    false,
  );
  console.log("campaign-memory-campaign-scope regression passed");
} finally {
  await db?._fileStore?.close?.();
  rmSync(root, { recursive: true, force: true });
}
