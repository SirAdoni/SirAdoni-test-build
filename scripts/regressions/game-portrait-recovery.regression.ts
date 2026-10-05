import assert from "node:assert/strict";
import { buildMissingSceneAssetGenerationPayload } from "../../packages/client/src/components/game/game-asset-generation-payload.js";
import {
  applyGameNpcAvatarAuthority,
  buildGameNpcAvatarLookup,
  mergeGameNpcIdentityUnion,
  mergeGameNpcsPreservingAvatars,
  resolveNpcAvatarStateForIdentity,
} from "../../packages/client/src/lib/game-npc-avatar.js";
import { useGameModeStore } from "../../packages/client/src/stores/game-mode.store.js";
import type { GameNpc } from "../../packages/shared/src/index.js";

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

function trackedNpc(
  id: string,
  name: string,
  avatarUrl?: string | null,
  avatarState?: GameNpc["avatarState"],
): GameNpc {
  return {
    id,
    name,
    emoji: "👤",
    description: "",
    location: "",
    reputation: 0,
    notes: [],
    avatarUrl,
    avatarState,
  };
}

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
    [
      {
        id: undefined,
        npcId: null,
        characterId: null,
        ...npc,
        gender: null,
        pronouns: null,
        avatarUrl: null,
        avatarState: undefined,
      },
    ],
    `${recovery.label} payload`,
  );
  assert.deepEqual(result?.forceNpcAvatarNames, [npc.name], `${recovery.label} force list`);
}

const sameNamePayload = buildMissingSceneAssetGenerationPayload({
  ...baseInput,
  sceneAssetNpcs: [
    { id: "npc:alex-one", name: "Alex", description: "Red scarf" },
    { id: "npc:alex-two", name: "Alex", description: "Blue coat" },
  ],
  npcAvatarLookup: new Map([["id:npc:alex-one", libraryAvatar]]),
  npcsNeedingAvatars: [{ npcId: "npc:alex-two", name: "Alex", description: "Blue coat" }],
});
assert.deepEqual(
  sameNamePayload?.npcsNeedingAvatars,
  [{ npcId: "npc:alex-two", name: "Alex", description: "Blue coat" }],
  "a same-name portrait must not suppress recovery for a different stable NPC ID",
);

const removal = mergeGameNpcsPreservingAvatars(
  [trackedNpc("npc:alex", "Alex", generatedAvatar, { revision: 1, removed: false })],
  [trackedNpc("npc:alex", "Alex", libraryAvatar, { revision: 2, removed: true })],
);
assert.equal(removal[0]?.avatarUrl, undefined, "a newer explicit removal clears only the matching stable NPC");
assert.deepEqual(removal[0]?.avatarState, { revision: 2, removed: true });

const reassignment = mergeGameNpcsPreservingAvatars(
  [
    {
      ...trackedNpc("npc:linked", "Linked", generatedAvatar, { revision: 5, removed: true }),
      characterId: "character:old",
    },
  ],
  [{ ...trackedNpc("npc:linked", "Linked", null), characterId: "character:new" }],
);
assert.equal(reassignment[0]?.avatarUrl, undefined, "a new linked card does not inherit the previous card portrait");
assert.equal(reassignment[0]?.characterId, "character:new");

assert.deepEqual(
  resolveNpcAvatarStateForIdentity({ revision: 5, removed: true }, "character:linked", undefined, undefined),
  { revision: 5, removed: true },
  "an incoming snapshot without characterId cannot discard linked avatar authority",
);

const ambiguousLegacy = mergeGameNpcsPreservingAvatars(
  [trackedNpc("legacy-one", "Alex", libraryAvatar), trackedNpc("legacy-two", "Alex", generatedAvatar)],
  [trackedNpc("", "Alex")],
);
assert.equal(ambiguousLegacy[0]?.avatarUrl, undefined, "ambiguous same-name legacy rows cannot transfer portraits");

const retainedTrackedOnly = mergeGameNpcIdentityUnion(
  [trackedNpc("npc:tracked-only", "Tracked only", generatedAvatar)],
  [],
);
assert.equal(retainedTrackedOnly.length, 1, "stale empty metadata does not drop a tracked-only NPC");
const distinctStableIdsWithSharedCharacter = mergeGameNpcIdentityUnion(
  [trackedNpc("npc:stable-one", "Alex")],
  [{ ...trackedNpc("npc:stable-two", "Alex"), characterId: "character:shared" }],
);
assert.deepEqual(
  distinctStableIdsWithSharedCharacter.map((entry) => entry.id),
  ["npc:stable-two", "npc:stable-one"],
  "different stable NPC IDs remain distinct even when linked to the same character card",
);
const deduplicatedClear = mergeGameNpcIdentityUnion(
  [trackedNpc("npc:linked", "Alex", generatedAvatar)],
  [{ ...trackedNpc("npc:linked", "Alex", undefined, { revision: 2, removed: true }), characterId: "character:alex" }],
);
assert.equal(deduplicatedClear.length, 1, "metadata and store rows merge by stable NPC ID");
assert.equal(deduplicatedClear[0]?.characterId, "character:alex");
assert.equal(deduplicatedClear[0]?.avatarUrl, undefined, "the linked removal tombstone wins over an older tracked URL");

useGameModeStore.setState({
  npcs: [trackedNpc("npc:alex", "Alex", "/api/avatars/file/current.png?v=1", { revision: 3, removed: false })],
});
useGameModeStore.getState().patchNpcAvatars([
  {
    npcId: "npc:alex",
    name: "Alex",
    avatarUrl: "/api/avatars/file/stale.png",
    avatarState: { revision: 2, removed: false },
  },
]);
assert.equal(
  useGameModeStore.getState().npcs[0]?.avatarUrl,
  "/api/avatars/file/current.png?v=1",
  "a stale lower-revision assignment cannot overwrite the current URL",
);
useGameModeStore.setState({
  npcs: [trackedNpc("npc:alex-one", "Alex", libraryAvatar), trackedNpc("npc:alex-two", "Alex", generatedAvatar)],
});
useGameModeStore.getState().patchNpcAvatars([{ name: "Alex", avatarUrl: "/api/avatars/file/wrong.png" }]);
assert.deepEqual(
  useGameModeStore.getState().npcs.map((entry) => entry.avatarUrl),
  [libraryAvatar, generatedAvatar],
  "name-only avatar patches cannot change ambiguous same-name NPCs",
);

const freshAfterRemoval = buildMissingSceneAssetGenerationPayload({
  ...baseInput,
  sceneAssetNpcs: [
    {
      npcId: "npc:cleared",
      name: "Cleared",
      description: "Previously removed portrait",
      avatarState: { revision: 3, removed: true },
    },
  ],
  npcsNeedingAvatars: [
    {
      npcId: "npc:cleared",
      name: "Cleared",
      description: "Previously removed portrait",
      avatarState: { revision: 3, removed: true },
    },
  ],
  npcAvatarLookup: new Map(),
});
assert.equal(
  freshAfterRemoval,
  null,
  "a cleared portrait stays out of passive missing-asset generation; explicit Generate missing uses the campaign batch path",
);

const removedLinkedNpc = {
  ...trackedNpc("npc:linked-alex", "Alex", undefined, { revision: 4, removed: true }),
  characterId: "character:alex",
};
const staleCharacterSnapshot = [{ characterId: "character:alex", name: "Alex", avatarPath: libraryAvatar }];
const removedSnapshotLookup = buildGameNpcAvatarLookup([removedLinkedNpc], staleCharacterSnapshot, [removedLinkedNpc]);
assert.equal(
  removedSnapshotLookup.has("character:character:alex"),
  false,
  "a removal tombstone masks an unversioned linked-card snapshot",
);
assert.equal(removedSnapshotLookup.has("alex"), false, "a tombstoned linked NPC cannot fall back to a name portrait");
const freshAfterLinkedRemoval = buildMissingSceneAssetGenerationPayload({
  ...baseInput,
  sceneAssetNpcs: [removedLinkedNpc],
  npcsNeedingAvatars: [removedLinkedNpc],
  npcAvatarLookup: removedSnapshotLookup,
});
assert.equal(
  freshAfterLinkedRemoval,
  null,
  "a linked removal stays out of passive generation even when the card snapshot still has a stale portrait",
);

const newlyAssignedNpc = {
  ...trackedNpc("npc:linked-alex", "Alex", generatedAvatar, { revision: 5, removed: false }),
  characterId: "character:alex",
};
const assignedSnapshotLookup = buildGameNpcAvatarLookup([newlyAssignedNpc], staleCharacterSnapshot, [newlyAssignedNpc]);
assert.equal(
  assignedSnapshotLookup.get("character:character:alex"),
  generatedAvatar,
  "a newer assignment beats a stale unversioned card URL",
);

const dialogueRemoval = applyGameNpcAvatarAuthority(
  new Map([["alex", { url: libraryAvatar, crop: null }]]),
  [removedLinkedNpc],
  [{ id: "character:alex", name: "Alex" }],
);
assert.equal(dialogueRemoval.has("alex"), false, "dialogue tombstones clear stale active-card portraits");
const dialogueAssignment = applyGameNpcAvatarAuthority(
  new Map([["alex", { url: libraryAvatar, crop: null }]]),
  [newlyAssignedNpc],
  [{ id: "character:alex", name: "Alex" }],
);
assert.equal(
  dialogueAssignment.get("alex")?.url,
  generatedAvatar,
  "dialogue uses the current authoritative NPC assignment",
);
const ambiguousDialogue = applyGameNpcAvatarAuthority(
  new Map([["alex", { url: libraryAvatar, crop: null }]]),
  [trackedNpc("npc:alex-one", "Alex", generatedAvatar), trackedNpc("npc:alex-two", "Alex", "/other.png")],
  [],
);
assert.equal(
  ambiguousDialogue.has("alex"),
  false,
  "dialogue never displays a same-name portrait from an ambiguous identity",
);
const sharedCardAmbiguousDialogue = applyGameNpcAvatarAuthority(
  new Map([["alex", { url: libraryAvatar, crop: null }]]),
  [
    { ...trackedNpc("npc:alex-one", "Alex", generatedAvatar), characterId: "character:shared" },
    { ...trackedNpc("npc:alex-two", "Alex", "/other.png"), characterId: "character:shared" },
  ],
  [{ id: "character:shared", name: "Alex" }],
);
assert.equal(
  sharedCardAmbiguousDialogue.has("alex"),
  false,
  "shared linked-card identity cannot collapse distinct stable NPCs in dialogue",
);

console.log("Game portrait recovery regression passed.");
