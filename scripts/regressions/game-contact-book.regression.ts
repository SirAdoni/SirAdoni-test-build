import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "marinara-contact-book-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");

try {
  const [{ createFileNativeDB }, schema, { sceneTurnHash }, { buildGameContactBook }] = await Promise.all([
    import("../../packages/server/src/db/file-backed-store.js"),
    import("../../packages/server/src/db/schema/index.js"),
    import("../../packages/server/src/services/game/scene-timeline-model.js"),
    import("../../packages/server/src/services/game/game-contact-book.js"),
  ]);
  const db = await createFileNativeDB();
  const now = "2026-09-19T00:00:00.000Z";
  const json = (value: unknown) => JSON.stringify(value);
  const campaign = "contact-campaign";
  const chat = (id: string, session: number, extra: Record<string, unknown> = {}) => ({
    id,
    name: id,
    mode: "game" as const,
    groupId: campaign,
    personaId: "persona-1",
    metadata: json({
      gameSessionNumber: session,
      gameNpcs: [
        { id: "npc-alice", characterId: "char-alice", name: "Alice", reputation: 75 },
        { id: "npc-eve", characterId: "char-eve", name: "Eve" },
      ],
      ...extra,
    }),
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.chats).values([
    chat("session-1", 1, {
      gameNpcs: [
        {
          id: "npc-alice",
          characterId: "char-alice",
          name: "Alice",
          reputation: 75,
          avatar: "alice-snapshot.png",
          avatarCrop: { srcX: 0.1, srcY: 0.2, srcWidth: 0.7, srcHeight: 0.8 },
        },
        { id: "npc-eve", characterId: "char-eve", name: "Eve", avatar: "eve-snapshot.png" },
        { id: "npc-alice-alt", characterId: "char-alice-alt", name: "Alice", reputation: -20 },
      ],
    }),
    chat("session-2", 2),
    chat("session-2-duplicate", 2),
    chat("session-3-future", 3),
    chat("session-unknown", 0, {
      gameSessionNumber: undefined,
      gameNpcs: [{ id: "npc-solo", name: "Solo", reputation: 0 }],
    }),
    chat("branch", 3, { branchParentChatId: "session-2" }),
  ]);
  await db.insert(schema.personas).values({ id: "persona-1", name: "Edmund", createdAt: now, updatedAt: now });
  await db.insert(schema.characters).values({
    id: "char-bob",
    data: json({ name: "Bob", extensions: { avatarCrop: { srcX: 0.2, srcY: 0.1, srcWidth: 0.6, srcHeight: 0.75 } } }),
    avatarPath: "bob-library.png",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.characters).values({
    id: "char-eve",
    data: json({ name: "Eve" }),
    createdAt: now,
    updatedAt: now,
  });
  const scene = (chatId: string, messageId: string, names: string[]) => {
    const source = `assistant: ${names.join(" ")} are here.`;
    const hash = sceneTurnHash(sceneTurnHash("scene-timeline-v3", "[]"), `${messageId}:0:${source}`);
    return {
      id: messageId,
      chatId,
      role: "assistant" as const,
      content: source.slice("assistant: ".length),
      activeSwipeIndex: 0,
      extra: json({
        gameSceneTimeline: {
          hash,
          visits: [{ location: "Room", present: names, participants: names, departures: [], facts: [] }],
        },
      }),
      createdAt: now,
    };
  };
  await db
    .insert(schema.messages)
    .values([
      scene("session-1", "message-1", ["Edmund", "Alice", "Bob", "Eve"]),
      scene("session-2", "message-2", ["Edmund", "Alice", "Bob", "Eve", "Carol", "Guards"]),
      scene("session-2-duplicate", "message-duplicate", ["Edmund", "Alice", "DuplicateOnly"]),
      scene("session-3-future", "message-3", ["Edmund", "Alice"]),
      scene("session-unknown", "message-unknown", ["Edmund", "Solo"]),
      scene("branch", "message-branch", ["Edmund", "Alice", "Bob"]),
    ]);
  const provenance = json({ source: "regression", sourceRevision: "1", actor: "system" });
  await db.insert(schema.campaignMemoryEntities).values([
    {
      entityId: "persona-entity",
      chatId: "session-1",
      kind: "persona",
      owner: json({ type: "existing", store: "personas", recordId: "persona-1" }),
      aliases: "[]",
      tags: "[]",
      attributes: "{}",
      status: "active",
      manualLock: 0,
      provenance,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    },
    {
      entityId: "alice-npc-entity",
      chatId: "session-1",
      kind: "character",
      owner: json({ type: "existing", store: "game-npcs", recordId: "npc-alice" }),
      aliases: json(["Alice"]),
      tags: "[]",
      attributes: "{}",
      status: "active",
      manualLock: 0,
      provenance,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    },
  ]);
  await db.insert(schema.campaignMemoryRelationships).values({
    relationshipId: "relationship-1",
    chatId: "session-1",
    sourceEntityId: "alice-npc-entity",
    targetEntityId: "persona-entity",
    type: "trusted ally",
    inverseLabel: "has trusted ally",
    status: "active",
    evidence: "[]",
    provenance,
    manualLock: 0,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.campaignMemoryRelationships).values({
    relationshipId: "relationship-2",
    chatId: "session-2",
    sourceEntityId: "alice-npc-entity",
    targetEntityId: "persona-entity",
    type: "current ally",
    inverseLabel: "has current ally",
    status: "active",
    evidence: "[]",
    provenance,
    manualLock: 0,
    revision: 2,
    createdAt: now,
    updatedAt: "2026-09-19T01:00:00.000Z",
  });
  await db.insert(schema.campaignMemoryRelationships).values({
    relationshipId: "relationship-standing",
    chatId: "session-2",
    sourceEntityId: "alice-npc-entity",
    targetEntityId: "persona-entity",
    type: "reputation:friendly",
    inverseLabel: "party-standing:friendly",
    status: "active",
    evidence: "[]",
    provenance,
    manualLock: 0,
    revision: 3,
    createdAt: now,
    updatedAt: "2026-09-19T02:00:00.000Z",
  });
  await db.insert(schema.campaignMemoryRelationships).values({
    relationshipId: "relationship-branch-proposed",
    chatId: "branch",
    sourceEntityId: "char-alice",
    targetEntityId: "persona-entity",
    type: "proposed ally",
    inverseLabel: "has proposed ally",
    status: "proposed",
    evidence: "[]",
    provenance,
    manualLock: 0,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });

  const result = await buildGameContactBook(db, "session-2");
  assert.deepEqual(
    result.contacts.map((contact) => contact.name),
    ["Alice", "Bob", "Eve"],
    "only encountered actual records are included; persona, unlinked people and groups are excluded",
  );
  assert.equal(result.contacts[0]?.opinion, 75, "reputation is projected as opinion");
  assert.equal(
    result.contacts.find((contact) => contact.name === "Bob")?.avatar,
    "bob-library.png",
    "saved library portrait is projected",
  );
  assert.deepEqual(
    result.contacts.find((contact) => contact.name === "Bob")?.avatarCrop,
    { srcX: 0.2, srcY: 0.1, srcWidth: 0.6, srcHeight: 0.75 },
    "saved library avatar crop is projected",
  );
  assert.equal(
    result.contacts.find((contact) => contact.name === "Eve")?.avatar,
    "eve-snapshot.png",
    "snapshot portrait is preserved",
  );
  assert.equal(result.contacts[0]?.relationshipStatus, "current ally", "latest eligible relationship predicate wins");
  assert.equal(result.coverage.complete, false, "duplicate historical session is reported as incomplete coverage");
  assert.equal(result.coverage.pendingSessions, 2, "coverage counts skipped duplicate and ambiguous sessions");
  assert.equal(
    result.contacts[0]?.evidenceMessageIds.includes("message-3"),
    false,
    "future session evidence is excluded",
  );

  assert.equal(
    result.contacts[0]?.evidenceMessageIds.includes("message-1"),
    false,
    "ambiguous identities do not acquire encounter evidence",
  );
  assert.ok(
    result.contacts.every((contact) => !contact.id.startsWith("name:")),
    "no synthetic contacts",
  );
  assert.equal(result.contacts.length, 3, "portrait enrichment does not add contacts");
  const branchResult = await buildGameContactBook(db, "branch");
  assert.deepEqual(
    branchResult.contacts.map((contact) => contact.evidenceMessageIds),
    [["message-branch"], ["message-branch"]],
    "branch uses its own session scope",
  );
  assert.equal(
    branchResult.contacts[0]?.relationshipStatus,
    undefined,
    "relationship from parent session does not leak into branch",
  );
  const unnumberedResult = await buildGameContactBook(db, "session-unknown");
  assert.deepEqual(
    unnumberedResult.contacts.map((contact) => contact.name),
    ["Solo"],
    "unnumbered sessions stay current-chat-only",
  );
  assert.equal(
    unnumberedResult.contacts[0]?.id,
    "npc-solo",
    "standalone NPC records are valid without a character card",
  );
  assert.equal(
    unnumberedResult.contacts[0]?.opinion,
    undefined,
    "an unobserved default zero is unknown, not a recorded neutral opinion",
  );
  await db.insert(schema.chats).values([
    { ...chat("score-old", 1), groupId: "score-campaign" },
    {
      ...chat("score-new", 2, {
        gameNpcs: [{ id: "npc-alice", characterId: "char-alice", name: "Alice", reputation: -75 }],
      }),
      groupId: "score-campaign",
    },
  ]);
  await db
    .insert(schema.messages)
    .values([scene("score-old", "score-message-old", ["Alice"]), scene("score-new", "score-message-new", ["Alice"])]);
  const latestOpinion = await buildGameContactBook(db, "score-new");
  assert.equal(latestOpinion.contacts[0]?.opinion, -75);
  assert.deepEqual(
    latestOpinion.contacts[0]?.automaticCategories,
    ["hostile"],
    "old reputation groups do not survive a changed opinion",
  );
  await db.insert(schema.characters).values({
    id: "char-iris",
    data: json({ name: "Iris" }),
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.chats).values({
    ...chat("stance-session", 1, {
      gameNpcs: [{ id: "npc-iris", characterId: "char-iris", name: "Iris", reputation: 0, reputationObserved: true }],
    }),
    groupId: "stance-campaign",
  });
  await db.insert(schema.messages).values(scene("stance-session", "stance-message", ["Iris"]));
  await db.insert(schema.campaignMemoryEntities).values([
    {
      entityId: "stance-persona",
      chatId: "stance-session",
      kind: "persona",
      owner: json({ type: "existing", store: "personas", recordId: "persona-1" }),
      aliases: "[]",
      tags: "[]",
      attributes: "{}",
      status: "active",
      manualLock: 0,
      provenance,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    },
    {
      entityId: "stance-npc",
      chatId: "stance-session",
      kind: "character",
      owner: json({ type: "existing", store: "game-npcs", recordId: "npc-iris" }),
      aliases: json(["Iris"]),
      tags: "[]",
      attributes: "{}",
      status: "active",
      manualLock: 0,
      provenance,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    },
  ]);
  const stanceRelationship = (
    id: string,
    type: string,
    sourceEntityId: string,
    targetEntityId: string,
    status: string,
    updatedAt: string,
    manualLock = 0,
  ) => ({
    relationshipId: id,
    chatId: "stance-session",
    sourceEntityId,
    targetEntityId,
    type,
    inverseLabel: type,
    status,
    evidence: "[]",
    provenance,
    manualLock,
    revision: 1,
    createdAt: now,
    updatedAt,
  });
  await db
    .insert(schema.campaignMemoryRelationships)
    .values([
      stanceRelationship("stance-score", "reputation:neutral", "stance-npc", "stance-persona", "active", now),
      stanceRelationship(
        "stance-suspicious",
        "suspicious-of",
        "stance-npc",
        "stance-persona",
        "active",
        "2026-09-19T01:00:00.000Z",
      ),
      stanceRelationship(
        "stance-proposed",
        "friend-of",
        "stance-npc",
        "stance-persona",
        "proposed",
        "2026-09-19T02:00:00.000Z",
      ),
      stanceRelationship(
        "stance-reverse",
        "loves",
        "stance-persona",
        "stance-npc",
        "active",
        "2026-09-19T03:00:00.000Z",
      ),
      stanceRelationship(
        "stance-ended-other",
        "enemy-of",
        "stance-npc",
        "stance-persona",
        "ended",
        "2026-09-19T04:00:00.000Z",
      ),
    ]);
  const observedStance = await buildGameContactBook(db, "stance-session");
  assert.equal(observedStance.contacts[0]?.opinion, 0, "recorded neutral score is distinct from unknown");
  assert.equal(
    observedStance.contacts[0]?.relationshipStatus,
    "suspicious-of",
    "a proposal, opposite-direction feeling and unrelated ended edge do not erase the NPC stance",
  );
  await db
    .insert(schema.campaignMemoryRelationships)
    .values(stanceRelationship("stance-manual", "friend-of", "stance-npc", "stance-persona", "active", now, 1));
  assert.equal(
    (await buildGameContactBook(db, "stance-session")).contacts[0]?.relationshipStatus,
    "friend-of",
    "a manually locked relationship wins over later automatic inference",
  );
  await db.insert(schema.characters).values({
    id: "char-other-mira",
    data: json({ name: "Mira" }),
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.chats).values({
    ...chat("mira-session", 1, { gameNpcs: [{ id: "npc-mira", name: "Mira" }] }),
    groupId: "mira-campaign",
  });
  await db.insert(schema.messages).values([scene("mira-session", "mira-message", ["Mira"])]);
  const miraResult = await buildGameContactBook(db, "mira-session");
  assert.deepEqual(
    miraResult.contacts.map((contact) => contact.id),
    ["npc-mira"],
    "an unrelated library card with the same name does not make a campaign NPC ambiguous",
  );
  assert.equal(miraResult.coverage.complete, true, "unrelated library cards do not block coverage");
} finally {
  rmSync(root, { recursive: true, force: true });
}
