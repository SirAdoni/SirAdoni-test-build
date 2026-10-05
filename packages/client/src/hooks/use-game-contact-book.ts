import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { isCampaignFeatureEnabled, useFeatureEnabled } from "./use-feature-settings";

export interface GameContact {
  id: string;
  sourceChatId: string;
  characterId?: string;
  name: string;
  avatar?: string;
  portraitDescription?: string;
  gender?: string;
  pronouns?: string;
  avatarState?: { revision: number; removed: boolean };
  opinion?: number | string;
  relationshipStatus?: string;
  automaticCategories: string[];
  evidenceMessageIds: string[];
}

export interface GameContactBookResult {
  contacts: GameContact[];
  coverage: { complete: boolean; pendingSessions: number };
}

export function useGameContactBook(chatId: string, refreshKey?: string, active = true) {
  const enabled = useFeatureEnabled("gameContactBook");
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: ["game-contact-book", chatId, refreshKey],
    enabled: active && enabled && !!chatId,
    queryFn: () => {
      if (!isCampaignFeatureEnabled(queryClient, "gameContactBook"))
        throw new Error("Feature disabled: gameContactBook");
      return api.get<GameContactBookResult>(`/game/${encodeURIComponent(chatId)}/contacts`);
    },
    staleTime: 15_000,
  });
}
