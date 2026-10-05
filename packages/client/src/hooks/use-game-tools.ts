import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { resolveFeatureEnabled, type FeatureSettingsResponse } from "@marinara-engine/shared";
import { featureSettingsKeys, useFeatureEnabled } from "./use-feature-settings";
import type { DiceRollLogResponse, DiceRollLogSource, DiceRollResult, SkillCheckResult } from "@marinara-engine/shared";
import { api } from "../lib/api-client";

export type DiceLogScope = "session" | "game";
export type DiceLogSource = DiceRollLogSource;
export type DiceLogRecord = DiceRollLogResponse["recent"][number];
export type DiceFaceStats = DiceRollLogResponse["stats"]["bySides"][number];

export const diceLogKeys = {
  all: ["game-dice-log"] as const,
  list: (chatId: string, scope: DiceLogScope) => [...diceLogKeys.all, chatId, scope] as const,
};

export function useDiceLog(chatId: string | null | undefined, scope: DiceLogScope, enabled = true) {
  const qc = useQueryClient();
  const active = useFeatureEnabled("diceLog") && enabled;
  return useQuery({
    queryKey: diceLogKeys.list(chatId ?? "", scope),
    queryFn: () => {
      if (!diceLogEnabledAtDispatch(qc)) throw new Error("FEATURE_DISABLED");
      return api.get<DiceRollLogResponse>(
        `/game-tools/dice-log?chatId=${encodeURIComponent(chatId ?? "")}&scope=${scope}`,
      );
    },
    enabled: !!chatId && active,
    staleTime: 2_000,
    refetchInterval: active ? 15_000 : false,
  });
}

export function diceLogEnabledAtDispatch(qc: QueryClient): boolean {
  const state = qc.getQueryState<FeatureSettingsResponse>(featureSettingsKeys.all);
  return (
    state?.status === "success" &&
    (state.data?.effective?.diceLog ?? resolveFeatureEnabled(state.data?.settings, "diceLog"))
  );
}

/** This post records the already-produced client result; history failure cannot change the roll. */
export function recordDiceLogEntry(
  qc: QueryClient,
  entry:
    | { source: "player"; chatId: string; result: DiceRollResult; context?: string }
    | { source: "skill_check"; chatId: string; result: SkillCheckResult; messageId?: string },
): void {
  if (!entry.chatId || !diceLogEnabledAtDispatch(qc)) return;
  try {
    void api
      .post("/game-tools/dice-log", entry)
      .then(() => qc.invalidateQueries({ queryKey: diceLogKeys.all }))
      .catch(() => undefined);
  } catch {
    // Logging is best effort by design.
  }
}
