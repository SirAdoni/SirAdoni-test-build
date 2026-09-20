import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, RefreshCw, ShieldCheck } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ChatMetadata,
  GameContinuityMetadata,
  GameContinuityReceipt,
  GameContinuityReceiptStatus,
} from "@marinara-engine/shared";
import { useTranslation as useUiTranslation } from "react-i18next";
import { api } from "../../lib/api-client";
import { useConnections } from "../../hooks/use-connections";
import { chatKeys } from "../../hooks/use-chats";

type ContinuityConfig = GameContinuityMetadata;
type ContinuityMode = GameContinuityMetadata["mode"];
type ContinuityConfigPatch = {
  mode: ContinuityMode;
  extractorConnectionId: string | null;
  verifierConnectionId: string | null;
  extractionInstructions: string | null;
  verificationInstructions: string | null;
};
type ContinuityStatus = GameContinuityReceiptStatus;

interface ContinuityCounts {
  [status: string]: number | undefined;
}

interface ContinuityBatchSummary {
  id: string;
  status: ContinuityStatus;
  sessionNumber?: number;
  updatedAt?: string;
  error?: string;
}

export type SessionSummaryRefreshBadgeStatus = "provisional" | "stale" | "conflict" | "refreshed";

export interface SessionSummaryRefreshState {
  sessionNumber: number;
  status: string;
  reason?: string | null;
  updatedAt?: string | null;
  lastError?: string | null;
}

interface ContinuityStatusResponse {
  config?: ContinuityConfig;
  counts?: ContinuityCounts;
  batches?: ContinuityBatchSummary[];
  gaps?: Array<{ batchId: string; status: string; reason: string; messageId?: string }>;
  verifiedThroughMessageId?: string | null;
  summaryRefreshes?: SessionSummaryRefreshState[];
}

/** Collapse the server refresh lifecycle into the badges a reader needs; null hides the badge. */
export function summaryRefreshBadge(status: string): SessionSummaryRefreshBadgeStatus | null {
  if (status === "stale" || status === "conflict" || status === "provisional") return status;
  if (status === "pending" || status === "ready" || status === "queued") return "provisional";
  if (status === "completed") return "refreshed";
  return null;
}

/** Read the same descriptors from chat metadata for views without the continuity query. */
export function summaryRefreshStatesFromMetadata(metadata: unknown): SessionSummaryRefreshState[] {
  const root =
    metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>).gameSessionSummaryRefreshes : null;
  if (!root || typeof root !== "object" || Array.isArray(root)) return [];
  return Object.values(root as Record<string, unknown>).flatMap((item) => {
    const descriptor = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
    if (!descriptor || typeof descriptor.sessionNumber !== "number" || typeof descriptor.status !== "string") return [];
    return [
      {
        sessionNumber: descriptor.sessionNumber,
        status: descriptor.status,
        reason: typeof descriptor.reason === "string" ? descriptor.reason : null,
        updatedAt: typeof descriptor.updatedAt === "string" ? descriptor.updatedAt : null,
        lastError: typeof descriptor.lastError === "string" ? descriptor.lastError : null,
      },
    ];
  });
}

export function SessionSummaryRefreshBadge({ state }: { state: SessionSummaryRefreshState }) {
  const { t } = useUiTranslation();
  const badge = summaryRefreshBadge(state.status);
  if (!badge) return null;
  const alert = badge === "stale" || badge === "conflict";
  const title = [
    state.reason ? t(`ui.game.continuity.summaryRefreshReason.${state.reason}`) : "",
    state.lastError ?? "",
    state.updatedAt ?? "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <span
      data-component="SessionSummaryRefreshBadge"
      data-status={badge}
      title={title || undefined}
      className={
        alert
          ? "inline-flex items-center rounded-md bg-[var(--destructive)]/10 px-2 py-0.5 text-[0.6875rem] font-medium text-[var(--destructive)]"
          : "inline-flex items-center rounded-md bg-[var(--secondary)] px-2 py-0.5 text-[0.6875rem] font-medium text-[var(--muted-foreground)] ring-1 ring-[var(--border)]"
      }
    >
      {t(`ui.game.continuity.summaryRefresh.${badge}`)}
    </span>
  );
}

interface GameContinuityPanelProps {
  chatId: string;
  metadata?: ChatMetadata | null;
  className?: string;
}

const continuityKeys = {
  status: (chatId: string) => ["game-continuity", chatId] as const,
  receipt: (chatId: string, batchId: string) => ["game-continuity", chatId, batchId] as const,
};

function asConfig(config: ContinuityConfig | null | undefined): ContinuityConfig {
  return config ?? { mode: "off" };
}

function summarizeCounts(counts: ContinuityCounts) {
  return {
    pending: ["queued", "extracting", "reviewing", "repairing"].reduce((sum, status) => sum + (counts[status] ?? 0), 0),
    reviewed: (counts.verified ?? 0) + (counts.published ?? 0),
    unresolved: counts.unresolved ?? 0,
    stale: counts.stale ?? 0,
    failed: counts.failed ?? 0,
  };
}

const activeStatuses = new Set<ContinuityStatus>(["queued", "extracting", "reviewing", "repairing"]);

function connectionLabel(connection: unknown): string {
  if (!connection || typeof connection !== "object") return "";
  const item = connection as Record<string, unknown>;
  return typeof item.name === "string" && item.name.trim() ? item.name : typeof item.id === "string" ? item.id : "";
}

export function GameContinuityPanel({ chatId, metadata, className }: GameContinuityPanelProps) {
  const { t } = useUiTranslation();
  const queryClient = useQueryClient();
  const updateMetadata = useMutation({
    mutationFn: (gameContinuity: ContinuityConfigPatch) => api.patch(`/game/${chatId}/continuity`, gameContinuity),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: continuityKeys.status(chatId) });
      void queryClient.invalidateQueries({ queryKey: chatKeys.detail(chatId) });
    },
  });
  const connections = useConnections();
  const [expandedBatchId, setExpandedBatchId] = useState<string | null>(null);
  const config = asConfig(metadata?.gameContinuity as ContinuityConfig | undefined);
  const [draft, setDraft] = useState<ContinuityConfig>(config);

  useEffect(() => {
    setDraft({
      mode: config.mode,
      extractorConnectionId: config.extractorConnectionId,
      verifierConnectionId: config.verifierConnectionId,
      extractionInstructions: config.extractionInstructions,
      verificationInstructions: config.verificationInstructions,
    });
  }, [
    chatId,
    config.mode,
    config.extractorConnectionId,
    config.verifierConnectionId,
    config.extractionInstructions,
    config.verificationInstructions,
  ]);

  const status = useQuery({
    queryKey: continuityKeys.status(chatId),
    queryFn: () => api.get<ContinuityStatusResponse>(`/game/${chatId}/continuity`),
    enabled: Boolean(chatId),
    staleTime: 5_000,
    refetchInterval: config.mode === "off" ? false : 5_000,
  });
  const receipt = useQuery({
    queryKey: continuityKeys.receipt(chatId, expandedBatchId ?? ""),
    queryFn: () => api.get<GameContinuityReceipt>(`/game/${chatId}/continuity/${expandedBatchId}`),
    enabled: Boolean(expandedBatchId),
    staleTime: 5_000,
    refetchInterval: (query) => {
      const data = query.state.data as GameContinuityReceipt | undefined;
      return data && activeStatuses.has(data.status) ? 5_000 : false;
    },
  });
  const retry = useMutation({
    mutationFn: (batchId: string) => api.post(`/game/${chatId}/continuity/retry`, { batchId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: continuityKeys.status(chatId) });
      if (expandedBatchId)
        void queryClient.invalidateQueries({ queryKey: continuityKeys.receipt(chatId, expandedBatchId) });
    },
  });
  const reconcile = useMutation({
    mutationFn: () => api.post(`/game/${chatId}/continuity/reconcile`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: continuityKeys.status(chatId) });
    },
  });

  const connectionOptions = useMemo(
    () =>
      (connections.data ?? []).filter((item) => connectionLabel(item)).map((item) => item as Record<string, unknown>),
    [connections.data],
  );
  const counts = summarizeCounts(status.data?.counts ?? {});
  const batches = status.data?.batches ?? [];
  const gaps = status.data?.gaps ?? [];
  const verifiedThroughMessageId = status.data?.verifiedThroughMessageId ?? null;
  const summaryRefreshes = (status.data?.summaryRefreshes ?? []).filter((item) => summaryRefreshBadge(item.status));

  const saveConfig = async () => {
    try {
      await updateMetadata.mutateAsync({
        mode: draft.mode,
        extractorConnectionId: draft.extractorConnectionId ?? null,
        verifierConnectionId: draft.verifierConnectionId ?? null,
        extractionInstructions: draft.extractionInstructions ?? null,
        verificationInstructions: draft.verificationInstructions ?? null,
      });
    } catch {
      // The inline error below keeps the draft available for another attempt.
    }
  };

  return (
    <section
      className={className ?? "rounded-lg border border-[var(--border)] bg-[var(--secondary)]/45"}
      aria-labelledby="game-continuity-title"
    >
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <ShieldCheck size={15} className="text-[var(--muted-foreground)]" aria-hidden="true" />
        <h3 id="game-continuity-title" className="text-sm font-semibold text-[var(--foreground)]">
          {t("ui.game.continuity.title")}
        </h3>
        <span className="text-xs text-[var(--muted-foreground)]">{t("ui.game.continuity.description")}</span>
        <label className="ml-auto flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
          <span>{t("ui.game.continuity.mode")}</span>
          <select
            value={draft.mode}
            onChange={(event) => setDraft((value) => ({ ...value, mode: event.target.value as ContinuityMode }))}
            disabled={updateMetadata.isPending}
            className="rounded-md border border-[var(--border)] bg-[var(--secondary)] px-2 py-1 text-xs text-[var(--foreground)]"
            aria-label={t("ui.game.continuity.mode")}
          >
            <option value="off">{t("ui.game.continuity.off")}</option>
            <option value="shadow">{t("ui.game.continuity.shadow")}</option>
            <option value="active">{t("ui.game.continuity.active")}</option>
          </select>
        </label>
      </div>

      {config.mode !== "off" && (
        <div className="border-t border-[var(--border)] px-3 py-3">
          <div className="grid gap-2 sm:grid-cols-2">
            {(["extractorConnectionId", "verifierConnectionId"] as const).map((field) => (
              <label key={field} className="flex flex-col gap-1 text-xs text-[var(--muted-foreground)]">
                <span>{t(`ui.game.continuity.${field === "extractorConnectionId" ? "extractor" : "verifier"}`)}</span>
                <select
                  value={draft[field] ?? ""}
                  onChange={(event) => setDraft((value) => ({ ...value, [field]: event.target.value || undefined }))}
                  disabled={updateMetadata.isPending || connections.isLoading}
                  className="rounded-md border border-[var(--border)] bg-[var(--secondary)] px-2 py-1.5 text-sm text-[var(--foreground)]"
                >
                  <option value="">{t("ui.game.continuity.useDefaultConnection")}</option>
                  {connectionOptions.map((connection) => (
                    <option key={String(connection.id)} value={String(connection.id)}>
                      {connectionLabel(connection)}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {(["extractionInstructions", "verificationInstructions"] as const).map((field) => (
              <label key={field} className="flex flex-col gap-1 text-xs text-[var(--muted-foreground)]">
                <span>
                  {t(
                    `ui.game.continuity.${field === "extractionInstructions" ? "extractionInstructions" : "verificationInstructions"}`,
                  )}
                </span>
                <textarea
                  value={draft[field] ?? ""}
                  onChange={(event) => setDraft((value) => ({ ...value, [field]: event.target.value || undefined }))}
                  rows={3}
                  className="resize-y rounded-md border border-[var(--border)] bg-[var(--secondary)] px-2 py-1.5 text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)]"
                />
              </label>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void saveConfig()}
              disabled={updateMetadata.isPending}
              className="rounded-md bg-[var(--primary)] px-3 py-1.5 text-xs font-medium text-[var(--primary-foreground)] disabled:opacity-50"
            >
              {updateMetadata.isPending ? t("ui.game.continuity.saving") : t("ui.game.continuity.save")}
            </button>
            {updateMetadata.isError && (
              <span className="text-xs text-[var(--destructive)]">{t("ui.game.continuity.saveFailed")}</span>
            )}
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-1.5 border-t border-[var(--border)] px-3 py-2" aria-live="polite">
        {(["pending", "reviewed", "unresolved", "stale", "failed"] as const).map((key) => (
          <span
            key={key}
            className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[0.6875rem] text-[var(--muted-foreground)]"
          >
            {t(`ui.game.continuity.${key}`)}: {counts[key] ?? 0}
          </span>
        ))}
        {config.mode !== "off" && (
          <button
            type="button"
            onClick={() => reconcile.mutate()}
            disabled={reconcile.isPending}
            className="ml-auto inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-[0.6875rem] text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)] disabled:opacity-50"
          >
            <RefreshCw size={12} className={reconcile.isPending ? "animate-spin" : ""} />
            {reconcile.isPending ? t("ui.game.continuity.rechecking") : t("ui.game.continuity.recheck")}
          </button>
        )}
      </div>
      {reconcile.isError && (
        <p className="border-t border-[var(--border)] px-3 py-2 text-xs text-[var(--destructive)]">
          {t("ui.game.continuity.recheckFailed")}
        </p>
      )}
      {config.mode !== "off" && status.data && (
        <p
          data-component="GameContinuityPanel.Watermark"
          className="border-t border-[var(--border)] px-3 py-2 text-xs text-[var(--muted-foreground)]"
        >
          {verifiedThroughMessageId
            ? t("ui.game.continuity.verifiedThrough", { value1: verifiedThroughMessageId })
            : t("ui.game.continuity.verifiedThroughNone")}
        </p>
      )}
      {!!gaps.length && (
        <div className="border-t border-[var(--border)] px-3 py-2 text-xs text-[var(--destructive)]">
          <div className="mb-1 font-medium">{t("ui.game.continuity.sourceGaps")}</div>
          <ul className="flex flex-col gap-1">
            {gaps.map((gap) => (
              <li key={`${gap.batchId}-${gap.messageId ?? ""}-${gap.reason}`}>
                <span className="font-medium">{gap.messageId ?? gap.batchId}</span> ·{" "}
                {gap.reason === "CONTINUITY_TURN_NOT_ENQUEUED" ? t("ui.game.continuity.turnNotEnqueued") : gap.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!!summaryRefreshes.length && (
        <div
          data-component="GameContinuityPanel.SummaryRefreshes"
          className="border-t border-[var(--border)] px-3 py-2 text-xs text-[var(--foreground)]"
        >
          <div className="mb-1 font-medium">{t("ui.game.continuity.summaryRefreshes")}</div>
          <ul className="flex flex-col gap-1">
            {summaryRefreshes.map((item) => (
              <li key={item.sessionNumber} className="flex flex-wrap items-center gap-2">
                <span>{t("ui.game.continuity.summaryRefreshSession", { value1: item.sessionNumber })}</span>
                <SessionSummaryRefreshBadge state={item} />
                {item.reason && (
                  <span className="text-[var(--muted-foreground)]">
                    {t(`ui.game.continuity.summaryRefreshReason.${item.reason}`)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {status.isError ? (
        <p className="border-t border-[var(--border)] px-3 py-2 text-xs text-[var(--destructive)]">
          {t("ui.game.continuity.statusUnavailable")}
        </p>
      ) : batches.length > 0 ? (
        <div className="border-t border-[var(--border)]">
          {batches.map((batch) => {
            const open = expandedBatchId === batch.id;
            return (
              <div key={batch.id} className="border-b border-[var(--border)] last:border-b-0">
                <div className="flex items-center gap-2 px-3 py-2">
                  <button
                    type="button"
                    onClick={() => setExpandedBatchId(open ? null : batch.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs text-[var(--foreground)]"
                    aria-expanded={open}
                  >
                    {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <span className="truncate">{t(`ui.game.continuity.batchStatus.${batch.status}`)}</span>
                    {batch.sessionNumber != null && (
                      <span className="text-[var(--muted-foreground)]">#{batch.sessionNumber}</span>
                    )}
                  </button>
                  {(batch.status === "failed" || batch.status === "unresolved" || batch.status === "stale") && (
                    <button
                      type="button"
                      onClick={() => retry.mutate(batch.id)}
                      disabled={retry.isPending}
                      className="flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-[0.6875rem] text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
                    >
                      <RefreshCw size={12} className={retry.isPending ? "animate-spin" : ""} />{" "}
                      {t("ui.game.continuity.retry")}
                    </button>
                  )}
                </div>
                {open && (
                  <div className="px-3 pb-3">
                    {receipt.isLoading ? (
                      <p className="text-xs text-[var(--muted-foreground)]">{t("ui.game.continuity.loadingReceipt")}</p>
                    ) : receipt.isError ? (
                      <p className="text-xs text-[var(--destructive)]">{t("ui.game.continuity.receiptUnavailable")}</p>
                    ) : (
                      <ReceiptDetails receipt={receipt.data} />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="border-t border-[var(--border)] px-3 py-2 text-xs text-[var(--muted-foreground)]">
          {t("ui.game.continuity.noBatches")}
        </p>
      )}
      {retry.isError && (
        <p className="border-t border-[var(--border)] px-3 py-2 text-xs text-[var(--destructive)]">
          {t("ui.game.continuity.retryFailed")}
        </p>
      )}
    </section>
  );
}

function ReceiptDetails({ receipt }: { receipt?: GameContinuityReceipt }) {
  const { t } = useUiTranslation();
  if (!receipt)
    return <p className="text-xs text-[var(--muted-foreground)]">{t("ui.game.continuity.receiptUnavailable")}</p>;
  const findings = receipt.review?.findings ?? [];
  return (
    <div className="flex flex-col gap-2 text-xs text-[var(--foreground)]">
      {receipt.errorCode && (
        <p className="text-[var(--destructive)]">
          {receipt.errorCode}: {receipt.error ?? t("ui.game.continuity.receiptFailed")}
        </p>
      )}
      {!!receipt.sources.length && (
        <div>
          <div className="mb-1 font-medium">{t("ui.game.continuity.sourceQuotes")}</div>
          {receipt.sources.map((source) => (
            <blockquote
              key={`${source.messageId}-${source.swipeIndex}-${source.hash}`}
              className="border border-[var(--border)] bg-[var(--secondary)] px-2 py-1 text-[var(--muted-foreground)]"
            >
              <span className="mr-1 font-medium">{source.messageId}</span>
              {source.content}
            </blockquote>
          ))}
        </div>
      )}
      {!!receipt.records.length && (
        <div>
          <div className="mb-1 font-medium">{t("ui.game.continuity.proposedRecords")}</div>
          {receipt.records.map((record) => (
            <div key={record.id} className="border border-[var(--border)] bg-[var(--secondary)] px-2 py-1">
              <p>
                <span className="font-medium">
                  {t(`ui.game.continuity.recordKind.${record.kind}`)} ·{" "}
                  {t(`ui.game.continuity.recordStatus.${record.status}`)}:{" "}
                </span>
                {record.text}
              </p>
              {record.conditions.length > 0 && (
                <p className="text-[var(--muted-foreground)]">
                  {t("ui.game.continuity.conditions")}: {record.conditions.join(", ")}
                </p>
              )}
              {record.knowledge && (
                <p className="text-[var(--muted-foreground)]">
                  {t("ui.game.continuity.knowledge")}:{" "}
                  {t(`ui.game.continuity.knowledgeScope.${record.knowledge.scope}`)}
                  {record.knowledge.holders.length > 0 && (
                    <>
                      <span className="ml-1">{t("ui.game.continuity.knowledgeHolders")}:</span>{" "}
                      {record.knowledge.holders.join(", ")}
                    </>
                  )}
                </p>
              )}
              {record.evidence.map((evidence) => (
                <p
                  key={`${record.id}-${evidence.messageId}-${evidence.quote}`}
                  className="text-[var(--muted-foreground)]"
                >
                  {evidence.messageId}: “{evidence.quote}”
                </p>
              ))}
            </div>
          ))}
        </div>
      )}
      {!!findings.length && (
        <div>
          <div className="mb-1 font-medium">{t("ui.game.continuity.reviewFindings")}</div>
          {findings.map((finding) => (
            <p key={`${finding.messageId}-${finding.quote}-${finding.kind}`}>
              <span className="font-medium">{t(`ui.game.continuity.findingKind.${finding.kind}`)}: </span>
              {finding.detail} <span className="text-[var(--muted-foreground)]">({finding.messageId})</span>
            </p>
          ))}
        </div>
      )}
      {!findings.length && receipt.status === "verified" && (
        <p className="text-[var(--muted-foreground)]">{t("ui.game.continuity.reviewedNoIssues")}</p>
      )}
    </div>
  );
}
