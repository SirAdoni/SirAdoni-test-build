import { characterNamesMatch } from "./game-character-name-match";

export interface SavedGameCharacterProfileSource {
  id?: string;
  name: string;
  comment?: string | null;
  description?: string;
  personality?: string;
  backstory?: string;
  appearance?: string;
  tags?: string[];
}

export interface GameCharacterProfile {
  description?: string;
  personality?: string;
  backstory?: string;
  appearance?: string;
  notes?: string;
  tags?: string[];
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizeSavedGameCharacterProfile(
  source: SavedGameCharacterProfileSource | null | undefined,
): GameCharacterProfile | undefined {
  if (!source) return undefined;
  const description = optionalText(source.description);
  const personality = optionalText(source.personality);
  const backstory = optionalText(source.backstory);
  const appearance = optionalText(source.appearance);
  const notes = optionalText(source.comment);
  const profile: GameCharacterProfile = {
    ...(description ? { description } : {}),
    ...(personality ? { personality } : {}),
    ...(backstory ? { backstory } : {}),
    ...(appearance ? { appearance } : {}),
    ...(notes ? { notes } : {}),
    ...(Array.isArray(source.tags)
      ? {
          tags: source.tags
            .filter((tag): tag is string => typeof tag === "string" && !!tag.trim())
            .map((tag) => tag.trim()),
        }
      : {}),
  };
  return Object.values(profile).some((value) => (Array.isArray(value) ? value.length > 0 : !!value))
    ? profile
    : undefined;
}

/** A stored ID is authoritative. Name matching is only used for legacy entries with no stable ID. */
export function findSavedGameCharacterProfile<T extends SavedGameCharacterProfileSource>(
  savedCharacters: readonly T[],
  selectedId: string | null | undefined,
  selectedName: string,
): T | undefined {
  if (selectedId) return savedCharacters.find((character) => character.id === selectedId);
  const matches = savedCharacters.filter((character) => characterNamesMatch(character.name, selectedName));
  return matches.length === 1 ? matches[0] : undefined;
}
