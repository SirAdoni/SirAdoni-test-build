import {
  gameNpcIdentityTokens,
  gameNpcNamesCouldBeAliases,
  isIgnoredGameNpcIdentity,
  isPlausibleNarrationNpcName,
  normalizeGameNpcIdentityName,
  type GameNpc,
} from "@marinara-engine/shared";

export const BUILT_IN_MARI_AVATAR = "/sprites/mari/Mari_profile.png";

const CHARACTER_NAME_LEADING_PREFIX_WORDS = new Set([
  "a",
  "an",
  "the",
  "il",
  "lo",
  "la",
  "le",
  "l",
  "el",
  "sir",
  "lady",
  "lord",
  "professor",
  "old",
  "young",
  "elder",
  "great",
  "captain",
]);
const lookupCandidatesByMap = new WeakMap<Map<string, string>, Map<string, Set<string>>>();
const lookupNamesByMap = new WeakMap<Map<string, string>, Map<string, Set<string>>>();

export interface GameNpcSanitizationOptions {
  /** Character-card names that must never be re-created as narration-derived NPCs. */
  protectedCharacterNames?: readonly string[];
  /** Known place names that must never be re-created as narration-derived NPCs. */
  locationNames?: readonly string[];
  /** Stable NPC identities the user explicitly removed. */
  ignoredNpcIds?: readonly string[];
  /** Per-game names (companions, onboard AIs) narration extraction must skip; never used to drop existing rows. */
  narrationExcludedNames?: readonly string[];
  /** Provenance-confirmed automatic cards that may be discarded when they duplicate protected identities. */
  autoCreatedCharacterIds?: readonly string[];
}

function uniqueSingleTokenAliasMatch(name: unknown, candidates: readonly string[]): boolean {
  const normalizedName = normalizeGameNpcIdentityName(name);
  const tokens = gameNpcIdentityTokens(name);
  if (!normalizedName || tokens.length !== 1) return false;
  const token = tokens[0]!;
  const matches = new Set<string>();
  for (const candidate of candidates) {
    const normalizedCandidate = normalizeGameNpcIdentityName(candidate);
    if (!normalizedCandidate || normalizedCandidate === normalizedName) continue;
    if (!gameNpcIdentityTokens(candidate).includes(token)) continue;
    matches.add(normalizedCandidate);
    if (matches.size > 1) return false;
  }
  return matches.size === 1;
}

function narrationNpcMatchesProtectedName(name: unknown, protectedNames: readonly string[]): boolean {
  const normalizedName = normalizeGameNpcIdentityName(name);
  if (!normalizedName) return false;
  if (protectedNames.some((candidate) => normalizeGameNpcIdentityName(candidate) === normalizedName)) return true;
  return uniqueSingleTokenAliasMatch(name, protectedNames);
}

/** Match an extracted narration name against exact or unambiguous short-form known identities. */
export function isNarrationNpcNameExcluded(name: unknown, excludedNames: readonly string[]): boolean {
  return narrationNpcMatchesProtectedName(name, excludedNames);
}

function narrationNpcMatchesKnownLocation(name: unknown, locationNames: readonly string[]): boolean {
  const normalizedName = normalizeGameNpcIdentityName(name);
  if (!normalizedName) return false;
  if (locationNames.some((candidate) => normalizeGameNpcIdentityName(candidate) === normalizedName)) return true;
  return uniqueSingleTokenAliasMatch(name, locationNames);
}

function npcDescriptionPriority(source: GameNpc["descriptionSource"]): number {
  switch (source) {
    case "user":
      return 4;
    case "library":
      return 3;
    case "model":
      return 2;
    case "narration":
      return 1;
    default:
      return 0;
  }
}

function npcRecordsAreAliases(left: GameNpc, right: GameNpc, allNames: readonly string[]): boolean {
  const leftName = normalizeGameNpcIdentityName(left.name);
  const rightName = normalizeGameNpcIdentityName(right.name);
  if (!leftName || !rightName) return false;
  if (left.characterId && right.characterId && left.characterId !== right.characterId) return false;
  if (leftName === rightName) {
    // Exact display names are not identities. Preserve two explicitly distinct
    // roster records; ordinary narration duplicates reuse the same stable id.
    return left.id === right.id;
  }
  if (left.descriptionSource !== "narration" && right.descriptionSource !== "narration") return false;

  if (!gameNpcNamesCouldBeAliases(left.name, right.name)) return false;

  // Prefer the narration spelling as the alias probe. It is the public name
  // that must have exactly one durable owner before records can be folded.
  const probe =
    left.descriptionSource === "narration" && right.descriptionSource !== "narration"
      ? left.name
      : right.descriptionSource === "narration" && left.descriptionSource !== "narration"
        ? right.name
        : gameNpcIdentityTokens(left.name).length < gameNpcIdentityTokens(right.name).length
          ? left.name
          : right.name;
  const normalizedProbe = normalizeGameNpcIdentityName(probe);
  const aliasOwners = allNames.filter(
    (candidate) =>
      normalizeGameNpcIdentityName(candidate) !== normalizedProbe && gameNpcNamesCouldBeAliases(probe, candidate),
  );

  // A short name or title variant is only safe to fold when exactly one
  // tracked record owns that alias.
  return aliasOwners.length === 1;
}

function mergeNpcRecords(existing: GameNpc, incoming: GameNpc): GameNpc {
  const existingPriority = npcDescriptionPriority(existing.descriptionSource);
  const incomingPriority = npcDescriptionPriority(incoming.descriptionSource);
  const incomingIsCanonical =
    incomingPriority > existingPriority ||
    (incomingPriority === existingPriority &&
      gameNpcIdentityTokens(incoming.name).length > gameNpcIdentityTokens(existing.name).length);
  const canonical = incomingIsCanonical ? incoming : existing;
  const secondary = incomingIsCanonical ? existing : incoming;
  const linkedIdentity =
    Boolean(existing.characterId) !== Boolean(incoming.characterId)
      ? existing.characterId
        ? existing
        : incoming
      : canonical;
  const canonicalDescription = canonical.description?.trim();
  const secondaryDescription = secondary.description?.trim();
  const canonicalIsPublic =
    canonical.descriptionSource === "user" ||
    canonical.descriptionSource === "library" ||
    canonical.descriptionSource === "narration";
  const secondaryIsPublic =
    secondary.descriptionSource === "user" ||
    secondary.descriptionSource === "library" ||
    secondary.descriptionSource === "narration";
  const mayUseSecondaryStructuredFields = !canonicalIsPublic || secondaryIsPublic;

  return {
    ...canonical,
    // A linked Character card establishes the NPC's durable identity. Keep
    // that stable id even when a fuller alias supplies the canonical display.
    id: linkedIdentity.id,
    characterId: canonical.characterId ?? secondary.characterId ?? null,
    description: canonicalDescription || (mayUseSecondaryStructuredFields ? secondaryDescription : "") || "",
    descriptionSource:
      canonicalDescription || canonicalIsPublic ? canonical.descriptionSource : secondary.descriptionSource,
    observedDescription:
      canonical.observedDescription ||
      secondary.observedDescription ||
      (canonical.descriptionSource === "narration" ? canonicalDescription : "") ||
      (secondary.descriptionSource === "narration" ? secondaryDescription : ""),
    observedAppearance: canonical.observedAppearance || secondary.observedAppearance,
    gender: canonical.gender ?? (mayUseSecondaryStructuredFields ? secondary.gender : null) ?? null,
    pronouns: canonical.pronouns ?? (mayUseSecondaryStructuredFields ? secondary.pronouns : null) ?? null,
    location: canonical.location || (mayUseSecondaryStructuredFields ? secondary.location : ""),
    notes: [
      ...new Set([...(canonical.notes ?? []), ...(mayUseSecondaryStructuredFields ? (secondary.notes ?? []) : [])]),
    ],
    avatarUrl:
      linkedIdentity.avatarUrl ||
      canonical.avatarUrl ||
      (mayUseSecondaryStructuredFields ? secondary.avatarUrl : null) ||
      null,
  };
}

function collectNamedRecords(value: unknown, key: "name" | "label", names: Set<string>): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const name = (item as Record<string, unknown>)[key];
    if (typeof name === "string" && name.trim()) names.add(name.trim());
  }
}

/** Build the identity boundary used when cleaning or persisting generated NPC portraits. */
export function gameNpcSanitizationOptionsFromMetadata(
  metadata: Record<string, unknown>,
  additionalProtectedNames: readonly string[] = [],
): GameNpcSanitizationOptions {
  const protectedCharacterNames = new Set(additionalProtectedNames.map((name) => name.trim()).filter(Boolean));
  collectNamedRecords(metadata.gameCharacterCards, "name", protectedCharacterNames);

  const setupLabels = metadata.gameInitialSetupLabels;
  if (setupLabels && typeof setupLabels === "object" && !Array.isArray(setupLabels)) {
    const characterNames = (setupLabels as Record<string, unknown>).characterNames;
    if (characterNames && typeof characterNames === "object" && !Array.isArray(characterNames)) {
      for (const name of Object.values(characterNames as Record<string, unknown>)) {
        if (typeof name === "string" && name.trim()) protectedCharacterNames.add(name.trim());
      }
    }
  }

  const locationNames = new Set<string>();
  const spatialContext = metadata.spatialContext;
  if (spatialContext && typeof spatialContext === "object" && !Array.isArray(spatialContext)) {
    collectNamedRecords((spatialContext as Record<string, unknown>).locations, "name", locationNames);
  }
  const addMapLocations = (map: unknown) => {
    if (!map || typeof map !== "object" || Array.isArray(map)) return;
    const source = map as Record<string, unknown>;
    if (typeof source.name === "string" && source.name.trim()) locationNames.add(source.name.trim());
    collectNamedRecords(source.nodes, "label", locationNames);
    collectNamedRecords(source.cells, "label", locationNames);
  };
  addMapLocations(metadata.gameMap);
  if (Array.isArray(metadata.gameMaps)) metadata.gameMaps.forEach(addMapLocations);

  const narrationExcludedNames = Array.isArray(metadata.gameNarrationExcludedNpcNames)
    ? (metadata.gameNarrationExcludedNpcNames as unknown[])
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => value.trim())
    : [];

  return {
    protectedCharacterNames: [...protectedCharacterNames],
    locationNames: [...locationNames],
    narrationExcludedNames,
    ignoredNpcIds: Array.isArray(metadata.gameIgnoredNpcIds)
      ? (metadata.gameIgnoredNpcIds as unknown[]).filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0,
        )
      : [],
  };
}

export function normalizeAvatarLookupName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['’]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function nameLookupWithoutLeadingPrefix(normalizedName: string): string {
  const words = normalizedName.split(/\s+/).filter(Boolean);
  return words.length > 1 && CHARACTER_NAME_LEADING_PREFIX_WORDS.has(words[0]!)
    ? words.slice(1).join(" ")
    : normalizedName;
}

function primaryAvatarLookupAliases(value: string): string[] {
  const normalized = normalizeAvatarLookupName(value);
  const withoutLeadingPrefix = nameLookupWithoutLeadingPrefix(normalized);
  return Array.from(new Set([value.normalize("NFKC").trim().toLowerCase(), normalized, withoutLeadingPrefix])).filter(
    Boolean,
  );
}

function avatarLookupAliases(value: string): string[] {
  const normalized = normalizeAvatarLookupName(value);
  const words = normalized.split(/\s+/).filter(Boolean);
  return Array.from(
    new Set([
      ...primaryAvatarLookupAliases(value),
      ...words.filter((word) => word.length >= 3 && !CHARACTER_NAME_LEADING_PREFIX_WORDS.has(word)),
    ]),
  );
}

export function addNameLookupEntry(map: Map<string, string>, name: unknown, value: unknown): void {
  if (typeof name !== "string" || typeof value !== "string") return;
  const trimmedValue = value.trim();
  if (!trimmedValue) return;
  // Keep original identities separate from generated word aliases. A shared surname
  // must not turn two different full names into the same portrait or appearance.
  let names = lookupNamesByMap.get(map);
  if (!names) {
    names = new Map();
    for (const [key, existing] of map) names.set(key, new Set([existing]));
    lookupNamesByMap.set(map, names);
  }
  const canonicalName = normalizeAvatarLookupName(name);
  if (!canonicalName) return;
  const values = names.get(canonicalName) ?? new Set<string>();
  values.add(trimmedValue);
  names.set(canonicalName, values);
  let candidatesByAlias = lookupCandidatesByMap.get(map);
  if (!candidatesByAlias) {
    candidatesByAlias = new Map();
    lookupCandidatesByMap.set(map, candidatesByAlias);
  }
  for (const alias of avatarLookupAliases(name)) {
    let candidates = candidatesByAlias.get(alias);
    if (!candidates) {
      candidates = new Set();
      const existing = map.get(alias);
      if (existing) candidates.add(existing);
      candidatesByAlias.set(alias, candidates);
    }
    candidates.add(trimmedValue);
    if (candidates.size === 1) map.set(alias, trimmedValue);
    else map.delete(alias);
  }
}

function containsLookupPhrase(value: string, phrase: string): boolean {
  return ` ${value} `.includes(` ${phrase} `);
}

/** Resolve title and partial-name aliases before creating a replacement portrait. */
export function findCharAvatarFuzzy(npcName: string, charAvatarByName: Map<string, string>): string | undefined {
  const npcAliases = primaryAvatarLookupAliases(npcName);
  const exactCandidates = new Set<string>();
  const trackedCandidates = lookupCandidatesByMap.get(charAvatarByName);
  for (const alias of primaryAvatarLookupAliases(npcName)) {
    const candidates = trackedCandidates?.get(alias);
    if (candidates) {
      for (const candidate of candidates) exactCandidates.add(candidate);
    } else {
      const exact = charAvatarByName.get(alias);
      if (exact) exactCandidates.add(exact);
    }
  }
  if (exactCandidates.size > 0) return exactCandidates.size === 1 ? exactCandidates.values().next().value : undefined;

  const fuzzyCandidates = new Set<string>();
  const identities =
    lookupNamesByMap.get(charAvatarByName) ??
    new Map(Array.from(charAvatarByName, ([name, value]) => [name, new Set([value])]));
  for (const [charName, avatars] of identities) {
    const charAliases = primaryAvatarLookupAliases(charName);
    for (const npcAlias of npcAliases) {
      for (const charAlias of charAliases) {
        if (
          npcAlias === charAlias ||
          (charAlias.length >= 3 && containsLookupPhrase(npcAlias, charAlias)) ||
          (npcAlias.length >= 3 && containsLookupPhrase(charAlias, npcAlias))
        ) {
          for (const avatar of avatars) fuzzyCandidates.add(avatar);
        }
      }
    }
  }
  return fuzzyCandidates.size === 1 ? fuzzyCandidates.values().next().value : undefined;
}

export async function loadCharacterLibraryAvatarLookup(
  loadCharacters: () => Promise<Array<{ data: string; avatarPath?: string | null }>>,
  onError: (error: unknown) => void,
): Promise<Map<string, string>> {
  const lookup = new Map<string, string>();
  let characters: Array<{ data: string; avatarPath?: string | null }>;
  try {
    characters = await loadCharacters();
  } catch (error) {
    onError(error);
    return lookup;
  }
  for (const character of characters) {
    try {
      const data = JSON.parse(character.data) as { name?: string };
      if (data.name && character.avatarPath) addNameLookupEntry(lookup, data.name, character.avatarPath);
    } catch {
      /* skip malformed library rows */
    }
  }
  return lookup;
}

export function npcAvatarSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/(^-|-$)/g, "");
}

function normalizeNpcName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/'/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isMariNpcName(name: unknown): boolean {
  if (typeof name !== "string") return false;
  const normalized = normalizeNpcName(name);
  return normalized === "mari" || normalized === "professor mari";
}

export function isInvalidBuiltInMariNpcAvatar(npc: Pick<GameNpc, "name" | "avatarUrl">): boolean {
  const avatarPath = typeof npc.avatarUrl === "string" ? npc.avatarUrl.split("?")[0] : "";
  return avatarPath === BUILT_IN_MARI_AVATAR && !isMariNpcName(npc.name);
}

export function sanitizeGameNpcAvatarUrls(npcs: GameNpc[], options: GameNpcSanitizationOptions = {}): GameNpc[] {
  let changed = false;
  const avatarSanitized = npcs.map((npc) => {
    const { met: _met, ...withoutMet } = npc as GameNpc & { met?: unknown };
    if (typeof withoutMet.avatarUrl === "string" && /^https?:\/\//i.test(withoutMet.avatarUrl)) {
      try {
        const url = new URL(withoutMet.avatarUrl);
        if (
          (url.hostname === "localhost" || url.hostname === "[::1]" || /^127\./.test(url.hostname)) &&
          /^\/api\/avatars\/(?:npc|file)\//.test(url.pathname)
        ) {
          // Legacy local URLs must resolve on the device viewing this server, including over LAN.
          withoutMet.avatarUrl = `${url.pathname}${url.search}${url.hash}`;
          changed = true;
        }
      } catch {
        // Leave an unparseable URL alone; it is not a known local avatar resource.
      }
    }
    const hasLegacyMet = "met" in npc;
    if (!isInvalidBuiltInMariNpcAvatar(withoutMet)) {
      if (hasLegacyMet) changed = true;
      return withoutMet;
    }
    changed = true;
    const { avatarUrl: _avatarUrl, ...rest } = withoutMet;
    return rest;
  });

  const protectedNames = options.protectedCharacterNames ?? [];
  const locationNames = options.locationNames ?? [];
  const ignoredNpcIds = new Set(options.ignoredNpcIds ?? []);
  const autoCreatedCharacterIds = new Set(options.autoCreatedCharacterIds ?? []);
  const knownNpcNames = avatarSanitized.map((npc) => npc.name);
  const filtered = avatarSanitized.filter((npc) => {
    if (isIgnoredGameNpcIdentity(ignoredNpcIds, npc.id, npc.name, knownNpcNames)) {
      changed = true;
      return false;
    }
    if (npc.descriptionSource !== "narration") return true;
    const characterId = typeof npc.characterId === "string" ? npc.characterId.trim() : "";
    const autoCreatedLink = !!characterId && autoCreatedCharacterIds.has(characterId);
    if (!isPlausibleNarrationNpcName(npc.name)) {
      if (!characterId || autoCreatedLink) changed = true;
      return !!characterId && !autoCreatedLink;
    }
    const shouldRemove =
      narrationNpcMatchesProtectedName(npc.name, protectedNames) ||
      narrationNpcMatchesKnownLocation(npc.name, locationNames);
    if (characterId && !autoCreatedLink) return true;
    if (shouldRemove) changed = true;
    return !shouldRemove;
  });

  const allNames = filtered.map((npc) => npc.name);
  const deduplicated: GameNpc[] = [];
  for (const npc of filtered) {
    const matchingIndexes = deduplicated
      .map((candidate, index) => (npcRecordsAreAliases(candidate, npc, allNames) ? index : -1))
      .filter((index) => index !== -1);
    if (matchingIndexes.length !== 1) {
      deduplicated.push(npc);
      continue;
    }

    const index = matchingIndexes[0]!;
    deduplicated[index] = mergeNpcRecords(deduplicated[index]!, npc);
    changed = true;
  }

  return changed ? deduplicated : npcs;
}
