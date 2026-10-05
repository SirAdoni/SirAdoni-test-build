import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api-client";
import { useFeatureEnabled } from "../../hooks/use-feature-settings";
import { GameMemorySettings, type ContinuityOwnershipValue } from "./GameMemorySettings";

interface ContinuityStatus {
  config: { mode: "off" | "shadow" | "active"; ownership: ContinuityOwnershipValue | null };
  counts: Record<string, number>;
  verifiedThroughMessageId: string | null;
  gaps: Array<{ fromMessageId: string; toMessageId: string; reason: string }>;
  batches: Array<{ id: string; sessionNumber: number; status: string; sourceCurrent: boolean }>;
}

export function GameContinuityPanel({
  chatId,
  metadata,
}: {
  chatId: string;
  metadata?: import("@marinara-engine/shared").ChatMetadata | null;
}) {
  const { t } = useTranslation();
  const controlsEnabled = useFeatureEnabled("gameMemoryControls");
  const continuityEnabled = useFeatureEnabled("gameContinuity");
  const status = useQuery({
    queryKey: ["game-continuity", chatId],
    queryFn: () => api.get<ContinuityStatus>(`/game/${chatId}/continuity`),
    enabled: Boolean(chatId) && controlsEnabled && continuityEnabled,
  });
  const state = continuityEnabled && status.isSuccess ? status.data : undefined;

  if (!controlsEnabled) return null;

  return (
    <section
      className="rounded-lg border border-[var(--border)] bg-[var(--secondary)]/30 px-3 py-2"
      aria-label={t("ui.game.continuity.title")}
    >
      <h3 className="text-xs font-semibold text-[var(--foreground)]">{t("ui.game.continuity.title")}</h3>
      {!continuityEnabled ? (
        <p className="pt-2 text-xs text-[var(--muted-foreground)]">{t("ui.game.continuity.disabled")}</p>
      ) : status.isLoading ? (
        <p className="pt-2 text-xs text-[var(--muted-foreground)]">{t("ui.game.continuity.loading")}</p>
      ) : status.isError || !state ? (
        <p role="alert" className="pt-2 text-xs text-[var(--muted-foreground)]">
          {t("ui.game.continuity.unavailable")}
        </p>
      ) : (
        <div className="pt-2 text-xs text-[var(--muted-foreground)]">
          <p>{t("ui.game.continuity.mode", { mode: t(`ui.game.continuity.mode_${state.config.mode}`) })}</p>
          <p>{t("ui.game.continuity.receipts", { count: state.batches.length })}</p>
          <p>{t("ui.game.continuity.gaps", { count: state.gaps.length })}</p>
          {state.verifiedThroughMessageId && (
            <p className="truncate">
              {t("ui.game.continuity.verifiedThrough", { id: state.verifiedThroughMessageId })}
            </p>
          )}
          {state.batches.length > 0 && (
            <ul className="mt-2 divide-y divide-[var(--border)]/60">
              {state.batches
                .slice(-5)
                .reverse()
                .map((batch) => (
                  <li key={batch.id} className="py-1">
                    {t("ui.game.continuity.sessionStatus", {
                      session: batch.sessionNumber,
                      status: batch.status,
                      stale: batch.sourceCurrent ? "" : ` · ${t("ui.game.continuity.stale")}`,
                    })}
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}
      <GameMemorySettings
        chatId={chatId}
        metadata={metadata}
        ownership={state?.config.ownership ?? null}
        ownershipLoaded={continuityEnabled && status.isSuccess && Boolean(state)}
        onContinuityChanged={() => void status.refetch()}
      />
    </section>
  );
}
