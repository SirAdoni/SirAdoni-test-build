import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { UsageDashboardSettings, UsageSummary } from "@marinara-engine/shared";
import { api } from "../lib/api-client";
import { translate } from "../localization/i18n";

export const usageKeys = {
  all: ["usage"] as const,
  summary: (from: string, to: string, tzOffsetMinutes: number) =>
    [...usageKeys.all, "summary", from, to, tzOffsetMinutes] as const,
  settings: () => [...usageKeys.all, "settings"] as const,
};

export function useUsageSummary(range: { from: string; to: string }, enabled = true) {
  // Date#getTimezoneOffset is UTC minus local; the server wants local minus UTC.
  const tzOffsetMinutes = -new Date().getTimezoneOffset();
  return useQuery({
    queryKey: usageKeys.summary(range.from, range.to, tzOffsetMinutes),
    queryFn: () => {
      const params = new URLSearchParams({ from: range.from, to: range.to, tzOffsetMinutes: String(tzOffsetMinutes) });
      return api.get<UsageSummary>(`/usage/summary?${params.toString()}`);
    },
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

export function useUsageDashboardSettings() {
  return useQuery({
    queryKey: usageKeys.settings(),
    queryFn: () => api.get<UsageDashboardSettings>("/usage/settings"),
    staleTime: 5 * 60_000,
  });
}

export function useSaveUsageDashboardSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: UsageDashboardSettings) => api.put<UsageDashboardSettings>("/usage/settings", settings),
    onSuccess: (settings) => {
      queryClient.setQueryData(usageKeys.settings(), settings);
    },
    onError: () => {
      toast.error(translate("usage.pricing.saveFailed"));
    },
  });
}
