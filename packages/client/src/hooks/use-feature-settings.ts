import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  FEATURE_SETTINGS_KEY,
  resolveFeatureEnabled,
  type FeatureSettings,
  type FeatureSettingsResponse,
  type FeatureSwitchName,
} from "@marinara-engine/shared";
import { api } from "../lib/api-client";

const FEATURES_PATH = `/app-settings/${FEATURE_SETTINGS_KEY}`;

export const featureSettingsKeys = {
  all: [FEATURE_SETTINGS_KEY] as const,
};

const WIKI_FEATURES = [
  "campaignMemory",
  "campaignWiki",
  "familyTree",
  "factionWeb",
  "gameCalendar",
  "worldHistory",
] as const;
export type WikiFeature = (typeof WIKI_FEATURES)[number];

/** Re-read effective settings at dispatch so a stale callback cannot use an earlier ON value. */
export function isWikiFeatureEnabled(queryClient: QueryClient, name: WikiFeature): boolean {
  const state = queryClient.getQueryState<FeatureSettingsResponse>(featureSettingsKeys.all);
  if (state?.status !== "success") return false;
  const enabled = (key: WikiFeature) =>
    state.data?.effective?.[key] ?? resolveFeatureEnabled(state.data?.settings, key);
  return enabled(name) && (name === "campaignMemory" || name === "gameCalendar" || enabled("campaignMemory"));
}

export function useWikiFeatureEnabled(name: WikiFeature): boolean {
  useFeatureSettings();
  return isWikiFeatureEnabled(useQueryClient(), name);
}

export function requireWikiFeatureEnabled(queryClient: QueryClient, name: WikiFeature): void {
  if (!isWikiFeatureEnabled(queryClient, name)) throw new Error("FEATURE_DISABLED");
}

/** Server-side Settings > Advanced > Features switches. Absent keys use the registry default (off). */
export function useFeatureSettings() {
  return useQuery<FeatureSettingsResponse>({
    queryKey: featureSettingsKeys.all,
    queryFn: () => api.get<FeatureSettingsResponse>(FEATURES_PATH),
    // Short, like the extension policy query: a .env change can lock or unlock a switch while Settings is open.
    staleTime: 30_000,
  });
}

/**
 * Whether a switch is in effect on the server: the environment value when one pins it, else the
 * saved setting, else the default. Returns the default (off) until the settings load.
 */
export function useFeatureEnabled(name: FeatureSwitchName): boolean {
  const query = useFeatureSettings();
  if (!query.isSuccess) return false;
  const data = query.data;
  return data?.effective?.[name] ?? resolveFeatureEnabled(data?.settings, name);
}

/** Recheck at queued/automatic work boundaries rather than capturing an earlier ON value. */
export function getCachedFeatureEnabled(qc: QueryClient | null, name: FeatureSwitchName): boolean {
  if (qc?.getQueryState(featureSettingsKeys.all)?.status !== "success") return false;
  const data = qc.getQueryData<FeatureSettingsResponse>(featureSettingsKeys.all);
  return data?.effective?.[name] ?? resolveFeatureEnabled(data?.settings, name);
}

export function isRewriteFeatureEnabled(
  queryClient: ReturnType<typeof useQueryClient>,
  name: "draftRewrites" | "localRewriteConnection",
): boolean {
  const query = queryClient.getQueryState<FeatureSettingsResponse>(featureSettingsKeys.all);
  return (
    query?.status === "success" && (query.data?.effective?.[name] ?? resolveFeatureEnabled(query.data?.settings, name))
  );
}

/** Read permission at dispatch time so an old callback cannot retain a previous ON value. */
export function isWidgetFeatureEnabledNow(
  queryClient: QueryClient,
  name: "extendedHudWidgets" | "playerStatus",
): boolean {
  const state = queryClient.getQueryState<FeatureSettingsResponse>(featureSettingsKeys.all);
  if (!state?.data || state.status !== "success") return false;
  return state.data.effective?.[name] ?? resolveFeatureEnabled(state.data.settings, name);
}

/** Save the complete switch object (omitted keys return to their defaults). */
export function useSaveFeatureSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: FeatureSettings) => api.put<FeatureSettingsResponse>(FEATURES_PATH, settings),
    onSuccess: async (response) => {
      await queryClient.cancelQueries({ queryKey: featureSettingsKeys.all });
      queryClient.setQueryData<FeatureSettingsResponse>(featureSettingsKeys.all, response);
    },
  });
}

/** Read current permission at dispatch time rather than trusting a stale render. */
export function isCampaignFeatureEnabled(
  queryClient: QueryClient,
  name:
    | "gameContinuity"
    | "campaignMemory"
    | "campaignIndex"
    | "gameMemoryControls"
    | "campaignMemoryRecall"
    | "sceneTimeline"
    | "gameContactBook"
    | "campaignPortraits",
): boolean {
  const state = queryClient.getQueryState<FeatureSettingsResponse>(featureSettingsKeys.all);
  if (state?.status !== "success") return false;
  return state.data?.effective?.[name] ?? resolveFeatureEnabled(state.data?.settings, name);
}

export function isSavedCharacterProfilesEnabled(queryClient: ReturnType<typeof useQueryClient>): boolean {
  const query = queryClient.getQueryState<FeatureSettingsResponse>(featureSettingsKeys.all);
  return (
    query?.status === "success" &&
    (query.data?.effective?.savedCharacterProfiles ??
      resolveFeatureEnabled(query.data?.settings, "savedCharacterProfiles"))
  );
}

/** Recheck the current settings at optional action dispatch, including retained callbacks. */
export function isGalleryBrowsingEnabled(queryClient: ReturnType<typeof useQueryClient>): boolean {
  const query = queryClient.getQueryState<FeatureSettingsResponse>(featureSettingsKeys.all);
  return (
    query?.status === "success" &&
    (query.data?.effective?.galleryBrowsing ?? resolveFeatureEnabled(query.data?.settings, "galleryBrowsing"))
  );
}

/** Reject callbacks retained from an enabled render after the setting turns off. */
export function isInventoryBrowsingEnabled(queryClient: ReturnType<typeof useQueryClient>): boolean {
  const state = queryClient.getQueryState<FeatureSettingsResponse>(featureSettingsKeys.all);
  return (
    state?.status === "success" &&
    (state.data?.effective?.inventoryBrowsing ?? resolveFeatureEnabled(state.data?.settings, "inventoryBrowsing"))
  );
}

export function isGameGuideEnabled(queryClient: ReturnType<typeof useQueryClient>): boolean {
  const state = queryClient.getQueryState<FeatureSettingsResponse>(featureSettingsKeys.all);
  return (
    state?.status === "success" &&
    (state.data?.effective?.gameGuide ?? resolveFeatureEnabled(state.data?.settings, "gameGuide"))
  );
}
