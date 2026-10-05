import { normalizeTextForMatch, type GameNpc, type GameNpcAvatarState } from "@marinara-engine/shared";

const NPC_AVATAR_REVISION_PARAM = "mariAvatarRevision";
const TRAILING_NPC_REPUTATION_LABEL = /(?:^|[\s_-])(?:devoted|allied|friendly|neutral|unfriendly|hostile|enemy)$/i;
let npcAvatarRevision = 0;

export function cleanNpcAvatarDisplayName(value: string): string {
  return value.replace(TRAILING_NPC_REPUTATION_LABEL, "").trim() || value;
}

export function normalizeNpcAvatarName(value: string): string {
  return normalizeTextForMatch(cleanNpcAvatarDisplayName(value).replace(/[_-]+/g, " "));
}

function splitHash(value: string): { base: string; hash: string } {
  const hashIndex = value.indexOf("#");
  return hashIndex === -1
    ? { base: value, hash: "" }
    : { base: value.slice(0, hashIndex), hash: value.slice(hashIndex) };
}

export function withoutNpcAvatarRevision(value: string): string {
  const { base, hash } = splitHash(value);
  const [pathname, query = ""] = base.split("?", 2);
  const params = new URLSearchParams(query);
  params.delete(NPC_AVATAR_REVISION_PARAM);
  const nextQuery = params.toString();
  return `${pathname}${nextQuery ? `?${nextQuery}` : ""}${hash}`;
}

export function isSameNpcAvatarResource(left: string, right: string): boolean {
  return withoutNpcAvatarRevision(left) === withoutNpcAvatarRevision(right);
}

export function hasAuthoritativeNpcAvatarState(
  state: GameNpcAvatarState | null | undefined,
): state is GameNpcAvatarState {
  return Number.isSafeInteger(state?.revision) && (state?.revision ?? 0) > 0 && typeof state?.removed === "boolean";
}

export function isNpcAvatarRemoved(state: GameNpcAvatarState | null | undefined): boolean {
  return hasAuthoritativeNpcAvatarState(state) && state.removed;
}

/** A stale or unmarked snapshot cannot replace a later explicit avatar mutation. */
export function resolveNpcAvatarState(
  current: GameNpcAvatarState | null | undefined,
  incoming: GameNpcAvatarState | null | undefined,
): GameNpcAvatarState | undefined {
  const currentValid = hasAuthoritativeNpcAvatarState(current);
  const incomingValid = hasAuthoritativeNpcAvatarState(incoming);
  if (!currentValid) return incomingValid ? incoming : undefined;
  if (!incomingValid || current.revision > incoming.revision) return current;
  if (current.revision === incoming.revision && current.removed && !incoming.removed) return current;
  return incoming;
}

/** A linked card owns its own revision domain; omitted incoming IDs cannot unlink it. */
export function resolveNpcAvatarStateForIdentity(
  current: GameNpcAvatarState | null | undefined,
  currentCharacterId: string | null | undefined,
  incoming: GameNpcAvatarState | null | undefined,
  incomingCharacterId: string | null | undefined,
): GameNpcAvatarState | undefined {
  const currentId = currentCharacterId?.trim();
  const incomingId = incomingCharacterId?.trim();
  if (currentId && !incomingId) return hasAuthoritativeNpcAvatarState(current) ? current : undefined;
  if (incomingId && incomingId !== currentId) return hasAuthoritativeNpcAvatarState(incoming) ? incoming : undefined;
  return resolveNpcAvatarState(current, incoming);
}

/**
 * Force browsers to refetch an NPC portrait after the server replaces the
 * image at a stable path. The persisted resource identity remains intact.
 */
export function withFreshNpcAvatarRevision(value: string): string {
  const { base, hash } = splitHash(withoutNpcAvatarRevision(value));
  const separator = base.includes("?") ? "&" : "?";
  npcAvatarRevision += 1;
  return `${base}${separator}${NPC_AVATAR_REVISION_PARAM}=${Date.now()}-${npcAvatarRevision}${hash}`;
}

/** Preserve local portraits across ordinary stale metadata while honoring exact-ID clears and reassignment. */
export function mergeGameNpcsPreservingAvatars(
  existingNpcs: readonly GameNpc[],
  incomingNpcs: readonly GameNpc[],
): GameNpc[] {
  const existingById = new Map(existingNpcs.filter((npc) => npc.id).map((npc) => [npc.id, npc]));
  const existingNameCounts = new Map<string, number>();
  for (const npc of existingNpcs) {
    const name = normalizeNpcAvatarName(npc.name ?? "");
    if (name) existingNameCounts.set(name, (existingNameCounts.get(name) ?? 0) + 1);
  }
  const incomingNameCounts = new Map<string, number>();
  for (const npc of incomingNpcs) {
    const name = normalizeNpcAvatarName(npc.name ?? "");
    if (name) incomingNameCounts.set(name, (incomingNameCounts.get(name) ?? 0) + 1);
  }

  return incomingNpcs.map((npc) => {
    const normalizedName = normalizeNpcAvatarName(npc.name ?? "");
    const existing =
      existingById.get(npc.id) ??
      (!npc.id && incomingNameCounts.get(normalizedName) === 1 && existingNameCounts.get(normalizedName) === 1
        ? existingNpcs.find((candidate) => normalizeNpcAvatarName(candidate.name ?? "") === normalizedName)
        : undefined);
    const avatarState = resolveNpcAvatarStateForIdentity(
      existing?.avatarState,
      existing?.characterId,
      npc.avatarState,
      npc.characterId,
    );
    const incomingCharacterId = npc.characterId?.trim();
    const existingCharacterId = existing?.characterId?.trim();
    const changedCharacter = !!incomingCharacterId && incomingCharacterId !== existingCharacterId;

    if (isNpcAvatarRemoved(avatarState)) {
      return { ...npc, characterId: incomingCharacterId || existing?.characterId, avatarUrl: undefined, avatarState };
    }
    if (hasAuthoritativeNpcAvatarState(avatarState)) {
      const owner = avatarState === npc.avatarState ? npc : existing;
      if (owner) {
        return {
          ...npc,
          characterId: incomingCharacterId || existing?.characterId,
          avatarUrl: owner.avatarUrl ?? undefined,
          avatarState,
        };
      }
    }
    if (changedCharacter) return { ...npc, characterId: incomingCharacterId, avatarUrl: npc.avatarUrl ?? undefined };

    const preserved = existing?.avatarUrl;
    if (preserved && (!npc.avatarUrl || isSameNpcAvatarResource(npc.avatarUrl, preserved))) {
      return { ...npc, characterId: incomingCharacterId || existing?.characterId, avatarUrl: preserved, avatarState };
    }
    return avatarState ? { ...npc, characterId: incomingCharacterId || existing?.characterId, avatarState } : npc;
  });
}

/** Keep tracked-only rows during stale metadata refreshes; current metadata wins for the same stable identity. */
export function mergeGameNpcIdentityUnion(
  trackedNpcs: readonly GameNpc[],
  metadataNpcs: readonly GameNpc[],
): GameNpc[] {
  const mergedMetadata = mergeGameNpcsPreservingAvatars(trackedNpcs, metadataNpcs);
  const metadataIds = new Set(metadataNpcs.map((npc) => npc.id?.trim()).filter((id): id is string => !!id));
  return [...mergedMetadata, ...trackedNpcs.filter((npc) => !metadataIds.has(npc.id?.trim() ?? ""))];
}

export type GameNpcAvatarSnapshot = {
  characterId?: string | null;
  name?: string | null;
  avatarPath?: string | null;
};

/** Build exact identity lookups while treating marked roster rows as newer than unmarked card snapshots. */
export function buildGameNpcAvatarLookup(
  trackedNpcs: readonly GameNpc[],
  presentCharacters: readonly GameNpcAvatarSnapshot[],
  metadataNpcs: readonly GameNpc[],
): Map<string, string> {
  const lookup = new Map<string, string>();
  const effectiveNpcs = mergeGameNpcIdentityUnion(trackedNpcs, metadataNpcs);
  const identityCounts = new Map<string, Set<string>>();
  const authoritativeCharacterIds = new Set<string>();
  const authoritativeNames = new Set<string>();
  const normalize = (value: string) => value.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  const recordNameIdentity = (name: string | null | undefined, identity: string) => {
    const key = normalize(name ?? "");
    if (!key) return;
    const identities = identityCounts.get(key) ?? new Set<string>();
    identities.add(identity);
    identityCounts.set(key, identities);
  };

  for (const npc of effectiveNpcs) {
    recordNameIdentity(
      npc.name,
      npc.id?.trim() || (npc.characterId ? `character:${npc.characterId}` : normalize(npc.name)),
    );
    if (!hasAuthoritativeNpcAvatarState(npc.avatarState)) continue;
    if (npc.characterId?.trim()) authoritativeCharacterIds.add(npc.characterId.trim());
    const name = normalize(npc.name);
    if (name) authoritativeNames.add(name);
  }
  for (const character of presentCharacters) {
    const name = normalize(character.name ?? "");
    if (!name) continue;
    recordNameIdentity(character.name, character.characterId?.trim() || name);
  }

  const add = (name: string | null | undefined, avatarUrl: string | null | undefined, keys: string[]) => {
    const normalizedName = normalize(name ?? "");
    const url = avatarUrl?.trim();
    if (!normalizedName || !url) return;
    for (const key of keys) lookup.set(key, url);
    if (identityCounts.get(normalizedName)?.size === 1 && !authoritativeNames.has(normalizedName)) {
      lookup.set(normalizedName, url);
    }
  };

  for (const npc of effectiveNpcs) {
    if (isNpcAvatarRemoved(npc.avatarState) || (hasAuthoritativeNpcAvatarState(npc.avatarState) && !npc.avatarUrl))
      continue;
    add(
      npc.name,
      npc.avatarUrl,
      [npc.id ? `id:${npc.id}` : "", npc.characterId ? `character:${npc.characterId}` : ""].filter(Boolean),
    );
  }
  for (const character of presentCharacters) {
    const characterId = character.characterId?.trim();
    if (characterId && authoritativeCharacterIds.has(characterId)) continue;
    add(character.name, character.avatarPath, characterId ? [`character:${characterId}`] : []);
  }
  return lookup;
}

/** Apply current NPC identity authority after dialogue's name-based avatar sources have been collected. */
export function applyGameNpcAvatarAuthority<T extends { url: string; crop?: unknown }>(
  avatarsByName: Map<string, T>,
  gameNpcs: readonly GameNpc[],
  activeCharacters: readonly { id: string; name: string }[],
): Map<string, T> {
  const result = new Map(avatarsByName);
  const npcsByName = new Map<string, GameNpc[]>();
  for (const npc of gameNpcs) {
    const name = normalizeTextForMatch(npc.name);
    if (!name) continue;
    const group = npcsByName.get(name) ?? [];
    group.push(npc);
    npcsByName.set(name, group);
  }

  for (const [name, group] of npcsByName) {
    const stableNpcIds = new Set(group.map((npc) => npc.id?.trim()).filter((id): id is string => !!id));
    const linkedCharacterIds = new Set(group.map((npc) => npc.characterId?.trim()).filter((id): id is string => !!id));
    const identities = new Set(stableNpcIds.size ? stableNpcIds : linkedCharacterIds);
    for (const character of activeCharacters) {
      if (normalizeTextForMatch(character.name) !== name) continue;
      const activeId = character.id.trim();
      if (!linkedCharacterIds.has(activeId) && !stableNpcIds.has(activeId)) identities.add(activeId);
    }
    if (identities.size > 1) {
      result.delete(name);
      continue;
    }

    const npc = group.find((candidate) => hasAuthoritativeNpcAvatarState(candidate.avatarState)) ?? group[0];
    if (!npc) continue;
    if (hasAuthoritativeNpcAvatarState(npc.avatarState)) {
      if (npc.avatarState.removed || !npc.avatarUrl) {
        result.delete(name);
      } else {
        result.set(name, { ...result.get(name), url: npc.avatarUrl } as T);
      }
    } else if (npc.avatarUrl) {
      result.set(name, { ...result.get(name), url: npc.avatarUrl } as T);
    }
  }
  return result;
}
