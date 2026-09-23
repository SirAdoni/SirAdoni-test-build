import type { AvatarCrop } from "@marinara-engine/shared";
import type { GameCharacterLibraryProfile } from "../../lib/game-character-profile";
import type { CharacterSheetCard } from "./GameCharacterSheet";

export type SceneCharacterCardCandidate = {
  id: string;
  name: string;
  avatarUrl?: string | null;
  avatarCrop?: AvatarCrop | null;
  libraryProfile?: GameCharacterLibraryProfile;
};

export type SceneCharacterGameCard = {
  name?: unknown;
  shortDescription?: unknown;
  class?: unknown;
  abilities?: unknown;
  strengths?: unknown;
  weaknesses?: unknown;
  extra?: unknown;
  rpgStats?: unknown;
};

function normalize(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function gameCardFromRaw(rawGameCard: SceneCharacterGameCard | undefined): CharacterSheetCard["gameCard"] {
  if (!rawGameCard) return undefined;
  return {
    shortDescription: typeof rawGameCard.shortDescription === "string" ? rawGameCard.shortDescription : "",
    class: typeof rawGameCard.class === "string" ? rawGameCard.class : "",
    abilities: asStringArray(rawGameCard.abilities),
    strengths: asStringArray(rawGameCard.strengths),
    weaknesses: asStringArray(rawGameCard.weaknesses),
    extra:
      rawGameCard.extra && typeof rawGameCard.extra === "object" && !Array.isArray(rawGameCard.extra)
        ? Object.fromEntries(Object.entries(rawGameCard.extra).map(([key, value]) => [key, String(value)] as const))
        : {},
    rpgStats: rawGameCard.rpgStats as NonNullable<CharacterSheetCard["gameCard"]>["rpgStats"],
  };
}

function findLibraryCandidate(
  memberId: string,
  memberName: string,
  existing: CharacterSheetCard | undefined,
  libraryCandidates: SceneCharacterCardCandidate[],
): SceneCharacterCardCandidate | undefined {
  const stable = libraryCandidates.find((candidate) => candidate.id === memberId);
  if (stable) return stable;
  const names = new Set([normalize(memberName), existing ? normalize(existing.title) : ""].filter(Boolean));
  const matches = libraryCandidates.filter((candidate) => names.has(normalize(candidate.name)));
  return matches.length === 1 ? matches[0] : undefined;
}

function enrichCard(
  existing: CharacterSheetCard,
  member: { name: string; avatarUrl?: string | null; avatarCrop?: AvatarCrop | null },
  library: SceneCharacterCardCandidate | undefined,
  rawGameCard: SceneCharacterGameCard | undefined,
  fallbackLevel: number,
): CharacterSheetCard {
  const libraryProfile = library?.libraryProfile
    ? { ...existing.libraryProfile, ...library.libraryProfile }
    : existing.libraryProfile;
  return {
    ...existing,
    avatarUrl: existing.avatarUrl ?? member.avatarUrl ?? library?.avatarUrl ?? null,
    avatarCrop: existing.avatarCrop ?? member.avatarCrop ?? library?.avatarCrop ?? null,
    libraryProfile,
    level: existing.level ?? libraryProfile?.level ?? fallbackLevel,
    gameCard: existing.gameCard ?? gameCardFromRaw(rawGameCard),
  };
}

export function ensureSceneCharacterCards(
  partyCards: Record<string, CharacterSheetCard>,
  sceneMembers: Array<{
    id: string;
    name: string;
    avatarUrl?: string | null;
    avatarCrop?: AvatarCrop | null;
  }>,
  libraryCandidates: SceneCharacterCardCandidate[],
  gameCards: SceneCharacterGameCard[],
  fallbackLevel: number,
): Record<string, CharacterSheetCard> {
  const cards = { ...partyCards };
  for (const member of sceneMembers) {
    const existing = cards[member.id];
    const library = findLibraryCandidate(member.id, member.name, existing, libraryCandidates);
    const rawGameCard = gameCards.find(
      (card) => typeof card.name === "string" && normalize(card.name) === normalize(member.name),
    );
    cards[member.id] = existing
      ? enrichCard(existing, member, library, rawGameCard, fallbackLevel)
      : enrichCard(
          {
            title: member.name,
            avatarUrl: undefined,
            avatarCrop: undefined,
          },
          member,
          library,
          rawGameCard,
          fallbackLevel,
        );
  }
  return cards;
}

/** Resolve a selected library profile without widening the scene-presence map. */
export function resolveCharacterSheetCard(
  cards: Record<string, CharacterSheetCard>,
  characterId: string | null,
  libraryCandidates: SceneCharacterCardCandidate[],
  gameCards: SceneCharacterGameCard[],
  fallbackLevel: number,
): CharacterSheetCard | undefined {
  if (!characterId) return undefined;
  const existing = cards[characterId];
  const candidate = libraryCandidates.find((entry) => entry.id === characterId);
  if (existing) {
    const resolved = ensureSceneCharacterCards(
      cards,
      [{ id: characterId, name: existing.title }],
      libraryCandidates,
      gameCards,
      fallbackLevel,
    );
    return resolved[characterId];
  }
  if (!candidate) return undefined;
  const resolved = ensureSceneCharacterCards(
    cards,
    [{ id: candidate.id, name: candidate.name, avatarUrl: candidate.avatarUrl, avatarCrop: candidate.avatarCrop }],
    [candidate],
    gameCards,
    fallbackLevel,
  );
  return resolved[characterId];
}
