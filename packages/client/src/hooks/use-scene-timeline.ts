import { useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { GameSceneTimeline } from "@marinara-engine/shared";
import { useFeatureEnabled, isCampaignFeatureEnabled } from "./use-feature-settings";
import { api } from "../lib/api-client";

export function useSceneTimeline(chatId: string | null | undefined) {
  const queryClient = useQueryClient();
  const enabled = useFeatureEnabled("sceneTimeline");
  const currentChat = useRef(chatId);
  currentChat.current = chatId;
  const canDispatch = () =>
    !!chatId && currentChat.current === chatId && isCampaignFeatureEnabled(queryClient, "sceneTimeline");
  const queryKey = ["game-scene-timeline", chatId];
  const query = useQuery({
    queryKey,
    queryFn: async () => {
      if (!canDispatch()) throw new Error("Scene Timeline is disabled");
      const result = await api.get<GameSceneTimeline>(`/game/${chatId}/scene-timeline`);
      if (!canDispatch()) throw new Error("Scene Timeline is disabled");
      return result;
    },
    enabled: !!chatId && enabled,
    staleTime: 1000,
    refetchInterval: (query) => (canDispatch() ? (query.state.data?.pending ? 2000 : 10_000) : false),
  });
  const sync = useMutation({
    mutationFn: () => {
      if (!canDispatch()) throw new Error("Scene Timeline is disabled");
      return api.post(`/game/${chatId}/scene-timeline/sync`, {});
    },
    onSuccess: () => {
      if (canDispatch()) return queryClient.invalidateQueries({ queryKey });
    },
  });
  const { mutate } = sync;
  useEffect(() => {
    if (
      enabled &&
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
    enabled,
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
  return { ...query, data: enabled && chatId ? query.data : undefined, sync };
}
