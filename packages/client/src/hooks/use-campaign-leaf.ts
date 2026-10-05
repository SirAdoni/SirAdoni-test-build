import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CampaignMemoryAuthoringRequest, CampaignMemoryEntity, CampaignMemoryPage } from "@marinara-engine/shared";
import { api } from "../lib/api-client";
import { requireWikiFeatureEnabled, useWikiFeatureEnabled } from "./use-feature-settings";

type Leaf = "factionWeb" | "worldHistory";
export type CampaignLeafEntity = Pick<CampaignMemoryEntity, "entityId" | "aliases" | "kind" | "status">;
const paths = { factionWeb: "factions", worldHistory: "world-history" } as const;

export function useCampaignLeafEntities(
  chatId: string,
  leaf: Leaf,
  options: {
    query?: string;
    kind: "character" | "organization" | "location";
    offset?: number;
    limit?: number;
  },
) {
  const queryClient = useQueryClient();
  const enabled = useWikiFeatureEnabled(leaf);
  return useQuery({
    queryKey: ["campaign-memory", paths[leaf], "entities", chatId, options],
    enabled: enabled && Boolean(chatId),
    queryFn: () => {
      requireWikiFeatureEnabled(queryClient, leaf);
      const params = new URLSearchParams({
        q: options.query ?? "",
        kind: options.kind,
        offset: String(options.offset ?? 0),
        limit: String(options.limit ?? 20),
      });
      return api.get<CampaignMemoryPage<CampaignLeafEntity>>(
        `/game/${encodeURIComponent(chatId)}/memory/${paths[leaf]}/entities?${params}`,
      );
    },
    staleTime: 30_000,
  });
}

export function useCampaignLeafMutation(chatId: string, leaf: Leaf) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: CampaignMemoryAuthoringRequest) => {
      requireWikiFeatureEnabled(queryClient, leaf);
      return api.post<unknown>(`/game/${encodeURIComponent(chatId)}/memory/${paths[leaf]}/mutations`, request);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["campaign-memory"] });
    },
  });
}
