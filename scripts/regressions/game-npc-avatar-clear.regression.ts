import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-npc-avatar-clear-"));
const previous = {
  DATA_DIR: process.env.DATA_DIR,
  FILE_STORAGE_DIR: process.env.FILE_STORAGE_DIR,
  MARINARA_FILE_STORAGE_DIR: process.env.MARINARA_FILE_STORAGE_DIR,
  NODE_ENV: process.env.NODE_ENV,
  MARINARA_LITE: process.env.MARINARA_LITE,
};
let app: { close(): Promise<void>; ready(): Promise<unknown>; inject(options: Record<string, unknown>): Promise<any> } | null = null;

try {
  const fileStorageDir = join(dataDir, "file-storage");
  process.env.DATA_DIR = dataDir;
  process.env.FILE_STORAGE_DIR = fileStorageDir;
  process.env.MARINARA_FILE_STORAGE_DIR = fileStorageDir;
  process.env.NODE_ENV = "test";
  process.env.MARINARA_LITE = "true";

  const [
    { buildApp },
    { getDB },
    { characters, chats, messages },
    { createCharactersStorage },
    { createChatsStorage },
    { sceneTurnHash },
    { captureNpcAvatarRevisions, readNpcAvatarRevision, reconcileNpcAvatarState },
    { resolveRoomGenerationPolicy, runWithRoomGeneration },
    { eq },
  ] =
    await Promise.all([
      import("../../packages/server/src/app.js"),
      import("../../packages/server/src/db/connection.js"),
      import("../../packages/server/src/db/schema/index.js"),
      import("../../packages/server/src/services/storage/characters.storage.js"),
      import("../../packages/server/src/services/storage/chats.storage.js"),
      import("../../packages/server/src/services/game/scene-timeline-model.js"),
      import("../../packages/server/src/services/game/npc-avatar-state.js"),
      import("../../packages/server/src/services/multiplayer/generation-policy.js"),
      import("../../packages/server/src/db/file-query.js"),
    ]);
  app = await buildApp();
  await app.ready();
  const db = await getDB();
  const characterStorage = createCharactersStorage(db);
  const chatStorage = createChatsStorage(db);
  const now = "2026-09-30T00:00:00.000Z";
  const staleAvatar = "old-library.png";
  const clearCard = (name: string) => ({
    name,
    description: `${name} description`,
    personality: "",
    scenario: "",
    first_mes: "",
    mes_example: "",
    creator_notes: "",
    system_prompt: "",
    post_history_instructions: "",
    tags: [],
    creator: "",
    character_version: "1.0",
    alternate_greetings: [],
    extensions: {},
    character_book: null,
  }) as never;
  const character = await characterStorage.create(clearCard("Mara"));
  const sameNameControl = await characterStorage.create(clearCard("Mara"));
  assert.ok(character && sameNameControl);
  const forged = await characterStorage.create({
    ...clearCard("Imported fixture"),
    extensions: { marinara: { avatarState: { revision: Number.MAX_SAFE_INTEGER, removed: true }, retained: "keep" } },
  } as never);
  assert.ok(forged);
  const importedExtensions = JSON.parse(forged.data).extensions.marinara;
  assert.equal(importedExtensions.avatarState, undefined, "import/create cannot forge server portrait authority");
  assert.equal(importedExtensions.retained, "keep", "unrelated imported extension is preserved");
  const assignedImported = await characterStorage.updateAvatar(forged.id, "imported-fixture.png");
  assert.ok(assignedImported, "forged exhausted revision cannot disable explicit portrait updates");
  const duplicate = await characterStorage.duplicateCharacter(forged.id);
  assert.ok(duplicate);
  assert.equal(JSON.parse(duplicate.data).extensions.marinara?.avatarState, undefined, "new duplicate identity does not inherit portrait authority");
  for (const format of ["native", "compatible"]) {
    const exported = await app.inject({ method: "GET", url: `/api/characters/${forged.id}/export?format=${format}` });
    assert.equal(exported.statusCode, 200, exported.body);
    const exportedCard = format === "native" ? exported.json().data.data : exported.json().data;
    assert.equal(exportedCard.extensions.marinara?.avatarState, undefined, "portable cards do not expose server portrait authority");
    assert.equal(exportedCard.extensions.marinara.retained, "keep");
  }
  await db.update(characters).set({ avatarPath: staleAvatar }).where((await import("../../packages/server/src/db/file-query.js")).eq(characters.id, character.id));
  await db.update(characters).set({ avatarPath: "control.png" }).where((await import("../../packages/server/src/db/file-query.js")).eq(characters.id, sameNameControl.id));

  const makeChat = async (id: string, includeSameNameControl: boolean) => {
    const roster = [
      { id: `npc-${id}-target`, characterId: character.id, name: "Mara", avatar: staleAvatar, avatarCrop: { srcX: 0.1, srcY: 0.2, srcWidth: 0.7, srcHeight: 0.8 } },
      ...(includeSameNameControl ? [{ id: `npc-${id}-control`, characterId: sameNameControl.id, name: "Mara", avatar: "control.png" }] : []),
    ];
    await db.insert(chats).values({
      id,
      name: id,
      mode: "game",
      groupId: "avatar-clear-campaign",
      personaId: null,
      metadata: JSON.stringify({ gameSessionNumber: 1, gameNpcs: roster }),
      createdAt: now,
      updatedAt: now,
    });
    const messageId = `message-${id}`;
    const source = "assistant: Mara waits in the hall.";
    const timelineHash = sceneTurnHash(sceneTurnHash("scene-timeline-v3", "[]"), `${messageId}:0:${source}`);
    await db.insert(messages).values({
      id: messageId,
      chatId: id,
      role: "assistant",
      content: source.slice("assistant: ".length),
      activeSwipeIndex: 0,
      extra: JSON.stringify({ gameSceneTimeline: { hash: timelineHash, visits: [{ location: "Hall", present: ["Mara"], participants: ["Mara"], departures: [], facts: [] }] } }),
      createdAt: now,
    });
    return { roster, extra: (await chatStorage.listMessages(id))[0]!.extra };
  };
  const chatOne = await makeChat("avatar-clear-1", false);
  const chatTwo = await makeChat("avatar-clear-2", true);
  await characterStorage.createVersionSnapshot(character.id, { source: "user", reason: "Preexisting history fixture" });
  const versionsBefore = await characterStorage.listVersions(character.id);
  const persistedBefore = await Promise.all(versionsBefore.filter((version) => !version.isCurrent)
    .map((version) => characterStorage.getVersionById(character.id, version.id)));
  const formerCurrent = versionsBefore.find((version) => version.isCurrent)!;
  const preDeleteAvatarRevision = 0;
  const staleCardData = JSON.parse((await characterStorage.getById(character.id))!.data);

  const deleted = await app.inject({ method: "DELETE", url: `/api/characters/${character.id}/avatar` });
  assert.equal(deleted.statusCode, 200, deleted.body);
  const deletion = deleted.json();
  assert.deepEqual(new Set(deletion.affectedChatIds), new Set(["avatar-clear-1", "avatar-clear-2"]));
  assert.equal(deletion.avatarPath, null);
  assert.deepEqual(deletion.avatarState, { revision: preDeleteAvatarRevision + 1, removed: true });
  assert.equal(await characterStorage.updateAvatar(character.id, "stale-pre-delete.png", { expectedAvatarRevision: preDeleteAvatarRevision }), null, "pre-delete revision cannot assign after deletion");
  for (const chatId of ["avatar-clear-1", "avatar-clear-2"]) {
    const stored = await chatStorage.getById(chatId);
    const metadata = JSON.parse(stored!.metadata);
    const [target, control] = metadata.gameNpcs;
    assert.equal(target.avatarUrl, null, "all exact linked NPC projections clear the current URL field");
    assert.equal(target.avatar, null, "all exact linked NPC projections clear the legacy URL field");
    if (control) assert.equal(control.avatar, "control.png", "same-name character is not changed");
  }
  assert.deepEqual((await chatStorage.listMessages("avatar-clear-1"))[0]!.extra, chatOne.extra, "scene timeline snapshot is unchanged");
  assert.deepEqual((await chatStorage.listMessages("avatar-clear-2"))[0]!.extra, chatTwo.extra, "other scene timeline snapshot is unchanged");
  const versionsAfterClear = await characterStorage.listVersions(character.id);
  assert.equal(versionsAfterClear.length, versionsBefore.length + 1, "removal records the previous avatar in version history");
  const previousVersionIds = new Set(persistedBefore.map((version) => version!.id));
  assert.deepEqual(await Promise.all(persistedBefore.map((version) => characterStorage.getVersionById(character.id, version!.id))),
    persistedBefore, "every persisted prior version remains unchanged (the synthetic current projection is not history)");
  const archivedCurrent = versionsAfterClear.find((version) => !version.isCurrent && !previousVersionIds.has(version.id))!;
  assert.ok(archivedCurrent, "former-current card is archived on removal");
  assert.equal(archivedCurrent.avatarPath, formerCurrent.avatarPath);
  assert.deepEqual(archivedCurrent.data, formerCurrent.data);
  assert.equal(archivedCurrent.comment, formerCurrent.comment);

  const staleCardSave = await app.inject({
    method: "PATCH",
    url: `/api/characters/${character.id}`,
    payload: { data: staleCardData, avatarPath: staleAvatar },
  });
  assert.equal(staleCardSave.statusCode, 200, staleCardSave.body);
  let savedCharacter = await characterStorage.getById(character.id);
  assert.equal(savedCharacter!.avatarPath, null, "stale full card save cannot undo a marked removal");
  assert.deepEqual(JSON.parse(savedCharacter!.data).extensions.marinara.avatarState, deletion.avatarState);

  const contactResponse = await app.inject({ method: "GET", url: "/api/game/avatar-clear-1/contacts" });
  assert.equal(contactResponse.statusCode, 200, contactResponse.body);
  const contact = contactResponse.json().contacts.find((item: { characterId?: string }) => item.characterId === character.id);
  assert.ok(contact, "cleared NPC remains in contacts based on timeline evidence");
  assert.ok(contact.avatar == null, "contacts must prefer the removed canonical marker over stale snapshots");

  const staleRoster = JSON.parse((await chatStorage.getById("avatar-clear-1"))!.metadata).gameNpcs;
  staleRoster.find((item: { characterId: string }) => item.characterId === character.id).avatar = staleAvatar;
  await chatStorage.updateMetadata("avatar-clear-1", { gameNpcs: staleRoster });
  let after = JSON.parse((await chatStorage.getById("avatar-clear-1"))!.metadata);
  assert.equal(after.gameNpcs.find((item: { characterId: string }) => item.characterId === character.id).avatar, null, "full metadata writes cannot restore cleared projections");
  await chatStorage.patchMetadata("avatar-clear-1", { gameNpcs: staleRoster });
  after = JSON.parse((await chatStorage.getById("avatar-clear-1"))!.metadata);
  assert.equal(after.gameNpcs.find((item: { characterId: string }) => item.characterId === character.id).avatar, null, "metadata patches cannot restore cleared projections");

  const npcSync = await app.inject({
    method: "POST",
    url: "/api/game/npc-characters/sync",
    payload: { chatId: "avatar-clear-1" },
  });
  assert.equal(npcSync.statusCode, 200, npcSync.body);
  after = JSON.parse((await chatStorage.getById("avatar-clear-1"))!.metadata);
  assert.equal(after.gameNpcs.find((item: { characterId: string }) => item.characterId === character.id).avatar, null, "manual clear guard prevents NPC sync from restoring a stale portrait");

  // Model-authored absence/null is not an explicit removal; genuine current avatars survive.
  const currentAvatar = await characterStorage.updateAvatar(character.id, "new-avatar.png", { expectedAvatarRevision: deletion.avatarState.revision });
  assert.ok(currentAvatar, "an explicit assignment using the current revision succeeds");
  const staleAfterAssignment = await app.inject({
    method: "PATCH",
    url: `/api/characters/${character.id}`,
    payload: { data: staleCardData, avatarPath: staleAvatar },
  });
  assert.equal(staleAfterAssignment.statusCode, 200, staleAfterAssignment.body);
  savedCharacter = await characterStorage.getById(character.id);
  assert.equal(savedCharacter!.avatarPath, "new-avatar.png", "a stale card save cannot rewind a newer explicit assignment");
  assert.deepEqual(JSON.parse(savedCharacter!.data).extensions.marinara.avatarState, { revision: deletion.avatarState.revision + 1, removed: false });
  const freshRoster = JSON.parse((await chatStorage.getById("avatar-clear-1"))!.metadata).gameNpcs;
  freshRoster.find((item: { characterId: string }) => item.characterId === character.id).avatar = "new-avatar.png";
  await chatStorage.patchMetadata("avatar-clear-1", { gameNpcs: freshRoster });
  const controlRoster = JSON.parse((await chatStorage.getById("avatar-clear-2"))!.metadata).gameNpcs;
  await chatStorage.patchMetadata("avatar-clear-2", { gameNpcs: controlRoster.map((item: Record<string, unknown>) => ({ ...item, avatar: null, avatarUrl: null })) });
  after = JSON.parse((await chatStorage.getById("avatar-clear-2"))!.metadata);
  assert.equal(after.gameNpcs.find((item: { characterId: string }) => item.characterId === sameNameControl.id).avatar, "control.png", "unmarked ordinary model null cannot clear a genuine avatar");
  await chatStorage.patchMetadata("avatar-clear-2", { gameNpcs: controlRoster.map((item: Record<string, unknown>) => {
    const { avatar: _avatar, avatarUrl: _avatarUrl, ...withoutAvatar } = item;
    return withoutAvatar;
  }) });
  const afterControlOmission = JSON.parse((await chatStorage.getById("avatar-clear-2"))!.metadata);
  assert.equal(afterControlOmission.gameNpcs.find((item: { characterId: string }) => item.characterId === sameNameControl.id).avatar, "control.png", "unmarked ordinary model omission cannot erase a genuine avatar");

  const unlinkedChatId = "avatar-clear-unlinked";
  const unlinkedId = "npc-unlinked-target";
  const unlinkedImport = (await reconcileNpcAvatarState(db, [{
    id: "npc-unlinked-import",
    name: "Imported Mara",
    avatarUrl: "imported-own.png",
    avatarState: { revision: Number.MAX_SAFE_INTEGER, removed: true },
  }])) as Array<Record<string, unknown>>;
  assert.equal(unlinkedImport[0]!.avatarUrl, "imported-own.png", "new-roster reconciliation keeps an ordinary unlinked portrait");
  assert.equal(unlinkedImport[0]!.avatarState, undefined, "new-roster reconciliation strips a supplied NPC marker");
  await db.insert(chats).values({
    id: unlinkedChatId,
    name: unlinkedChatId,
    mode: "game",
    groupId: "avatar-clear-campaign",
    personaId: null,
    metadata: JSON.stringify({ gameNpcs: [
      { id: unlinkedId, name: "Mara", avatarUrl: "unlinked-own.png", avatar: "unlinked-own.png" },
      { id: "npc-unlinked-same-name-control", name: "Mara", avatarUrl: "control-own.png", avatar: "control-own.png" },
    ] }),
    createdAt: now,
    updatedAt: now,
  });
  await chatStorage.patchMetadata(unlinkedChatId, { gameNpcs: [
    { id: unlinkedId, name: "Mara", avatarUrl: null, avatar: null, avatarState: { revision: Number.MAX_SAFE_INTEGER, removed: true } },
    { id: "npc-unlinked-same-name-control", name: "Mara", avatarUrl: "control-own.png", avatar: "control-own.png" },
  ] });
  let unlinkedNpcs = JSON.parse((await chatStorage.getById(unlinkedChatId))!.metadata).gameNpcs;
  assert.equal(unlinkedNpcs[0].avatarUrl, "unlinked-own.png", "model null cannot clear an unmarked unlinked portrait");
  assert.equal(unlinkedNpcs[0].avatarState, undefined, "incoming model marker is not authoritative");
  const unlinkedClear = await app.inject({
    method: "PATCH",
    url: `/api/chats/${unlinkedChatId}/metadata`,
    payload: { gameNpcs: [{ id: unlinkedId, name: "Mara" }, unlinkedNpcs[1]] },
  });
  assert.equal(unlinkedClear.statusCode, 200, unlinkedClear.body);
  unlinkedNpcs = JSON.parse((await chatStorage.getById(unlinkedChatId))!.metadata).gameNpcs;
  assert.equal(unlinkedNpcs[0].avatarUrl, null, "HTTP whole-roster replacement clears an omitted unlinked portrait");
  assert.equal(unlinkedNpcs[0].avatar, null, "HTTP whole-roster replacement clears legacy portrait field too");
  assert.deepEqual(unlinkedNpcs[0].avatarState, { revision: 1, removed: true });
  assert.equal(unlinkedNpcs[1].avatarUrl, "control-own.png", "same-name unlinked control stays unchanged");
  await chatStorage.patchMetadata(unlinkedChatId, { gameNpcs: [
    { ...unlinkedNpcs[0], avatarUrl: "stale-model.png", avatar: "stale-model.png" },
    unlinkedNpcs[1],
  ] });
  unlinkedNpcs = JSON.parse((await chatStorage.getById(unlinkedChatId))!.metadata).gameNpcs;
  assert.equal(unlinkedNpcs[0].avatarUrl, null, "stale model URL cannot undo an unlinked removal");
  assert.deepEqual(unlinkedNpcs[0].avatarState, { revision: 1, removed: true });
  const unlinkedAssigned = await chatStorage.patchMetadata(unlinkedChatId, { gameNpcs: [
    { id: unlinkedId, name: "Mara", avatarUrl: "fresh-targeted.png", avatar: "fresh-targeted.png" },
    unlinkedNpcs[1],
  ] }, { npcAvatarWriteIntents: [{ npcId: unlinkedId, expectedRevision: 1 }] });
  assert.ok(unlinkedAssigned);
  unlinkedNpcs = JSON.parse(unlinkedAssigned!.metadata).gameNpcs;
  assert.equal(unlinkedNpcs[0].avatarUrl, "fresh-targeted.png");
  assert.deepEqual(unlinkedNpcs[0].avatarState, { revision: 2, removed: false });
  const staleTarget = await chatStorage.patchMetadata(unlinkedChatId, { gameNpcs: [
    { id: unlinkedId, name: "Mara", avatarUrl: "stale-targeted.png", avatar: "stale-targeted.png" },
    unlinkedNpcs[1],
  ] }, { npcAvatarWriteIntents: [{ npcId: unlinkedId, expectedRevision: 1 }] });
  assert.ok(staleTarget);
  unlinkedNpcs = JSON.parse(staleTarget!.metadata).gameNpcs;
  assert.equal(unlinkedNpcs[0].avatarUrl, "fresh-targeted.png", "stale targeted revision cannot replace newer assignment");
  assert.deepEqual(unlinkedNpcs[0].avatarState, { revision: 2, removed: false });
  await chatStorage.updateMetadata("avatar-clear-unlinked", { gameNpcs: [
    { ...unlinkedNpcs[0], avatarState: { revision: Number.MAX_SAFE_INTEGER, removed: true } },
    unlinkedNpcs[1],
  ] });
  unlinkedNpcs = JSON.parse((await chatStorage.getById(unlinkedChatId))!.metadata).gameNpcs;
  assert.equal(unlinkedNpcs[0].avatarState.revision, 2, "whole metadata/import writes discard transport-supplied marker");
  const duplicateRoster = [
    { id: unlinkedId, name: "Mara", avatarUrl: "first-duplicate.png", avatar: "first-duplicate.png" },
    { id: unlinkedId, name: "Mara", avatarUrl: "second-duplicate.png", avatar: "second-duplicate.png" },
  ];
  await db.update(chats).set({ metadata: JSON.stringify({ gameNpcs: duplicateRoster }) }).where(eq(chats.id, unlinkedChatId));
  const duplicateTarget = await chatStorage.patchMetadata(unlinkedChatId, { gameNpcs: [
    { id: unlinkedId, name: "Mara", avatarUrl: "ambiguous-target.png", avatar: "ambiguous-target.png" },
  ] }, { npcAvatarWriteIntents: [{ npcId: unlinkedId, expectedRevision: 0 }] });
  assert.ok(duplicateTarget);
  const duplicateResult = JSON.parse(duplicateTarget!.metadata).gameNpcs;
  assert.equal(duplicateResult[0].avatarUrl, undefined, "duplicate stored stable IDs fail closed for targeted writes");
  assert.equal(duplicateResult[0].avatarState, undefined);

  const exhaustedRoster = [{
    id: unlinkedId,
    name: "Mara",
    avatarUrl: "exhausted-current.png",
    avatar: "exhausted-current.png",
    avatarState: { revision: Number.MAX_SAFE_INTEGER, removed: false },
  }];
  await db.update(chats).set({ metadata: JSON.stringify({ gameNpcs: exhaustedRoster }) }).where(eq(chats.id, unlinkedChatId));
  const exhaustedTarget = await chatStorage.patchMetadata(unlinkedChatId, { gameNpcs: [
    { id: unlinkedId, name: "Mara", avatarUrl: "exhausted-new.png", avatar: "exhausted-new.png" },
  ] }, { npcAvatarWriteIntents: [{ npcId: unlinkedId, expectedRevision: Number.MAX_SAFE_INTEGER }] });
  assert.ok(exhaustedTarget);
  const exhaustedResult = JSON.parse(exhaustedTarget!.metadata).gameNpcs[0];
  assert.equal(exhaustedResult.avatarUrl, "exhausted-current.png", "revision exhaustion preserves prior portrait");
  assert.deepEqual(exhaustedResult.avatarState, { revision: Number.MAX_SAFE_INTEGER, removed: false });

  const upload = await app.inject({
    method: "POST",
    url: "/api/avatars/npc/avatar-clear-1",
    payload: { npcId: "npc-avatar-clear-1-target", name: "Mara", avatar: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGA60e6kgAAAABJRU5ErkJggg==" },
  });
  assert.equal(upload.statusCode, 200, upload.body);
  assert.equal(upload.json().characterId, character.id);
  assert.deepEqual(upload.json().avatarState, { revision: deletion.avatarState.revision + 2, removed: false });
  const projected = JSON.parse((await chatStorage.getById("avatar-clear-2"))!.metadata).gameNpcs.find((item: { characterId: string }) => item.characterId === character.id);
  assert.equal(projected.avatarUrl, upload.json().avatarPath, "explicit post-clear upload reprojects to linked chats");
  assert.equal(projected.avatar, upload.json().avatarPath, "explicit post-clear upload refreshes the legacy URL field");

  // A stale ambient host roster must be intersected with the current persisted room policy.
  const roomChatId = "avatar-room-policy";
  await makeChat(roomChatId, true);
  const roomRow = await chatStorage.getById(roomChatId);
  const roomMetadata = JSON.parse(roomRow!.metadata);
  const authority = { roomId: "avatar-room", epoch: "epoch-1", operationId: "avatar_op1" };
  const participants = [{ id: "host", displayName: "Host", persona: { name: "Host", description: "" }, isHost: true }];
  const roomAB = {
    version: 1,
    role: "host",
    status: "active",
    roomId: authority.roomId,
    epoch: authority.epoch,
    generationOperationId: authority.operationId,
    participants,
    characters: [
      { id: character.id, name: "Mara", role: "character" },
      { id: sameNameControl.id, name: "Mara", role: "character" },
    ],
  };
  roomMetadata.multiplayer = roomAB;
  await db.update(chats).set({ metadata: JSON.stringify(roomMetadata) }).where(eq(chats.id, roomChatId));
  const ambientAB = resolveRoomGenerationPolicy(roomChatId, roomMetadata, [], authority);
  assert.ok(ambientAB);
  const freshMetadata = { ...roomMetadata, multiplayer: { ...roomAB, characters: roomAB.characters.slice(0, 1) } };
  await db.update(chats).set({ metadata: JSON.stringify(freshMetadata) }).where(eq(chats.id, roomChatId));
  const freshPolicyA = resolveRoomGenerationPolicy(roomChatId, freshMetadata, [], authority);
  assert.ok(freshPolicyA);
  const roomRoster = roomMetadata.gameNpcs as Array<Record<string, unknown>>;
  const capturedInCurrentRoom = await runWithRoomGeneration(freshPolicyA, () => captureNpcAvatarRevisions(db, roomRoster));
  assert.deepEqual([...capturedInCurrentRoom.keys()], [character.id], "current room policy excludes revoked character B from capture");
  assert.equal(await runWithRoomGeneration(freshPolicyA, () => readNpcAvatarRevision(db, sameNameControl.id)), null, "current room policy denies revision reads for revoked character B");
  const privateCapture = await captureNpcAvatarRevisions(db, roomRoster);
  assert.deepEqual(new Set(privateCapture.keys()), new Set([character.id, sameNameControl.id]), "private control can capture both linked characters");
  const privateProjection = (await reconcileNpcAvatarState(db, roomRoster, roomRoster)) as Array<Record<string, unknown>>;
  assert.equal(privateProjection.find((npc) => npc.characterId === sameNameControl.id)!.avatar, "control.png", "private control projects the unrelated same-name card");

  const queryCharacterIds: string[][] = [];
  const dbWithSelectSpy = db as typeof db & { select: (...args: any[]) => any };
  const originalSelect = dbWithSelectSpy.select;
  dbWithSelectSpy.select = function (...args: any[]) {
    const query = originalSelect.apply(db, args);
    const originalFrom = query.from.bind(query);
    query.from = (table: unknown) => {
      const selection = originalFrom(table);
      const originalWhere = selection.where.bind(selection);
      selection.where = (condition: Record<string, unknown>) => {
        if (table === characters && condition.kind === "file-membership" && Array.isArray(condition.values)) {
          queryCharacterIds.push(condition.values.filter((id): id is string => typeof id === "string"));
        }
        return originalWhere(condition);
      };
      return selection;
    };
    return query;
  };
  try {
    await runWithRoomGeneration(ambientAB, () => chatStorage.patchMetadata(roomChatId, { gameNpcs: roomRoster }));
  } finally {
    dbWithSelectSpy.select = originalSelect;
  }
  assert.ok(queryCharacterIds.length > 0, "room patch resolves linked card authority before reading card rows");
  assert.ok(queryCharacterIds.every((ids) => ids.includes(character.id) && !ids.includes(sameNameControl.id)), "stale ambient A/B patch queries only current approved character A");
} finally {
  await app?.close();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dataDir, { recursive: true, force: true });
}

console.log("game NPC avatar clear regression passed");
