export type ScenePresenceIdentity = {
  id: string;
  name: string;
  avatarUrl?: string | null;
};

export type ResolvedScenePresence<T extends ScenePresenceIdentity> = {
  sceneMembers: T[];
  sceneExtras: string[];
  scopedLibraryCandidates: T[];
  libraryAvatarLookup: Map<string, string>;
};

function normalizeSceneName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Resolve only names already recorded as present in the current scene. */
export function resolveScenePresence<T extends ScenePresenceIdentity>(
  presentNames: readonly string[],
  existingCandidates: readonly T[],
  libraryCandidates: readonly T[],
): ResolvedScenePresence<T> {
  const existingByName = new Map<string, T[]>();
  const libraryByName = new Map<string, T[]>();
  const addByName = (map: Map<string, T[]>, candidate: T) => {
    const normalized = normalizeSceneName(candidate.name);
    if (!normalized) return;
    const entries = map.get(normalized) ?? [];
    entries.push(candidate);
    map.set(normalized, entries);
  };

  for (const candidate of existingCandidates) addByName(existingByName, candidate);
  for (const candidate of libraryCandidates) addByName(libraryByName, candidate);

  const sceneMembers: T[] = [];
  const sceneExtras: string[] = [];
  const scopedLibraryCandidates: T[] = [];
  const libraryAvatarLookup = new Map<string, string>();
  const resolvedIds = new Set<string>();
  const scopedLibraryIds = new Set<string>();
  const seenNames = new Set<string>();

  for (const rawName of presentNames) {
    const name = typeof rawName === "string" ? rawName.trim() : "";
    const normalizedName = normalizeSceneName(name);
    if (!normalizedName || seenNames.has(normalizedName)) continue;
    seenNames.add(normalizedName);

    const existingMatches = existingByName.get(normalizedName) ?? [];
    const libraryMatches = libraryByName.get(normalizedName) ?? [];
    const libraryMatch = libraryMatches.length === 1 ? libraryMatches[0] : undefined;
    const existingMatch = existingMatches.length === 1 ? existingMatches[0] : undefined;
    const match = libraryMatch
      ? ({ ...(existingMatch ?? {}), ...libraryMatch, name } as T)
      : existingMatch
        ? ({ ...existingMatch, name } as T)
        : undefined;

    if (!match || resolvedIds.has(match.id)) {
      sceneExtras.push(name);
      continue;
    }

    resolvedIds.add(match.id);
    sceneMembers.push(match);
    if (libraryMatch && !scopedLibraryIds.has(libraryMatch.id)) {
      scopedLibraryIds.add(libraryMatch.id);
      scopedLibraryCandidates.push(libraryMatch);
      if (typeof libraryMatch.avatarUrl === "string" && libraryMatch.avatarUrl.trim()) {
        libraryAvatarLookup.set(normalizedName, libraryMatch.avatarUrl.trim());
      }
    }
  }

  return { sceneMembers, sceneExtras, scopedLibraryCandidates, libraryAvatarLookup };
}
