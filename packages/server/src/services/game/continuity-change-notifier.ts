import type { FastifyInstance } from "fastify";
import { createChatsStorage } from "../storage/chats.storage.js";
import { logger } from "../../lib/logger.js";

/**
 * Fire-and-forget bridge from chat message mutations (edit, delete, swipe,
 * hide) to the game continuity runtime and the session summary refresh queue.
 * Calls are debounced per chat and never awaited on the request path so a
 * burst of edits costs one reconcile; the chat mode is checked inside the
 * deferred task so non-game chats pay only the timer.
 */
export function createContinuityChangeNotifier(app: FastifyInstance, delayMs = 250) {
  const chats = createChatsStorage(app.db);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const changedMessages = new Map<string, Set<string>>();
  let closed = false;

  async function run(chatId: string, changedMessageIds: string[]): Promise<void> {
    try {
      const chat = await chats.getById(chatId);
      if (!chat || chat.mode !== "game") return;
      await app.gameContinuity.reconcileChat(chatId, { changedMessageIds });
      await app.sessionSummaryRefresh?.onDependencyChanged(chatId);
    } catch (error) {
      logger.warn(error, "[game-continuity] source change reconcile failed for chat %s", chatId);
    }
  }

  app.addHook("onClose", async () => {
    closed = true;
    timers.forEach((timer) => clearTimeout(timer));
    timers.clear();
  });

  return {
    /** `messageIds` names the messages whose text or visibility changed, so memory read from them can be retired. */
    notify(chatId: string, messageIds: Iterable<string> = []) {
      if (closed || !chatId) return;
      const changed = changedMessages.get(chatId) ?? new Set<string>();
      for (const messageId of messageIds) if (messageId) changed.add(messageId);
      changedMessages.set(chatId, changed);
      const existing = timers.get(chatId);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        timers.delete(chatId);
        const ids = [...(changedMessages.get(chatId) ?? [])];
        changedMessages.delete(chatId);
        void run(chatId, ids);
      }, delayMs);
      timer.unref?.();
      timers.set(chatId, timer);
    },
  };
}
