import type { AvatarCrop } from "@marinara-engine/shared";
import type { CharacterSheetCard } from "./GameCharacterSheet";

export type SceneCharacterCardCandidate = {
  id: string;
  name: string;
  avatarUrl?: string | null;
  avatarCrop?: AvatarCrop | null;
};

export type SceneCharacterGameCard = {
  id?: unknown;
  characterId?: unknown;
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
  return {
    ...existing,
    avatarUrl: existing.avatarUrl ?? member.avatarUrl ?? library?.avatarUrl ?? null,
    avatarCrop: existing.avatarCrop ?? member.avatarCrop ?? library?.avatarCrop ?? null,
    level: existing.level ?? fallbackLevel,
    gameCard: existing.gameCard ?? gameCardFromRaw(rawGameCard),
  };
}

function findGameCard(
  memberId: string,
  memberName: string,
  gameCards: SceneCharacterGameCard[],
): SceneCharacterGameCard | undefined {
  const hasIdentity = (card: SceneCharacterGameCard) =>
    (typeof card.characterId === "string" && card.characterId.trim().length > 0) ||
    (typeof card.id === "string" && card.id.trim().length > 0);
  const hasMemberIdentity = (card: SceneCharacterGameCard) => card.characterId === memberId || card.id === memberId;
  const stableMatches = gameCards.filter(hasMemberIdentity);
  if (stableMatches.length > 0) return stableMatches.length === 1 ? stableMatches[0] : undefined;

  const nameMatches = gameCards.filter(
    (card) => typeof card.name === "string" && normalize(card.name) === normalize(memberName),
  );
  // If a same-name card is explicitly bound to another identity, do not borrow it.
  const unbound = nameMatches.filter((card) => !hasIdentity(card));
  return unbound.length === 1 && unbound.length === nameMatches.length ? unbound[0] : undefined;
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
    const rawGameCard = findGameCard(member.id, member.name, gameCards);
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

export interface GameSceneCharacterSnapshot {
  name: string;
  outfit?: string | null;
  appearance?: string | null;
  mood?: string | null;
  thoughts?: string | null;
  avatarPath?: string | null;
  avatarCrop?: unknown;
  stats?: Array<{ name: string; value: number; max?: number; color?: string }> | null;
  customFields?: Record<string, string> | null;
}

export interface GameSceneCharacterSheetCard {
  title: string;
  subtitle?: string;
  mood?: string;
  status?: string;
  avatarUrl?: string | null;
  avatarCrop?: unknown;
  stats?: Array<{ name: string; value: number; max?: number; color?: string }>;
  customFields?: Record<string, string>;
  inventory?: Array<{ name: string; quantity?: number; location?: string }>;
  gameCard?: unknown;
}

/** Scene snapshots own any field they actually carry, including an explicit null avatar clear. */
export function overlayGameSceneCharacterCard<T extends GameSceneCharacterSheetCard>(
  existing: T | undefined,
  scene: GameSceneCharacterSnapshot,
  normalizedAvatarCrop: unknown,
): T {
  return {
    ...existing,
    title: scene.name || existing?.title || "Unknown",
    subtitle: scene.outfit || scene.appearance || existing?.subtitle || undefined,
    mood: scene.mood || existing?.mood || undefined,
    status: scene.thoughts || existing?.status || undefined,
    avatarUrl: scene.avatarPath !== undefined ? scene.avatarPath : (existing?.avatarUrl ?? null),
    avatarCrop: normalizedAvatarCrop ?? existing?.avatarCrop ?? null,
    stats:
      (scene.stats ?? []).length > 0
        ? scene.stats!.map((stat) => ({ name: stat.name, value: stat.value, max: stat.max, color: stat.color }))
        : existing?.stats,
    customFields: scene.customFields || existing?.customFields,
    inventory: existing?.inventory,
    gameCard: existing?.gameCard,
  } as T;
}
