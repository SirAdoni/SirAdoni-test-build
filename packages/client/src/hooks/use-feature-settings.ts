import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FEATURE_SETTINGS_KEY,
  resolveFeatureEnabled,
  resolveFeatureNumber,
  type FeatureNumberName,
  type FeatureSettings,
  type FeatureSettingsResponse,
  type FeatureSwitchName,
} from "@marinara-engine/shared";
import { api } from "../lib/api-client";

const FEATURES_PATH = `/app-settings/${FEATURE_SETTINGS_KEY}`;

export const featureSettingsKeys = {
  all: [FEATURE_SETTINGS_KEY] as const,
};

/** Server-side Settings > Features switches. Absent keys are ON. */
export function useFeatureSettings() {
  return useQuery<FeatureSettingsResponse>({
    queryKey: featureSettingsKeys.all,
    queryFn: () => api.get<FeatureSettingsResponse>(FEATURES_PATH),
    // Refresh while Settings is open so environment locks are reflected promptly.
    staleTime: 30_000,
  });
}

/** ON until the settings load, so nothing hides or changes before the server answers. */
export function useFeatureEnabled(name: FeatureSwitchName): boolean {
  const data = useFeatureSettings().data;
  return data?.effective?.[name] ?? resolveFeatureEnabled(data?.settings, name);
}

export function useFeatureNumber(name: FeatureNumberName): number {
  return resolveFeatureNumber(useFeatureSettings().data?.settings, name);
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
