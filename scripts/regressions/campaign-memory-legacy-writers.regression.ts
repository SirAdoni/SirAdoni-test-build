import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The runner does not isolate storage: DATA_DIR must be set before any server module loads.
const root = mkdtempSync(join(tmpdir(), "marinara-campaign-memory-legacy-writers-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");

try {
  const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
  const { chats, messages, campaignMemoryMutationJournal } =
    await import("../../packages/server/src/db/schema/index.js");
  const { eq } = await import("../../packages/server/src/db/file-query.js");
  const { createCampaignMemoryStorage } =
    await import("../../packages/server/src/services/storage/campaign-memory.storage.js");
  const { registerCapabilityService } =
    await import("../../packages/server/src/services/capability-packages/capability-service-registry.service.js");
  const { commitSpatialOwnerTurn } = await import("../../packages/server/src/services/spatial-context/owner-turn.js");
  const { recordLegacyPresence, recordLegacyQuestProgress, recordLegacyReputation, resolveLegacySourceMessageId } =
    await import("../../packages/server/src/services/game/campaign-memory-legacy-writers.js");
  const db = await getDB();
  const chatId = "legacy-writers-chat";
  const now = new Date().toISOString();
  await db
    .insert(chats)
    .values({
      id: chatId,
      name: "Legacy writers",
      mode: "game",
      characterIds: JSON.stringify(["alice"]),
      personaId: "hero",
      createdAt: now,
      updatedAt: now,
    });
  const texts: Record<string, string> = {
    m1: "The hero waited at the gate.",
    m2: "The hero climbed to the tower.",
    m3: "Alice joined the hero in the tower and took the job.",
    m4: "Bob thanked the hero for the help. The job was finished.",
    m5: "The hero rested.",
  };
  await db
    .insert(messages)
    .values(
      Object.entries(texts).map(([id, content], index) => ({
        id,
        chatId,
        role: "assistant",
        content,
        createdAt: `2026-09-15T12:0${index}:00.000Z`,
      })),
    );

  const kinds: Record<string, "persona" | "character" | "location" | "quest"> = {
    hero: "persona",
    alice: "character",
    "npc-bob": "character",
    gate: "location",
    tower: "location",
    job: "quest",
  };
  const stores: Record<string, string> = {
    hero: "personas",
    alice: "characters",
    "npc-bob": "game-npcs",
    gate: "spatial-context",
    tower: "spatial-context",
    job: "game-state",
  };
  const ownerReader = {
    async readChatScope(id: string) {
      return {
        chatId: id,
        characterIds: ["alice"],
        npcIds: ["npc-bob"],
        personaId: "hero",
        questEntryIds: ["job"],
        itemIds: [],
        spatialDefinition: { locations: [{ id: "gate" }, { id: "tower" }] },
      } as never;
    },
    async readExistingOwner(owner: { store: string; recordId: string }) {
      const kind = kinds[owner.recordId];
      return kind && stores[owner.recordId] === owner.store
        ? { store: owner.store, recordId: owner.recordId, kind }
        : null;
    },
  };
  const storage = createCampaignMemoryStorage(db, ownerReader);
  const provenance = { source: "regression", sourceRevision: "r1", actor: "user" as const };
  for (const [recordId, kind] of Object.entries(kinds)) {
    await storage.createEntity({
      entityId: `ent-${recordId}`,
      chatId,
      kind,
      owner: { type: "existing", store: stores[recordId]!, recordId },
      aliases: [recordId],
      tags: [],
      attributes: {},
      status: "active",
      manualLock: false,
      provenance,
    });
  }

  const scope = { chatId };
  const journalRows = async () =>
    db.select().from(campaignMemoryMutationJournal).where(eq(campaignMemoryMutationJournal.chatId, chatId));
  const journalCount = async () => (await journalRows()).length;
  const transitionRows = async (cls: string) =>
    (await journalRows())
      .filter((row) => row.recordType === "transition")
      .map(
        (row) => JSON.parse(row.after!) as { class: string; status: string; reasons: string[]; transitionId: string },
      )
      .filter((row) => row.class === cls);
  const state = async (entityId: string, property: string) =>
    (await storage.listCurrentState(scope)).find((s) => s.entityId === entityId && s.property === property);
  const events = async () => storage.listEvents(scope);

  // Spatial movement through the owner-turn bridge: the capability provider stays the location owner.
  const turn = { messageId: "m2", locationId: "tower", from: "gate" };
  registerCapabilityService("hierarchical-maps:owner-turn", {
    async commitSpatialOwnerTurn(input: { chatId: string; transition: { commandId: string } }) {
      const message = (await db.select().from(messages).where(eq(messages.id, turn.messageId)))[0]!;
      return {
        message,
        snapshot: {
          id: `snap-${turn.messageId}`,
          chatId: input.chatId,
          messageId: turn.messageId,
          swipeIndex: 0,
          currentLocationId: turn.locationId,
          definitionRevision: 1,
          source: "owner",
          transitionCommandId: input.transition.commandId,
          transitionPayloadHash: null,
          createdAt: now,
        },
        travel: {
          mode: "step_by_step",
          fromLocationId: turn.from,
          targetLocationId: turn.locationId,
          routeLocationIds: [turn.locationId],
          remainingLocationIds: [],
          complete: true,
        },
      };
    },
  });
  const move = {
    chatId,
    content: texts.m2!,
    transition: {
      destinationId: "tower",
      expectedDefinitionRevision: 1,
      expectedCurrentLocationId: "gate",
      commandId: "cmd-tower",
    },
  };
  const committed = await commitSpatialOwnerTurn(move);
  assert.equal(committed.snapshot.currentLocationId, "tower");
  assert.equal((await state("ent-hero", "location"))!.value, "ent-tower");
  assert.equal((await state("ent-hero", "presence"))!.value, "present");
  const movements = await transitionRows("movement");
  assert.equal(movements.length, 1);
  assert.equal(movements[0]!.status, "applied");
  assert.equal((await events()).filter((e) => e.participantEntityIds.includes("ent-hero")).length, 1);
  const journalAfterMove = await journalCount();
  await commitSpatialOwnerTurn(move);
  assert.equal(await journalCount(), journalAfterMove, "a repeated owner turn replays; no second effect");
  assert.equal((await events()).filter((e) => e.participantEntityIds.includes("ent-hero")).length, 1);
  assert.equal((await state("ent-hero", "location"))!.revision, 1);

  // An older move delivered after a newer one is journaled stale and the newer location stays.
  Object.assign(turn, { messageId: "m1", locationId: "gate", from: null });
  await commitSpatialOwnerTurn({
    ...move,
    content: texts.m1!,
    transition: { ...move.transition, destinationId: "gate", commandId: "cmd-gate" },
  });
  const stale = (await transitionRows("movement")).find((row) => row.status === "stale");
  assert.ok(stale, "older movement is journaled as stale");
  assert.match(stale!.reasons.join(" "), /newer order/u);
  assert.equal((await state("ent-hero", "location"))!.value, "ent-tower");
  assert.equal((await state("ent-hero", "location"))!.revision, 1);

  // Presence: one transition per arriving character; an unregistered character is journaled pending, never written.
  const presence = {
    chatId,
    messageId: "m3",
    before: [],
    after: [{ characterId: "alice", name: "Alice" }],
    locationId: "tower",
  };
  const arrived = await recordLegacyPresence(db, presence);
  assert.equal(arrived.length, 1);
  assert.equal(arrived[0]!.status, "applied");
  assert.equal((await state("ent-alice", "presence"))!.value, "present");
  assert.equal((await state("ent-alice", "location"))!.value, "ent-tower");
  const journalAfterPresence = await journalCount();
  const arrivedAgain = await recordLegacyPresence(db, presence);
  assert.equal(arrivedAgain[0]!.result?.replayed, true);
  assert.equal(await journalCount(), journalAfterPresence);
  const ghost = await recordLegacyPresence(db, {
    ...presence,
    before: presence.after,
    after: [...presence.after, { characterId: "ghost", name: "Ghost" }],
  });
  assert.equal(ghost.length, 1, "only the newly arrived character is a change");
  assert.equal(ghost[0]!.status, "pending");
  assert.match(ghost[0]!.reasons.join(" "), /ghost has no registered campaign-memory entity/u);
  assert.equal(
    (await journalRows()).filter((row) => row.operationId === `${ghost[0]!.transitionId}/pending`).length,
    1,
  );
  assert.equal(
    (await storage.listCurrentState(scope)).some((s) => s.entityId.includes("ghost")),
    false,
  );
  assert.deepEqual(
    await recordLegacyPresence(db, presence),
    arrivedAgain,
    "an unchanged tracker edit emits nothing new",
  );

  // Quest: an advance applies; an illegal legacy jump is journaled pending and never rejected.
  const taken = await recordLegacyQuestProgress(db, { chatId, messageId: "m3", questEntryId: "job", status: "active" });
  assert.equal(taken.status, "applied");
  assert.equal((await state("ent-job", "quest.status"))!.value, "active");
  const finished = await recordLegacyQuestProgress(db, {
    chatId,
    messageId: "m4",
    questEntryId: "job",
    status: "completed",
  });
  assert.equal(finished.status, "applied");
  const journalAfterQuest = await journalCount();
  assert.equal(
    (await recordLegacyQuestProgress(db, { chatId, messageId: "m4", questEntryId: "job", status: "completed" })).result
      ?.replayed,
    true,
  );
  assert.equal(await journalCount(), journalAfterQuest);
  const reopened = await recordLegacyQuestProgress(db, {
    chatId,
    messageId: "m5",
    questEntryId: "job",
    status: "active",
  });
  assert.equal(reopened.status, "pending");
  assert.match(reopened.reasons.join(" "), /cannot move from completed to active/u);
  assert.equal((await state("ent-job", "quest.status"))!.value, "completed");
  const unknownQuest = await recordLegacyQuestProgress(db, {
    chatId,
    messageId: "m5",
    questEntryId: "rumour-quest",
    status: "active",
  });
  assert.equal(unknownQuest.status, "pending");
  assert.equal(
    (await journalRows()).filter((row) => row.operationId === `${unknownQuest.transitionId}/pending`).length,
    1,
  );

  // Reputation: the qualitative standing becomes a typed NPC -> persona edge; the score never enters campaign memory.
  const thanks = {
    chatId,
    messageId: "m4",
    changes: [{ npcId: "npc-bob", npcName: "Bob", action: "helped", previousReputation: 10, newReputation: 25 }],
  };
  const standing = await recordLegacyReputation(db, thanks);
  assert.deepEqual(
    standing.map((o) => o.status),
    ["applied", "applied"],
  );
  const edges = await storage.listRelationships(scope);
  assert.equal(edges.length, 2);
  const friendly = edges.find((e) => e.type === "reputation:friendly");
  assert.equal(friendly?.status, "active");
  assert.equal(friendly?.sourceEntityId, "ent-npc-bob");
  assert.equal(friendly?.targetEntityId, "ent-hero");
  assert.equal(edges.find((e) => e.type === "reputation:neutral")?.status, "ended");
  for (const edge of edges)
    assert.doesNotMatch(`${edge.type} ${edge.inverseLabel}`, /\d/u, "relationship kind carries no score");
  const standingRows = (await journalRows()).filter((row) => standing.some((o) => o.transitionId === row.operationId));
  assert.equal(standingRows.length, 2);
  for (const row of standingRows) assert.doesNotMatch(row.reason, /\d/u, "journaled reason carries no score");
  const journalAfterReputation = await journalCount();
  assert.deepEqual(
    (await recordLegacyReputation(db, thanks)).map((o) => o.result?.replayed),
    [true, true],
  );
  assert.equal(await journalCount(), journalAfterReputation);
  assert.equal(await resolveLegacySourceMessageId(db, chatId), "m5");
  assert.equal(await resolveLegacySourceMessageId(db, chatId, "m2"), "m2");

  // A transition failure is logged and never fails the game path.
  const flaky = new Proxy(db, {
    get(target, key, receiver) {
      if (key !== "transaction") return Reflect.get(target, key, receiver);
      return async () => {
        throw new Error("campaign memory unavailable");
      };
    },
  }) as typeof db;
  Object.assign(turn, { messageId: "m5", locationId: "gate", from: "tower" });
  const survived = await commitSpatialOwnerTurn(
    { ...move, content: texts.m5!, transition: { ...move.transition, destinationId: "gate", commandId: "cmd-back" } },
    { db: flaky },
  );
  assert.equal(
    survived.snapshot.currentLocationId,
    "gate",
    "the owner turn result is returned despite the failed projection",
  );
  assert.equal((await state("ent-hero", "location"))!.value, "ent-tower");
  const failedQuest = await recordLegacyQuestProgress(flaky, {
    chatId,
    messageId: "m5",
    questEntryId: "job",
    status: "completed",
  });
  assert.equal(failedQuest.status, "failed");
  assert.match(failedQuest.reasons.join(" "), /campaign memory unavailable/u);
  assert.equal((await recordLegacyReputation(flaky, thanks))[0]!.status, "failed");

  await closeDB();
  console.log("campaign memory legacy writers regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
