import { useQuery } from "@tanstack/react-query";
import type { WorldHistoryPage } from "@marinara-engine/shared";
import { api } from "../lib/api-client";

export function useWorldHistory(
  chatId: string,
  filters: { q: string; era?: string; offset: number; archived: boolean },
) {
  return useQuery({
    queryKey: ["campaign-memory", "world-history", chatId, filters],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({
        q: filters.q,
        offset: String(filters.offset),
        limit: "25",
        archived: String(filters.archived),
      });
      if (filters.era !== undefined) params.set("era", filters.era);
      return api.get<WorldHistoryPage>(`/game/${encodeURIComponent(chatId)}/memory/world-history?${params}`, {
        signal,
      });
    },
    enabled: !!chatId,
    staleTime: 10_000,
  });
}
