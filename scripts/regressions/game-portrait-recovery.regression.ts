import assert from "node:assert/strict";
import type { GameNpc } from "../../packages/shared/src/index.js";
import { buildMissingSceneAssetGenerationPayload } from "../../packages/client/src/components/game/game-asset-generation-payload.js";
import { mergeGameNpcsPreservingAvatars } from "../../packages/client/src/lib/game-npc-avatar.js";
import {
  gameNpcCharacterSyncRetryDelay,
  isRetryableGameNpcCharacterSyncError,
} from "../../packages/client/src/lib/game-npc-character-sync-policy.js";
import { isForcedSceneAssetNpcAvatar } from "../../packages/server/src/routes/game.routes.js";
import {
  buildNpcAvatarUploadFilename,
  buildNpcAvatarMetadataPatch,
  npcAvatarUploadSlug,
} from "../../packages/server/src/routes/avatars.routes.js";

function trackedNpc(id: string, name: string, avatarUrl?: string): GameNpc {
  return {
    id,
    name,
    emoji: "👤",
    description: "",
    location: "",
    reputation: 0,
    notes: [],
    avatarUrl,
  };
}

const chatId = "game-chat";
const npc = {
  name: "Il Dottore",
  description: "A familiar character with an existing portrait.",
};
const libraryAvatar = "/api/avatars/file/dottore.png";
const generatedAvatar = `/api/avatars/npc/${chatId}/il-dottore.png?v=1`;
const baseInput = {
  gameImageGenerationEnabled: true,
  activeChatId: chatId,
  currentBackground: "backgrounds:forest",
  savedSceneBackground: "backgrounds:forest",
  assetMap: { "backgrounds:forest": { path: "/forest.png" } },
  sceneAssetNpcs: [npc],
  npcsNeedingAvatars: [],
};

assert.equal(isRetryableGameNpcCharacterSyncError(new TypeError("network unavailable")), true);
assert.equal(isRetryableGameNpcCharacterSyncError({ status: 409 }), true);
assert.equal(isRetryableGameNpcCharacterSyncError({ status: 429 }), true);
assert.equal(isRetryableGameNpcCharacterSyncError({ status: 500 }), true);
assert.equal(isRetryableGameNpcCharacterSyncError({ status: 400 }), false);
assert.equal(isRetryableGameNpcCharacterSyncError({ status: 404 }), false);
assert.deepEqual(
  [0, 1, 2, 3, 8].map(gameNpcCharacterSyncRetryDelay),
  [1_000, 2_000, 4_000, 4_000, 4_000],
  "automatic card sync retries must back off without growing beyond four seconds",
);

assert.equal(
  buildMissingSceneAssetGenerationPayload({
    ...baseInput,
    npcAvatarLookup: new Map([["il dottore", libraryAvatar]]),
    failedNpcAvatarNames: [npc.name],
  }),
  null,
  "a library-avatar load error must not replace the character portrait",
);

const libraryBackgroundRecovery = buildMissingSceneAssetGenerationPayload({
  ...baseInput,
  currentBackground: null,
  savedSceneBackground: "backgrounds:generated:missing-scene",
  assetMap: {},
  npcAvatarLookup: new Map([["il dottore", libraryAvatar]]),
});
assert.equal(libraryBackgroundRecovery?.backgroundTag, "backgrounds:generated:missing-scene");
assert.equal(
  libraryBackgroundRecovery?.npcsNeedingAvatars,
  undefined,
  "recovering a missing background must not regenerate a library portrait",
);
assert.equal(libraryBackgroundRecovery?.forceNpcAvatarNames, undefined);

for (const recovery of [
  {
    label: "load error",
    input: { failedNpcAvatarNames: [npc.name] },
  },
  {
    label: "missing background",
    input: {
      currentBackground: null,
      savedSceneBackground: "backgrounds:generated:missing-scene",
      assetMap: {},
    },
  },
]) {
  const result = buildMissingSceneAssetGenerationPayload({
    ...baseInput,
    ...recovery.input,
    npcAvatarLookup: new Map([["il dottore", generatedAvatar]]),
  });
  assert.deepEqual(
    result?.npcsNeedingAvatars,
    [{ npcId: null, ...npc, gender: null, pronouns: null }],
    `${recovery.label} payload`,
  );
  assert.deepEqual(result?.forceNpcAvatarNames, [npc.name], `${recovery.label} force list`);
}

const sameNameIdentityPayload = buildMissingSceneAssetGenerationPayload({
  ...baseInput,
  sceneAssetNpcs: [
    { id: "npc:alex-one", name: "Alex", description: "A red scarf." },
    { id: "npc:alex-two", name: "Alex", description: "A blue coat." },
  ],
  npcAvatarLookup: new Map([["id:npc:alex-one", libraryAvatar]]),
  npcsNeedingAvatars: [{ npcId: "npc:alex-two", name: "Alex", description: "A blue coat." }],
});
assert.deepEqual(
  sameNameIdentityPayload?.npcsNeedingAvatars,
  [{ npcId: "npc:alex-two", name: "Alex", description: "A blue coat." }],
  "missing-portrait payloads must preserve same-name NPC identity",
);

const sameNameFailurePayload = buildMissingSceneAssetGenerationPayload({
  ...baseInput,
  sceneAssetNpcs: [
    { id: "npc:alex-one", name: "Alex", description: "A red scarf." },
    { id: "npc:alex-two", name: "Alex", description: "A blue coat." },
  ],
  npcAvatarLookup: new Map([
    ["id:npc:alex-one", `/api/avatars/npc/${chatId}/alex-one.png?v=1`],
    ["id:npc:alex-two", `/api/avatars/npc/${chatId}/alex-two.png?v=1`],
  ]),
  npcsNeedingAvatars: [],
  failedNpcAvatarNames: ["id:npc:alex-one"],
});
assert.deepEqual(
  sameNameFailurePayload?.npcsNeedingAvatars,
  [{ npcId: "npc:alex-one", name: "Alex", description: "A red scarf.", gender: null, pronouns: null }],
  "a portrait load failure must retry only the exact same-name NPC identity",
);
assert.deepEqual(
  sameNameFailurePayload?.forceNpcAvatarNames,
  ["id:npc:alex-one"],
  "the server force key must preserve exact same-name NPC identity",
);
assert.equal(
  isForcedSceneAssetNpcAvatar(sameNameFailurePayload?.forceNpcAvatarNames ?? [], {
    npcId: "npc:alex-one",
    name: "Alex",
    description: "A red scarf.",
  }),
  true,
);
assert.equal(
  isForcedSceneAssetNpcAvatar(sameNameFailurePayload?.forceNpcAvatarNames ?? [], {
    npcId: "npc:alex-two",
    name: "Alex",
    description: "A blue coat.",
  }),
  false,
  "the server must not expand an exact force key to another same-name NPC",
);

const atomicUploadPatch = buildNpcAvatarMetadataPatch(
  {
    gameNpcs: [trackedNpc("npc:alex-one", "Alex"), trackedNpc("npc:alex-two", "Alex"), trackedNpc("npc:new", "New")],
  },
  "npc:alex-one",
  "Alex",
  "/api/avatars/npc/game-chat/npc-alex-one.png",
);
assert.deepEqual(
  atomicUploadPatch?.gameNpcs.map((entry) => ({ id: entry.id, avatarUrl: entry.avatarUrl })),
  [
    { id: "npc:alex-one", avatarUrl: "/api/avatars/npc/game-chat/npc-alex-one.png" },
    { id: "npc:alex-two", avatarUrl: undefined },
    { id: "npc:new", avatarUrl: undefined },
  ],
  "an upload must update only its exact identity while preserving a concurrent NPC and same-name sibling",
);
assert.equal(
  buildNpcAvatarMetadataPatch(
    { gameNpcs: [trackedNpc("npc:alex-one", "Alex")], gameIgnoredNpcIds: ["npc:alex-one"] },
    "npc:alex-one",
    "Alex",
    "/api/avatars/npc/game-chat/npc-alex-one.png",
  ),
  null,
  "a stale upload must not restore a user-removed NPC",
);
assert.equal(
  npcAvatarUploadSlug("npc:Alex", "Alex"),
  npcAvatarUploadSlug("npc:Alex", "Alex"),
  "manual portrait filename prefixes must be stable for the same exact NPC id",
);
assert.notEqual(
  npcAvatarUploadSlug("npc:Alex", "Alex"),
  npcAvatarUploadSlug("npc-Alex", "Alex"),
  "punctuation-distinct NPC ids must not share a portrait filename prefix",
);
assert.notEqual(
  npcAvatarUploadSlug("npc:Alex", "Alex"),
  npcAvatarUploadSlug("npc:alex", "Alex"),
  "case-distinct NPC ids must not share a portrait filename prefix",
);
assert.notEqual(
  buildNpcAvatarUploadFilename("npc:alex-one", "Alex", "png", "upload-one"),
  buildNpcAvatarUploadFilename("npc:alex-one", "Alex", "png", "upload-two"),
  "two uploads for the same NPC must write distinct files until the metadata commit selects one",
);

const sameNameMetadataRefresh = mergeGameNpcsPreservingAvatars(
  [trackedNpc("npc:alex-one", "Alex", libraryAvatar)],
  [trackedNpc("npc:alex-two", "Alex")],
);
assert.equal(
  sameNameMetadataRefresh[0]?.avatarUrl,
  undefined,
  "a stale metadata refresh must not transfer a portrait to a different same-named NPC",
);

console.log("Game portrait recovery regression passed.");
