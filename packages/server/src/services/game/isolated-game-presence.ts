export interface IsolatedPresenceNpc {
  id: string;
  characterId?: string | null;
  name: string;
}
export interface IsolatedPresenceCharacter {
  id: string;
  name: string;
}

const normalizePresenceName = (value: string): string =>
  value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase();

export function selectIsolatedActorCandidateIds(args: {
  presentIds: ReadonlySet<string>;
  npcs: readonly IsolatedPresenceNpc[];
  characters: readonly IsolatedPresenceCharacter[];
  excludedIds?: readonly string[];
}): Set<string> {
  const excluded = new Set(args.excludedIds ?? []);
  const result = new Set([...args.presentIds].filter((id) => id && !excluded.has(id)));
  // The caller supplies the campaign's known identity catalogue. Eligibility is
  // therefore bounded by that catalogue, while presence remains a separate
  // planner-validated concern.
  const identities = [
    ...args.npcs.map((npc) => ({ id: npc.characterId?.trim() || npc.id.trim(), name: npc.name })),
    ...args.characters.map((character) => ({ id: character.id.trim(), name: character.name })),
  ].filter((identity) => identity.id && normalizePresenceName(identity.name));
  for (const identity of identities) {
    if (!result.has(identity.id) && !excluded.has(identity.id)) result.add(identity.id);
  }
  return result;
}

export function resolveIsolatedPresentActorIds(args: {
  snapshotIds: readonly string[];
  sceneNames: readonly string[];
  npcs: readonly IsolatedPresenceNpc[];
  characters: readonly IsolatedPresenceCharacter[];
  excludedIds?: readonly string[];
}): Set<string> {
  const ids = new Set(args.snapshotIds.filter(Boolean));
  const excluded = new Set(args.excludedIds ?? []);
  const normalize = (value: string) => value.trim().toLocaleLowerCase();
  for (const name of args.sceneNames) {
    const key = normalize(name);
    if (!key) continue;
    const npcIds = args.npcs
      .filter((npc) => normalize(npc.name) === key)
      .map((npc) => npc.characterId?.trim() || npc.id)
      .filter(Boolean);
    const characterIds = args.characters
      .filter((character) => normalize(character.name) === key)
      .map((character) => character.id);
    const candidates = [...new Set([...npcIds, ...characterIds])];
    if (candidates.length === 1) ids.add(candidates[0]!);
  }
  for (const id of excluded) ids.delete(id);
  return ids;
}
