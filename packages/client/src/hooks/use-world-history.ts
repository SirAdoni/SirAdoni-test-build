import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { WorldHistoryPage } from "@marinara-engine/shared";
import { api } from "../lib/api-client";
import { requireWikiFeatureEnabled, useWikiFeatureEnabled } from "./use-feature-settings";

export function useWorldHistory(
  chatId: string,
  filters: { q: string; era?: string; offset: number; archived: boolean },
) {
  const qc = useQueryClient();
  const enabled = useWikiFeatureEnabled("worldHistory");
  return useQuery({
    queryKey: ["campaign-memory", "world-history", chatId, filters],
    queryFn: ({ signal }) => {
      requireWikiFeatureEnabled(qc, "worldHistory");
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
    enabled: !!chatId && enabled,
    staleTime: 10_000,
  });
}
