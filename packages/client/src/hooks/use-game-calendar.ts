// ──────────────────────────────────────────────
// Game calendar: the in-world calendar of a game chat
//
// The calendar lives in chat metadata beside the Game Mode clock (gameTime).
// Moving the date moves that clock, so after a write the chat query is
// refreshed and the loaded game-state snapshot gets the new time label, the
// same way the Day editor updates both.
// ──────────────────────────────────────────────
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import {
  calendarWidgetEntries,
  readGameCalendar,
  readGameClock,
  type GameCalendarDate,
  type GameCalendarState,
  type GameClockTime,
} from "@marinara-engine/shared";
import { api } from "../lib/api-client";
import { parseChatMetadata } from "../lib/chat-display";
import { useChatStore } from "../stores/chat.store";
import { useGameStateStore } from "../stores/game-state.store";
import { chatKeys, useChat } from "./use-chats";

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
  return useQuery({
    queryKey: gameCalendarKeys.detail(chatId ?? ""),
    queryFn: ({ signal }) => api.get<GameCalendarResponse>(path(chatId ?? ""), { signal }),
    enabled: !!chatId,
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
    mutationFn: (calendar: GameCalendarState) => api.put<GameCalendarResponse>(path(chatId), { calendar }),
    onSuccess: (response) => applyResponse(qc, chatId, response, false),
  });
}

export function useAdvanceGameCalendar(chatId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (days: number) => api.post<GameCalendarResponse>(`${path(chatId)}/advance`, { days }),
    onSuccess: (response) => applyResponse(qc, chatId, response, true),
  });
}

export function useSetGameCalendarDate(chatId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (date: GameCalendarDate) => api.post<GameCalendarResponse>(`${path(chatId)}/date`, { date }),
    onSuccess: (response) => applyResponse(qc, chatId, response, true),
  });
}

/**
 * Upcoming calendar events as calendar HUD widget entries ("Day N" + title) for the open game, read from
 * the chat query the game screen already holds. Empty when the game has no calendar switched on.
 */
export function useGameCalendarWidgetEntries(enabled: boolean): Array<{ when: string; text: string }> {
  const activeChatId = useChatStore((state) => state.activeChatId);
  const { data: chat } = useChat(enabled ? activeChatId : null);
  return useMemo(() => {
    if (!enabled || !chat) return [];
    const meta = parseChatMetadata((chat as { metadata?: unknown }).metadata);
    const calendar = readGameCalendar(meta);
    if (!calendar) return [];
    return calendarWidgetEntries(calendar, readGameClock(meta.gameTime)?.day ?? 1);
  }, [enabled, chat]);
}
