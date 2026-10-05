import { useQuery, useQueryClient } from "@tanstack/react-query";
import { requireWikiFeatureEnabled, useWikiFeatureEnabled } from "./use-feature-settings";
import type { CampaignFactionWeb, CampaignMemoryAuditPage } from "@marinara-engine/shared";
import { api } from "../lib/api-client";

export function useFactionWeb(chatId: string, entityId: string, offset: number, includeEnded: boolean) {
  const queryClient = useQueryClient();
  const featureEnabled = useWikiFeatureEnabled("factionWeb");
  return useQuery({
    queryKey: ["campaign-memory", "factions", chatId, entityId, offset, includeEnded],
    queryFn: () => {
      requireWikiFeatureEnabled(queryClient, "factionWeb");
      return api.get<CampaignFactionWeb>(
        `/game/${encodeURIComponent(chatId)}/memory/factions?entityId=${encodeURIComponent(entityId)}&offset=${offset}&limit=8&includeEnded=${includeEnded}`,
      );
    },
    enabled: featureEnabled && Boolean(entityId),
    staleTime: 30_000,
  });
}

export function useFactionHistory(chatId: string, recordId: string, offset: number) {
  const queryClient = useQueryClient();
  const featureEnabled = useWikiFeatureEnabled("factionWeb");
  return useQuery({
    queryKey: ["campaign-memory", "faction-history", chatId, recordId, offset],
    queryFn: () => {
      requireWikiFeatureEnabled(queryClient, "factionWeb");
      return api.get<CampaignMemoryAuditPage>(
        `/game/${encodeURIComponent(chatId)}/memory/factions/audit?recordId=${encodeURIComponent(recordId)}&offset=${offset}&limit=10`,
      );
    },
    enabled: featureEnabled && Boolean(recordId),
    staleTime: 30_000,
  });
}
