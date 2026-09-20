import { useMutation, useQuery } from "@tanstack/react-query";
import type { GameSceneVideoAspectRatio, GameTurnStoryboard, StoryboardProgress } from "@marinara-engine/shared";
import { api, ApiError } from "../lib/api-client";

async function requestStoryboard<T>(input: GenerateGameTurnStoryboardInput & { previewOnly?: boolean }): Promise<T> {
  try {
    return await api.post<T>("/game/storyboard/generate", input);
  } catch (error) {
    if (error instanceof ApiError && error.payload && typeof error.payload === "object") {
      const details = (error.payload as { details?: Array<{ path?: string; message?: string }> }).details;
      if (Array.isArray(details)) {
        const reason = details
          .filter((item) => typeof item?.message === "string")
          .map((item) => `${item.path ? `${item.path}: ` : ""}${item.message}`)
          .join("; ");
        if (reason) throw new ApiError(error.status, `${error.message}: ${reason}`, error.payload);
      }
    }
    throw error;
  }
}

export const gameStoryboardKeys = {
  all: ["game", "storyboards"] as const,
  chat: (chatId: string) => [...gameStoryboardKeys.all, chatId] as const,
  list: (chatId: string) => [...gameStoryboardKeys.chat(chatId), "list"] as const,
  turn: (chatId: string, messageId: string, swipeIndex: number) =>
    [...gameStoryboardKeys.chat(chatId), "turn", messageId, swipeIndex] as const,
};

export function useStoryboardProgress(chatId: string | undefined, generating: boolean) {
  return useQuery({
    queryKey: ["storyboard-progress", chatId],
    queryFn: () => api.get<StoryboardProgress | null>(`/game/storyboard/progress/${chatId}`),
    enabled: !!chatId,
    refetchInterval: (query) => (generating || query.state.data?.active ? 1000 : false),
    staleTime: 0,
  });
}

export type GenerateGameTurnStoryboardInput = {
  chatId: string;
  messageId: string;
  swipeIndex?: number;
  sections?: Array<{
    index: number;
    kind: "narration" | "dialogue" | "readable" | "system" | "user" | "assistant";
    speaker?: string | null;
    content: string;
  }>;
  keyframeCount?: number;
  durationSeconds?: number;
  aspectRatio?: GameSceneVideoAspectRatio;
  generateVideos?: boolean;
  automatic?: boolean;
  plannedStoryboard?: unknown;
  promptOverrides?: Array<{
    id: string;
    prompt: string;
    negativePrompt?: string;
  }>;
  debugMode?: boolean;
};

export type GameStoryboardPromptPreviewItem = {
  id: string;
  kind: "illustration";
  title: string;
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
};

export type GameStoryboardPromptPreviewResult = {
  items: GameStoryboardPromptPreviewItem[];
  plannedStoryboard: unknown;
  plannerWarning: string | null;
};

const RENDERING_STORYBOARD_STATUSES = new Set(["planning", "rendering_images", "rendering_videos"]);
const ACTIVE_KEYFRAME_STATUSES = new Set(["planned", "rendering_image", "rendering_video"]);

export function isGameTurnStoryboardTerminalFailure(storyboard: GameTurnStoryboard | null | undefined): boolean {
  if (!storyboard) return false;
  if (storyboard.status === "failed") return true;
  return !!storyboard.error && !storyboard.keyframes.some((frame) => ACTIVE_KEYFRAME_STATUSES.has(frame.status));
}

export function isGameTurnStoryboardPreparationFailure(storyboard: GameTurnStoryboard | null | undefined): boolean {
  return (
    isGameTurnStoryboardTerminalFailure(storyboard) && !storyboard?.keyframes.some((frame) => frame.status === "failed")
  );
}

export function isGameTurnStoryboardRendering(storyboard: GameTurnStoryboard | null | undefined): boolean {
  if (!storyboard) return false;
  if (!RENDERING_STORYBOARD_STATUSES.has(storyboard.status)) return false;
  // A planner can leave a rendering status behind when it returns a degraded
  // terminal result. Keep the spinner only while at least one keyframe still
  // has work pending; a failed frame alone must not hide other active frames.
  return !isGameTurnStoryboardTerminalFailure(storyboard);
}

function hasRenderingStoryboard(storyboards: GameTurnStoryboard[] | undefined): boolean {
  return storyboards?.some(isGameTurnStoryboardRendering) ?? false;
}

export function useGameChatStoryboards(chatId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: gameStoryboardKeys.list(chatId ?? ""),
    queryFn: async () => {
      const result = await api.get<{ storyboards: GameTurnStoryboard[] }>(`/game/storyboards/${chatId}`);
      return result.storyboards;
    },
    enabled: enabled && !!chatId,
    refetchInterval: (query) => {
      const storyboards = query.state.data as GameTurnStoryboard[] | undefined;
      return hasRenderingStoryboard(storyboards) ? 1000 : false;
    },
    staleTime: 30_000,
  });
}

export function useGameTurnStoryboards(
  chatId: string | undefined,
  messageId: string | undefined,
  swipeIndex: number | undefined,
  enabled = true,
) {
  const normalizedSwipeIndex = swipeIndex ?? 0;
  return useQuery({
    queryKey: gameStoryboardKeys.turn(chatId ?? "", messageId ?? "", normalizedSwipeIndex),
    queryFn: async () => {
      const params = new URLSearchParams({
        messageId: messageId!,
        swipeIndex: String(normalizedSwipeIndex),
      });
      const result = await api.get<{ storyboards: GameTurnStoryboard[] }>(
        `/game/storyboards/${chatId}?${params.toString()}`,
      );
      return result.storyboards;
    },
    enabled: enabled && !!chatId && !!messageId,
    refetchInterval: (query) => {
      const storyboards = query.state.data as GameTurnStoryboard[] | undefined;
      return hasRenderingStoryboard(storyboards) ? 1000 : false;
    },
    staleTime: 30_000,
  });
}

export function useGenerateGameTurnStoryboard() {
  return useMutation({
    mutationFn: (input: GenerateGameTurnStoryboardInput) =>
      requestStoryboard<
        { storyboard: GameTurnStoryboard } | { skipped: true; reason: "manual" | "interval" | "duplicate" }
      >(input),
  });
}

export function usePreviewGameTurnStoryboardPrompts() {
  return useMutation({
    mutationFn: (input: GenerateGameTurnStoryboardInput) =>
      requestStoryboard<GameStoryboardPromptPreviewResult>({
        ...input,
        previewOnly: true,
      }),
  });
}
