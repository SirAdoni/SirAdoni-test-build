import { useUIStore } from "../stores/ui.store";
import type { GameLogTarget } from "./game-log";

export const GAME_LOG_MODAL = "game-log";

/**
 * Open the campaign log for the game a chat belongs to. With a message id or a /goto
 * number it opens at that turn and highlights it; otherwise at the start of that session.
 */
export function openGameLog(target: GameLogTarget & { focusChapters?: boolean }) {
  if (!target.chatId) return;
  useUIStore.getState().openModal(GAME_LOG_MODAL, {
    chatId: target.chatId,
    messageId: target.messageId ?? null,
    messageNumber: target.messageNumber ?? null,
    focusChapters: target.focusChapters === true,
  });
}
