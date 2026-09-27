import { useQuery } from "@tanstack/react-query";
import type { CampaignFactionWeb, CampaignMemoryAuditPage } from "@marinara-engine/shared";
import { api } from "../lib/api-client";

export function useFactionWeb(chatId: string, entityId: string, offset: number, includeEnded: boolean) {
  return useQuery({
    queryKey: ["campaign-memory", "factions", chatId, entityId, offset, includeEnded],
    queryFn: () =>
      api.get<CampaignFactionWeb>(
        `/game/${encodeURIComponent(chatId)}/memory/factions?entityId=${encodeURIComponent(entityId)}&offset=${offset}&limit=8&includeEnded=${includeEnded}`,
      ),
    enabled: Boolean(entityId),
    staleTime: 30_000,
  });
}

export function useFactionHistory(chatId: string, recordId: string, offset: number) {
  return useQuery({
    queryKey: ["campaign-memory", "faction-history", chatId, recordId, offset],
    queryFn: () =>
      api.get<CampaignMemoryAuditPage>(
        `/game/${encodeURIComponent(chatId)}/memory/audit?recordId=${encodeURIComponent(recordId)}&offset=${offset}&limit=10`,
      ),
    enabled: Boolean(recordId),
    staleTime: 30_000,
  });
}
