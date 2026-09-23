// ──────────────────────────────────────────────
// Character usage: where a character is used, and which cards never are
// ──────────────────────────────────────────────
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api-client";

export type CharacterUsageRole = "member" | "persona" | "party" | "npc" | "gm";

export interface CharacterChatUsage {
  chatId: string;
  chatName: string;
  mode: "conversation" | "roleplay" | "game";
  roles: CharacterUsageRole[];
  gameId: string | null;
  gameName: string | null;
  lastActivityAt: string;
  lastMessageAt: string | null;
  createdAt: string;
}

export interface CharacterGameUsage {
  gameId: string;
  gameName: string;
  sessions: number;
  roles: CharacterUsageRole[];
  lastActivityAt: string;
}

export interface CharacterUsageResponse {
  characterId: string;
  chats: CharacterChatUsage[];
  games: CharacterGameUsage[];
  lastActivityAt: string | null;
  messageCounts: Record<string, number> | null;
  messageCountsTruncated: boolean;
}

export interface UnusedCharactersResponse {
  total: number;
  characters: Array<{
    id: string;
    name: string;
    avatarPath: string | null;
    category: "characters" | "npcs";
    createdAt: string;
  }>;
}

export const characterUsageKeys = {
  all: ["character-usage"] as const,
  detail: (characterId: string, counts: boolean) => [...characterUsageKeys.all, characterId, counts] as const,
  unused: () => [...characterUsageKeys.all, "unused"] as const,
};

export function useCharacterUsage(characterId: string | null | undefined, options: { counts?: boolean } = {}) {
  const counts = options.counts === true;
  return useQuery({
    queryKey: characterUsageKeys.detail(characterId ?? "", counts),
    queryFn: () =>
      api.get<CharacterUsageResponse>(
        `/character-usage/${encodeURIComponent(characterId!)}${counts ? "?counts=1" : ""}`,
      ),
    enabled: !!characterId,
    staleTime: 30_000,
  });
}

export function useUnusedCharacters(enabled: boolean) {
  return useQuery({
    queryKey: characterUsageKeys.unused(),
    queryFn: () => api.get<UnusedCharactersResponse>("/character-usage/unused"),
    enabled,
    staleTime: 10_000,
  });
}
