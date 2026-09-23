// ──────────────────────────────────────────────
// Game tools: dice roll history, the campaign codex export and the campaign log
// ──────────────────────────────────────────────
import { useQuery, type QueryClient } from "@tanstack/react-query";
import type { DiceRollResult, SkillCheckResult } from "@marinara-engine/shared";
import { api } from "../lib/api-client";
import type { CampaignLogResponse } from "../lib/game-log";

export type DiceLogScope = "session" | "game";
export type DiceLogSource = "player" | "gm" | "skill_check" | "table" | "initiative";

export interface DiceLogRecord {
  id: string;
  chatId: string;
  gameId: string;
  messageId: string | null;
  source: DiceLogSource;
  actor: string | null;
  label: string | null;
  notation: string;
  rolls: number[];
  modifier: number;
  total: number;
  critical: boolean;
  fumble: boolean;
  createdAt: string;
}

export interface DiceFaceStats {
  sides: number;
  dice: number;
  average: number;
  expected: number;
  counts: number[];
}

export interface DiceLogStats {
  rolls: number;
  dice: number;
  averageTotal: number | null;
  expectedTotal: number | null;
  natural20s: number;
  natural1s: number;
  criticals: number;
  fumbles: number;
  bySides: DiceFaceStats[];
}

export interface DiceLogResponse {
  scope: DiceLogScope;
  gameId: string;
  total: number;
  stats: DiceLogStats;
  recent: DiceLogRecord[];
}

export const diceLogKeys = {
  all: ["game-dice-log"] as const,
  list: (chatId: string, scope: DiceLogScope) => [...diceLogKeys.all, chatId, scope] as const,
};

export function useDiceLog(chatId: string | null | undefined, scope: DiceLogScope, enabled = true) {
  return useQuery({
    queryKey: diceLogKeys.list(chatId ?? "", scope),
    queryFn: () =>
      api.get<DiceLogResponse>(`/game-tools/dice-log?chatId=${encodeURIComponent(chatId ?? "")}&scope=${scope}`),
    enabled: !!chatId && enabled,
    staleTime: 2_000,
    // GM rolls land server-side during generation, so an open log keeps itself current.
    refetchInterval: enabled ? 15_000 : false,
  });
}

/**
 * Record a roll the player made from the dice tray or a skill-check button. Never throws
 * and is never awaited by the roll itself: a lost history row must not cost a roll.
 */
export function recordDiceLogEntry(
  qc: QueryClient | null,
  entry:
    | { source: "player"; chatId: string; result: DiceRollResult; context?: string }
    | { source: "skill_check"; chatId: string; result: SkillCheckResult; messageId?: string },
): void {
  if (!entry.chatId) return;
  try {
    void api
      .post("/game-tools/dice-log", entry)
      .then(() => qc?.invalidateQueries({ queryKey: diceLogKeys.all }))
      .catch(() => undefined);
  } catch {
    // Logging is best effort by design.
  }
}

/** Download the campaign codex for the game this chat belongs to. */
export function downloadCampaignCodex(chatId: string, format: "md" | "json") {
  return api.download(
    `/game-tools/codex/${encodeURIComponent(chatId)}?format=${format}`,
    format === "md" ? "campaign-codex.md" : "campaign-codex.json",
  );
}

export const campaignLogKeys = {
  all: ["game-campaign-log"] as const,
  detail: (chatId: string) => [...campaignLogKeys.all, chatId] as const,
};

/** Every readable turn of the campaign the chat belongs to, session by session. */
export function useCampaignLog(chatId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: campaignLogKeys.detail(chatId ?? ""),
    queryFn: ({ signal }) =>
      api.get<CampaignLogResponse>(`/game-tools/log/${encodeURIComponent(chatId ?? "")}`, { signal }),
    enabled: !!chatId && enabled,
    staleTime: 30_000,
    // A long campaign is a large payload; don't hold it for minutes after the reader closes.
    gcTime: 30_000,
  });
}
