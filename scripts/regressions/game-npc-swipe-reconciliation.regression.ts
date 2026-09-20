import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileNativeDB } from "../../packages/server/src/db/file-backed-store.js";
import {
  removeUntouchedAutoNpcCharacter,
  resolveGameNpcSyncState,
  rollbackStaleGameNpcRoster,
  type GameNpcCharacterCandidate,
} from "../../packages/server/src/services/game/npc-character-sync.js";
import { syncGameNpcCharacters } from "./npc-admission-fixture.js";
import {
  characterStorageRevision,
  createCharactersStorage,
} from "../../packages/server/src/services/storage/characters.storage.js";
import { createChatsStorage } from "../../packages/server/src/services/storage/chats.storage.js";
import {
  addNpcEntry,
  createJournal,
  pruneGameNpcJournal,
  restorePrunedGameNpcJournal,
} from "../../packages/server/src/services/game/journal.service.js";

function candidate(overrides: Partial<GameNpcCharacterCandidate> = {}): GameNpcCharacterCandidate {
  return {
    npcId: "npc:zev",
    characterId: null,
    name: "Zev",
    description: "A courier who introduced himself beside the fountain.",
    descriptionSource: "narration",
    appearance: "A young man in a rain-dark courier's coat.",
    avatarUrl: null,
    location: "Market Square",
    evidenceKind: "narration",
    sourceMessageId: "assistant-turn",
    sourceSwipeIndex: 0,
    ...overrides,
  };
}

const storageRoot = mkdtempSync(join(tmpdir(), "marinara-game-npc-swipe-"));
const previousStorageRoot = process.env.FILE_STORAGE_DIR;
process.env.FILE_STORAGE_DIR = storageRoot;
const db = await createFileNativeDB();

try {
  const store = createCharactersStorage(db);
  const baseInput = {
    db,
    gameId: "game-swipe-reconciliation",
    chatId: "chat-swipe-reconciliation",
    sessionNumber: 1,
    campaignName: "Swipe Regression",
  };

  let latestStateReads = 0;
  const exactSwipeState = {
    location: "Selected-swipe harbor",
    presentCharacters: JSON.stringify([{ name: "Zev", appearance: "Blue coat" }]),
  };
  const selectedState = await resolveGameNpcSyncState({
    storage: {
      getLatest: async () => {
        latestStateReads += 1;
        return { location: "Discarded-swipe palace", presentCharacters: "[]" };
      },
      getByChatAndMessage: async (_chatId, messageId, swipeIndex) =>
        messageId === "assistant-turn" && swipeIndex === 1 ? exactSwipeState : null,
    },
    chatId: baseInput.chatId,
    source: { messageId: "assistant-turn", swipeIndex: 1 },
  });
  assert.deepEqual(selectedState, exactSwipeState, "NPC fields must come from the selected narration's exact snapshot");
  assert.equal(latestStateReads, 0, "an active narration must never fall back to a different swipe's latest snapshot");
  const missingSelectedState = await resolveGameNpcSyncState({
    storage: {
      getLatest: async () => {
        latestStateReads += 1;
        return { location: "Discarded-swipe palace", presentCharacters: "[]" };
      },
      getByChatAndMessage: async () => null,
    },
    chatId: baseInput.chatId,
    source: { messageId: "assistant-turn", swipeIndex: 2 },
  });
  assert.equal(missingSelectedState, null, "a missing exact snapshot must yield no scene evidence, not stale fields");
  assert.equal(latestStateReads, 0);

  const zev = candidate();
  const first = await syncGameNpcCharacters({
    ...baseInput,
    candidates: [zev],
    canonicalSource: { messageId: "assistant-turn", swipeIndex: 0, supportedNpcIds: [zev.npcId] },
  });
  assert.equal(first.created.length, 1);
  const zevCharacterId = first.created[0]!.characterId;

  const discarded = await syncGameNpcCharacters({
    ...baseInput,
    candidates: [
      candidate({
        characterId: zevCharacterId,
        evidenceKind: "linked",
        sourceMessageId: null,
        sourceSwipeIndex: null,
      }),
    ],
    canonicalSource: { messageId: "assistant-turn", swipeIndex: 1, supportedNpcIds: [] },
  });
  assert.deepEqual(discarded.links, [], "a stale linked roster row must not defeat canonical-swipe reconciliation");
  assert.deepEqual(discarded.retracted, [
    { characterId: zevCharacterId, npcId: "npc:zev", name: "Zev", cardRemoved: true },
  ]);
  assert.equal(
    await store.getById(zevCharacterId),
    null,
    "an untouched card introduced only by a discarded swipe is removed",
  );

  const mira = candidate({ npcId: "npc:mira", name: "Mira" });
  const editedFirst = await syncGameNpcCharacters({
    ...baseInput,
    candidates: [mira],
    canonicalSource: { messageId: "assistant-turn", swipeIndex: 0, supportedNpcIds: [mira.npcId] },
  });
  const miraCharacterId = editedFirst.created[0]!.characterId;
  await store.update(miraCharacterId, { personality: "User-authored: cautious, funny, and fiercely loyal." });

  const editedDiscarded = await syncGameNpcCharacters({
    ...baseInput,
    candidates: [
      candidate({
        npcId: "npc:mira",
        characterId: miraCharacterId,
        name: "Mira",
        evidenceKind: "linked",
        sourceMessageId: null,
        sourceSwipeIndex: null,
      }),
    ],
    canonicalSource: { messageId: "assistant-turn", swipeIndex: 1, supportedNpcIds: [] },
  });
  assert.deepEqual(editedDiscarded.links, []);
  assert.equal(
    editedDiscarded.retracted[0]?.cardRemoved,
    false,
    "user editing converts deletion into unlink-only cleanup",
  );
  assert.equal(
    JSON.parse((await store.getById(miraCharacterId))!.data).personality,
    "User-authored: cautious, funny, and fiercely loyal.",
    "a user-edited card must survive its originating swipe",
  );

  const lysa = candidate({ npcId: "npc:lysa", name: "Lysa" });
  const linkedFirst = await syncGameNpcCharacters({
    ...baseInput,
    candidates: [lysa],
    canonicalSource: { messageId: "assistant-turn", swipeIndex: 0, supportedNpcIds: [lysa.npcId] },
  });
  const lysaCharacterId = linkedFirst.created[0]!.characterId;
  await store.createGroup("Saved NPCs", "Cards the user chose to keep.", [lysaCharacterId]);
  const linkedDiscarded = await syncGameNpcCharacters({
    ...baseInput,
    candidates: [{ ...lysa, characterId: lysaCharacterId, evidenceKind: "linked" }],
    canonicalSource: { messageId: "assistant-turn", swipeIndex: 1, supportedNpcIds: [] },
  });
  assert.equal(linkedDiscarded.retracted.find((entry) => entry.npcId === lysa.npcId)?.cardRemoved, false);
  assert.ok(await store.getById(lysaCharacterId), "a reused card must be unlinked without deleting the user's copy");

  const sera = candidate({ npcId: "npc:sera", name: "Sera" });
  const crossSessionFirst = await syncGameNpcCharacters({
    ...baseInput,
    candidates: [sera],
    canonicalSource: { messageId: "assistant-turn", swipeIndex: 0, supportedNpcIds: [sera.npcId] },
  });
  const seraCharacterId = crossSessionFirst.created[0]!.characterId;
  const chats = createChatsStorage(db);
  const laterSession = await chats.create({
    name: "Later Session",
    mode: "game",
    characterIds: [],
    groupId: baseInput.gameId,
    personaId: null,
    promptPresetId: null,
    connectionId: null,
  });
  await chats.patchMetadata(laterSession!.id, {
    gameId: baseInput.gameId,
    gameNpcs: [
      {
        id: sera.npcId,
        characterId: seraCharacterId,
        name: sera.name,
        emoji: "👤",
        description: sera.description,
        descriptionSource: "narration",
        location: "Later Session",
        reputation: 0,
        notes: [],
        avatarUrl: null,
      },
    ],
  });
  const crossSessionDiscarded = await syncGameNpcCharacters({
    ...baseInput,
    candidates: [{ ...sera, characterId: seraCharacterId, evidenceKind: "linked" }],
    canonicalSource: { messageId: "assistant-turn", swipeIndex: 1, supportedNpcIds: [] },
  });
  assert.equal(crossSessionDiscarded.retracted.find((entry) => entry.npcId === sera.npcId)?.cardRemoved, false);
  assert.ok(
    await store.getById(seraCharacterId),
    "a card referenced by another session must survive retrying its source session",
  );

  const tova = candidate({ npcId: "npc:tova", name: "Tova" });
  const deferredFirst = await syncGameNpcCharacters({
    ...baseInput,
    candidates: [tova],
    canonicalSource: { messageId: "assistant-turn", swipeIndex: 0, supportedNpcIds: [tova.npcId] },
  });
  const tovaCharacterId = deferredFirst.created[0]!.characterId;
  const deferredRetraction = await syncGameNpcCharacters({
    ...baseInput,
    candidates: [{ ...tova, characterId: tovaCharacterId, evidenceKind: "linked" }],
    canonicalSource: { messageId: "assistant-turn", swipeIndex: 1, supportedNpcIds: [] },
    deferRetractionDeletion: true,
  });
  assert.equal(deferredRetraction.retracted.find((entry) => entry.npcId === tova.npcId)?.cardRemoved, false);
  assert.ok(
    await store.getById(tovaCharacterId),
    "a stale-swipe result must not delete its card before the queued canonical metadata patch accepts ownership",
  );

  const staleJournal = addNpcEntry(
    createJournal(),
    {
      id: tova.npcId,
      name: tova.name,
      emoji: "👤",
      description: tova.description,
      descriptionSource: "narration",
      location: tova.location,
      reputation: 0,
      notes: [],
      avatarUrl: null,
    },
    "Introduced only in the discarded swipe.",
  );
  const prunedJournal = pruneGameNpcJournal(staleJournal, tova.name);
  assert.equal(prunedJournal.npcLog.length, 0, "discarded NPC interactions must not survive in the journal");
  assert.equal(prunedJournal.entries.length, 0, "discarded NPC journal entries must not influence later recaps");

  const concurrentJournal = addNpcEntry(
    prunedJournal,
    {
      id: "npc:concurrent",
      name: "Concurrent Arrival",
      emoji: "👤",
      description: "Arrived during reconciliation.",
      descriptionSource: "narration",
      location: "Market Square",
      reputation: 0,
      notes: [],
      avatarUrl: null,
    },
    "Arrived while the stale sync result was being persisted.",
  );
  const restoredAfterPersistRace = restorePrunedGameNpcJournal(concurrentJournal, staleJournal, [tova.name]);
  assert.deepEqual(
    restoredAfterPersistRace.npcLog.map((entry) => entry.npcName),
    ["Concurrent Arrival", "Tova"],
    "a post-persist stale-swipe rollback restores pruned NPC history without overwriting concurrent entries",
  );
  assert.equal(restoredAfterPersistRace.entries.length, 2);

  const tovaRosterNpc = {
    id: tova.npcId,
    characterId: tovaCharacterId,
    name: tova.name,
    emoji: "👤",
    description: tova.description,
    descriptionSource: "narration" as const,
    location: tova.location,
    reputation: 0,
    notes: [],
    avatarUrl: null,
  };
  const concurrentRosterNpc = {
    ...tovaRosterNpc,
    id: "npc:concurrent",
    characterId: "character:concurrent",
    name: "Concurrent Arrival",
  };
  const staleRetraction = deferredRetraction.retracted.filter((entry) => entry.npcId === tova.npcId);
  const restoredRoster = rollbackStaleGameNpcRoster({
    currentNpcs: [concurrentRosterNpc],
    previousNpcs: [tovaRosterNpc],
    persistedNpcs: [],
    touchedNpcIds: new Set(staleRetraction.map((entry) => entry.npcId)),
  });
  assert.deepEqual(
    restoredRoster.map((npc) => npc.id),
    [tova.npcId, concurrentRosterNpc.id],
    "a stale metadata write restores only its exact retraction and preserves a concurrent NPC",
  );
  assert.deepEqual(
    rollbackStaleGameNpcRoster({
      currentNpcs: [concurrentRosterNpc],
      previousNpcs: [tovaRosterNpc],
      persistedNpcs: [],
      touchedNpcIds: new Set(staleRetraction.map((entry) => entry.npcId)),
      ignoredNpcIds: new Set([tova.npcId]),
    }),
    [concurrentRosterNpc],
    "an explicit removal tombstone must win over stale-swipe rollback",
  );

  const staleLinkedNpc = { ...tovaRosterNpc, id: "npc:stale-link", characterId: "character:stale-link" };
  assert.deepEqual(
    rollbackStaleGameNpcRoster({
      currentNpcs: [concurrentRosterNpc, staleLinkedNpc],
      previousNpcs: [concurrentRosterNpc],
      persistedNpcs: [concurrentRosterNpc, staleLinkedNpc],
      touchedNpcIds: new Set([staleLinkedNpc.id]),
    }),
    [concurrentRosterNpc],
    "the same stale-write rollback removes a reused-card link introduced after the final freshness check",
  );
  assert.deepEqual(
    rollbackStaleGameNpcRoster({
      currentNpcs: [{ ...staleLinkedNpc, location: "Concurrent edit" }],
      previousNpcs: [],
      persistedNpcs: [staleLinkedNpc],
      touchedNpcIds: new Set([staleLinkedNpc.id]),
    }),
    [{ ...staleLinkedNpc, location: "Concurrent edit" }],
    "three-way rollback must preserve a row changed again after the stale write",
  );

  const ula = candidate({ npcId: "npc:ula", name: "Ula" });
  const guardedFirst = await syncGameNpcCharacters({
    ...baseInput,
    candidates: [ula],
    canonicalSource: { messageId: "assistant-turn", swipeIndex: 0, supportedNpcIds: [ula.npcId] },
  });
  const ulaCharacterId = guardedFirst.created[0]!.characterId;
  const ulaBeforeBlockedUpdate = await store.getById(ulaCharacterId);
  const blockedUpdate = await syncGameNpcCharacters({
    ...baseInput,
    candidates: [
      {
        ...ula,
        characterId: ulaCharacterId,
        description: "Description from a swipe that stopped being active during the card update.",
      },
    ],
    canonicalSource: { messageId: "assistant-turn", swipeIndex: 0, supportedNpcIds: [ula.npcId] },
    canUpdate: async () => false,
  });
  assert.deepEqual(blockedUpdate.updated, [], "an in-transaction target guard must veto a stale managed-card update");
  assert.equal(
    (await store.getById(ulaCharacterId))!.data,
    ulaBeforeBlockedUpdate!.data,
    "a discarded swipe must not leave description, appearance, avatar, or provenance changes on an existing card",
  );
  assert.equal(
    await removeUntouchedAutoNpcCharacter({
      db,
      characterId: ulaCharacterId,
      gameId: baseInput.gameId,
      npcId: ula.npcId,
      campaignName: baseInput.campaignName,
      canRemove: async () => false,
    }),
    false,
    "an active-swipe guard that turns stale at deletion must atomically veto card removal",
  );
  assert.ok(await store.getById(ulaCharacterId), "the card needed by the newly selected swipe must remain intact");

  const orin = candidate({ npcId: "npc:orin", name: "Orin" });
  const supportedFirst = await syncGameNpcCharacters({
    ...baseInput,
    candidates: [orin],
    canonicalSource: { messageId: "assistant-turn", swipeIndex: 0, supportedNpcIds: [orin.npcId] },
  });
  const orinCharacterId = supportedFirst.created[0]!.characterId;
  const independentlySupported = await syncGameNpcCharacters({
    ...baseInput,
    candidates: [{ ...orin, characterId: orinCharacterId, sourceSwipeIndex: 1 }],
    canonicalSource: { messageId: "assistant-turn", swipeIndex: 1, supportedNpcIds: [orin.npcId] },
  });
  assert.equal(
    independentlySupported.retracted.some((entry) => entry.npcId === orin.npcId),
    false,
    "current canonical evidence preserves the prior card",
  );
  assert.equal(independentlySupported.links[0]?.characterId, orinCharacterId);

  const orinBeforeConcurrentEdit = await store.getById(orinCharacterId);
  const staleRemovalRevision = characterStorageRevision(orinBeforeConcurrentEdit!);
  await store.update(orinCharacterId, { scenario: "A concurrent user edit made before automatic cleanup." });
  assert.equal(
    await store.remove(orinCharacterId, { expectedRevision: staleRemovalRevision }),
    false,
    "conditional removal must atomically reject a card edited after cleanup inspected it",
  );
  assert.ok(await store.getById(orinCharacterId));

  let freshnessChecks = 0;
  const raced = await syncGameNpcCharacters({
    ...baseInput,
    candidates: [candidate({ npcId: "npc:late", name: "Late Arrival" })],
    isTargetCurrent: async () => {
      freshnessChecks += 1;
      return freshnessChecks < 3;
    },
  });
  assert.equal(raced.created.length, 0, "a swipe change after candidate collection must not publish a stale card");
  assert.equal(
    (await store.list()).some((row) => JSON.parse(row.data).name === "Late Arrival"),
    false,
    "a card created inside the freshness race is safely rolled back",
  );

  const tombstoned = await syncGameNpcCharacters({
    ...baseInput,
    candidates: [candidate({ npcId: "npc:ignored", name: "Ignored NPC" })],
    isTargetCurrent: async (npcId) => npcId !== "npc:ignored",
  });
  assert.equal(tombstoned.created.length, 0, "a newly tombstoned NPC must be rejected before its Character write");
} finally {
  await db._fileStore.close();
  if (previousStorageRoot === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousStorageRoot;
  rmSync(storageRoot, { recursive: true, force: true });
}

console.log("Game NPC canonical-swipe reconciliation regression passed.");
