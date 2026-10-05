// ──────────────────────────────────────────────
// React Query: Library campaigns
// Game Mode campaigns derived by the server from session
// chats, plus manual add/remove of library items.
// ──────────────────────────────────────────────
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  resolveFeatureEnabled,
  type FeatureSettingsResponse,
  type LibraryCampaign,
  type LibraryCampaignItemType,
  type LibraryCampaignList,
} from "@marinara-engine/shared";
import { featureSettingsKeys, useFeatureEnabled } from "./use-feature-settings";
import { api } from "../lib/api-client";
import { characterKeys } from "./use-characters";
import { lorebookKeys } from "./use-lorebooks";
import { getCampaignItemIds } from "../lib/library-campaign-filter";

export type { LibraryCampaign, LibraryCampaignItemType } from "@marinara-engine/shared";
export { campaignFilterRevision, getCampaignItemIds } from "../lib/library-campaign-filter";

export const libraryCampaignKeys = {
  all: ["library-campaigns"] as const,
};

export function useLibraryCampaigns() {
  const enabled = useFeatureEnabled("campaignRoster");
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: libraryCampaignKeys.all,
    enabled,
    queryFn: async () => {
      if (!campaignRosterEnabledAtDispatch(qc)) throw new Error("FEATURE_DISABLED:campaignRoster");
      const result = (await api.get<LibraryCampaignList>("/library/campaigns")).campaigns;
      return result;
    },
    staleTime: 30_000,
  });
  return { ...query, data: enabled ? query.data : undefined };
}

export function campaignRosterEnabledAtDispatch(qc: QueryClient): boolean {
  if (qc.getQueryState(featureSettingsKeys.all)?.status !== "success") return false;
  const data = qc.getQueryData<FeatureSettingsResponse>(featureSettingsKeys.all);
  return data?.effective?.campaignRoster ?? resolveFeatureEnabled(data?.settings, "campaignRoster");
}

/** Campaigns per library item id, in the campaign list's order (most recently played first). */
export function useCampaignMembership(campaigns: LibraryCampaign[] | undefined, itemType: LibraryCampaignItemType) {
  const enabled = useFeatureEnabled("campaignRoster");
  return useMemo(() => {
    const membership = new Map<string, LibraryCampaign[]>();
    for (const campaign of enabled ? (campaigns ?? []) : []) {
      for (const id of getCampaignItemIds(campaign, itemType)) {
        const list = membership.get(id);
        if (list) list.push(campaign);
        else membership.set(id, [campaign]);
      }
    }
    return membership;
  }, [campaigns, itemType, enabled]);
}

export function useUpdateLibraryCampaignItems() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      campaignId,
      itemType,
      itemIds,
      action,
    }: {
      campaignId: string;
      itemType: LibraryCampaignItemType;
      itemIds: string[];
      action: "add" | "remove";
    }) => {
      if (!campaignRosterEnabledAtDispatch(qc)) throw new Error("FEATURE_DISABLED:campaignRoster");
      const ids = Array.from(new Set(itemIds));
      if (ids.length === 0) return;
      const path = `/library/campaigns/${encodeURIComponent(campaignId)}/items${action === "remove" ? "/remove" : ""}`;
      await api.post(path, { itemType, itemIds: ids });
    },
    // Returning the refetch keeps the mutation pending until the campaign list is
    // fresh, so the picker's checkboxes never offer a toggle based on stale state.
    // Library pages refetch in the background (a grouped view may hold many pages).
    onSuccess: (_result, variables) => {
      // Campaign-filtered library pages are resolved on the server.
      if (variables.itemType === "lorebook") void qc.invalidateQueries({ queryKey: lorebookKeys.list() });
      if (variables.itemType === "character") {
        void qc.invalidateQueries({ queryKey: [...characterKeys.list(), "page"] });
      }
      return qc.invalidateQueries({ queryKey: libraryCampaignKeys.all });
    },
  });
}
