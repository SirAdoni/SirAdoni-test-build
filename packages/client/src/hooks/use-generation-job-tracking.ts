import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api-client";
import { isActiveJob, type TrackedGenerationJob } from "../lib/generation-job-tracking";

export interface GenerationJobTrackingSettings {
  enabled: boolean;
  retentionDays: number;
  maxRecords: number;
}

export const generationJobTrackingKeys = {
  all: ["generation-job-records"] as const,
  settings: () => [...generationJobTrackingKeys.all, "settings"] as const,
  list: () => [...generationJobTrackingKeys.all, "list"] as const,
  detail: (id: string) => [...generationJobTrackingKeys.all, "detail", id] as const,
};

/** Server-side "Track generation jobs" setting. Off by default; one read on load, no writes. */
export function useGenerationJobTrackingSettings() {
  return useQuery({
    queryKey: generationJobTrackingKeys.settings(),
    queryFn: () => api.get<GenerationJobTrackingSettings>("/generation-job-records/settings"),
    staleTime: 5 * 60_000,
  });
}

export function useGenerationJobTrackingEnabled(): boolean {
  return useGenerationJobTrackingSettings().data?.enabled === true;
}

export function useSetGenerationJobTracking() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) =>
      api.put<GenerationJobTrackingSettings>("/generation-job-records/settings", { enabled }),
    onSuccess: (settings) => {
      queryClient.setQueryData(generationJobTrackingKeys.settings(), settings);
      queryClient.invalidateQueries({ queryKey: generationJobTrackingKeys.list() });
    },
  });
}

/**
 * Recent tracked jobs, shared by the indicator, the recovery host and the jobs viewer (one request).
 * Polls quickly while something runs, slowly otherwise, and never while tracking is off.
 */
export function useTrackedGenerationJobs(enabled: boolean) {
  return useQuery({
    queryKey: generationJobTrackingKeys.list(),
    queryFn: async () =>
      (await api.get<{ records: TrackedGenerationJob[] }>("/generation-job-records?limit=100")).records,
    enabled,
    staleTime: 2_000,
    refetchOnWindowFocus: true,
    refetchInterval: (query) => (!enabled ? false : query.state.data?.some(isActiveJob) ? 3_000 : 30_000),
    refetchIntervalInBackground: false,
  });
}

export function useTrackedGenerationJob(id: string | null, enabled: boolean) {
  return useQuery({
    queryKey: generationJobTrackingKeys.detail(id ?? ""),
    queryFn: () => api.get<TrackedGenerationJob>(`/generation-job-records/${encodeURIComponent(id ?? "")}`),
    enabled: enabled && Boolean(id),
    staleTime: 2_000,
  });
}

export async function markGenerationJobsSeen(ids: readonly string[], recovered: boolean): Promise<void> {
  if (ids.length === 0) return;
  await api.post("/generation-job-records/seen", { ids: ids.slice(0, 100), recovered });
}
