// ──────────────────────────────────────────────
// GM prep board (server-stored, one per game)
//
// Edits apply to the cached board at once through the shared pure helpers and
// are saved in the background, one save at a time per chat, each carrying the
// revision it was edited from. A save that lost a race gets the stored board
// back and the cache takes it. The board is private: nothing sends it to a model.
// ──────────────────────────────────────────────
import { useCallback } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { PrepBoard } from "@marinara-engine/shared";
import { ApiError, api } from "../lib/api-client";
import { i18n } from "../localization/i18n";

export interface PrepBoardResponse {
  gameId: string;
  /** The session of the chat asked about. */
  sessionNumber: number;
  chatName: string;
  board: PrepBoard;
  revision: number;
  updatedAt: string | null;
}

export const prepBoardKeys = {
  all: ["prep-board"] as const,
  board: (chatId: string) => [...prepBoardKeys.all, chatId] as const,
};

const saveQueues = new Map<string, { running: boolean; dirty: boolean }>();

function isSaving(chatId: string) {
  const queue = saveQueues.get(chatId);
  return !!queue && (queue.running || queue.dirty);
}

/**
 * Every session chat of a game shares one board, but each chat has its own
 * cache entry. After a save, sibling entries of the same game that have no
 * pending edits take the stored board, so their next edit does not start from
 * a stale revision and lose to a 409.
 */
function syncSiblingBoards(qc: QueryClient, chatId: string, stored: PrepBoardResponse) {
  for (const [key, data] of qc.getQueriesData<PrepBoardResponse>({ queryKey: prepBoardKeys.all })) {
    const otherChatId = typeof key[1] === "string" ? key[1] : "";
    if (!data || !otherChatId || otherChatId === chatId || data.gameId !== stored.gameId) continue;
    if (isSaving(otherChatId) || data.revision >= stored.revision) continue;
    qc.setQueryData<PrepBoardResponse>(key, {
      ...data,
      board: stored.board,
      revision: stored.revision,
      updatedAt: stored.updatedAt,
    });
  }
}

async function flushSaves(qc: QueryClient, chatId: string) {
  const queue = saveQueues.get(chatId) ?? { running: false, dirty: false };
  saveQueues.set(chatId, queue);
  queue.dirty = true;
  if (queue.running) return;
  queue.running = true;
  const key = prepBoardKeys.board(chatId);
  try {
    while (queue.dirty) {
      queue.dirty = false;
      const current = qc.getQueryData<PrepBoardResponse>(key);
      if (!current) break;
      try {
        const saved = await api.put<{ board?: PrepBoard; revision: number; updatedAt: string }>("/prep-board", {
          chatId,
          revision: current.revision,
          board: current.board,
        });
        // Keep the local board: it may hold edits made while this save was in flight.
        qc.setQueryData<PrepBoardResponse>(key, (data) =>
          data ? { ...data, revision: saved.revision, updatedAt: saved.updatedAt } : data,
        );
        syncSiblingBoards(qc, chatId, {
          ...current,
          board: saved.board ?? current.board,
          revision: saved.revision,
          updatedAt: saved.updatedAt,
        });
      } catch (error) {
        queue.dirty = false;
        if (error instanceof ApiError && error.status === 409) {
          const payload = error.payload as { board?: PrepBoard; revision?: number } | undefined;
          qc.setQueryData<PrepBoardResponse>(key, (data) =>
            data && payload?.board
              ? { ...data, board: payload.board, revision: payload.revision ?? data.revision }
              : data,
          );
          toast.error(i18n.t("ui.prepBoard.conflict"));
        } else {
          toast.error(error instanceof Error && error.message ? error.message : i18n.t("ui.prepBoard.saveFailed"));
          void qc.invalidateQueries({ queryKey: key });
        }
      }
    }
  } finally {
    queue.running = false;
  }
}

export function usePrepBoard(chatId: string | null | undefined) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: prepBoardKeys.board(chatId ?? ""),
    queryFn: () => api.get<PrepBoardResponse>(`/prep-board?chatId=${encodeURIComponent(chatId!)}`),
    enabled: !!chatId,
    staleTime: 30_000,
    refetchOnWindowFocus: () => !chatId || !isSaving(chatId),
  });

  /** Apply a pure edit to the board and save it. Returns the edited board, or null before it loads. */
  const edit = useCallback(
    (change: (board: PrepBoard) => PrepBoard): PrepBoard | null => {
      if (!chatId) return null;
      const key = prepBoardKeys.board(chatId);
      const current = qc.getQueryData<PrepBoardResponse>(key);
      if (!current) return null;
      const next = change(current.board);
      if (next === current.board) return next;
      qc.setQueryData<PrepBoardResponse>(key, { ...current, board: next });
      void flushSaves(qc, chatId);
      return next;
    },
    [chatId, qc],
  );

  const removeBoard = useCallback(async () => {
    if (!chatId) return;
    await api.delete(`/prep-board?chatId=${encodeURIComponent(chatId)}`);
    await qc.invalidateQueries({ queryKey: prepBoardKeys.board(chatId) });
  }, [chatId, qc]);

  return { ...query, edit, removeBoard };
}
