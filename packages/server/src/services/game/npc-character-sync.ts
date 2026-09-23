import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  buildStableGameNpcId,
  findUnambiguousGameNpcNameMatch,
  gameNpcNamesCouldBeAliases,
  isGameNpcRelationalLabel,
  isPlausibleNarrationNpcName,
  normalizeGameNpcIdentityName,
  PRIVATE_NOTEBOOK_SETTINGS_PREFIX,
  type CharacterData,
  type GameNpc,
  type PresentCharacter,
} from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { eq } from "../../db/file-query.js";
import {
  appSettings,
  assets,
  characterGroups,
  characterImages,
  chats,
  conversationCallMessages,
  conversationCallSessions,
  lorebookCharacterLinks,
  lorebooks,
  noodleAccounts,
} from "../../db/schema/index.js";
import { logger } from "../../lib/logger.js";
import { DATA_DIR } from "../../utils/data-dir.js";
import { newId } from "../../utils/id-generator.js";
import { assertInsideDir, isAllowedImageBuffer } from "../../utils/security.js";
import { readAvatarBase64 } from "./game-asset-generation.js";
import { normalizeCharacterLookupName } from "./name-normalization.js";
import {
  collectCharacterAvatarPaths,
  mutateAvatarReferencesAndCleanup,
  removeUnattachedAvatarFile,
} from "../image/avatar-file-lifecycle.js";
import { characterStorageRevision, createCharactersStorage } from "../storage/characters.storage.js";
import type { NpcProfile } from "./npc-profile.js";

const AUTO_NPC_CREATOR = "Marinara Game Mode";
const AUTO_NPC_TAG = "Game NPC";
const AUTO_NPC_GENERATED_TAG = "Auto-created";
const AUTO_NPC_PROVENANCE_VERSION = 1;
const AUTO_NPC_CREATOR_NOTES =
  "Automatically created from a named NPC introduced in Game Mode. Only observed or explicitly established details are copied; this card is not automatically added to the party.";
const gameNpcCharacterSyncQueues = new Map<string, Promise<void>>();
const GENERIC_NPC_NAMES = new Set([
  "boy",
  "child",
  "crowd",
  "figure",
  "girl",
  "guard",
  "guards",
  "innkeeper",
  "man",
  "merchant",
  "narrator",
  "someone",
  "stranger",
  "traveler",
  "traveller",
  "voice",
  "woman",
]);
const GENERIC_COMBAT_NPC_PATTERNS = [
  /^(?:enemy|foe|monster|creature|beast|minion|summon|shadow|construct|automaton|drone|specter|slime)(?:\s+(?:\d+|[ivx]+))?$/iu,
  /^(?:(?:[\p{L}'’-]+)\s+)?(?:guard|soldier|bandit|thug|raider|cultist|mercenary|assassin|archer|mage|warrior)(?:\s+(?:\d+|[ivx]+))?$/iu,
  /^(?:goblin|orc|kobold|skeleton|zombie|wolf|spider|hilichurl|mitachurl|samachurl)(?:\s+(?:\d+|[ivx]+))?$/iu,
];

export interface GameNpcCharacterCandidate {
  /** Set only by the server's evidence-checked AI identity admission stage. */
  identityVerified?: boolean;
  /** Generated profile stays separate from observed facts used by the tracker. */
  profile?: NpcProfile;
  npcId: string;
  /** Durable card link from the roster NPC (npc.characterId). */
  characterId?: string | null;
  /**
   * Free-form tracker id ("ID or name"). Only a lookup hint: it may be a roster
   * id or a name, so a miss must not be treated as a deleted card link.
   */
  presentCharacterId?: string | null;
  name: string;
  description: string;
  descriptionSource?: GameNpc["descriptionSource"];
  appearance: string;
  avatarUrl?: string | null;
  location: string;
  gender?: string | null;
  pronouns?: string | null;
  emoji?: string;
  evidenceKind: "present" | "narration" | "roster" | "journal" | "linked";
  sourceMessageId?: string | null;
  sourceSwipeIndex?: number | null;
}

interface AutoNpcManagedFields {
  personality?: string;
  backstory?: string;
  name: string;
  description: string;
  appearance: string;
  avatarPath: string | null;
  sourceAvatarUrl: string | null;
}

interface AutoNpcProvenance {
  identityVerified?: boolean;
  profileSourceKey?: string;
  profileSourceMessageId?: string;
  creativeAdditions?: string;
  schemaVersion: number;
  autoCreated: true;
  gameId: string;
  sourceChatId: string;
  sourceSessionNumber: number | null;
  npcId: string;
  normalizedName: string;
  evidenceKind: GameNpcCharacterCandidate["evidenceKind"];
  sourceMessageId: string | null;
  sourceSwipeIndex: number | null;
  managed: AutoNpcManagedFields;
}

export interface AutoNpcCharacterSyncResult {
  created: Array<{ characterId: string; npcId: string; name: string }>;
  updated: Array<{ characterId: string; npcId: string; name: string }>;
  links: Array<{ characterId: string; npcId: string; name: string }>;
  retracted: Array<{ characterId: string; npcId: string; name: string; cardRemoved: boolean }>;
  portraitCopiesPending: Array<{ npcId: string; name: string }>;
}

export interface AutoNpcCanonicalSource {
  messageId: string;
  swipeIndex: number;
  /** NPC identities supported by the selected swipe or independent durable evidence. */
  supportedNpcIds: readonly string[];
}

/** Three-way rollback of only roster identities written by a sync result that later proved stale. */
export function rollbackStaleGameNpcRoster(input: {
  currentNpcs: readonly GameNpc[];
  previousNpcs: readonly GameNpc[];
  persistedNpcs: readonly GameNpc[];
  touchedNpcIds: ReadonlySet<string>;
  ignoredNpcIds?: ReadonlySet<string>;
}): GameNpc[] {
  if (input.touchedNpcIds.size === 0) return input.currentNpcs as GameNpc[];

  const nextNpcs = [...input.currentNpcs];
  let changed = false;
  for (const npcId of input.touchedNpcIds) {
    const previousNpc = input.previousNpcs.find((npc) => npc.id === npcId);
    const persistedNpc = input.persistedNpcs.find((npc) => npc.id === npcId);
    const currentIndex = nextNpcs.findIndex((npc) => npc.id === npcId);
    const currentNpc = currentIndex >= 0 ? nextNpcs[currentIndex] : undefined;
    if (input.ignoredNpcIds?.has(npcId)) continue;

    if (!persistedNpc) {
      if (!currentNpc && previousNpc) {
        const previousIndex = input.previousNpcs.findIndex((npc) => npc.id === npcId);
        nextNpcs.splice(Math.min(previousIndex, nextNpcs.length), 0, previousNpc);
        changed = true;
      }
      continue;
    }

    // A concurrent edit owns the current row. Roll back only the exact stale
    // value that this sync persisted, never a subsequently changed value.
    if (!currentNpc || !isDeepStrictEqual(currentNpc, persistedNpc)) continue;
    if (!previousNpc) {
      nextNpcs.splice(currentIndex, 1);
    } else {
      nextNpcs[currentIndex] = previousNpc;
    }
    changed = true;
  }
  return changed ? nextNpcs : (input.currentNpcs as GameNpc[]);
}

/** Identify the exact roster identities changed by a sanitize/merge pass. */
export function changedGameNpcRosterIds(previousNpcs: readonly GameNpc[], nextNpcs: readonly GameNpc[]): Set<string> {
  const changedNpcIds = new Set<string>();
  const allNpcIds = new Set([...previousNpcs.map((npc) => npc.id), ...nextNpcs.map((npc) => npc.id)]);
  for (const npcId of allNpcIds) {
    const previousRows = previousNpcs.filter((npc) => npc.id === npcId);
    const nextRows = nextNpcs.filter((npc) => npc.id === npcId);
    if (!isDeepStrictEqual(previousRows, nextRows)) changedNpcIds.add(npcId);
  }
  return changedNpcIds;
}

export function isGameNpcCharacterSyncTargetCurrent(expectedGameId: string, currentGameId: unknown): boolean {
  return typeof currentGameId === "string" && currentGameId.trim() === expectedGameId;
}

/** Resolve scene evidence for the selected narration without falling back to another swipe's snapshot. */
export async function resolveGameNpcSyncState<T>(input: {
  storage: {
    getLatest(chatId: string): Promise<T | null>;
    getByChatAndMessage(chatId: string, messageId: string, swipeIndex: number): Promise<T | null>;
  };
  chatId: string;
  source?: { messageId: string; swipeIndex: number } | null;
}): Promise<T | null> {
  return input.source
    ? input.storage.getByChatAndMessage(input.chatId, input.source.messageId, input.source.swipeIndex)
    : input.storage.getLatest(input.chatId);
}

/** Serialize duplicate-prone library creation for one campaign within this process. */
export async function withGameNpcCharacterSyncLock<T>(gameId: string, operation: () => Promise<T>): Promise<T> {
  const key = gameId.trim();
  const previous = gameNpcCharacterSyncQueues.get(key) ?? Promise.resolve();
  const queued = previous.catch(() => undefined).then(operation);
  const settled = queued.then(
    () => undefined,
    () => undefined,
  );
  gameNpcCharacterSyncQueues.set(key, settled);
  try {
    return await queued;
  } finally {
    if (gameNpcCharacterSyncQueues.get(key) === settled) gameNpcCharacterSyncQueues.delete(key);
  }
}

type CharacterStore = ReturnType<typeof createCharactersStorage>;
type CharacterRow = Awaited<ReturnType<CharacterStore["getById"]>>;

function cleanText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, maxLength) : "";
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function optionalString(value: unknown): string | null {
  const cleaned = cleanText(value, 500);
  return cleaned || null;
}

export function isEligibleGameNpcCharacterName(value: unknown): value is string {
  const name = cleanText(value, 120);
  if (!name || name.length < 2 || /[<>{}\[\]"“”]/u.test(name)) return false;
  if (isGameNpcRelationalLabel(name)) return false;
  const normalized = normalizeCharacterLookupName(name);
  if (!normalized || GENERIC_NPC_NAMES.has(normalized)) return false;
  if (GENERIC_COMBAT_NPC_PATTERNS.some((pattern) => pattern.test(name))) return false;
  return /[\p{L}\p{N}]/u.test(name);
}

export interface GameNpcNarrationObservation {
  name: string;
  description: string;
}

/**
 * Attach public introduction text to an existing setup NPC without exposing or
 * replacing its private model-authored dossier. New narration-only NPCs become
 * ordinary roster candidates; ambiguous same-name rows are left untouched.
 */
export function mergeNarrationNpcObservations(
  gameNpcs: readonly GameNpc[],
  observations: readonly GameNpcNarrationObservation[],
): GameNpc[] {
  const merged = gameNpcs.map((npc) => ({ ...npc }));
  for (const observation of observations) {
    const name = cleanText(observation.name, 120);
    const description = cleanText(observation.description, 4_000);
    if (!isEligibleGameNpcCharacterName(name) || !isPlausibleNarrationNpcName(name)) continue;
    const normalizedName = normalizeCharacterLookupName(name);
    const exactMatchingIndexes = merged
      .map((npc, index) => (normalizeCharacterLookupName(npc.name) === normalizedName ? index : -1))
      .filter((index) => index >= 0);
    const matchedIndex =
      exactMatchingIndexes.length === 1
        ? exactMatchingIndexes[0]!
        : exactMatchingIndexes.length === 0
          ? findUnambiguousGameNpcNameMatch(
              name,
              merged.map((npc) => npc.name),
            )
          : -1;

    if (matchedIndex >= 0) {
      const existing = merged[matchedIndex]!;
      if (description && !cleanText(existing.observedDescription, 4_000)) {
        // Keep the durable setup/library/user description untouched. The
        // sentence that actually introduced this alias is separately safe to
        // present and use for automatic Character-card creation.
        merged[matchedIndex] = { ...existing, observedDescription: description };
      }
      continue;
    }
    if (exactMatchingIndexes.length > 1 || merged.some((npc) => gameNpcNamesCouldBeAliases(name, npc.name))) {
      continue;
    }

    merged.push({
      id: buildStableGameNpcId(name),
      name,
      emoji: "👤",
      description,
      descriptionSource: "narration",
      location: "",
      reputation: 0,
      notes: [],
      avatarUrl: null,
    });
  }
  return merged;
}

function npcNameHasEncounterEvidence(
  name: string,
  encounteredNames: ReadonlySet<string>,
  rosterNames: readonly string[],
): boolean {
  const normalizedName = normalizeGameNpcIdentityName(name);
  if (!normalizedName) return false;
  if ([...encounteredNames].some((encountered) => normalizeGameNpcIdentityName(encountered) === normalizedName)) {
    return true;
  }

  for (const encounteredName of encounteredNames) {
    const matchIndex = findUnambiguousGameNpcNameMatch(encounteredName, rosterNames);
    if (matchIndex >= 0 && normalizeGameNpcIdentityName(rosterNames[matchIndex]) === normalizedName) {
      return true;
    }
  }
  return false;
}

function preferText(primary: unknown, fallback: unknown, maxLength: number): string {
  return cleanText(primary, maxLength) || cleanText(fallback, maxLength);
}

/**
 * Build confirmed NPC candidates from the durable NPC roster and the Character
 * Tracker's current scene. Planned setup NPCs are deliberately ignored until
 * they actually appear, so creating a card cannot reveal an unreached name.
 */
export function collectGameNpcCharacterCandidates(input: {
  gameNpcs: readonly GameNpc[];
  presentCharacters: readonly PresentCharacter[];
  protectedCharacterIds?: ReadonlySet<string>;
  protectedNames?: ReadonlySet<string>;
  encounteredNames?: ReadonlySet<string>;
  presentSource?: { messageId?: string | null; swipeIndex?: number | null };
}): GameNpcCharacterCandidate[] {
  const protectedCharacterIds = input.protectedCharacterIds ?? new Set<string>();
  const protectedNames = input.protectedNames ?? new Set<string>();
  const encounteredNames = input.encounteredNames ?? new Set<string>();
  const rosterNames = input.gameNpcs.map((npc) => npc.name);
  const rosterByName = new Map<string, GameNpc[]>();
  for (const npc of input.gameNpcs) {
    if (!isEligibleGameNpcCharacterName(npc.name)) continue;
    const normalized = normalizeCharacterLookupName(npc.name);
    if (normalized) rosterByName.set(normalized, [...(rosterByName.get(normalized) ?? []), npc]);
  }

  const candidates = new Map<string, GameNpcCharacterCandidate>();
  const addCandidate = (
    npc: GameNpc,
    evidenceKind: GameNpcCharacterCandidate["evidenceKind"],
    present?: PresentCharacter,
  ) => {
    const name = cleanText(npc.name || present?.name, 120);
    if (!isEligibleGameNpcCharacterName(name)) return;
    if (npc.descriptionSource === "narration" && !isPlausibleNarrationNpcName(name)) return;
    const normalizedName = normalizeCharacterLookupName(name);
    const linkedCharacterId = optionalString(npc.characterId);
    if (!normalizedName || (protectedNames.has(normalizedName) && !linkedCharacterId)) return;
    if (present?.characterId && protectedCharacterIds.has(present.characterId)) return;

    const rosterDescriptionIsObserved =
      npc.descriptionSource === "user" || npc.descriptionSource === "narration" || npc.descriptionSource === "library";
    const canonicalDescription = preferText(
      npc.observedDescription,
      rosterDescriptionIsObserved ? npc.description : "",
      4_000,
    );
    const observedAppearance = preferText(npc.observedAppearance, present?.appearance, 3_500);
    const appearance = observedAppearance;
    const description = canonicalDescription || (appearance ? `Observed appearance: ${appearance}` : "");
    const presentIdentity = present as
      | (PresentCharacter & { gender?: string | null; pronouns?: string | null })
      | undefined;
    const npcId = cleanText(npc.id, 200) || buildStableGameNpcId(name);
    candidates.set(npcId, {
      npcId,
      characterId: linkedCharacterId,
      presentCharacterId: linkedCharacterId ? null : optionalString(present?.characterId),
      name,
      description,
      descriptionSource: npc.descriptionSource,
      appearance,
      avatarUrl: optionalString(npc.avatarUrl) ?? optionalString(present?.avatarPath),
      location: rosterDescriptionIsObserved ? preferText(npc.location, "", 500) : "",
      gender: rosterDescriptionIsObserved ? optionalString(npc.gender) : optionalString(presentIdentity?.gender),
      pronouns: rosterDescriptionIsObserved ? optionalString(npc.pronouns) : optionalString(presentIdentity?.pronouns),
      emoji: cleanText(npc.emoji, 20) || "👤",
      evidenceKind,
      sourceMessageId:
        evidenceKind === "present" || evidenceKind === "narration"
          ? optionalString(input.presentSource?.messageId)
          : null,
      sourceSwipeIndex:
        (evidenceKind === "present" || evidenceKind === "narration") &&
        typeof input.presentSource?.swipeIndex === "number" &&
        Number.isSafeInteger(input.presentSource.swipeIndex)
          ? input.presentSource.swipeIndex
          : null,
    });
  };

  for (const present of input.presentCharacters) {
    if (!isEligibleGameNpcCharacterName(present.name) || !isPlausibleNarrationNpcName(present.name)) continue;
    if (present.characterId && protectedCharacterIds.has(present.characterId)) continue;
    const normalizedName = normalizeCharacterLookupName(present.name);
    if (!normalizedName || protectedNames.has(normalizedName)) continue;
    const matchingRoster = rosterByName.get(normalizedName) ?? [];
    const aliasMatchIndex =
      matchingRoster.length === 0 ? findUnambiguousGameNpcNameMatch(present.name, rosterNames) : -1;
    const identityRosterNpc = present.characterId
      ? input.gameNpcs.find(
          (npc) => npc.id === present.characterId || optionalString(npc.characterId) === present.characterId,
        )
      : null;
    const rosterNpc =
      identityRosterNpc ??
      matchingRoster.find(
        (npc) =>
          npc.id === present.characterId ||
          (typeof npc.characterId === "string" && npc.characterId === present.characterId),
      ) ??
      (matchingRoster.length === 1
        ? matchingRoster[0]
        : aliasMatchIndex >= 0
          ? input.gameNpcs[aliasMatchIndex]!
          : null);
    // A name alone cannot tell two same-named people apart. Wait for a stable
    // tracker/library identity instead of creating or linking the wrong card.
    if (!rosterNpc && matchingRoster.length > 1) continue;
    const rosterIsExplicitlyUserAuthored = rosterNpc?.descriptionSource === "user";
    const alreadyLinked = typeof rosterNpc?.characterId === "string" && rosterNpc.characterId.trim().length > 0;
    const wasEncountered = npcNameHasEncounterEvidence(rosterNpc?.name ?? present.name, encounteredNames, rosterNames);
    if (!wasEncountered && !rosterIsExplicitlyUserAuthored && !alreadyLinked) continue;
    addCandidate(
      rosterNpc ?? {
        id: buildStableGameNpcId(present.name),
        name: present.name,
        emoji: present.emoji || "👤",
        description: present.appearance ?? "",
        descriptionSource: present.appearance ? "model" : undefined,
        location: "",
        reputation: 0,
        notes: [],
        avatarUrl: present.avatarPath ?? null,
      },
      "present",
      present,
    );
  }

  for (const npc of input.gameNpcs) {
    if (!isEligibleGameNpcCharacterName(npc.name)) continue;
    if (npc.descriptionSource === "narration" && !isPlausibleNarrationNpcName(npc.name)) continue;
    const normalizedName = normalizeCharacterLookupName(npc.name);
    const candidateNpcId = cleanText(npc.id, 200) || buildStableGameNpcId(npc.name);
    if (candidates.has(candidateNpcId)) continue;
    const alreadyLinked = typeof npc.characterId === "string" && npc.characterId.trim().length > 0;
    const sameNameRoster = rosterByName.get(normalizedName) ?? [];
    const wasEncountered = npcNameHasEncounterEvidence(npc.name, encounteredNames, rosterNames);
    const explicitlyIntroduced =
      npc.descriptionSource === "user" || npc.descriptionSource === "narration" || wasEncountered;
    if (sameNameRoster.length > 1 && !alreadyLinked && npc.descriptionSource !== "user") {
      continue;
    }
    if (alreadyLinked || explicitlyIntroduced) {
      addCandidate(
        npc,
        alreadyLinked
          ? "linked"
          : npc.descriptionSource === "narration"
            ? "narration"
            : wasEncountered
              ? "journal"
              : "roster",
      );
    }
  }

  return [...candidates.values()];
}

function getAutoNpcProvenance(data: Record<string, unknown>): AutoNpcProvenance | null {
  const extensions = parseRecord(data.extensions);
  const marinara = parseRecord(extensions.marinara);
  const value = parseRecord(marinara.gameNpc);
  if (value.autoCreated !== true || typeof value.gameId !== "string" || typeof value.npcId !== "string") return null;
  return {
    schemaVersion:
      typeof value.schemaVersion === "number" && Number.isFinite(value.schemaVersion)
        ? value.schemaVersion
        : AUTO_NPC_PROVENANCE_VERSION,
    autoCreated: true,
    gameId: value.gameId,
    sourceChatId: typeof value.sourceChatId === "string" ? value.sourceChatId : "",
    sourceSessionNumber:
      typeof value.sourceSessionNumber === "number" && Number.isFinite(value.sourceSessionNumber)
        ? value.sourceSessionNumber
        : null,
    npcId: value.npcId,
    normalizedName: typeof value.normalizedName === "string" ? value.normalizedName : "",
    evidenceKind:
      value.evidenceKind === "present" ||
      value.evidenceKind === "narration" ||
      value.evidenceKind === "roster" ||
      value.evidenceKind === "journal" ||
      value.evidenceKind === "linked"
        ? value.evidenceKind
        : "linked",
    sourceMessageId: typeof value.sourceMessageId === "string" ? value.sourceMessageId : null,
    sourceSwipeIndex:
      typeof value.sourceSwipeIndex === "number" && Number.isSafeInteger(value.sourceSwipeIndex)
        ? value.sourceSwipeIndex
        : null,
    ...(typeof value.profileSourceKey === "string" ? { profileSourceKey: value.profileSourceKey } : {}),
    ...(value.identityVerified === true ? { identityVerified: true } : {}),
    ...(typeof value.profileSourceMessageId === "string"
      ? { profileSourceMessageId: value.profileSourceMessageId }
      : {}),
    ...(typeof value.creativeAdditions === "string" ? { creativeAdditions: value.creativeAdditions } : {}),
    managed: {
      ...(typeof parseRecord(value.managed).personality === "string"
        ? { personality: String(parseRecord(value.managed).personality) }
        : {}),
      ...(typeof parseRecord(value.managed).backstory === "string"
        ? { backstory: String(parseRecord(value.managed).backstory) }
        : {}),
      name: typeof parseRecord(value.managed).name === "string" ? String(parseRecord(value.managed).name) : "",
      description:
        typeof parseRecord(value.managed).description === "string"
          ? String(parseRecord(value.managed).description)
          : "",
      appearance:
        typeof parseRecord(value.managed).appearance === "string" ? String(parseRecord(value.managed).appearance) : "",
      avatarPath:
        typeof parseRecord(value.managed).avatarPath === "string"
          ? String(parseRecord(value.managed).avatarPath)
          : null,
      sourceAvatarUrl:
        typeof parseRecord(value.managed).sourceAvatarUrl === "string"
          ? String(parseRecord(value.managed).sourceAvatarUrl)
          : null,
    },
  };
}

/** Identify an Engine-owned automatic NPC card without relying on display tags or comments. */
export function isAutoCreatedGameNpcCharacterData(value: unknown, gameId?: string): boolean {
  const provenance = getAutoNpcProvenance(parseRecord(value));
  return !!provenance && (!gameId || provenance.gameId === gameId);
}

/** Ordinary authored cards are trusted; legacy automatic cards must pass admission first. */
export function isVerifiedNpcCharacterData(value: unknown): boolean {
  const data = parseRecord(value);
  const provenance = getAutoNpcProvenance(data);
  return Object.keys(data).length > 0 && (!provenance || provenance.identityVerified === true);
}

function buildProvenance(input: {
  gameId: string;
  chatId: string;
  sessionNumber: number | null;
  candidate: GameNpcCharacterCandidate;
  managed: AutoNpcManagedFields;
}): AutoNpcProvenance {
  return {
    schemaVersion: AUTO_NPC_PROVENANCE_VERSION,
    ...(input.candidate.identityVerified === true ? { identityVerified: true } : {}),
    ...(input.candidate.profile
      ? {
          profileSourceKey: input.candidate.profile.sourceKey,
          profileSourceMessageId: input.candidate.profile.sourceMessageId,
          creativeAdditions: input.candidate.profile.creativeAdditions,
        }
      : {}),
    autoCreated: true,
    gameId: input.gameId,
    sourceChatId: input.chatId,
    sourceSessionNumber: input.sessionNumber,
    npcId: input.candidate.npcId,
    normalizedName: normalizeCharacterLookupName(input.candidate.name),
    evidenceKind: input.candidate.evidenceKind,
    sourceMessageId: optionalString(input.candidate.sourceMessageId),
    sourceSwipeIndex:
      typeof input.candidate.sourceSwipeIndex === "number" && Number.isSafeInteger(input.candidate.sourceSwipeIndex)
        ? input.candidate.sourceSwipeIndex
        : null,
    managed: input.managed,
  };
}

function withProvenance(data: CharacterData, provenance: AutoNpcProvenance): CharacterData {
  const extensions = parseRecord(data.extensions);
  const marinara = parseRecord(extensions.marinara);
  return {
    ...data,
    extensions: {
      ...data.extensions,
      marinara: {
        ...marinara,
        gameNpc: provenance,
      },
    },
  };
}

export function buildAutoNpcCharacterData(input: {
  candidate: GameNpcCharacterCandidate;
  gameId: string;
  chatId: string;
  sessionNumber: number | null;
}): CharacterData {
  const description =
    input.candidate.profile?.description ||
    input.candidate.description ||
    `${input.candidate.name} is an NPC introduced in this game.`;
  const appearance = input.candidate.profile?.appearance || input.candidate.appearance;
  const personality = input.candidate.profile?.personality ?? "";
  const backstory = input.candidate.profile?.backstory ?? "";
  const managed: AutoNpcManagedFields = {
    name: input.candidate.name,
    personality,
    backstory,
    description,
    appearance,
    avatarPath: null,
    sourceAvatarUrl: null,
  };
  return withProvenance(
    {
      name: input.candidate.name,
      description,
      personality,
      scenario: "",
      first_mes: "",
      mes_example: "",
      creator_notes: AUTO_NPC_CREATOR_NOTES,
      system_prompt: "",
      post_history_instructions: "",
      tags: [AUTO_NPC_TAG, AUTO_NPC_GENERATED_TAG],
      creator: AUTO_NPC_CREATOR,
      character_version: "1.0",
      alternate_greetings: [],
      extensions: {
        talkativeness: 0.5,
        fav: false,
        world: "",
        depth_prompt: { prompt: "", depth: 4, role: "system" },
        backstory,
        appearance,
        versioningEnabled: true,
      },
      character_book: null,
    },
    buildProvenance({
      gameId: input.gameId,
      chatId: input.chatId,
      sessionNumber: input.sessionNumber,
      candidate: input.candidate,
      managed,
    }),
  );
}

async function copyNpcAvatarToCharacterStorage(sourceAvatarUrl: string): Promise<string | null> {
  const base64 = readAvatarBase64(sourceAvatarUrl);
  if (!base64) return null;
  const buffer = Buffer.from(base64, "base64");
  const image = isAllowedImageBuffer(buffer);
  if (!image) return null;
  const avatarDir = join(DATA_DIR, "avatars");
  const filename = `character-game-npc-${newId()}.${image.ext}`;
  const filePath = assertInsideDir(avatarDir, join(avatarDir, filename));
  await mkdir(avatarDir, { recursive: true });
  await writeFile(filePath, buffer);
  return `/api/avatars/file/${filename}`;
}

function characterDataFromRow(row: NonNullable<CharacterRow>): CharacterData {
  return parseRecord(row.data) as unknown as CharacterData;
}

function isManagedGameNpcCard(
  data: CharacterData,
  provenance: AutoNpcProvenance | null,
): provenance is AutoNpcProvenance {
  return (
    !!provenance &&
    data.creator === AUTO_NPC_CREATOR &&
    Array.isArray(data.tags) &&
    data.tags.includes(AUTO_NPC_TAG) &&
    data.tags.includes(AUTO_NPC_GENERATED_TAG)
  );
}

function rowsMatchCandidate(
  row: NonNullable<CharacterRow>,
  candidate: GameNpcCharacterCandidate,
  gameId: string,
): boolean {
  const data = characterDataFromRow(row);
  const provenance = getAutoNpcProvenance(data as unknown as Record<string, unknown>);
  return !!provenance && provenance.gameId === gameId && provenance.npcId === candidate.npcId;
}

function parseStringArray(value: unknown): string[] {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return [];
    }
  }
  return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
}

function expectedUntouchedAutoNpcData(data: CharacterData, provenance: AutoNpcProvenance): CharacterData {
  const expected = buildAutoNpcCharacterData({
    candidate: {
      npcId: provenance.npcId,
      name: provenance.managed.name,
      description: provenance.managed.description,
      appearance: provenance.managed.appearance,
      avatarUrl: null,
      location: "",
      evidenceKind: provenance.evidenceKind,
      sourceMessageId: provenance.sourceMessageId,
      sourceSwipeIndex: provenance.sourceSwipeIndex,
    },
    gameId: provenance.gameId,
    chatId: provenance.sourceChatId,
    sessionNumber: provenance.sourceSessionNumber,
  });
  return withProvenance(
    {
      ...expected,
      personality: provenance.managed.personality ?? "",
      extensions: { ...expected.extensions, backstory: provenance.managed.backstory ?? "" },
      character_version: data.character_version,
    },
    provenance,
  );
}

async function hasExternalCharacterReference(input: {
  db: DB;
  characterId: string;
  gameId: string;
  npcId: string;
  sourceChatId: string;
}): Promise<boolean> {
  const [
    chatRows,
    groupRows,
    assetRows,
    imageRows,
    lorebookRows,
    lorebookLinkRows,
    noodleRows,
    notebookRows,
    callMessageRows,
    callSessionRows,
  ] = await Promise.all([
    input.db.select().from(chats),
    input.db.select().from(characterGroups),
    input.db.select().from(assets).where(eq(assets.characterId, input.characterId)).limit(1),
    input.db.select().from(characterImages).where(eq(characterImages.characterId, input.characterId)).limit(1),
    input.db.select().from(lorebooks).where(eq(lorebooks.characterId, input.characterId)).limit(1),
    input.db
      .select()
      .from(lorebookCharacterLinks)
      .where(eq(lorebookCharacterLinks.characterId, input.characterId))
      .limit(1),
    input.db.select().from(noodleAccounts).where(eq(noodleAccounts.entityId, input.characterId)).limit(1),
    input.db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, `${PRIVATE_NOTEBOOK_SETTINGS_PREFIX}character:${input.characterId}`))
      .limit(1),
    input.db
      .select()
      .from(conversationCallMessages)
      .where(eq(conversationCallMessages.characterId, input.characterId))
      .limit(1),
    input.db
      .select()
      .from(conversationCallSessions)
      .where(eq(conversationCallSessions.initiatorCharacterId, input.characterId))
      .limit(1),
  ]);
  if (
    assetRows.length > 0 ||
    imageRows.length > 0 ||
    lorebookRows.length > 0 ||
    lorebookLinkRows.length > 0 ||
    notebookRows.length > 0 ||
    callMessageRows.length > 0 ||
    callSessionRows.length > 0 ||
    noodleRows.some((row) => row.kind === "character")
  ) {
    return true;
  }
  if (groupRows.some((group) => parseStringArray(group.characterIds).includes(input.characterId))) return true;

  return chatRows.some((chat) => {
    if (parseStringArray(chat.characterIds).includes(input.characterId)) return true;
    const metadata = parseRecord(chat.metadata);
    if (parseStringArray(metadata.gamePartyCharacterIds).includes(input.characterId)) return true;
    if (metadata.gameGmCharacterId === input.characterId) return true;
    const chatGameId =
      (typeof metadata.gameId === "string" ? metadata.gameId.trim() : "") || chat.groupId?.trim() || chat.id;
    const gameNpcs = Array.isArray(metadata.gameNpcs) ? metadata.gameNpcs : [];
    return gameNpcs.some((value) => {
      const npc = parseRecord(value);
      if (npc.characterId !== input.characterId) return false;
      return chat.id !== input.sourceChatId || chatGameId !== input.gameId || npc.id !== input.npcId;
    });
  });
}

/**
 * Remove a now-noncanonical auto-created card only while it is still exactly
 * engine-managed and unreferenced. Any user edit or reuse converts deletion
 * into a harmless unlink, and the exact revision check closes edit races.
 */
export async function removeUntouchedAutoNpcCharacter(input: {
  db: DB;
  characterId: string;
  gameId: string;
  npcId: string;
  campaignName: string;
  /** Optional ownership check evaluated atomically with reference checks and deletion. */
  canRemove?: (transaction: DB) => Promise<boolean>;
}): Promise<boolean> {
  const store = createCharactersStorage(input.db);
  const row = await store.getById(input.characterId);
  if (!row) return true;
  const data = characterDataFromRow(row);
  const provenance = getAutoNpcProvenance(data as unknown as Record<string, unknown>);
  if (
    !isManagedGameNpcCard(data, provenance) ||
    provenance.gameId !== input.gameId ||
    provenance.npcId !== input.npcId
  ) {
    return false;
  }
  if (row.avatarPath !== provenance.managed.avatarPath || row.spriteFolderPath) return false;
  const expectedComment = `Auto-created Game NPC · ${input.campaignName || "Game"}`;
  if (row.comment !== expectedComment || !isDeepStrictEqual(data, expectedUntouchedAutoNpcData(data, provenance))) {
    return false;
  }
  const versions = await store.listVersions(row.id);
  if (versions.some((version) => !version.isCurrent && version.source !== "game-npc-sync")) return false;
  const revision = characterStorageRevision(row);
  const removal = await mutateAvatarReferencesAndCleanup({
    db: input.db,
    collectAvatarPaths: () => collectCharacterAvatarPaths(input.db, [row.id]),
    mutateReferences: () =>
      store.remove(row.id, {
        expectedRevision: revision,
        canRemove: async (transaction) => {
          if (input.canRemove && !(await input.canRemove(transaction))) return false;
          return !(await hasExternalCharacterReference({
            db: transaction,
            characterId: row.id,
            gameId: input.gameId,
            npcId: input.npcId,
            sourceChatId: provenance.sourceChatId,
          }));
        },
      }),
  });
  return removal.result;
}

export function shouldReplaceManagedValue(current: string, previousManaged: string): boolean {
  return current === previousManaged;
}

function avatarResourcePath(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? (trimmed.split(/[?#]/u, 1)[0] ?? trimmed) : null;
}

export function shouldCopyNpcAvatar(input: {
  sourceAvatarUrl: string | null;
  currentAvatarPath: string | null;
  managedAvatarPath: string | null;
  managedSourceAvatarUrl: string | null;
}): boolean {
  return (
    !!input.sourceAvatarUrl &&
    input.currentAvatarPath === input.managedAvatarPath &&
    input.sourceAvatarUrl !== input.managedSourceAvatarUrl &&
    avatarResourcePath(input.sourceAvatarUrl) !== avatarResourcePath(input.currentAvatarPath)
  );
}

async function updateLinkedAutoNpcCard(input: {
  store: CharacterStore;
  row: NonNullable<CharacterRow>;
  candidate: GameNpcCharacterCandidate;
  gameId: string;
  chatId: string;
  sessionNumber: number | null;
  copyAvatarToCharacterStorage: (sourceAvatarUrl: string) => Promise<string | null>;
  onPortraitCopyPending?: () => void;
  canUpdate?: (transaction: DB) => Promise<boolean>;
}): Promise<boolean> {
  const currentData = characterDataFromRow(input.row);
  const currentProvenance = getAutoNpcProvenance(currentData as unknown as Record<string, unknown>);
  if (
    !isManagedGameNpcCard(currentData, currentProvenance) ||
    currentProvenance.gameId !== input.gameId ||
    currentProvenance.npcId !== input.candidate.npcId
  ) {
    return false;
  }

  let changed = false;
  let versionedContentChanged = false;
  const updates: Partial<CharacterData> = {};
  const nextDescription =
    input.candidate.profile?.description ||
    (currentProvenance.profileSourceKey ? currentData.description : input.candidate.description) ||
    currentData.description;
  if (
    nextDescription !== currentData.description &&
    shouldReplaceManagedValue(currentData.description ?? "", currentProvenance.managed.description)
  ) {
    updates.description = nextDescription;
    changed = true;
    versionedContentChanged = true;
  }

  const currentAppearance =
    typeof currentData.extensions?.appearance === "string" ? currentData.extensions.appearance : "";
  const nextAppearance =
    input.candidate.profile?.appearance ||
    (currentProvenance.profileSourceKey ? currentAppearance : input.candidate.appearance) ||
    currentAppearance;
  let managedAppearance = currentProvenance.managed.appearance;
  if (
    nextAppearance !== currentAppearance &&
    shouldReplaceManagedValue(currentAppearance, currentProvenance.managed.appearance)
  ) {
    updates.extensions = { appearance: nextAppearance } as CharacterData["extensions"];
    managedAppearance = nextAppearance;
    changed = true;
    versionedContentChanged = true;
  }

  if (
    input.candidate.name !== currentData.name &&
    shouldReplaceManagedValue(currentData.name ?? "", currentProvenance.managed.name)
  ) {
    updates.name = input.candidate.name;
    changed = true;
    versionedContentChanged = true;
  }

  const managedProfileFields: Partial<AutoNpcManagedFields> = {};
  for (const field of ["personality", "backstory"] as const) {
    const current = field === "backstory" ? (currentData.extensions?.backstory ?? "") : (currentData.personality ?? "");
    const next = input.candidate.profile?.[field];
    if (next && next !== current && shouldReplaceManagedValue(current, currentProvenance.managed[field] ?? "")) {
      if (field === "backstory")
        updates.extensions = { ...updates.extensions, backstory: next } as CharacterData["extensions"];
      else updates.personality = next;
      managedProfileFields[field] = next;
      changed = true;
      versionedContentChanged = true;
    }
  }

  let nextAvatarPath = input.row.avatarPath ?? null;
  let managedAvatarPath = currentProvenance.managed.avatarPath;
  let managedSourceAvatarUrl = currentProvenance.managed.sourceAvatarUrl;
  const sourceAvatarUrl = optionalString(input.candidate.avatarUrl);
  if (
    sourceAvatarUrl &&
    shouldCopyNpcAvatar({
      sourceAvatarUrl,
      currentAvatarPath: nextAvatarPath,
      managedAvatarPath: currentProvenance.managed.avatarPath,
      managedSourceAvatarUrl: currentProvenance.managed.sourceAvatarUrl,
    })
  ) {
    const copiedAvatarPath = await input.copyAvatarToCharacterStorage(sourceAvatarUrl).catch((error) => {
      logger.warn(error, '[game/npc-character-sync] Failed to copy updated portrait for "%s"', input.candidate.name);
      return null;
    });
    if (copiedAvatarPath) {
      nextAvatarPath = copiedAvatarPath;
      managedAvatarPath = copiedAvatarPath;
      managedSourceAvatarUrl = sourceAvatarUrl;
      changed = true;
      versionedContentChanged = true;
    } else {
      input.onPortraitCopyPending?.();
    }
  }

  const managed: AutoNpcManagedFields = {
    ...currentProvenance.managed,
    name: updates.name ?? currentProvenance.managed.name ?? currentData.name,
    ...managedProfileFields,
    description: updates.description ?? currentProvenance.managed.description,
    appearance: managedAppearance,
    avatarPath: managedAvatarPath,
    sourceAvatarUrl: managedSourceAvatarUrl,
  };
  const nextProvenance: AutoNpcProvenance = {
    ...currentProvenance,
    ...(input.candidate.identityVerified === true ? { identityVerified: true } : {}),
    ...(input.candidate.profile
      ? {
          profileSourceKey: input.candidate.profile.sourceKey,
          profileSourceMessageId: input.candidate.profile.sourceMessageId,
          creativeAdditions: input.candidate.profile.creativeAdditions,
        }
      : {}),
    normalizedName: normalizeCharacterLookupName(input.candidate.name),
    managed,
  };
  if (!isDeepStrictEqual(nextProvenance, currentProvenance)) {
    updates.extensions = {
      ...(updates.extensions ?? {}),
      marinara: {
        ...parseRecord(currentData.extensions?.marinara),
        gameNpc: nextProvenance,
      },
    } as CharacterData["extensions"];
    changed = true;
  }

  if (!changed) return false;
  try {
    const updated = await input.store.update(input.row.id, updates, nextAvatarPath ?? undefined, {
      versionSource: "game-npc-sync",
      versionReason: "Observed Game NPC details updated",
      skipVersionSnapshot: !versionedContentChanged,
      expectedRevision: characterStorageRevision(input.row),
      canUpdate: input.canUpdate,
    });
    if (!updated) {
      if (nextAvatarPath && nextAvatarPath !== input.row.avatarPath) {
        await removeUnattachedAvatarFile({ avatarPath: nextAvatarPath });
      }
      return false;
    }
    return true;
  } catch (error) {
    if (nextAvatarPath && nextAvatarPath !== input.row.avatarPath) {
      await removeUnattachedAvatarFile({ avatarPath: nextAvatarPath });
    }
    throw error;
  }
}

/** Create or refresh campaign-owned Character cards without touching user-edited fields. */
export async function syncGameNpcCharacters(input: {
  db: DB;
  gameId: string;
  chatId: string;
  sessionNumber: number | null;
  campaignName: string;
  candidates: readonly GameNpcCharacterCandidate[];
  canonicalSource?: AutoNpcCanonicalSource | null;
  /** Explicitly invalidated roster identities whose untouched automatic cards may be removed. */
  rejectedNpcIds?: readonly string[];
  /** Let the caller persist canonical metadata ownership before deleting stale cards. */
  deferRetractionDeletion?: boolean;
  /** Re-check campaign, swipe, and optional NPC ownership before globally visible Character writes. */
  isTargetCurrent?: (npcId?: string) => Promise<boolean>;
  /** Re-check the same target inside the transaction that updates an existing managed card. */
  canUpdate?: (transaction: DB, npcId: string) => Promise<boolean>;
  /** Injectable portrait copier used by regression tests and alternate storage hosts. */
  copyAvatarToCharacterStorage?: (sourceAvatarUrl: string) => Promise<string | null>;
}): Promise<AutoNpcCharacterSyncResult> {
  const result: AutoNpcCharacterSyncResult = {
    created: [],
    updated: [],
    links: [],
    retracted: [],
    portraitCopiesPending: [],
  };
  if (!input.gameId) return result;

  const store = createCharactersStorage(input.db);
  const rows = await store.list();
  const targetIsCurrent = async (npcId?: string) => !input.isTargetCurrent || input.isTargetCurrent(npcId);
  const canUpdate = input.canUpdate;
  const copyAvatar = input.copyAvatarToCharacterStorage ?? copyNpcAvatarToCharacterStorage;
  const retractedNpcIds = new Set<string>();
  const markPortraitCopyPending = (candidate: GameNpcCharacterCandidate) => {
    if (!result.portraitCopiesPending.some((entry) => entry.npcId === candidate.npcId)) {
      result.portraitCopiesPending.push({ npcId: candidate.npcId, name: candidate.name });
    }
  };

  const rejectedNpcIds = new Set(input.rejectedNpcIds ?? []);
  for (const row of [...rows]) {
    const data = characterDataFromRow(row);
    const provenance = getAutoNpcProvenance(data as unknown as Record<string, unknown>);
    if (
      !provenance ||
      provenance.gameId !== input.gameId ||
      !rejectedNpcIds.has(provenance.npcId) ||
      !(await targetIsCurrent(provenance.npcId))
    ) {
      continue;
    }
    const cardRemoved = await removeUntouchedAutoNpcCharacter({
      db: input.db,
      characterId: row.id,
      gameId: input.gameId,
      npcId: provenance.npcId,
      campaignName: input.campaignName,
    });
    retractedNpcIds.add(provenance.npcId);
    result.retracted.push({
      characterId: row.id,
      npcId: provenance.npcId,
      name: data.name,
      cardRemoved,
    });
    if (cardRemoved) {
      const rowIndex = rows.findIndex((candidateRow) => candidateRow.id === row.id);
      if (rowIndex >= 0) rows.splice(rowIndex, 1);
    }
  }

  if (input.canonicalSource && (await targetIsCurrent())) {
    const supportedNpcIds = new Set(input.canonicalSource.supportedNpcIds);
    for (const row of [...rows]) {
      const data = characterDataFromRow(row);
      const provenance = getAutoNpcProvenance(data as unknown as Record<string, unknown>);
      if (
        !isManagedGameNpcCard(data, provenance) ||
        provenance.gameId !== input.gameId ||
        retractedNpcIds.has(provenance.npcId) ||
        provenance.sourceMessageId !== input.canonicalSource.messageId ||
        provenance.sourceSwipeIndex === null ||
        provenance.sourceSwipeIndex === input.canonicalSource.swipeIndex ||
        supportedNpcIds.has(provenance.npcId)
      ) {
        continue;
      }
      if (!(await targetIsCurrent(provenance.npcId))) break;

      const cardRemoved = input.deferRetractionDeletion
        ? false
        : await removeUntouchedAutoNpcCharacter({
            db: input.db,
            characterId: row.id,
            gameId: input.gameId,
            npcId: provenance.npcId,
            campaignName: input.campaignName,
          });
      retractedNpcIds.add(provenance.npcId);
      result.retracted.push({
        characterId: row.id,
        npcId: provenance.npcId,
        name: data.name,
        cardRemoved,
      });
      if (cardRemoved) {
        const rowIndex = rows.findIndex((candidateRow) => candidateRow.id === row.id);
        if (rowIndex >= 0) rows.splice(rowIndex, 1);
      }
    }
  }

  for (const candidate of input.candidates) {
    if (retractedNpcIds.has(candidate.npcId)) continue;
    if (!(await targetIsCurrent(candidate.npcId))) break;
    const directCharacterId = candidate.characterId || candidate.presentCharacterId;
    let row = directCharacterId ? await store.getById(directCharacterId) : null;
    if (row) {
      const directData = characterDataFromRow(row);
      const directProvenance = getAutoNpcProvenance(directData as unknown as Record<string, unknown>);
      // Direct links to ordinary/recruited cards are authoritative but never
      // auto-edited. A card explicitly owned by a different campaign NPC is not.
      if (
        directProvenance &&
        (directProvenance.gameId !== input.gameId || directProvenance.npcId !== candidate.npcId)
      ) {
        row = null;
      }
    }
    if (!row) row = rows.find((entry) => rowsMatchCandidate(entry, candidate, input.gameId)) ?? null;

    // A durable link whose card was explicitly deleted is a user deletion,
    // not permission to silently recreate the card under a new id.
    if (!row && candidate.characterId) continue;

    if (row) {
      const provenance = getAutoNpcProvenance(parseRecord(row.data));
      const updated = isManagedGameNpcCard(characterDataFromRow(row), provenance)
        ? await updateLinkedAutoNpcCard({
            store,
            row,
            candidate,
            gameId: input.gameId,
            chatId: input.chatId,
            sessionNumber: input.sessionNumber,
            copyAvatarToCharacterStorage: copyAvatar,
            onPortraitCopyPending: () => markPortraitCopyPending(candidate),
            canUpdate: canUpdate ? (transaction) => canUpdate(transaction, candidate.npcId) : undefined,
          })
        : false;
      if (!(await targetIsCurrent(candidate.npcId))) break;
      result.links.push({ characterId: row.id, npcId: candidate.npcId, name: candidate.name });
      if (updated) result.updated.push({ characterId: row.id, npcId: candidate.npcId, name: candidate.name });
      continue;
    }

    const normalizedCandidateName = normalizeCharacterLookupName(candidate.name);
    const conflictsWithOrdinaryCard = rows.some((entry) => {
      const data = characterDataFromRow(entry);
      if (getAutoNpcProvenance(data as unknown as Record<string, unknown>)) return false;
      const names = [data.name, ...(data.extensions?.nameAliases ?? [])];
      return names.some((name) => normalizeCharacterLookupName(name) === normalizedCandidateName);
    });
    // An ordinary library card with the same name may be intentional. Do not
    // guess that it is this NPC and do not create a duplicate beside it.
    if (conflictsWithOrdinaryCard) continue;
    if (!(await targetIsCurrent(candidate.npcId))) break;

    // No fallback from failed/disabled verification or biography to a prose-fragment card.
    if (!candidate.identityVerified || !candidate.profile) continue;
    const data = buildAutoNpcCharacterData({
      candidate,
      gameId: input.gameId,
      chatId: input.chatId,
      sessionNumber: input.sessionNumber,
    });
    const comment = `Auto-created Game NPC · ${input.campaignName || "Game"}`;
    const created = await store.create(data, undefined, undefined, comment);
    if (!created) continue;
    if (!(await targetIsCurrent(candidate.npcId))) {
      await removeUntouchedAutoNpcCharacter({
        db: input.db,
        characterId: created.id,
        gameId: input.gameId,
        npcId: candidate.npcId,
        campaignName: input.campaignName,
      });
      break;
    }

    let createdRow = created;
    const sourceAvatarUrl = optionalString(candidate.avatarUrl);
    if (sourceAvatarUrl) {
      const copiedAvatarPath = await copyAvatar(sourceAvatarUrl).catch((error) => {
        logger.warn(error, '[game/npc-character-sync] Failed to copy portrait for "%s"', candidate.name);
        return null;
      });
      if (copiedAvatarPath) {
        try {
          const createdData = characterDataFromRow(created);
          const provenance = getAutoNpcProvenance(createdData as unknown as Record<string, unknown>);
          const nextProvenance = provenance
            ? {
                ...provenance,
                managed: {
                  ...provenance.managed,
                  avatarPath: copiedAvatarPath,
                  sourceAvatarUrl,
                },
              }
            : null;
          const updated = await store.update(
            created.id,
            nextProvenance
              ? {
                  extensions: {
                    marinara: {
                      ...parseRecord(createdData.extensions?.marinara),
                      gameNpc: nextProvenance,
                    },
                  } as unknown as CharacterData["extensions"],
                }
              : {},
            copiedAvatarPath,
            { skipVersionSnapshot: true, expectedRevision: characterStorageRevision(created) },
          );
          if (updated) createdRow = updated;
          else {
            await removeUnattachedAvatarFile({ avatarPath: copiedAvatarPath });
            markPortraitCopyPending(candidate);
          }
        } catch (error) {
          await removeUnattachedAvatarFile({ avatarPath: copiedAvatarPath });
          logger.warn(error, '[game/npc-character-sync] Failed to attach copied avatar for "%s"', candidate.name);
          markPortraitCopyPending(candidate);
        }
      } else {
        markPortraitCopyPending(candidate);
      }
    }

    if (!(await targetIsCurrent(candidate.npcId))) {
      await removeUntouchedAutoNpcCharacter({
        db: input.db,
        characterId: created.id,
        gameId: input.gameId,
        npcId: candidate.npcId,
        campaignName: input.campaignName,
      });
      break;
    }

    rows.push(createdRow);
    const link = { characterId: created.id, npcId: candidate.npcId, name: candidate.name };
    result.created.push(link);
    result.links.push(link);
    logger.info('[game/npc-character-sync] Created Character card for "%s" (%s)', candidate.name, created.id);
  }

  for (const created of [...result.created]) {
    if (await targetIsCurrent(created.npcId)) continue;
    await removeUntouchedAutoNpcCharacter({
      db: input.db,
      characterId: created.characterId,
      gameId: input.gameId,
      npcId: created.npcId,
      campaignName: input.campaignName,
    });
    result.created = result.created.filter((entry) => entry.characterId !== created.characterId);
    result.links = result.links.filter((entry) => entry.characterId !== created.characterId);
  }

  return result;
}
