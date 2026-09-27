import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { GameState, GameTurnReview, GameTurnReviewCorrection } from "@marinara-engine/shared";
import { toast } from "sonner";
import { ApiError, api } from "../lib/api-client";
import { chatKeys } from "./use-chats";
import { spatialContextKeys } from "./use-spatial-context";
import { useGameStateStore } from "../stores/game-state.store";
import { useChatStore } from "../stores/chat.store";
import { translate } from "../localization/i18n";

export const gameTurnReviewKeys = {
  all: ["game-turn-review"] as const,
  turn: (chatId: string, messageId: string, swipeIndex: number) =>
    [...gameTurnReviewKeys.all, chatId, messageId, swipeIndex] as const,
};

export function useGameTurnReview(
  chatId: string | undefined,
  messageId: string | undefined,
  swipeIndex: number | undefined,
) {
  return useQuery({
    queryKey:
      chatId && messageId && swipeIndex != null
        ? gameTurnReviewKeys.turn(chatId, messageId, swipeIndex)
        : [...gameTurnReviewKeys.all, "disabled"],
    queryFn: async () => {
      const review = await api.get<GameTurnReview>(
        `/game/${encodeURIComponent(chatId!)}/turn-review/${encodeURIComponent(messageId!)}?swipeIndex=${swipeIndex}`,
      );
      if (review.swipeIndex !== swipeIndex) {
        return {
          ...review,
          canCorrect: false,
          readOnlyReason: "This review belongs to a different saved swipe.",
        };
      }
      return review;
    },
    enabled: !!chatId && !!messageId && swipeIndex != null,
    staleTime: 0,
    refetchInterval: (query) => (query.state.data?.pending ? 1000 : false),
  });
}

export function useCorrectGameTurnReview(
  chatId: string | undefined,
  messageId: string | undefined,
  swipeIndex: number | undefined,
) {
  const queryClient = useQueryClient();
  const queryKey =
    chatId && messageId && swipeIndex != null
      ? gameTurnReviewKeys.turn(chatId, messageId, swipeIndex)
      : [...gameTurnReviewKeys.all, "disabled"];

  return useMutation({
    mutationFn: (correction: GameTurnReviewCorrection) => {
      if (!chatId || !messageId || swipeIndex == null) {
        throw new Error("A saved game turn is required before correcting it.");
      }
      const current = queryClient.getQueryData<GameTurnReview>(queryKey);
      if (!current) throw new Error("This turn review is still loading.");
      return api.patch<GameTurnReview>(
        `/game/${encodeURIComponent(chatId)}/turn-review/${encodeURIComponent(messageId)}`,
        { revision: current.revision, swipeIndex, correction },
      );
    },
    onSuccess: (review) => {
      queryClient.setQueryData(queryKey, review);
      if (chatId) {
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: chatKeys.detail(chatId) }),
          queryClient.invalidateQueries({ queryKey: chatKeys.messages(chatId) }),
          queryClient.invalidateQueries({ queryKey: ["game-scene-timeline", chatId] }),
          queryClient.invalidateQueries({ queryKey: spatialContextKeys.detail(chatId) }),
          api.get<GameState | null>(`/chats/${encodeURIComponent(chatId)}/game-state`).then((state) => {
            if (useChatStore.getState().activeChatId === chatId) {
              useGameStateStore.getState().setGameState(state);
            }
          }),
        ]).catch(() => {
          // The corrected review remains authoritative even if a secondary cache refresh is unavailable.
        });
      }
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.status === 409) {
        await queryClient.invalidateQueries({ queryKey });
        toast.error(translate("ui.game.turnReview.stale"));
        return;
      }
      toast.error(error instanceof Error ? error.message : translate("ui.game.turnReview.failed"));
    },
  });
}
