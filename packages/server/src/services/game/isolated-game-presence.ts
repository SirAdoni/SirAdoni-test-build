export interface IsolatedPresenceNpc {
  id: string;
  characterId?: string | null;
  name: string;
}
export interface IsolatedPresenceCharacter {
  id: string;
  name: string;
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
