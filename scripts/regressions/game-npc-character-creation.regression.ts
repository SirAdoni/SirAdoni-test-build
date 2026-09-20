import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GameNpc, PresentCharacter } from "../../packages/shared/src/index.js";
import {
  buildStableGameNpcId,
  findUnambiguousGameNpcNameMatch,
  isGameNpcRelationalLabel,
  isPlausibleNarrationNpcName,
  resolveEffectiveGameId,
} from "../../packages/shared/src/utils/game-npc-id.js";
import {
  getJournalNpcPublicDescription,
  getJournalNpcPublicLocation,
  shouldShowJournalNpc,
} from "../../packages/client/src/lib/game-journal-npcs.js";
import { createFileNativeDB } from "../../packages/server/src/db/file-backed-store.js";
import {
  buildAutoNpcCharacterData,
  changedGameNpcRosterIds,
  collectGameNpcCharacterCandidates,
  isGameNpcCharacterSyncTargetCurrent,
  isEligibleGameNpcCharacterName,
  mergeNarrationNpcObservations,
  shouldCopyNpcAvatar,
  shouldReplaceManagedValue,
} from "../../packages/server/src/services/game/npc-character-sync.js";
import { syncGameNpcCharacters } from "./npc-admission-fixture.js";
import {
  gameNpcSanitizationOptionsFromMetadata,
  isNarrationNpcNameExcluded,
  sanitizeGameNpcAvatarUrls,
} from "../../packages/server/src/services/game/npc-avatar-utils.js";
import { npcPortraitSlug } from "../../packages/server/src/services/game/game-asset-generation.js";
import {
  characterStorageRevision,
  createCharactersStorage,
} from "../../packages/server/src/services/storage/characters.storage.js";

function npc(overrides: Partial<GameNpc> = {}): GameNpc {
  return {
    id: "npc:elara-vale",
    name: "Elara Vale",
    emoji: "🧭",
    description: "A poised envoy with a sealed royal brief.",
    descriptionSource: "narration",
    location: "West Gate",
    reputation: 0,
    notes: [],
    avatarUrl: null,
    ...overrides,
  };
}

function present(overrides: Partial<PresentCharacter> = {}): PresentCharacter {
  return {
    name: "Elara Vale",
    appearance: "A weathered woman with silver-streaked black hair.",
    outfit: "A rain-dark green traveling coat.",
    ...overrides,
  } as PresentCharacter;
}

assert.equal(isEligibleGameNpcCharacterName("Goblin Archer 1"), false, "generic combat mobs must not get cards");
assert.equal(isGameNpcRelationalLabel("Your father"), true);
assert.equal(isGameNpcRelationalLabel("Liveth Corren's father"), true);
assert.equal(isGameNpcRelationalLabel("Father Aldren"), false, "a real titled name must remain eligible");
assert.equal(isEligibleGameNpcCharacterName("Your father"), false, "relationship labels must not get cards");
assert.equal(isEligibleGameNpcCharacterName("Elara Vale"), true, "specific named NPCs must remain eligible");
for (const fragment of [
  "Bramble who",
  "But you",
  "Cook",
  "Da",
  "Dinner",
  "Father",
  "Fifth-month and",
  "I'd",
  "I'd have",
  "I've",
  "If it",
  "Ilyrien's already",
  "It",
  "It is",
  "Nobody has",
  "Osric and",
  "Sabine has",
  "She",
  "Unknown Cursewright",
  "You never",
  "You've",
]) {
  assert.equal(isPlausibleNarrationNpcName(fragment), false, `narration fragment ${fragment} must not become an NPC`);
}
assert.equal(isPlausibleNarrationNpcName("Dorra"), true);
assert.equal(isPlausibleNarrationNpcName("Under-Gardener Pell Marrow"), true);
assert.equal(isPlausibleNarrationNpcName("Aensyl of the Rootmother's Line"), true);
assert.equal(isPlausibleNarrationNpcName("Mirah hai-Tal"), true);
assert.equal(isPlausibleNarrationNpcName("שרה"), true);
assert.equal(buildStableGameNpcId("Elara Vale"), "npc:elara-vale");
assert.equal(
  resolveEffectiveGameId(undefined, "legacy-campaign", "session-chat"),
  "legacy-campaign",
  "legacy/imported sessions without metadata.gameId must still hydrate under their group identity",
);
assert.equal(
  buildStableGameNpcId("שרה"),
  buildStableGameNpcId("שרה"),
  "non-Latin NPC names must receive deterministic ids instead of random portrait/sync identities",
);
assert.notEqual(buildStableGameNpcId("שרה"), "npc:unknown");
assert.notEqual(buildStableGameNpcId("ך"), buildStableGameNpcId("כ"), "distinct Hebrew names must not collide");
assert.notEqual(buildStableGameNpcId("王明"), buildStableGameNpcId("王敏"), "distinct CJK names must not collide");
assert.notEqual(
  buildStableGameNpcId("Sarah שרה"),
  buildStableGameNpcId("Sarah רחל"),
  "a shared ASCII fragment must not collapse distinct mixed-script names",
);
const longUnicodeId = buildStableGameNpcId("王".repeat(48));
assert.ok(longUnicodeId.length <= 200, "long Unicode NPC ids must fit the portrait and sync API schema");
assert.notEqual(
  longUnicodeId,
  buildStableGameNpcId(`${"王".repeat(47)}明`),
  "long Unicode names sharing a prefix must retain distinct bounded ids",
);
assert.notEqual(
  npcPortraitSlug({
    chatId: "chat",
    npcId: "npc:alex-one",
    npcName: "Alex",
    appearance: "Red scarf.",
    imgModel: "unused",
    imgBaseUrl: "",
    imgApiKey: "",
  }),
  npcPortraitSlug({
    chatId: "chat",
    npcId: "npc:alex-two",
    npcName: "Alex",
    appearance: "Red scarf.",
    imgModel: "unused",
    imgBaseUrl: "",
    imgApiKey: "",
  }),
  "separate same-named NPC identities must use separate portrait files",
);
assert.equal(isGameNpcCharacterSyncTargetCurrent("game-a", "game-a"), true);
assert.equal(
  isGameNpcCharacterSyncTargetCurrent("game-a", "game-b"),
  false,
  "a queued sync must abort if the chat was reset onto another campaign",
);
assert.deepEqual(
  sanitizeGameNpcAvatarUrls([npc()], { ignoredNpcIds: ["npc:elara-vale"] }),
  [],
  "a user-removed NPC tombstone must prevent portrait persistence from restoring the row",
);

const sameNameAfterRemoval = sanitizeGameNpcAvatarUrls(
  [npc({ id: "npc:alex", name: "Alex" }), npc({ id: "npc:alex-2", name: "Alex" })],
  { ignoredNpcIds: ["npc:alex"] },
);
assert.deepEqual(
  sameNameAfterRemoval.map((entry) => entry.id),
  ["npc:alex-2"],
  "removing one explicit NPC identity must not suppress another same-named NPC",
);
assert.deepEqual(
  sanitizeGameNpcAvatarUrls([npc({ id: "npc:moonrise", name: "Moonrise", descriptionSource: "narration" })], {
    locationNames: ["City of Moonrise"],
  }),
  [],
  "a durable short-form place alias must not become an NPC card",
);
assert.deepEqual(
  sanitizeGameNpcAvatarUrls(
    [npc({ id: "npc:it-is", name: "It is", characterId: "auto-it-is", descriptionSource: "narration" })],
    { autoCreatedCharacterIds: ["auto-it-is"] },
  ),
  [],
  "a linked automatic card must not preserve a narration fragment in the roster",
);
assert.deepEqual(
  sanitizeGameNpcAvatarUrls(
    [npc({ id: "npc:mirah", name: "Mirah", characterId: "auto-mirah", descriptionSource: "narration" })],
    {
      protectedCharacterNames: ["mirah hai tal", "Mirah hai-Tal"],
      autoCreatedCharacterIds: ["auto-mirah"],
    },
  ),
  [],
  "a provenance-confirmed automatic short alias must not duplicate a protected Character card",
);
assert.deepEqual(
  sanitizeGameNpcAvatarUrls([npc({ id: "npc:robert", name: "Rowan", descriptionSource: "narration" })], {
    protectedCharacterNames: ["Rowan Mercer"],
  }),
  [],
  "a durable short-form player alias must not become an NPC card",
);
assert.deepEqual(
  collectGameNpcCharacterCandidates({
    gameNpcs: [npc({ descriptionSource: "model" })],
    presentCharacters: [],
  }),
  [],
  "planned setup NPCs must remain private until genuinely introduced",
);
assert.equal(
  collectGameNpcCharacterCandidates({
    gameNpcs: [npc({ descriptionSource: "narration" })],
    presentCharacters: [],
  }).length,
  1,
  "a persisted narration-derived NPC must remain eligible if the first sync was missed",
);

assert.deepEqual(
  collectGameNpcCharacterCandidates({ gameNpcs: [], presentCharacters: [present()] }),
  [],
  "tracker-only nearby or implied characters must not create cards",
);

const introduced = collectGameNpcCharacterCandidates({
  gameNpcs: [
    npc({
      description: "This setup dossier contains a private betrayal.",
      descriptionSource: "model",
      observedDescription: "The envoy who introduced herself at the West Gate.",
      observedAppearance: "Silver-streaked black hair.",
    }),
  ],
  presentCharacters: [present()],
  encounteredNames: new Set(["elara vale"]),
  presentSource: { messageId: "message-42", swipeIndex: 2 },
});
assert.equal(introduced.length, 1);
assert.equal(introduced[0]?.npcId, "npc:elara-vale");
assert.equal(introduced[0]?.description, "The envoy who introduced herself at the West Gate.");
assert.match(introduced[0]?.appearance ?? "", /silver-streaked black hair/iu);
assert.doesNotMatch(introduced[0]?.appearance ?? "", /rain-dark green traveling coat/u);
assert.equal(introduced[0]?.sourceMessageId, "message-42");
assert.equal(introduced[0]?.sourceSwipeIndex, 2);
assert.doesNotMatch(introduced[0]?.description ?? "", /private betrayal/u);

const publiclyIntroducedRoster = mergeNarrationNpcObservations(
  [
    npc({
      description: "Secret setup dossier: she serves the usurper.",
      descriptionSource: "model",
      observedDescription: undefined,
    }),
  ],
  [{ name: "Elara Vale", description: "The rain-soaked envoy introduced herself at the gate." }],
);
assert.match(publiclyIntroducedRoster[0]?.description ?? "", /Secret setup dossier/u);
assert.equal(publiclyIntroducedRoster[0]?.observedDescription, "The rain-soaked envoy introduced herself at the gate.");
const publicIntroductionCandidate = collectGameNpcCharacterCandidates({
  gameNpcs: publiclyIntroducedRoster,
  presentCharacters: [],
  encounteredNames: new Set(["elara vale"]),
});
assert.equal(publicIntroductionCandidate[0]?.description, "The rain-soaked envoy introduced herself at the gate.");
assert.doesNotMatch(
  JSON.stringify(
    buildAutoNpcCharacterData({
      candidate: publicIntroductionCandidate[0]!,
      gameId: "game-public-introduction",
      chatId: "chat-public-introduction",
      sessionNumber: 1,
    }),
  ),
  /serves the usurper/u,
);

const aliasedPrivateIntroduction = mergeNarrationNpcObservations(
  [
    npc({
      id: "npc:captain-elara-vale",
      name: "Captain Elara Vale",
      description: "Secret setup dossier: she serves the usurper.",
      descriptionSource: "model",
      observedDescription: undefined,
      location: "The usurper's hidden war room",
      gender: "secret model gender",
      pronouns: "secret/model",
    }),
  ],
  [{ name: "Elara", description: "Elara, the envoy, entered beneath a rain-dark hood." }],
);
assert.equal(aliasedPrivateIntroduction.length, 1, "a unique public short name must attach to its setup identity");
assert.equal(aliasedPrivateIntroduction[0]?.name, "Captain Elara Vale");
assert.match(aliasedPrivateIntroduction[0]?.description ?? "", /Secret setup dossier/u);
assert.equal(aliasedPrivateIntroduction[0]?.observedDescription, "Elara, the envoy, entered beneath a rain-dark hood.");
const aliasedIntroductionCandidate = collectGameNpcCharacterCandidates({
  gameNpcs: aliasedPrivateIntroduction,
  presentCharacters: [],
  encounteredNames: new Set(["elara"]),
});
assert.equal(aliasedIntroductionCandidate.length, 1, "encounter evidence must follow a unique short-name alias");
assert.equal(aliasedIntroductionCandidate[0]?.npcId, "npc:captain-elara-vale");
assert.equal(aliasedIntroductionCandidate[0]?.description, "Elara, the envoy, entered beneath a rain-dark hood.");
assert.equal(aliasedIntroductionCandidate[0]?.location, "", "private setup locations must not enter Character cards");
assert.equal(aliasedIntroductionCandidate[0]?.gender, null, "private setup gender must not enter Character cards");
assert.equal(aliasedIntroductionCandidate[0]?.pronouns, null, "private setup pronouns must not enter Character cards");
assert.doesNotMatch(JSON.stringify(aliasedIntroductionCandidate), /serves the usurper|hidden war room|secret model/u);

assert.equal(findUnambiguousGameNpcNameMatch("Maybelle", ["Lady Maybelle"]), 0);
assert.equal(findUnambiguousGameNpcNameMatch("Elara", ["Captain Elara"]), 0);
assert.equal(
  findUnambiguousGameNpcNameMatch("Halvern Corren", ["Master Founder Halvern Corren"]),
  0,
  "profession titles must not split a short narration name from its existing roster identity",
);
assert.equal(
  findUnambiguousGameNpcNameMatch("Elara", ["Captain Elara Vale", "Elara Stone"]),
  -1,
  "short-name aliases must remain unresolved when two identities could own them",
);
const ambiguousAliasIntroduction = mergeNarrationNpcObservations(
  [
    npc({ id: "npc:elara-vale", name: "Captain Elara Vale", descriptionSource: "model" }),
    npc({ id: "npc:elara-stone", name: "Elara Stone", descriptionSource: "model" }),
  ],
  [{ name: "Elara", description: "Elara enters." }],
);
assert.equal(ambiguousAliasIntroduction.length, 2, "an ambiguous alias must not create a guessed third identity");
assert.ok(
  ambiguousAliasIntroduction.every((entry) => !entry.observedDescription),
  "an ambiguous public observation must not be attached to either private dossier",
);
const titleAliasedIntroduction = mergeNarrationNpcObservations(
  [
    npc({
      id: "npc:lady-maybelle",
      name: "Lady Maybelle",
      description: "Private setup dossier.",
      descriptionSource: "model",
      observedDescription: undefined,
    }),
  ],
  [{ name: "Maybelle", description: "Maybelle enters carrying a basket of eggs." }],
);
assert.equal(titleAliasedIntroduction.length, 1);
assert.equal(titleAliasedIntroduction[0]?.name, "Lady Maybelle");
assert.equal(titleAliasedIntroduction[0]?.observedDescription, "Maybelle enters carrying a basket of eggs.");

const plannedJournalNpc = npc({
  id: "npc:planned",
  name: "Captain Elara Vale",
  characterId: "card-elara",
  description: "Secret setup dossier: she serves the usurper.",
  descriptionSource: "model",
  observedDescription: undefined,
  observedAppearance: undefined,
  location: "The usurper's hidden war room",
  notes: ["Next-session role: Ambush the party after the treaty."],
});
assert.equal(
  shouldShowJournalNpc(plannedJournalNpc, [{ npcName: "Elara", interactions: ["Tracked."] }], [plannedJournalNpc.name]),
  false,
  "a linked setup NPC with only synthetic tracking evidence must remain hidden",
);
assert.equal(
  shouldShowJournalNpc(
    plannedJournalNpc,
    [{ npcName: "Elara", interactions: ["Asked Rowan to shelter from the rain."] }],
    [plannedJournalNpc.name],
  ),
  true,
  "a linked NPC becomes visible after a genuine encounter through its unique alias",
);
assert.equal(getJournalNpcPublicDescription(plannedJournalNpc), "", "the Journal must never show a model dossier");
assert.equal(
  getJournalNpcPublicLocation(plannedJournalNpc),
  "",
  "the Journal must never show a planned model location",
);
const publicJournalNpc = npc({
  description: "The village healer.",
  descriptionSource: "narration",
  location: "West Gate",
});
assert.equal(shouldShowJournalNpc(publicJournalNpc, [], [publicJournalNpc.name]), true);
assert.equal(getJournalNpcPublicDescription(publicJournalNpc), "The village healer.");
assert.equal(getJournalNpcPublicLocation(publicJournalNpc), "West Gate");

const durablePortraitCandidate = collectGameNpcCharacterCandidates({
  gameNpcs: [npc({ avatarUrl: "/api/avatars/npc/chat/elara.png?v=2" })],
  presentCharacters: [present({ avatarPath: "/api/avatars/file/character-game-npc-own.png?v=9" })],
  encounteredNames: new Set(["elara vale"]),
});
assert.equal(
  durablePortraitCandidate[0]?.avatarUrl,
  "/api/avatars/npc/chat/elara.png?v=2",
  "the durable NPC portrait must win over a linked card's projected avatar",
);

const card = buildAutoNpcCharacterData({
  candidate: introduced[0]!,
  gameId: "game-1",
  chatId: "chat-1",
  sessionNumber: 3,
});
assert.equal(card.name, "Elara Vale");
assert.equal(card.description, "The envoy who introduced herself at the West Gate.");
assert.equal(card.personality, "");
assert.equal(card.scenario, "");
assert.equal(card.first_mes, "");
assert.equal(card.mes_example, "");
assert.equal(card.system_prompt, "");
assert.equal(card.post_history_instructions, "");
assert.equal(card.extensions.backstory, "");
assert.match(card.extensions.appearance, /silver-streaked black hair/iu);
assert.doesNotMatch(JSON.stringify(card), /private betrayal/u);

const protectedPlayer = collectGameNpcCharacterCandidates({
  gameNpcs: [npc()],
  presentCharacters: [present()],
  encounteredNames: new Set(["elara vale"]),
  protectedNames: new Set(["elara vale"]),
});
assert.deepEqual(protectedPlayer, [], "player and party identities must not be materialized as NPC cards");

const locationBoundary = gameNpcSanitizationOptionsFromMetadata({
  spatialContext: { locations: [{ name: "Moonrise" }] },
});
assert.equal(isNarrationNpcNameExcluded("Moonrise", locationBoundary.locationNames ?? []), true);
assert.deepEqual(
  collectGameNpcCharacterCandidates({
    gameNpcs: [npc({ id: "npc:moonrise", name: "Moonrise" })],
    presentCharacters: [],
    encounteredNames: new Set(["moonrise"]),
    protectedNames: new Set(["moonrise"]),
  }),
  [],
  "known locations extracted from narration must never reach Character-card sync",
);
assert.equal(
  sanitizeGameNpcAvatarUrls([npc({ name: "Elara Vale", descriptionSource: "narration", characterId: "card-elara" })], {
    protectedCharacterNames: ["Elara Vale"],
  }).length,
  1,
  "a confirmed linked NPC must survive protected-name sanitation after recruitment",
);

const ambiguousSameName = collectGameNpcCharacterCandidates({
  gameNpcs: [npc({ id: "npc:elara-one", name: "Elara" }), npc({ id: "npc:elara-two", name: "Elara" })],
  presentCharacters: [present({ name: "Elara" })],
  encounteredNames: new Set(["elara"]),
});
assert.deepEqual(ambiguousSameName, [], "a name-only observation must not guess between two same-named roster NPCs");

const distinctLinkedNames = collectGameNpcCharacterCandidates({
  gameNpcs: [
    npc({ id: "npc:elara-one", name: "Elara", characterId: "card-one" }),
    npc({ id: "npc:elara-two", name: "Elara", characterId: "card-two" }),
  ],
  presentCharacters: [],
});
assert.deepEqual(
  distinctLinkedNames.map((candidate) => candidate.npcId),
  ["npc:elara-one", "npc:elara-two"],
  "stable NPC ids must keep same-named linked characters distinct",
);

assert.equal(shouldReplaceManagedValue("engine value", "engine value"), true);
assert.equal(shouldReplaceManagedValue("user correction", "engine value"), false);
assert.equal(shouldReplaceManagedValue("", "engine value"), false, "a deliberate clear must stay cleared");
assert.equal(
  shouldCopyNpcAvatar({
    sourceAvatarUrl: "/api/avatars/file/character-game-npc-own.png?v=9",
    currentAvatarPath: "/api/avatars/file/character-game-npc-own.png",
    managedAvatarPath: "/api/avatars/file/character-game-npc-own.png",
    managedSourceAvatarUrl: "/api/avatars/npc/chat/elara.png?v=1",
  }),
  false,
  "a projected card avatar must never be copied back into another character file",
);
assert.equal(
  shouldCopyNpcAvatar({
    sourceAvatarUrl: "/api/avatars/npc/chat/elara.png?v=2",
    currentAvatarPath: "/api/avatars/file/character-game-npc-own.png",
    managedAvatarPath: "/api/avatars/file/character-game-npc-own.png",
    managedSourceAvatarUrl: "/api/avatars/npc/chat/elara.png?v=1",
  }),
  true,
  "a genuinely revised NPC portrait must be copied once",
);

const sanitizedAliases = sanitizeGameNpcAvatarUrls([
  npc({
    id: "npc:elara-short",
    name: "Elara",
    characterId: "card-elara",
    description: "A traveler.",
    descriptionSource: "narration",
    avatarUrl: "/avatars/elara-linked.png",
  }),
  npc({
    id: "npc:elara-full",
    name: "Captain Elara Vale",
    characterId: null,
    description: "Captain of the western watch.",
    descriptionSource: "model",
    avatarUrl: "/avatars/elara-setup.png",
  }),
]);
assert.equal(sanitizedAliases.length, 1);
assert.equal(sanitizedAliases[0]?.name, "Captain Elara Vale");
assert.equal(sanitizedAliases[0]?.id, "npc:elara-short", "a linked alias merge must retain the card's stable NPC id");
assert.equal(sanitizedAliases[0]?.characterId, "card-elara", "NPC alias merging must preserve its linked card");
assert.equal(
  sanitizedAliases[0]?.avatarUrl,
  "/avatars/elara-linked.png",
  "a linked identity's specific portrait must win over an unlinked setup alias avatar",
);

const legacyHalvernRoster = [
  npc({
    id: "setup-halvern",
    name: "Master Founder Halvern Corren",
    characterId: null,
    description: "Master founder of the Corren bell-foundry.",
    descriptionSource: "model",
  }),
  npc({
    id: "npc:halvern-corren",
    name: "Halvern Corren",
    characterId: "card-halvern",
    description: "Halvern Corren appears in the current scene.",
    descriptionSource: "narration",
  }),
];
const sanitizedHalvernRoster = sanitizeGameNpcAvatarUrls(legacyHalvernRoster);
assert.equal(sanitizedHalvernRoster.length, 1, "a linked title alias must collapse to one persisted NPC row");
assert.equal(sanitizedHalvernRoster[0]?.id, "npc:halvern-corren");
assert.equal(sanitizedHalvernRoster[0]?.name, "Master Founder Halvern Corren");
assert.deepEqual(
  [...changedGameNpcRosterIds(legacyHalvernRoster, sanitizedHalvernRoster)].sort(),
  ["npc:halvern-corren", "setup-halvern"],
  "sanitizer-only alias cleanup must mark both the removed setup row and changed linked row for persistence rollback",
);

const contradictoryCorrenProctors = sanitizeGameNpcAvatarUrls([
  npc({ id: "setup-ilsabet", name: "Proctor Ilsabet Corren", descriptionSource: "model" }),
  npc({ id: "npc:proctor-hanne-corren", name: "Proctor Hanne Corren", descriptionSource: "narration" }),
]);
assert.equal(
  contradictoryCorrenProctors.length,
  2,
  "different given names must remain distinct even when narration contradicts setup continuity",
);

const libraryRecordWinsPrivateDuplicate = sanitizeGameNpcAvatarUrls([
  npc({
    id: "npc:library-elara",
    name: "Elara Vale",
    characterId: "card-elara",
    description: "The publicly documented royal envoy.",
    descriptionSource: "library",
    location: "West Gate",
  }),
  npc({
    id: "npc:library-elara",
    name: "Elara Vale",
    description: "Secret model dossier: she serves the usurper.",
    descriptionSource: "model",
    location: "The usurper's hidden war room",
    gender: "secret model gender",
    pronouns: "secret/model",
    notes: ["Secretly reports to the usurper."],
  }),
]);
assert.equal(libraryRecordWinsPrivateDuplicate.length, 1);
assert.equal(libraryRecordWinsPrivateDuplicate[0]?.descriptionSource, "library");
assert.equal(libraryRecordWinsPrivateDuplicate[0]?.description, "The publicly documented royal envoy.");
assert.equal(libraryRecordWinsPrivateDuplicate[0]?.location, "West Gate");
assert.doesNotMatch(
  JSON.stringify(libraryRecordWinsPrivateDuplicate),
  /serves the usurper|hidden war room|secret model|secretly reports/u,
);

const distinctLinkedAliases = sanitizeGameNpcAvatarUrls([
  npc({ id: "npc:elara-short", name: "Elara", characterId: "card-short" }),
  npc({ id: "npc:elara-full", name: "Captain Elara Vale", characterId: "card-full" }),
]);
assert.equal(distinctLinkedAliases.length, 2, "different linked cards must never be folded as name aliases");

const sameNamedLinkedAfterSanitize = sanitizeGameNpcAvatarUrls([
  npc({ id: "npc:same-name-one", name: "Alex", characterId: "card-one" }),
  npc({ id: "npc:same-name-two", name: "Alex", characterId: "card-two" }),
]);
assert.equal(sameNamedLinkedAfterSanitize.length, 2, "sanitization must not merge distinct same-named NPC ids");
assert.deepEqual(
  sameNamedLinkedAfterSanitize.map((entry) => entry.characterId),
  ["card-one", "card-two"],
);

const storageRoot = mkdtempSync(join(tmpdir(), "marinara-game-npc-character-"));
const previousStorageRoot = process.env.FILE_STORAGE_DIR;
process.env.FILE_STORAGE_DIR = storageRoot;
const db = await createFileNativeDB();
try {
  const stableCandidates = [
    {
      ...introduced[0]!,
      npcId: "npc:alex-one",
      name: "Alex",
      description: "The royal archivist.",
      appearance: "Round spectacles and a blue waistcoat.",
      avatarUrl: null,
    },
    {
      ...introduced[0]!,
      npcId: "npc:alex-two",
      name: "Alex",
      description: "The harbor pilot.",
      appearance: "A red scarf and a weathered cap.",
      avatarUrl: null,
    },
  ];
  const syncInput = {
    db,
    gameId: "game-idempotency",
    chatId: "chat-idempotency",
    sessionNumber: 1,
    campaignName: "Regression Campaign",
    candidates: stableCandidates,
  };
  const firstSync = await syncGameNpcCharacters(syncInput);
  assert.equal(firstSync.created.length, 2, "stable ids must create two same-named NPC cards");
  assert.equal(new Set(firstSync.created.map((entry) => entry.characterId)).size, 2);

  const secondSync = await syncGameNpcCharacters({
    ...syncInput,
    candidates: stableCandidates.map((candidate) => ({
      ...candidate,
      sourceMessageId: "later-message",
      sourceSwipeIndex: 7,
    })),
  });
  assert.equal(secondSync.created.length, 0, "an identical retry must not duplicate cards");
  assert.equal(secondSync.updated.length, 0, "new scene evidence alone must not rewrite or reorder existing cards");
  assert.deepEqual(
    new Set(secondSync.links.map((entry) => entry.characterId)),
    new Set(firstSync.links.map((entry) => entry.characterId)),
  );

  const store = createCharactersStorage(db);
  const invalidCandidate = {
    ...introduced[0]!,
    npcId: "npc:it-is",
    name: "It is",
    description: "None of it is the state apartments.",
    appearance: "",
    avatarUrl: null,
  };
  const invalidCard = await store.create(
    buildAutoNpcCharacterData({
      candidate: invalidCandidate,
      gameId: "game-invalid-cleanup",
      chatId: "chat-invalid-cleanup",
      sessionNumber: 1,
    }),
    undefined,
    undefined,
    "Auto-created Game NPC · Regression Campaign",
  );
  assert.ok(invalidCard);
  const invalidCleanup = await syncGameNpcCharacters({
    db,
    gameId: "game-invalid-cleanup",
    chatId: "chat-invalid-cleanup",
    sessionNumber: 1,
    campaignName: "Regression Campaign",
    candidates: [],
    rejectedNpcIds: ["npc:it-is"],
  });
  assert.deepEqual(invalidCleanup.retracted, [
    {
      characterId: invalidCard!.id,
      npcId: "npc:it-is",
      name: "It is",
      cardRemoved: true,
    },
  ]);
  assert.equal(await store.getById(invalidCard!.id), null, "an untouched invalid automatic card must be deleted");
  const avatarRetryCardId = firstSync.links.find((entry) => entry.npcId === "npc:alex-two")!.characterId;
  const avatarRetryCandidate = {
    ...stableCandidates[1]!,
    characterId: avatarRetryCardId,
    avatarUrl: "/api/avatars/npc/chat-idempotency/alex-two.png?v=2",
  };
  const rejectedAvatarCopy = await syncGameNpcCharacters({
    ...syncInput,
    candidates: [avatarRetryCandidate],
    copyAvatarToCharacterStorage: async () => {
      throw Object.assign(new Error("portrait file is temporarily busy"), { code: "EPERM" });
    },
  });
  assert.equal(rejectedAvatarCopy.links[0]?.characterId, avatarRetryCardId);
  assert.deepEqual(rejectedAvatarCopy.portraitCopiesPending, [{ npcId: "npc:alex-two", name: "Alex" }]);
  assert.equal(
    rejectedAvatarCopy.updated.length,
    0,
    "a failed optional portrait copy must not reject or rewrite the card",
  );
  assert.equal(
    (await store.getById(avatarRetryCardId))!.avatarPath,
    null,
    "a failed portrait refresh must preserve the existing card avatar",
  );

  const unavailableAvatarCopy = await syncGameNpcCharacters({
    ...syncInput,
    candidates: [avatarRetryCandidate],
    copyAvatarToCharacterStorage: async () => null,
  });
  assert.deepEqual(
    unavailableAvatarCopy.portraitCopiesPending,
    [{ npcId: "npc:alex-two", name: "Alex" }],
    "an unreadable portrait source must remain pending for the bounded automatic retry",
  );
  assert.equal((await store.getById(avatarRetryCardId))!.avatarPath, null);

  const retriedAvatarPath = "/api/avatars/file/test-game-npc-avatar.png";
  const successfulAvatarRetry = await syncGameNpcCharacters({
    ...syncInput,
    candidates: [avatarRetryCandidate],
    copyAvatarToCharacterStorage: async () => retriedAvatarPath,
  });
  assert.equal(successfulAvatarRetry.links[0]?.characterId, avatarRetryCardId);
  assert.deepEqual(successfulAvatarRetry.portraitCopiesPending, []);
  assert.deepEqual(
    successfulAvatarRetry.updated.map((entry) => entry.characterId),
    [avatarRetryCardId],
    "a later successful portrait copy must update the same linked card",
  );
  assert.equal((await store.getById(avatarRetryCardId))!.avatarPath, retriedAvatarPath);

  const casFixture = await store.create({
    ...card,
    name: "CAS Fixture",
    description: "Initial managed description.",
  });
  assert.ok(casFixture);
  const staleRevision = characterStorageRevision(casFixture!);
  await store.update(casFixture!.id, { description: "A user edit made while auto-sync was preparing." }, undefined, {
    updatedAt: casFixture!.updatedAt,
  });
  const versionsAfterUserEdit = await store.listVersions(casFixture!.id);
  const rejectedAutoWrite = await store.update(
    casFixture!.id,
    { description: "Stale automatic description." },
    undefined,
    {
      expectedRevision: staleRevision,
      versionSource: "game-npc-sync",
      versionReason: "Observed Game NPC details updated",
    },
  );
  assert.equal(rejectedAutoWrite, null, "an atomic CAS must reject a stale automatic Character-card write");
  assert.equal(
    JSON.parse((await store.getById(casFixture!.id))!.data).description,
    "A user edit made while auto-sync was preparing.",
    "a same-timestamp user edit must win over the stale automatic update",
  );
  assert.equal(
    (await store.listVersions(casFixture!.id)).length,
    versionsAfterUserEdit.length,
    "a rejected CAS must not create a misleading version snapshot",
  );
  const currentCasRow = await store.getById(casFixture!.id);
  const acceptedAutoWrite = await store.update(
    casFixture!.id,
    { scenario: "A newly observed public setting." },
    undefined,
    {
      expectedRevision: characterStorageRevision(currentCasRow!),
      versionSource: "game-npc-sync",
      versionReason: "Observed Game NPC details updated",
    },
  );
  assert.ok(acceptedAutoWrite, "a current CAS must still update the Character card");
  assert.equal(
    (await store.listVersions(casFixture!.id)).length,
    versionsAfterUserEdit.length + 1,
    "a successful CAS must preserve the normal Character version history",
  );
  await store.remove(casFixture!.id);

  assert.equal((await store.list()).length, 2);
  const firstCardId = firstSync.links.find((entry) => entry.npcId === "npc:alex-one")!.characterId;
  const secondCardId = firstSync.links.find((entry) => entry.npcId === "npc:alex-two")!.characterId;
  const preservedOrigin = JSON.parse((await store.getById(firstCardId))!.data).extensions.marinara.gameNpc;
  assert.equal(preservedOrigin.sourceMessageId, "message-42", "provenance must keep the first confirmed introduction");
  assert.equal(preservedOrigin.sourceSwipeIndex, 2);
  await store.update(firstCardId, {
    name: "Alex Rowan",
    description: "User-corrected description.",
    tags: ["Game NPC"],
    extensions: { appearance: "" },
  });

  const refreshed = stableCandidates.map((candidate) => {
    const characterId = firstSync.links.find((entry) => entry.npcId === candidate.npcId)!.characterId;
    return {
      ...candidate,
      characterId,
      description: `${candidate.description} Newly observed detail.`,
      appearance: `${candidate.appearance} Newly observed detail.`,
    };
  });
  const refreshSync = await syncGameNpcCharacters({ ...syncInput, candidates: refreshed });
  assert.deepEqual(
    refreshSync.updated.map((entry) => entry.characterId),
    [secondCardId],
    "only untouched engine-managed fields should refresh",
  );

  const manuallyEdited = await store.getById(firstCardId);
  const manuallyEditedData = JSON.parse(manuallyEdited!.data);
  assert.equal(manuallyEditedData.name, "Alex Rowan");
  assert.equal(manuallyEditedData.description, "User-corrected description.");
  assert.equal(manuallyEditedData.extensions.appearance, "", "a user-cleared appearance must remain empty");

  const automaticallyRefreshed = await store.getById(secondCardId);
  const automaticallyRefreshedData = JSON.parse(automaticallyRefreshed!.data);
  assert.match(automaticallyRefreshedData.description, /Newly observed detail/u);
  assert.match(automaticallyRefreshedData.extensions.appearance, /Newly observed detail/u);
  assert.equal((await store.list()).length, 2);

  await store.update(firstCardId, { creator: "User", tags: [] });
  const relinkEditedCard = await syncGameNpcCharacters({
    ...syncInput,
    candidates: [stableCandidates[0]!],
  });
  assert.equal(
    relinkEditedCard.created.length,
    0,
    "edited creator/tags must not make a stale roster link duplicate a card",
  );
  assert.equal(relinkEditedCard.updated.length, 0, "an edited auto-created card must remain outside managed updates");
  assert.equal(relinkEditedCard.links[0]?.characterId, firstCardId);
  assert.equal((await store.list()).length, 2);

  const aliasFirstSync = await syncGameNpcCharacters({
    ...syncInput,
    gameId: "game-alias-identity",
    candidates: [
      {
        ...introduced[0]!,
        npcId: "npc:elara-short",
        name: "Elara",
        avatarUrl: null,
      },
    ],
  });
  assert.equal(aliasFirstSync.created.length, 1);
  const aliasCharacterId = aliasFirstSync.created[0]!.characterId;
  const mergedAliasRoster = sanitizeGameNpcAvatarUrls([
    npc({
      id: "npc:elara-short",
      name: "Elara",
      characterId: aliasCharacterId,
      description: "A traveler.",
      descriptionSource: "narration",
    }),
    npc({
      id: "npc:elara-full",
      name: "Captain Elara Vale",
      characterId: null,
      description: "Captain of the western watch.",
      descriptionSource: "model",
    }),
  ]);
  assert.equal(mergedAliasRoster[0]?.id, "npc:elara-short");
  const aliasSecondSync = await syncGameNpcCharacters({
    ...syncInput,
    gameId: "game-alias-identity",
    candidates: collectGameNpcCharacterCandidates({
      gameNpcs: mergedAliasRoster,
      presentCharacters: [],
    }),
  });
  assert.equal(aliasSecondSync.created.length, 0, "a fuller alias must not duplicate its existing Character card");
  assert.equal(aliasSecondSync.links[0]?.characterId, aliasCharacterId);
  assert.equal((await store.list()).length, 3);

  const ordinaryExtensions = { ...card.extensions } as Record<string, unknown>;
  delete ordinaryExtensions.marinara;
  const ordinary = await store.create({
    ...card,
    name: "Existing Librarian",
    description: "A user-authored library card.",
    creator: "User",
    tags: [],
    extensions: ordinaryExtensions as unknown as typeof card.extensions,
  });
  const ordinaryLink = await syncGameNpcCharacters({
    ...syncInput,
    candidates: [
      {
        ...stableCandidates[0]!,
        npcId: "npc:existing-librarian",
        characterId: ordinary!.id,
        name: "Existing Librarian",
        description: "Conflicting observed text must not rewrite the user card.",
      },
    ],
  });
  assert.equal(ordinaryLink.created.length, 0, "a direct ordinary/recruited card link must not create a duplicate");
  assert.equal(ordinaryLink.links[0]?.characterId, ordinary!.id);
  assert.equal(JSON.parse((await store.getById(ordinary!.id))!.data).description, "A user-authored library card.");
  assert.equal((await store.list()).length, 4);

  const ordinaryNameConflict = await syncGameNpcCharacters({
    ...syncInput,
    candidates: [
      {
        ...stableCandidates[0]!,
        npcId: "npc:unlinked-existing-librarian",
        characterId: null,
        name: "Existing Librarian",
      },
    ],
  });
  assert.equal(ordinaryNameConflict.created.length, 0, "an ordinary same-name card must suppress duplicate creation");
  assert.equal(ordinaryNameConflict.links.length, 0, "the sync must not guess-link an ordinary same-name card");
  assert.equal((await store.list()).length, 4);

  await store.remove(secondCardId);
  const deletedCardSync = await syncGameNpcCharacters({
    ...syncInput,
    candidates: [{ ...stableCandidates[1]!, characterId: secondCardId }],
  });
  assert.equal(deletedCardSync.created.length, 0, "a deleted linked Character card must stay deleted");
  assert.equal(deletedCardSync.links.length, 0);
} finally {
  await db._fileStore.close();
  if (previousStorageRoot === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousStorageRoot;
  rmSync(storageRoot, { recursive: true, force: true });
}

console.log("Game NPC character creation regression passed.");
