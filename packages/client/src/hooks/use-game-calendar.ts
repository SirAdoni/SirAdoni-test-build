// ──────────────────────────────────────────────
// Game calendar: the in-world calendar of a game chat
//
// The calendar lives in chat metadata beside the Game Mode clock (gameTime).
// Moving the date moves that clock, so after a write the chat query is
// refreshed and the loaded game-state snapshot gets the new time label, the
// same way the Day editor updates both.
// ──────────────────────────────────────────────
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { type GameCalendarDate, type GameCalendarState, type GameClockTime } from "@marinara-engine/shared";
import { api } from "../lib/api-client";
import { useGameStateStore } from "../stores/game-state.store";
import { chatKeys } from "./use-chats";
import { requireWikiFeatureEnabled, useWikiFeatureEnabled } from "./use-feature-settings";

export interface GameCalendarResponse {
  calendar: GameCalendarState;
  clock: GameClockTime | null;
  formattedTime: string | null;
}

export const gameCalendarKeys = {
  all: ["game-calendar"] as const,
  detail: (chatId: string) => [...gameCalendarKeys.all, chatId] as const,
};

const path = (chatId: string) => `/game-calendar/${encodeURIComponent(chatId)}`;

export function useGameCalendar(chatId: string | null | undefined) {
  const qc = useQueryClient();
  const enabled = useWikiFeatureEnabled("gameCalendar");
  return useQuery({
    queryKey: gameCalendarKeys.detail(chatId ?? ""),
    queryFn: ({ signal }) => {
      requireWikiFeatureEnabled(qc, "gameCalendar");
      return api.get<GameCalendarResponse>(path(chatId ?? ""), { signal });
    },
    enabled: !!chatId && enabled,
    staleTime: 5_000,
  });
}

function applyResponse(qc: QueryClient, chatId: string, response: GameCalendarResponse, clockMoved: boolean) {
  qc.setQueryData(gameCalendarKeys.detail(chatId), response);
  // The chat's metadata carries gameTime and gameCalendar: refresh it so the HUD, Day editor and widgets agree.
  void qc.invalidateQueries({ queryKey: chatKeys.detail(chatId) });
  if (!clockMoved || !response.formattedTime) return;
  const snapshot = useGameStateStore.getState().current;
  if (snapshot?.chatId === chatId) {
    useGameStateStore.getState().setGameState({ ...snapshot, time: response.formattedTime });
  }
}

export function useSaveGameCalendar(chatId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (calendar: GameCalendarState) => {
      requireWikiFeatureEnabled(qc, "gameCalendar");
      return api.put<GameCalendarResponse>(path(chatId), { calendar });
    },
    onSuccess: (response) => applyResponse(qc, chatId, response, false),
  });
}

export function useAdvanceGameCalendar(chatId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (days: number) => {
      requireWikiFeatureEnabled(qc, "gameCalendar");
      return api.post<GameCalendarResponse>(`${path(chatId)}/advance`, { days });
    },
    onSuccess: (response) => applyResponse(qc, chatId, response, true),
  });
}

export function useSetGameCalendarDate(chatId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (date: GameCalendarDate) => {
      requireWikiFeatureEnabled(qc, "gameCalendar");
      return api.post<GameCalendarResponse>(`${path(chatId)}/date`, { date });
    },
    onSuccess: (response) => applyResponse(qc, chatId, response, true),
  });
}
