import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api-client";
import { translate } from "../localization/i18n";
import { chatKeys } from "./use-chats";
import { useChatStore } from "../stores/chat.store";

const GENERATION_STATUS_POLL_MS = 1_000;

type GenerationStatus = { active: boolean };

/**
 * Reconnect the mounted chat surface to server-owned generation state.
 *
 * This deliberately does not recreate the lost SSE controller. The server
 * owns accepted work; the mounted UI only shows a generic busy state, polls
 * until the run settles, then refreshes durable results. Stop still uses the
 * existing abort endpoint because no local controller is required for it.
 */
export function useGenerationRecovery(chatId: string | null) {
  const queryClient = useQueryClient();
  const remoteBusyRef = useRef(false);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    let ownsBusyUi = false;

    const markBusy = () => {
      remoteBusyRef.current = true;
      const state = useChatStore.getState();
      if (!state.abortControllers.has(chatId ?? "") && state.activeChatId === chatId) {
        ownsBusyUi = true;
        state.setStreaming(true, chatId ?? undefined);
        state.setGenerationPhase(translate("ui.chat.summarypopover.generating"));
      }
    };

    const refreshAfterCompletion = () => {
      if (!chatId) return;
      void queryClient.invalidateQueries({ queryKey: chatKeys.messages(chatId) });
      void queryClient.invalidateQueries({ queryKey: chatKeys.messageCount(chatId) });
      void queryClient.invalidateQueries({ queryKey: chatKeys.detail(chatId) });
      void queryClient.invalidateQueries({ queryKey: chatKeys.list() });
      void queryClient.invalidateQueries({ queryKey: ["gallery", chatId] });
    };

    const markSettled = () => {
      if (!remoteBusyRef.current) return;
      remoteBusyRef.current = false;
      const state = useChatStore.getState();
      // A foreground stream may have been started after the status probe. Its
      // controller owns the UI and must not be cleared by this recovery poll.
      if (
        ownsBusyUi &&
        state.activeChatId === chatId &&
        !state.abortControllers.has(chatId ?? "") &&
        state.streamingChatId === chatId
      ) {
        state.setStreaming(false, chatId ?? undefined);
        state.setGenerationPhase(null);
      }
      ownsBusyUi = false;
      refreshAfterCompletion();
    };

    const poll = async () => {
      if (disposed || !chatId || inFlight) return;
      inFlight = true;
      let active: boolean | null = null;
      try {
        active = (await api.get<GenerationStatus>(`/generate/status/${encodeURIComponent(chatId)}`)).active;
      } catch {
        // A transient reconnect failure must not look like completion. Keep a
        // known busy run visible and retry; idle chats wait for focus/remount.
      }
      inFlight = false;
      if (disposed) return;
      if (active === true) {
        markBusy();
        timer = setTimeout(() => void poll(), GENERATION_STATUS_POLL_MS);
      } else if (active === false) {
        if (remoteBusyRef.current) markSettled();
      } else if (remoteBusyRef.current) {
        timer = setTimeout(() => void poll(), GENERATION_STATUS_POLL_MS);
      }
    };

    void poll();
    const onFocus = () => {
      if (disposed || inFlight) return;
      if (timer) clearTimeout(timer);
      timer = null;
      void poll();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
      // Unmounting the observer must never abort server-owned work. Clear only
      // generic UI this observer installed, leaving a real foreground stream.
      const state = useChatStore.getState();
      if (
        ownsBusyUi &&
        state.activeChatId === chatId &&
        !state.abortControllers.has(chatId ?? "") &&
        state.streamingChatId === chatId
      ) {
        state.setStreaming(false, chatId ?? undefined);
        state.setGenerationPhase(null);
      }
      remoteBusyRef.current = false;
      ownsBusyUi = false;
    };
  }, [chatId, queryClient]);
}
