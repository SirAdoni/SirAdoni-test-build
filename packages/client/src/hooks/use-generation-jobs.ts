import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api-client";

export type GenerationJobStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";

export interface GenerationJobMetadata {
  id: string;
  kind: string;
  label: string;
  chatId: string | null;
  status: GenerationJobStatus;
  createdAt: string;
  updatedAt: string;
  error: string | null;
  resultAvailable: boolean;
}

type GenerationJobsResponse = GenerationJobMetadata[] | { jobs?: GenerationJobMetadata[] };

export const generationJobKeys = {
  all: ["generation-jobs"] as const,
  list: () => [...generationJobKeys.all, "list"] as const,
  result: (id: string) => [...generationJobKeys.all, "result", id] as const,
};

function normalizeJobs(response: GenerationJobsResponse): GenerationJobMetadata[] {
  return Array.isArray(response) ? response : (response.jobs ?? []);
}

export function useGenerationJobs(open: boolean) {
  return useQuery({
    queryKey: generationJobKeys.list(),
    queryFn: async () => normalizeJobs(await api.get<GenerationJobsResponse>("/generation-jobs")),
    enabled: open,
    staleTime: 5_000,
    refetchInterval: (query) => (open && query.state.data?.some((job) => job.status === "running") ? 2_500 : false),
  });
}

export function useGenerationJobResult(id: string | null, enabled: boolean) {
  return useQuery({
    queryKey: generationJobKeys.result(id ?? ""),
    queryFn: () => api.get<unknown>(`/generation-jobs/${encodeURIComponent(id ?? "")}/result`),
    enabled: enabled && Boolean(id),
    staleTime: 5 * 60_000,
  });
}

export function useCancelGenerationJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/generation-jobs/${encodeURIComponent(id)}/cancel`),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: generationJobKeys.list() });
      queryClient.removeQueries({ queryKey: generationJobKeys.result(id) });
    },
  });
}
