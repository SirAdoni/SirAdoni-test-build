import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ChatMetadata } from "@marinara-engine/shared";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api-client";
import { chatKeys, useUpdateChatMetadata } from "../../hooks/use-chats";
import { isCampaignFeatureEnabled, useFeatureEnabled } from "../../hooks/use-feature-settings";

export interface ContinuityOwnershipValue {
  lorebook: "keeper" | "continuity";
  fromSession: number;
}

const DEFAULT_MEMORY_BUDGET = 10_000;
const MIN_MEMORY_BUDGET = 1_000;
const MAX_MEMORY_BUDGET = 100_000;

export function GameMemorySettings({
  chatId,
  metadata,
  ownership,
  ownershipLoaded,
  onContinuityChanged,
}: {
  chatId: string;
  metadata?: ChatMetadata | null;
  ownership: ContinuityOwnershipValue | null;
  ownershipLoaded: boolean;
  onContinuityChanged: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const controlsEnabled = useFeatureEnabled("gameMemoryControls");
  const updateMetadata = useUpdateChatMetadata({ serialize: true });
  const saveOwnership = useMutation({
    mutationFn: (next: ContinuityOwnershipValue) => {
      if (
        !isCampaignFeatureEnabled(queryClient, "gameMemoryControls") ||
        !isCampaignFeatureEnabled(queryClient, "gameContinuity")
      ) {
        throw new Error("FEATURE_DISABLED:gameMemoryControls");
      }
      return api.patch(`/game/${chatId}/continuity`, { ownership: next });
    },
    onSuccess: () => {
      onContinuityChanged();
      void queryClient.invalidateQueries({ queryKey: chatKeys.detail(chatId) });
    },
  });
  const meta = (metadata ?? {}) as Record<string, unknown>;
  const currentSession =
    typeof meta.gameSessionNumber === "number" && meta.gameSessionNumber >= 1 ? Math.floor(meta.gameSessionNumber) : 1;
  const recapLimit =
    typeof meta.gamePromptRecentSessionLimit === "number" && meta.gamePromptRecentSessionLimit > 0
      ? meta.gamePromptRecentSessionLimit
      : "";
  const memoryScope = meta.gameCampaignMemoryScope === "session" ? "session" : "campaign";
  const rawBudget = meta.gameCampaignMemoryMaxCharacters;
  const savedBudget =
    typeof rawBudget === "number" &&
    Number.isSafeInteger(rawBudget) &&
    rawBudget >= MIN_MEMORY_BUDGET &&
    rawBudget <= MAX_MEMORY_BUDGET
      ? rawBudget
      : null;
  const [budgetText, setBudgetText] = useState(savedBudget === null ? "" : String(savedBudget));
  useEffect(() => setBudgetText(savedBudget === null ? "" : String(savedBudget)), [chatId, savedBudget]);
  const keeperReplaced = ownershipLoaded && ownership?.lorebook !== "keeper";
  const busy = !controlsEnabled || saveOwnership.isPending || updateMetadata.isPending;
  const patchMetadata = (patch: Record<string, unknown>) => {
    if (!isCampaignFeatureEnabled(queryClient, "gameMemoryControls")) return;
    updateMetadata.mutate({ id: chatId, ...patch });
  };
  const commitBudget = (badInput: boolean) => {
    if (badInput) {
      setBudgetText(savedBudget === null ? "" : String(savedBudget));
      return;
    }
    const trimmed = budgetText.trim();
    if (!trimmed) {
      if (savedBudget !== null || (rawBudget !== null && rawBudget !== undefined)) {
        patchMetadata({ gameCampaignMemoryMaxCharacters: null });
      }
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      setBudgetText(savedBudget === null ? "" : String(savedBudget));
      return;
    }
    const next = Math.min(MAX_MEMORY_BUDGET, Math.max(MIN_MEMORY_BUDGET, Math.round(parsed)));
    setBudgetText(String(next));
    if (next !== savedBudget) patchMetadata({ gameCampaignMemoryMaxCharacters: next });
  };

  if (!controlsEnabled) return null;

  return (
    <section className="border-t border-[var(--border)] pt-2" aria-label={t("ui.game.memorySettings.title")}>
      <h3 className="text-[0.6875rem] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
        {t("ui.game.memorySettings.title")}
      </h3>
      <div className="divide-y divide-[var(--border)]/60">
        <label className="flex items-center justify-between gap-4 py-2 text-xs">
          <span>{t("ui.game.memorySettings.keeperLabel")}</span>
          <input
            type="checkbox"
            role="switch"
            aria-label={t("ui.game.memorySettings.keeperLabel")}
            checked={keeperReplaced}
            disabled={!ownershipLoaded || busy}
            onChange={() =>
              saveOwnership.mutate({
                lorebook: keeperReplaced ? "keeper" : "continuity",
                fromSession: ownership?.fromSession ?? currentSession,
              })
            }
          />
        </label>
        <label className="flex items-center justify-between gap-4 py-2 text-xs">
          <span>{t("ui.game.memorySettings.recapsLabel")}</span>
          <select
            aria-label={t("ui.game.memorySettings.recapsLabel")}
            value={recapLimit}
            disabled={busy}
            onChange={(event) =>
              patchMetadata({
                gamePromptRecentSessionLimit: event.target.value ? Number(event.target.value) : null,
              })
            }
            className="min-h-8 rounded-md border border-[var(--border)] bg-[var(--secondary)] px-2 text-xs"
          >
            <option value="">{t("ui.game.memorySettings.recapsAll")}</option>
            {[1, 2, 3, 5, 10].map((limit) => (
              <option key={limit} value={limit}>
                {t("ui.game.memorySettings.recapsLast", { count: limit })}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center justify-between gap-4 py-2 text-xs">
          <span>{t("ui.game.memorySettings.scopeLabel")}</span>
          <select
            aria-label={t("ui.game.memorySettings.scopeLabel")}
            value={memoryScope}
            disabled={busy}
            onChange={(event) =>
              patchMetadata({ gameCampaignMemoryScope: event.target.value === "session" ? "session" : "campaign" })
            }
            className="min-h-8 rounded-md border border-[var(--border)] bg-[var(--secondary)] px-2 text-xs"
          >
            <option value="campaign">{t("ui.game.memorySettings.scopeCampaign")}</option>
            <option value="session">{t("ui.game.memorySettings.scopeSession")}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 py-2 text-xs sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <span>
            <span className="block">{t("ui.game.memorySettings.budgetLabel")}</span>
            <span className="block text-[0.6875rem] text-[var(--muted-foreground)]">
              {t("ui.game.memorySettings.budgetHint", { count: DEFAULT_MEMORY_BUDGET })}
            </span>
          </span>
          <input
            type="number"
            inputMode="numeric"
            min={MIN_MEMORY_BUDGET}
            max={MAX_MEMORY_BUDGET}
            step={1_000}
            value={budgetText}
            placeholder={String(DEFAULT_MEMORY_BUDGET)}
            disabled={updateMetadata.isPending}
            aria-label={t("ui.game.memorySettings.budgetLabel")}
            onChange={(event) => setBudgetText(event.target.value)}
            onBlur={(event) => commitBudget(event.currentTarget.validity.badInput)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            className="min-h-8 w-28 rounded-md border border-[var(--border)] bg-[var(--secondary)] px-2 text-right text-xs tabular-nums"
          />
        </label>
      </div>
      {(saveOwnership.isError || updateMetadata.isError) && (
        <p role="alert" className="pt-1 text-xs text-red-500">
          {t("ui.game.memorySettings.saveFailed")}
        </p>
      )}
    </section>
  );
}
