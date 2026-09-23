// ──────────────────────────────────────────────
// Initiative tracker: saved encounters per game and server-side initiative rolls
// ──────────────────────────────────────────────
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { InitiativeEncounterState } from "@marinara-engine/shared";
import { ApiError, api } from "../lib/api-client";
import { diceLogKeys } from "./use-game-tools";

export interface InitiativeEncounterRecord {
  id: string;
  gameId: string;
  name: string;
  state: InitiativeEncounterState;
  createdAt: string;
  updatedAt: string;
}

export interface InitiativeRollResponse {
  results: Array<{ id: string; notation: string; rolls: number[]; modifier: number; total: number }>;
  totals: Record<string, number>;
  logged: number;
}

export const initiativeKeys = {
  all: ["game-initiative"] as const,
  list: (chatId: string) => [...initiativeKeys.all, "list", chatId] as const,
};

export function useInitiativeEncounters(chatId: string | null | undefined) {
  return useQuery({
    queryKey: initiativeKeys.list(chatId ?? ""),
    queryFn: () =>
      api.get<{ gameId: string; encounters: InitiativeEncounterRecord[] }>(
        `/game-initiative?chatId=${encodeURIComponent(chatId!)}`,
      ),
    enabled: !!chatId,
    staleTime: 30_000,
  });
}

export function useInitiativeMutations(chatId: string | null | undefined) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: initiativeKeys.all });

  const save = useMutation({
    mutationFn: async (input: { id?: string | null; name: string; state: InitiativeEncounterState }) => {
      const create = () =>
        api.post<InitiativeEncounterRecord>("/game-initiative", { chatId, name: input.name, state: input.state });
      if (!input.id) return create();
      try {
        return await api.put<InitiativeEncounterRecord>(`/game-initiative/${encodeURIComponent(input.id)}`, {
          name: input.name,
          state: input.state,
        });
      } catch (error) {
        // Deleted from another session or tab: save it again as a new encounter instead of failing forever.
        if (error instanceof ApiError && error.status === 404) return create();
        throw error;
      }
    },
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete<{ deleted: boolean }>(`/game-initiative/${encodeURIComponent(id)}`),
    onSuccess: invalidate,
  });

  const roll = useMutation({
    mutationFn: (combatants: Array<{ id: string; name: string; dice: string }>) =>
      api.post<InitiativeRollResponse>("/game-initiative/roll", { chatId, combatants }),
    onSuccess: (data) => {
      if (data.logged > 0) void qc.invalidateQueries({ queryKey: diceLogKeys.all });
    },
  });

  return { save, remove, roll };
}
