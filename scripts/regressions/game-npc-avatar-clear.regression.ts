import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileNativeDB } from "../../packages/server/src/db/file-backed-store.js";
import { characters } from "../../packages/server/src/db/schema/index.js";
import { createChatsStorage } from "../../packages/server/src/services/storage/chats.storage.js";
import {
  readCharacterAvatarState,
  reconcileNpcAvatarState,
  withoutCharacterAvatarState,
  withoutGameNpcAvatarStates,
} from "../../packages/server/src/services/game/npc-avatar-state.js";
import { createCharactersStorage } from "../../packages/server/src/services/storage/characters.storage.js";
import { sanitizeProfileAvatarStateRow, sanitizeProfileTableRows } from "../../packages/server/src/routes/backup.routes.js";
import {
  buildCompatibleCharacterExport,
  buildNativeCharacterEnvelope,
} from "../../packages/server/src/routes/characters.routes.js";

const storageRoot = mkdtempSync(join(tmpdir(), "marinara-npc-avatar-clear-"));
const previousStorageRoot = process.env.FILE_STORAGE_DIR;
process.env.FILE_STORAGE_DIR = storageRoot;
const db = await createFileNativeDB();

try {
  const timestamp = "2026-09-30T00:00:00.000Z";
  await db.insert(characters).values({
    id: "portrait-owner",
    data: JSON.stringify({ name: "Portrait Owner", description: "Original card", character_version: "1.0" }),
    comment: "",
    avatarPath: "/api/avatars/file/portrait-owner.png",
    spriteFolderPath: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  const storage = createCharactersStorage(db);
  const cleared = await storage.updateAvatar("portrait-owner", null);
  assert.ok(cleared);
  assert.deepEqual(readCharacterAvatarState(cleared.data), { revision: 1, removed: true });
  assert.equal(cleared.avatarPath, null);
  assert.deepEqual(cleared.affectedChatIds, []);

  const ordinarySave = await storage.update("portrait-owner", { description: "Model update" });
  assert.ok(ordinarySave);
  assert.deepEqual(readCharacterAvatarState(ordinarySave.data), { revision: 1, removed: true });

  const staleAssignment = await storage.update(
    "portrait-owner",
    {},
    "/api/avatars/file/stale.png",
    { avatarIntent: true, expectedAvatarRevision: 0 },
  );
  assert.equal(staleAssignment, null, "a generation captured before removal must not restore its portrait");

  const freshAssignment = await storage.update(
    "portrait-owner",
    {},
    "/api/avatars/file/fresh.png",
    { avatarIntent: true, expectedAvatarRevision: 1 },
  );
  assert.ok(freshAssignment);
  assert.deepEqual(readCharacterAvatarState(freshAssignment.data), { revision: 2, removed: false });
  assert.equal(freshAssignment.avatarPath, "/api/avatars/file/fresh.png");

  const explicitIntentClear = await storage.update("portrait-owner", {}, null, {
    avatarIntent: true,
    expectedAvatarRevision: 2,
  });
  assert.ok(explicitIntentClear);
  assert.equal(explicitIntentClear.avatarPath, null);
  assert.deepEqual(readCharacterAvatarState(explicitIntentClear.data), { revision: 3, removed: true });

  await db.insert(characters).values({
    id: "same-name-other-card",
    data: JSON.stringify({ name: "Shared Name", character_version: "1.0" }),
    comment: "",
    avatarPath: "/api/avatars/file/unrelated.png",
    spriteFolderPath: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const chatsStorage = createChatsStorage(db);
  const chat = await chatsStorage.create({ name: "Avatar sync fixture", mode: "game" });
  const baseNpcRoster = [
    { id: "linked-stable-id", characterId: "portrait-owner", name: "Shared Name", avatarUrl: "/npc/stale.png", avatar: "/npc/stale.png" },
    { id: "same-name-unrelated", characterId: "same-name-other-card", name: "Shared Name", avatarUrl: "/npc/unrelated.png", avatar: "/npc/unrelated.png" },
  ];
  await chatsStorage.patchMetadata(chat.id, {
    freshUnrelatedMetadata: "preserve-me",
    gameNpcs: baseNpcRoster,
  });
  for (const [npcId, legacyUrl] of [["http-omitted-avatar", "/npc/omitted-old.png"], ["http-null-avatar", "/npc/null-old.png"]]) {
    await chatsStorage.patchMetadata(chat.id, {
      gameNpcs: [...baseNpcRoster, { id: npcId, avatarUrl: legacyUrl, avatar: legacyUrl }],
    });
  }
  await chatsStorage.patchMetadata(
    chat.id,
    { gameNpcs: [...baseNpcRoster, { id: "http-omitted-avatar" }] },
    { npcAvatarWriteIntents: "replace" },
  );
  await chatsStorage.patchMetadata(
    chat.id,
    { gameNpcs: [...baseNpcRoster, { id: "http-omitted-avatar" }, { id: "http-null-avatar", avatarUrl: null, avatar: "/npc/null-old.png" }] },
    { npcAvatarWriteIntents: "replace" },
  );
  const explicitRosterChat = await chatsStorage.getById(chat.id);
  assert.ok(explicitRosterChat);
  const explicitRosterNpcs = (JSON.parse(explicitRosterChat.metadata) as { gameNpcs: Array<Record<string, unknown>> }).gameNpcs;
  for (const npcId of ["http-omitted-avatar", "http-null-avatar"]) {
    const npc = explicitRosterNpcs.find((entry) => entry.id === npcId);
    assert.deepEqual(npc?.avatarState, { revision: 1, removed: true });
    assert.equal(npc?.avatarUrl, null);
    assert.equal(npc?.avatar, null);
  }
  const historicalMessage = await chatsStorage.createMessage({
    chatId: chat.id,
    role: "assistant",
    characterId: null,
    content: "historical message stays unchanged",
  });
  const clearedWithLinkedChat = await storage.updateAvatar("portrait-owner", null, { expectedAvatarRevision: 3 });
  assert.ok(clearedWithLinkedChat);
  assert.deepEqual(clearedWithLinkedChat.affectedChatIds, [chat.id]);
  const synchronizedChat = await chatsStorage.getById(chat.id);
  assert.ok(synchronizedChat);
  const synchronizedMetadata = JSON.parse(synchronizedChat.metadata) as {
    freshUnrelatedMetadata: string;
    gameNpcs: Array<Record<string, unknown>>;
  };
  assert.equal(synchronizedMetadata.freshUnrelatedMetadata, "preserve-me");
  const linkedNpc = synchronizedMetadata.gameNpcs.find((npc) => npc.id === "linked-stable-id");
  assert.deepEqual(linkedNpc?.avatarState, { revision: 4, removed: true });
  assert.equal(linkedNpc?.avatarUrl, null);
  assert.equal(linkedNpc?.avatar, null);
  const sameNameNpc = synchronizedMetadata.gameNpcs.find((npc) => npc.id === "same-name-unrelated");
  assert.equal(sameNameNpc?.avatarUrl, "/npc/unrelated.png");
  const historyAfterSync = await chatsStorage.listMessages(chat.id);
  assert.equal(historyAfterSync.length, 1);
  assert.equal(historyAfterSync[0]?.id, historicalMessage.id);
  assert.equal(historyAfterSync[0]?.content, "historical message stays unchanged");

  const emptyRosterClear = (await reconcileNpcAvatarState(
    db,
    [{ id: "stable-unlinked-id", avatarUrl: null, avatar: null }],
    [{ id: "stable-unlinked-id", avatarUrl: "/npc/old.png", avatar: "/npc/old.png" }],
    { npcAvatarWriteIntents: "replace" },
  )) as Array<Record<string, unknown>>;
  assert.deepEqual(emptyRosterClear[0]?.avatarState, { revision: 1, removed: true });
  assert.equal(emptyRosterClear[0]?.avatarUrl, null);
  assert.equal(emptyRosterClear[0]?.avatar, null);

  const omittedPortraitFields = (await reconcileNpcAvatarState(
    db,
    [{ id: "omitted-avatar-fields" }],
    [{ id: "omitted-avatar-fields", avatarUrl: "/npc/old.png", avatar: "/npc/old.png" }],
    { npcAvatarWriteIntents: "replace" },
  )) as Array<Record<string, unknown>>;
  assert.deepEqual(omittedPortraitFields[0]?.avatarState, { revision: 1, removed: true });
  assert.equal(omittedPortraitFields[0]?.avatarUrl, null);
  assert.equal(omittedPortraitFields[0]?.avatar, null);

  const modernNullClearsLegacyPortrait = (await reconcileNpcAvatarState(
    db,
    [{ id: "modern-null-legacy-old", avatarUrl: null, avatar: "/npc/legacy-old.png" }],
    [{ id: "modern-null-legacy-old", avatarUrl: "/npc/old.png", avatar: "/npc/old.png" }],
    { npcAvatarWriteIntents: "replace" },
  )) as Array<Record<string, unknown>>;
  assert.deepEqual(modernNullClearsLegacyPortrait[0]?.avatarState, { revision: 1, removed: true });
  assert.equal(modernNullClearsLegacyPortrait[0]?.avatarUrl, null);
  assert.equal(modernNullClearsLegacyPortrait[0]?.avatar, null);

  const unmarkedModelNullPreservesPortrait = (await reconcileNpcAvatarState(
    db,
    [{ id: "unmarked-model-null", avatarUrl: null, avatar: null }],
    [{ id: "unmarked-model-null", avatarUrl: "/npc/kept.png", avatar: "/npc/kept.png" }],
  )) as Array<Record<string, unknown>>;
  assert.equal(unmarkedModelNullPreservesPortrait[0]?.avatarUrl, "/npc/kept.png");
  assert.equal(unmarkedModelNullPreservesPortrait[0]?.avatar, "/npc/kept.png");

  const staleUnlinkedWrite = (await reconcileNpcAvatarState(
    db,
    [{ id: "stable-unlinked-id", avatarUrl: "/npc/stale.png" }],
    emptyRosterClear,
  )) as Array<Record<string, unknown>>;
  assert.deepEqual(staleUnlinkedWrite[0]?.avatarState, { revision: 1, removed: true });
  assert.equal(staleUnlinkedWrite[0]?.avatarUrl, null);

  const freshUnlinkedWrite = (await reconcileNpcAvatarState(
    db,
    [{ id: "stable-unlinked-id", avatarUrl: "/npc/fresh.png" }],
    emptyRosterClear,
    { npcAvatarWriteIntents: [{ npcId: "stable-unlinked-id", expectedRevision: 1 }] },
  )) as Array<Record<string, unknown>>;
  assert.deepEqual(freshUnlinkedWrite[0]?.avatarState, { revision: 2, removed: false });
  assert.equal(freshUnlinkedWrite[0]?.avatarUrl, "/npc/fresh.png");

  assert.deepEqual(
    withoutCharacterAvatarState({
      name: "Imported",
      extensions: { marinara: { avatarState: { revision: 99, removed: true }, retained: true } },
    }),
    { name: "Imported", extensions: { marinara: { retained: true } } },
  );
  assert.deepEqual(
    withoutGameNpcAvatarStates([{ id: "stable-unlinked-id", avatarState: { revision: 99, removed: true } }]),
    [{ id: "stable-unlinked-id" }],
  );

  const portableCharacter = {
    id: "portable-character",
    data: JSON.stringify({ name: "Portable", extensions: { marinara: { avatarState: { revision: 88, removed: true }, keep: true } } }),
  };
  const sanitizedPortableCharacter = sanitizeProfileTableRows("characters", [portableCharacter])[0]!;
  assert.deepEqual(JSON.parse(sanitizedPortableCharacter.data as string).extensions.marinara, { keep: true });
  const importedRawCharacter = sanitizeProfileAvatarStateRow("characters", {
    data: { name: "Imported", extensions: { marinara: { avatarState: { revision: 88, removed: true }, keep: true } } },
  });
  assert.deepEqual((importedRawCharacter.data as { extensions: { marinara: unknown } }).extensions.marinara, { keep: true });
  const portableMetadata = {
    gameNpcs: [{ id: "npc", avatarState: { revision: 88, removed: true }, avatarUrl: "/portrait.png" }],
    keep: { location: "Generic location", branch: "branch-a" },
  };
  for (const metadata of [JSON.stringify(portableMetadata), portableMetadata]) {
    const importedChat = sanitizeProfileAvatarStateRow("chats", { id: "portable-chat", metadata });
    const sanitized =
      typeof importedChat.metadata === "string" ? JSON.parse(importedChat.metadata) : importedChat.metadata;
    assert.equal(typeof importedChat.metadata, typeof metadata);
    assert.equal(importedChat.id, "portable-chat");
    assert.deepEqual(sanitized, { gameNpcs: [{ id: "npc", avatarUrl: "/portrait.png" }], keep: portableMetadata.keep });
  }
  assert.deepEqual(portableMetadata.gameNpcs[0]!.avatarState, { revision: 88, removed: true });

  const exportData = {
    name: "Portable",
    description: "",
    extensions: { marinara: { avatarState: { revision: 88, removed: true }, keep: true } },
  };
  assert.deepEqual(buildCompatibleCharacterExport(exportData).data.extensions.marinara, { keep: true });
  const nativeEnvelope = await buildNativeCharacterEnvelope(
    { id: "portable-character", createdAt: timestamp, updatedAt: timestamp, avatarPath: null },
    exportData,
    { listByCharacterId: async () => [] },
  );
  assert.deepEqual(nativeEnvelope.data.data.extensions.marinara, { keep: true });
} finally {
  if (previousStorageRoot === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousStorageRoot;
  rmSync(storageRoot, { recursive: true, force: true });
}
