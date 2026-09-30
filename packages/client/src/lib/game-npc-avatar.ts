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

/** Older or unmarked snapshots cannot undo the server's latest avatar mutation. */
export function resolveNpcAvatarState(
  current: GameNpcAvatarState | null | undefined,
  incoming: GameNpcAvatarState | null | undefined,
): GameNpcAvatarState | undefined {
  const currentIsAuthoritative = hasAuthoritativeNpcAvatarState(current);
  const incomingIsAuthoritative = hasAuthoritativeNpcAvatarState(incoming);
  if (!currentIsAuthoritative) return incomingIsAuthoritative ? incoming : undefined;
  if (!incomingIsAuthoritative || current.revision > incoming.revision) return current;
  if (current.revision === incoming.revision && current.removed && !incoming.removed) return current;
  return incoming;
}

/** Character-linked revisions belong to the card identity, not the NPC's earlier unlinked history. */
export function resolveNpcAvatarStateForIdentity(
  current: GameNpcAvatarState | null | undefined,
  currentCharacterId: string | null | undefined,
  incoming: GameNpcAvatarState | null | undefined,
  incomingCharacterId: string | null | undefined,
): GameNpcAvatarState | undefined {
  const currentId = currentCharacterId?.trim();
  const incomingId = incomingCharacterId?.trim();
  if (currentId && !incomingId) {
    return hasAuthoritativeNpcAvatarState(current) ? current : undefined;
  }
  if (incomingId && incomingId !== currentId) {
    return hasAuthoritativeNpcAvatarState(incoming) ? incoming : undefined;
  }
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

/** Preserve a locally generated portrait while fresh metadata catches up. */
export function mergeGameNpcsPreservingAvatars(
  existingNpcs: readonly GameNpc[],
  incomingNpcs: readonly GameNpc[],
): GameNpc[] {
  const existingById = new Map<string, GameNpc>();
  const existingByNameCandidates = new Map<string, Set<string>>();
  for (const existing of existingNpcs) {
    if (existing.id) existingById.set(existing.id, existing);
    if (!existing.avatarUrl || !existing.name || isNpcAvatarRemoved(existing.avatarState)) continue;
    const name = normalizeNpcAvatarName(existing.name);
    const candidates = existingByNameCandidates.get(name) ?? new Set<string>();
    candidates.add(existing.avatarUrl);
    existingByNameCandidates.set(name, candidates);
  }

  const incomingNameCounts = new Map<string, number>();
  for (const npc of incomingNpcs) {
    const name = normalizeNpcAvatarName(npc.name ?? "");
    if (name) incomingNameCounts.set(name, (incomingNameCounts.get(name) ?? 0) + 1);
  }

  return incomingNpcs.map((npc) => {
    const normalizedName = normalizeNpcAvatarName(npc.name ?? "");
    const nameCandidates = existingByNameCandidates.get(normalizedName);
    const existing =
      existingById.get(npc.id) ??
      (!npc.id && incomingNameCounts.get(normalizedName) === 1 && nameCandidates?.size === 1
        ? [...existingNpcs].find((candidate) => normalizeNpcAvatarName(candidate.name) === normalizedName)
        : undefined);
    const avatarState = resolveNpcAvatarStateForIdentity(
      existing?.avatarState,
      existing?.characterId,
      npc.avatarState,
      npc.characterId,
    );
    const incomingCharacterId = npc.characterId?.trim();
    const existingCharacterId = existing?.characterId?.trim();
    const changedAuthoritySubject = !!incomingCharacterId && incomingCharacterId !== existingCharacterId;
    if (isNpcAvatarRemoved(avatarState)) {
      return {
        ...npc,
        characterId: npc.characterId?.trim() || existing?.characterId,
        avatarUrl: undefined,
        avatarState,
      };
    }

    // An explicit assignment supersedes an older portrait; a stale/unmarked
    // snapshot keeps the current assignment while metadata catches up.
    if (hasAuthoritativeNpcAvatarState(avatarState)) {
      const stateOwner = avatarState === npc.avatarState ? npc : existing;
      if (stateOwner) {
        return {
          ...npc,
          characterId: npc.characterId?.trim() || existing?.characterId,
          avatarUrl: stateOwner.avatarUrl ?? undefined,
          avatarState,
        };
      }
    }

    if (changedAuthoritySubject) {
      return { ...npc, characterId: incomingCharacterId, avatarState, avatarUrl: npc.avatarUrl ?? undefined };
    }

    const preserved = existing?.avatarUrl;
    if (!preserved) return npc;
    if (!npc.avatarUrl || isSameNpcAvatarResource(npc.avatarUrl, preserved)) {
      return { ...npc, characterId: npc.characterId?.trim() || existing?.characterId, avatarUrl: preserved };
    }
    return npc;
  });
}
