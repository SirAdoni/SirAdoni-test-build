import assert from "node:assert/strict";
import type { GameNpc } from "../../packages/shared/src/index.js";
import {
  buildCampaignPortraitRosterCandidates,
  buildMissingSceneAssetGenerationPayload,
} from "../../packages/client/src/components/game/game-asset-generation-payload.js";
import { mergeGameNpcsPreservingAvatars, resolveNpcAvatarStateForIdentity } from "../../packages/client/src/lib/game-npc-avatar.js";
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

function trackedNpc(id: string, name: string, avatarUrl?: string | null, avatarState?: GameNpc["avatarState"]): GameNpc {
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
    [{ id: undefined, npcId: null, characterId: null, ...npc, gender: null, pronouns: null, avatarUrl: null, avatarState: undefined }],
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
  [{ id: "npc:alex-one", npcId: "npc:alex-one", characterId: null, name: "Alex", description: "A red scarf.", gender: null, pronouns: null, avatarUrl: null, avatarState: undefined }],
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

for (const missingAvatarUrl of [undefined, null]) {
  const ordinaryMissingAvatar = mergeGameNpcsPreservingAvatars(
    [trackedNpc("npc:ordinary", "Ordinary", libraryAvatar)],
    [trackedNpc("npc:ordinary", "Ordinary", missingAvatarUrl)],
  );
  assert.equal(
    ordinaryMissingAvatar[0]?.avatarUrl,
    libraryAvatar,
    "ordinary missing or null model fields must preserve a locally generated portrait",
  );
}

const newerRemoval = mergeGameNpcsPreservingAvatars(
  [trackedNpc("npc:alex-one", "Alex", generatedAvatar, { revision: 1, removed: false })],
  [trackedNpc("npc:alex-one", "Alex", libraryAvatar, { revision: 2, removed: true })],
);
assert.equal(newerRemoval[0]?.avatarUrl, undefined, "a newer explicit removal must beat stale metadata URLs");
assert.deepEqual(newerRemoval[0]?.avatarState, { revision: 2, removed: true });

const laterAssignment = mergeGameNpcsPreservingAvatars(
  newerRemoval,
  [trackedNpc("npc:alex-one", "Alex", generatedAvatar, { revision: 3, removed: false })],
);
assert.equal(laterAssignment[0]?.avatarUrl, generatedAvatar, "a newer assignment must supersede an earlier removal");
assert.deepEqual(laterAssignment[0]?.avatarState, { revision: 3, removed: false });

const linkedAfterUnlinkedRevision = mergeGameNpcsPreservingAvatars(
  [trackedNpc("npc:domain", "Domain", undefined, { revision: 5, removed: true })],
  [{ ...trackedNpc("npc:domain", "Domain", generatedAvatar, { revision: 1, removed: false }), characterId: "character:linked" }],
);
assert.equal(linkedAfterUnlinkedRevision[0]?.avatarUrl, generatedAvatar, "a new character authority accepts its lower-domain revision");
assert.deepEqual(linkedAfterUnlinkedRevision[0]?.avatarState, { revision: 1, removed: false });
assert.equal(linkedAfterUnlinkedRevision[0]?.characterId, "character:linked");
for (const missingUrl of [undefined, null]) {
  const newLinkedWithoutAvatar = mergeGameNpcsPreservingAvatars(
    [trackedNpc("npc:domain", "Domain", generatedAvatar, { revision: 5, removed: false })],
    [{ ...trackedNpc("npc:domain", "Domain", missingUrl), characterId: "character:new" }],
  );
  assert.equal(newLinkedWithoutAvatar[0]?.avatarUrl, undefined, "a new linked authority without a marker must not inherit an unlinked portrait");
  assert.equal(newLinkedWithoutAvatar[0]?.characterId, "character:new");
}
const switchedCardWithoutAvatar = mergeGameNpcsPreservingAvatars(
  [{ ...trackedNpc("npc:domain", "Domain", generatedAvatar, { revision: 5, removed: false }), characterId: "character:old" }],
  [{ ...trackedNpc("npc:domain", "Domain", null), characterId: "character:new" }],
);
assert.equal(switchedCardWithoutAvatar[0]?.avatarUrl, undefined, "a different linked card must not inherit the prior card portrait");
assert.equal(switchedCardWithoutAvatar[0]?.characterId, "character:new");
const linkedRosterAfterUnlinkedRevision = buildCampaignPortraitRosterCandidates(
  [trackedNpc("npc:domain", "Domain", undefined, { revision: 5, removed: true })],
  [{ ...trackedNpc("npc:domain", "Domain", generatedAvatar, { revision: 1, removed: false }), characterId: "character:linked" }],
  [],
  new Set(),
);
assert.equal(linkedRosterAfterUnlinkedRevision[0]?.avatarUrl, generatedAvatar, "roster candidates must honor the fresh linked revision domain");
assert.deepEqual(linkedRosterAfterUnlinkedRevision[0]?.avatarState, { revision: 1, removed: false });
const linkedRosterRejectsUnlinkedRemoval = buildCampaignPortraitRosterCandidates(
  [{ ...trackedNpc("npc:domain", "Domain", generatedAvatar, { revision: 1, removed: false }), characterId: "character:linked" }],
  [trackedNpc("npc:domain", "Domain", null, { revision: 5, removed: true })],
  [],
  new Set(),
);
assert.equal(linkedRosterRejectsUnlinkedRemoval[0]?.avatarUrl, generatedAvatar, "roster merge must ignore higher unlinked removal for a linked character");
assert.deepEqual(linkedRosterRejectsUnlinkedRemoval[0]?.avatarState, { revision: 1, removed: false });
const linkedRosterRejectsUnlinkedAssignment = buildCampaignPortraitRosterCandidates(
  [{ ...trackedNpc("npc:domain", "Domain", undefined, { revision: 1, removed: true }), characterId: "character:linked" }],
  [trackedNpc("npc:domain", "Domain", generatedAvatar, { revision: 5, removed: false })],
  [],
  new Set(),
);
assert.equal(linkedRosterRejectsUnlinkedAssignment[0]?.avatarUrl, undefined, "roster merge must not revive a linked removal from a higher unlinked revision");
assert.deepEqual(linkedRosterRejectsUnlinkedAssignment[0]?.avatarState, { revision: 1, removed: true });
const rosterNewLinkedWithoutAvatar = buildCampaignPortraitRosterCandidates(
  [trackedNpc("npc:domain", "Domain", generatedAvatar, { revision: 5, removed: false })],
  [{ ...trackedNpc("npc:domain", "Domain", null), characterId: "character:new" }],
  [],
  new Set(),
);
assert.equal(rosterNewLinkedWithoutAvatar[0]?.avatarUrl, undefined, "roster merge must not inherit an unlinked portrait into a new card domain");
const rosterSwitchedCardWithoutAvatar = buildCampaignPortraitRosterCandidates(
  [{ ...trackedNpc("npc:domain", "Domain", generatedAvatar, { revision: 5, removed: false }), characterId: "character:old" }],
  [{ ...trackedNpc("npc:domain", "Domain", null), characterId: "character:new" }],
  [],
  new Set(),
);
assert.equal(rosterSwitchedCardWithoutAvatar[0]?.avatarUrl, undefined, "roster merge must not carry a portrait across linked cards");

const switchedCharacterAuthority = resolveNpcAvatarStateForIdentity(
  { revision: 5, removed: true },
  "character:old",
  { revision: 1, removed: false },
  "character:new",
);
assert.deepEqual(switchedCharacterAuthority, { revision: 1, removed: false }, "an explicit character switch starts a new revision domain");
assert.deepEqual(
  resolveNpcAvatarStateForIdentity({ revision: 5, removed: true }, "character:linked", undefined, undefined),
  { revision: 5, removed: true },
  "an incoming snapshot without characterId must retain the existing linked authority",
);
const linkedAssignmentRejectsUnlinkedRemoval = mergeGameNpcsPreservingAvatars(
  [{ ...trackedNpc("npc:domain", "Domain", generatedAvatar, { revision: 1, removed: false }), characterId: "character:linked" }],
  [trackedNpc("npc:domain", "Domain", null, { revision: 5, removed: true })],
);
assert.equal(linkedAssignmentRejectsUnlinkedRemoval[0]?.avatarUrl, generatedAvatar, "higher unlinked removal must not clear a linked assignment");
assert.deepEqual(linkedAssignmentRejectsUnlinkedRemoval[0]?.avatarState, { revision: 1, removed: false });

const linkedRemovalRejectsUnlinkedAssignment = mergeGameNpcsPreservingAvatars(
  [{ ...trackedNpc("npc:domain", "Domain", undefined, { revision: 1, removed: true }), characterId: "character:linked" }],
  [trackedNpc("npc:domain", "Domain", generatedAvatar, { revision: 5, removed: false })],
);
assert.equal(linkedRemovalRejectsUnlinkedAssignment[0]?.avatarUrl, undefined, "higher unlinked assignment must not revive a linked removal");
assert.deepEqual(linkedRemovalRejectsUnlinkedAssignment[0]?.avatarState, { revision: 1, removed: true });

const sameCardAssignment = mergeGameNpcsPreservingAvatars(
  [{ ...trackedNpc("npc:domain", "Domain", undefined, { revision: 1, removed: true }), characterId: "character:linked" }],
  [{ ...trackedNpc("npc:domain", "Domain", generatedAvatar, { revision: 2, removed: false }), characterId: "character:linked" }],
);
assert.equal(sameCardAssignment[0]?.avatarUrl, generatedAvatar, "same-card increasing revision must still attach normally");
assert.deepEqual(sameCardAssignment[0]?.avatarState, { revision: 2, removed: false });
const missingCharacterIdRefresh = mergeGameNpcsPreservingAvatars(
  [{ ...trackedNpc("npc:domain", "Domain", undefined, { revision: 5, removed: true }), characterId: "character:linked" }],
  [trackedNpc("npc:domain", "Domain", generatedAvatar)],
);
assert.equal(missingCharacterIdRefresh[0]?.avatarUrl, undefined, "missing characterId must not revive a linked portrait");
assert.equal(missingCharacterIdRefresh[0]?.characterId, "character:linked");

const sameNameRemovalControl = mergeGameNpcsPreservingAvatars(
  [
    trackedNpc("npc:alex-one", "Alex", generatedAvatar, { revision: 1, removed: false }),
    trackedNpc("npc:alex-two", "Alex", libraryAvatar),
  ],
  [
    trackedNpc("npc:alex-one", "Alex", libraryAvatar, { revision: 2, removed: true }),
    trackedNpc("npc:alex-two", "Alex"),
  ],
);
assert.equal(sameNameRemovalControl[0]?.avatarUrl, undefined, "removal must clear only the targeted stable identity");
assert.equal(sameNameRemovalControl[1]?.avatarUrl, libraryAvatar, "same-name sibling portrait must remain attached");

const ambiguousLegacyNames = mergeGameNpcsPreservingAvatars(
  [trackedNpc("legacy-existing", "Alex", libraryAvatar)],
  [trackedNpc("", "Alex"), trackedNpc("", "Alex")],
);
assert.deepEqual(
  ambiguousLegacyNames.map((entry) => entry.avatarUrl),
  [undefined, undefined],
  "legacy same-name NPCs without stable IDs must not share a portrait when identity is ambiguous",
);

console.log("Game portrait recovery regression passed.");
