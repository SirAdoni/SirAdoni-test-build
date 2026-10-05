import type { QueryClient } from "@tanstack/react-query";
import {
  isGameExtendedWidgetsEnabled,
  isExtendedHudWidgetType,
  type Chat,
  type HudWidget,
} from "@marinara-engine/shared";
import { chatKeys, useChat } from "./use-chats";
import { isWidgetFeatureEnabledNow, useFeatureEnabled } from "./use-feature-settings";

function metadata(chat: Chat): Record<string, unknown> | null {
  try {
    const value: unknown = typeof chat.metadata === "string" ? JSON.parse(chat.metadata) : chat.metadata;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function useExtendedWidgetsEnabled(chatId: string | null, newGameSetup = false): boolean {
  const enabled = useFeatureEnabled("extendedHudWidgets");
  const chat = useChat(chatId);
  if (!chatId) return newGameSetup && enabled;
  if (!enabled || chat.isError || !chat.data) return false;
  const meta = metadata(chat.data);
  return meta !== null && isGameExtendedWidgetsEnabled(meta);
}

export function canUseExtendedWidgetsNow(queryClient: QueryClient, chatId: string | null): boolean {
  if (!isWidgetFeatureEnabledNow(queryClient, "extendedHudWidgets")) return false;
  if (chatId === null) return true;
  const state = queryClient.getQueryState<Chat>(chatKeys.detail(chatId));
  if (state?.status !== "success" || !state.data) return false;
  const meta = metadata(state.data);
  return meta !== null && isGameExtendedWidgetsEnabled(meta);
}
/** New setup has no stored records to preserve and uses the app-wide permission. */
export function isNewGameWidgetSetupAllowed(queryClient: QueryClient, widgets: HudWidget[]): boolean {
  return (
    canUseExtendedWidgetsNow(queryClient, null) ||
    (widgets.length <= 4 && widgets.every((widget) => !isExtendedHudWidgetType(widget.type)))
  );
}

/** Ordinary edits must carry hidden records unchanged; server checks the authoritative copy again. */
export function assertWidgetUpdateAllowed(queryClient: QueryClient, chatId: string, widgets: HudWidget[]): void {
  if (canUseExtendedWidgetsNow(queryClient, chatId)) return;
  const chat = queryClient.getQueryData<Chat>(chatKeys.detail(chatId));
  const meta = chat ? metadata(chat) : null;
  const blueprint =
    meta?.gameBlueprint && typeof meta.gameBlueprint === "object"
      ? (meta.gameBlueprint as { hudWidgets?: unknown })
      : null;
  const saved = Array.isArray(meta?.gameWidgetState) ? meta.gameWidgetState : blueprint?.hudWidgets;
  const previous = Array.isArray(saved) ? (saved as HudWidget[]) : [];
  const extended = (list: HudWidget[]) => list.filter((widget) => isExtendedHudWidgetType(widget.type));
  if (JSON.stringify(extended(previous)) !== JSON.stringify(extended(widgets))) {
    throw new Error("Extended HUD widget modification is disabled");
  }
}
