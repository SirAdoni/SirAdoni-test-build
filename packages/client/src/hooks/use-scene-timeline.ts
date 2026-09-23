import { useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { GameSceneTimeline } from "@marinara-engine/shared";
import { api } from "../lib/api-client";

export function useSceneTimeline(chatId: string | null | undefined) {
  const queryClient = useQueryClient();
  const queryKey = ["game-scene-timeline", chatId];
  const query = useQuery({
    queryKey,
    queryFn: () => api.get<GameSceneTimeline>(`/game/${chatId}/scene-timeline`),
    enabled: !!chatId,
    staleTime: 1000,
    refetchInterval: (query) => (query.state.data?.pending ? 2000 : 10_000),
  });
  const sync = useMutation({
    mutationFn: () => api.post(`/game/${chatId}/scene-timeline/sync`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });
  const { mutate } = sync;
  useEffect(() => {
    if (
      chatId &&
      query.data &&
      ((query.data.remaining ?? 0) > 0 || query.data.needsReview === true) &&
      !query.data.pending &&
      !query.data.error &&
      !sync.isPending &&
      !sync.error
    )
      mutate();
  }, [
    chatId,
    query.data,
    query.data?.remaining,
    query.data?.needsReview,
    query.data?.scenes,
    query.data?.pending,
    query.data?.error,
    sync.isPending,
    sync.error,
    mutate,
  ]);
  return { ...query, sync };
}
