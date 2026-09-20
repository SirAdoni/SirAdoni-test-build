import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { GameMap } from "@marinara-engine/shared";
import { api } from "../lib/api-client";
import { useGameModeStore } from "../stores/game-mode.store";
import { chatKeys } from "./use-chats";

export function useSaveMapLayout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ chatId, previous, next }: { chatId: string; previous: GameMap; next: GameMap }) =>
      api.post<{ map: GameMap; maps: GameMap[]; activeGameMapId: string | null }>("/game/map/layout", {
        chatId,
        mapId: previous.id,
        expectedMap: JSON.stringify(previous),
        nodes: (next.nodes ?? []).map(({ id, x, y }) => ({ id, x, y })),
        edges: next.edges ?? [],
      }),
    onSuccess: (result, variables) => {
      if (result.maps?.length) useGameModeStore.getState().setMaps(result.maps, result.activeGameMapId);
      void qc.invalidateQueries({ queryKey: chatKeys.detail(variables.chatId) });
    },
    onError: (_error, variables) => {
      void qc.invalidateQueries({ queryKey: chatKeys.detail(variables.chatId) });
    },
  });
}
