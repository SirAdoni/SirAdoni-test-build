import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  Loader2,
  PauseCircle,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ChatMetadata,
  GameContinuityFindingKind,
  GameContinuityMetadata,
  GameContinuityReceipt,
  GameContinuityReceiptStatus,
  GameContinuityRecord,
} from "@marinara-engine/shared";
import { useTranslation as useUiTranslation } from "react-i18next";
import { api } from "../../lib/api-client";
import { showConfirmDialog } from "../../lib/app-dialogs";
import { cn } from "../../lib/utils";
import { useConnections } from "../../hooks/use-connections";
import { chatKeys } from "../../hooks/use-chats";
import { WikiChip, factKindTone, type WikiTone } from "./campaign-wiki-ui";
import { GameMemorySettings, type ContinuityOwnershipValue } from "./GameMemorySettings";

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
type Translate = (key: string, options?: Record<string, unknown>) => string;

interface ContinuityCounts {
  [status: string]: number | undefined;
}

interface ContinuityBatchSummary {
  id: string;
  status: ContinuityStatus;
  sessionNumber?: number;
  createdAt?: string;
  updatedAt?: string;
  attempts?: number;
  sourceCurrent?: boolean;
  errorCode?: string | null;
  error?: string | null;
}

export type SessionSummaryRefreshBadgeStatus = "provisional" | "stale" | "conflict" | "refreshed";

export interface SessionSummaryRefreshState {
  sessionNumber: number;
  status: string;
  reason?: string | null;
  updatedAt?: string | null;
  lastError?: string | null;
}

interface ContinuityGap {
  batchId: string;
  status: string;
  reason: string;
  messageId?: string;
}

/** POST /game/:chatId/continuity/retry-all with { dryRun: true }: what Retry all would do. */
interface ContinuityRetryAllSummary {
  counts: { batches: number; modelBatches: number; publishOnly: number; superseded: number; split: number };
  estimatedModelCalls: number;
  budget: { used: number; limit: number };
}

/** The same route with { confirm: true }: what Retry all did. */
interface ContinuityRetryAllResult extends ContinuityRetryAllSummary {
  retried: string[];
  published: string[];
  requeued: string[];
  skipped: Array<{ id: string; reason: string }>;
}

interface ContinuityStatusResponse {
  config?: ContinuityConfig & { ownership?: ContinuityOwnershipValue | null };
  counts?: ContinuityCounts;
  /** False when no usable reader/checker connection exists, so the queue cannot run. */
  connectionAvailable?: boolean;
  batches?: ContinuityBatchSummary[];
  gaps?: ContinuityGap[];
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
          ? "inline-flex items-center rounded-full border border-amber-400/35 bg-amber-400/10 px-2 py-0.5 text-[0.6875rem] font-medium text-amber-200"
          : "inline-flex items-center rounded-full border border-[var(--border)] bg-[var(--secondary)] px-2 py-0.5 text-[0.6875rem] font-medium text-[var(--muted-foreground)]"
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
  const pending = ["queued", "extracting", "reviewing", "repairing"].reduce(
    (sum, status) => sum + (counts[status] ?? 0),
    0,
  );
  const working = ["extracting", "reviewing", "repairing"].reduce((sum, status) => sum + (counts[status] ?? 0), 0);
  const reviewed = (counts.verified ?? 0) + (counts.published ?? 0);
  const unresolved = counts.unresolved ?? 0;
  const failed = counts.failed ?? 0;
  const stale = counts.stale ?? 0;
  return {
    pending,
    working,
    reviewed,
    unresolved,
    stale,
    failed,
    attention: unresolved + failed,
    total: pending + reviewed + unresolved + failed + stale,
  };
}

const activeStatuses = new Set<ContinuityStatus>(["queued", "extracting", "reviewing", "repairing"]);
const retryableStatuses = new Set<ContinuityStatus>(["failed", "unresolved", "stale"]);
const doneStatuses = new Set<ContinuityStatus>(["verified", "published"]);
const BATCH_PAGE = 20;

function connectionLabel(connection: unknown): string {
  if (!connection || typeof connection !== "object") return "";
  const item = connection as Record<string, unknown>;
  return typeof item.name === "string" && item.name.trim() ? item.name : typeof item.id === "string" ? item.id : "";
}

// ── Plain-language helpers ──────────────────────────────────────────────

type ProblemKind =
  | "connection"
  | "credentials"
  | "budget"
  | "limit"
  | "timeout"
  | "tooLong"
  | "configChanged"
  | "sourceChanged"
  | "stopped"
  | "badAnswer"
  | "requestFailed"
  | "generic";

/** Map a server error code (and its message) to a reason a player can understand. */
function problemKind(code: string | null | undefined, message: string | null | undefined): ProblemKind | null {
  const value = `${code ?? ""} ${message ?? ""}`;
  if (!value.trim()) return null;
  if (/NO_CONNECTION|CONNECTION_UNAVAILABLE|CONNECTION_MISSING|CONNECTION_NOT_FOUND/i.test(value)) return "connection";
  if (/PROVIDER_AUTH/i.test(value)) return "credentials";
  if (/BACKGROUND_BUDGET/i.test(value)) return "budget";
  if (/PROVIDER_LIMITED|rate.?limit|session limit|usage limit|quota|429/i.test(value)) return "limit";
  if (/TIMEOUT|UNRESPONSIVE|PROVIDER_UNAVAILABLE|timed out/i.test(value)) return "timeout";
  if (/CONTEXT_OVERFLOW|context length|too long/i.test(value)) return "tooLong";
  if (/CONFIG_CHANGED/i.test(value)) return "configChanged";
  if (/SOURCE_CHANGED/i.test(value)) return "sourceChanged";
  if (/CONTINUITY_PAUSED|CONTINUITY_STOPPED/i.test(value)) return "stopped";
  if (/EMPTY_RESPONSE|JSON|PARSE|ENVELOPE|INVALID_OUTPUT/i.test(value)) return "badAnswer";
  if (/STAGE_FAILED|request failed/i.test(value)) return "requestFailed";
  return "generic";
}

function problemText(t: Translate, kind: ProblemKind): string {
  switch (kind) {
    case "connection":
      return t("ui.game.continuityPanel.problem.connection", {
        defaultValue: "No AI connection is set for memory, or the chosen one was removed.",
      });
    case "credentials":
      return t("ui.game.continuityPanel.problem.credentials", {
        defaultValue: "Your AI connection rejected its API key. Fix the key in Connections, then press Retry.",
      });
    case "budget":
      return t("ui.game.continuityPanel.problem.budget", {
        defaultValue: "Automatic AI calls reached the hourly cap. Memory resumes on its own when a slot frees.",
      });
    case "limit":
      return t("ui.game.continuityPanel.problem.limit", {
        defaultValue: "Your AI connection hit its usage limit. Memory picks up again once the limit resets.",
      });
    case "timeout":
      return t("ui.game.continuityPanel.problem.timeout", {
        defaultValue: "The AI connection did not answer in time.",
      });
    case "tooLong":
      return t("ui.game.continuityPanel.problem.tooLong", {
        defaultValue: "This part of the story was too long for the model to read in one go.",
      });
    case "configChanged":
      return t("ui.game.continuityPanel.problem.configChanged", {
        defaultValue: "Memory settings changed after this turn was queued. Retry to read it with the new settings.",
      });
    case "sourceChanged":
      return t("ui.game.continuityPanel.problem.sourceChanged", {
        defaultValue: "The message was edited or swiped after it was read.",
      });
    case "stopped":
      return t("ui.game.continuityPanel.problem.stopped", {
        defaultValue: "Memory was turned off or stopped while this turn was being read.",
      });
    case "badAnswer":
      return t("ui.game.continuityPanel.problem.badAnswer", {
        defaultValue: "The model sent back an answer that could not be understood.",
      });
    case "requestFailed":
      return t("ui.game.continuityPanel.problem.requestFailed", {
        defaultValue: "The request to your AI connection failed.",
      });
    default:
      return t("ui.game.continuityPanel.problem.generic", {
        defaultValue: "Something went wrong while remembering this turn.",
      });
  }
}

/** One short line for a batch row: why it needs attention, or nothing. */
function batchNote(t: Translate, batch: Pick<ContinuityBatchSummary, "status" | "errorCode" | "error">): string | null {
  const kind = problemKind(batch.errorCode, batch.error);
  if (kind && (batch.status === "failed" || activeStatuses.has(batch.status) || batch.status === "stale")) {
    return problemText(t, kind);
  }
  if (batch.status === "unresolved") {
    return t("ui.game.continuityPanel.problem.unresolved", {
      defaultValue: "The checker still had doubts after several fixes, so this turn was not added to memory.",
    });
  }
  if (batch.status === "stale") {
    return t("ui.game.continuityPanel.problem.stale", {
      defaultValue: "The story changed after this was remembered. Retry to read it again.",
    });
  }
  if (batch.status === "failed") return problemText(t, "generic");
  return null;
}

function statusTone(status: ContinuityStatus): WikiTone {
  if (doneStatuses.has(status)) return "success";
  if (status === "failed") return "danger";
  if (status === "unresolved" || status === "stale") return "warning";
  if (status === "queued") return "neutral";
  return "info";
}

function statusLabel(t: Translate, status: ContinuityStatus): string {
  switch (status) {
    case "queued":
      return t("ui.game.continuityPanel.status.queued", { defaultValue: "Waiting" });
    case "extracting":
      return t("ui.game.continuityPanel.status.extracting", { defaultValue: "Reading" });
    case "reviewing":
      return t("ui.game.continuityPanel.status.reviewing", { defaultValue: "Double-checking" });
    case "repairing":
      return t("ui.game.continuityPanel.status.repairing", { defaultValue: "Fixing" });
    case "verified":
      return t("ui.game.continuityPanel.status.verified", { defaultValue: "Checked" });
    case "published":
      return t("ui.game.continuityPanel.status.published", { defaultValue: "Remembered" });
    case "unresolved":
      return t("ui.game.continuityPanel.status.unresolved", { defaultValue: "Has doubts" });
    case "failed":
      return t("ui.game.continuityPanel.status.failed", { defaultValue: "Failed" });
    case "stale":
      return t("ui.game.continuityPanel.status.stale", { defaultValue: "Out of date" });
    default:
      return t(`ui.game.continuity.batchStatus.${status}`);
  }
}

function findingLabel(t: Translate, kind: GameContinuityFindingKind): string {
  switch (kind) {
    case "omission":
      return t("ui.game.continuityPanel.finding.omission", { defaultValue: "Left something out" });
    case "attribution":
      return t("ui.game.continuityPanel.finding.attribution", { defaultValue: "Credited the wrong person" });
    case "condition":
      return t("ui.game.continuityPanel.finding.condition", { defaultValue: 'Missed an "only if"' });
    case "unsupported":
      return t("ui.game.continuityPanel.finding.unsupported", { defaultValue: "Not backed by the story" });
    case "contradiction":
      return t("ui.game.continuityPanel.finding.contradiction", { defaultValue: "Contradicts the story" });
    case "knowledge":
      return t("ui.game.continuityPanel.finding.knowledge", { defaultValue: "Wrong about who knows" });
    default:
      return t("ui.game.continuityPanel.finding.other", { defaultValue: "Other note" });
  }
}

function roleLabel(t: Translate, role: string): string {
  if (role === "user") return t("ui.game.continuityPanel.detail.roleYou", { defaultValue: "You" });
  if (role.startsWith("assistant")) return t("ui.game.continuityPanel.detail.roleStory", { defaultValue: "Story" });
  return t("ui.game.continuityPanel.detail.roleOther", { defaultValue: "Note" });
}

function relativeTime(iso: string | null | undefined, locale: string): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  const seconds = Math.round((then - Date.now()) / 1000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const abs = Math.abs(seconds);
  if (abs < 60) return format.format(seconds, "second");
  if (abs < 3600) return format.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return format.format(Math.round(seconds / 3600), "hour");
  return format.format(Math.round(seconds / 86_400), "day");
}

type Health =
  | "loading"
  | "off"
  | "error"
  | "connection"
  | "credentials"
  | "budget"
  | "limit"
  | "attention"
  | "catchingUp"
  | "stale"
  | "empty"
  | "ok";

const HEALTH_TONE: Record<Health, { icon: typeof CheckCircle2; className: string }> = {
  loading: { icon: Loader2, className: "bg-secondary text-muted-foreground" },
  off: { icon: CircleSlash, className: "bg-secondary text-muted-foreground" },
  error: { icon: AlertTriangle, className: "bg-destructive/15 text-destructive" },
  connection: { icon: PauseCircle, className: "bg-destructive/15 text-destructive" },
  credentials: { icon: PauseCircle, className: "bg-destructive/15 text-destructive" },
  budget: { icon: PauseCircle, className: "bg-amber-400/15 text-amber-200" },
  limit: { icon: PauseCircle, className: "bg-amber-400/15 text-amber-200" },
  attention: { icon: AlertTriangle, className: "bg-amber-400/15 text-amber-200" },
  catchingUp: { icon: Loader2, className: "bg-sky-400/15 text-sky-200" },
  stale: { icon: RefreshCw, className: "bg-amber-400/15 text-amber-200" },
  empty: { icon: Sparkles, className: "bg-primary/15 text-foreground" },
  ok: { icon: CheckCircle2, className: "bg-emerald-400/15 text-emerald-200" },
};

type BatchFilter = "attention" | "waiting" | "done" | "stale" | "all";

const buttonBase =
  "inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-50";
const primaryButton = cn(buttonBase, "bg-primary text-primary-foreground shadow-sm hover:opacity-90");
const secondaryButton = cn(buttonBase, "border border-border bg-secondary/50 text-foreground hover:bg-secondary");
const fieldClass =
  "min-h-9 w-full rounded-lg border border-border bg-secondary px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-primary focus-visible:ring-2 focus-visible:ring-primary/40";

function Disclosure({
  open,
  onToggle,
  title,
  hint,
  icon,
  extra,
  dataComponent,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  title: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  extra?: ReactNode;
  dataComponent?: string;
  children: ReactNode;
}) {
  return (
    <div className="border-t border-border" data-component={dataComponent}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60"
      >
        {open ? (
          <ChevronDown size={15} className="shrink-0 text-muted-foreground" aria-hidden="true" />
        ) : (
          <ChevronRight size={15} className="shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
        {icon}
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-foreground">{title}</span>
          {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
        </span>
        {extra}
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
}

function TechnicalDetails({
  label,
  lines,
}: {
  label: string;
  lines: Array<[string, string | number | null | undefined]>;
}) {
  const visible = lines.filter(([, value]) => value !== null && value !== undefined && value !== "");
  if (!visible.length) return null;
  return (
    <details className="group mt-1 text-[0.6875rem] text-muted-foreground">
      <summary className="inline-flex min-h-8 cursor-pointer select-none items-center gap-1 rounded-md px-1 hover:text-foreground">
        <ChevronRight size={12} className="transition-transform group-open:rotate-90" aria-hidden="true" />
        {label}
      </summary>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-lg bg-secondary/50 px-2.5 py-2 font-mono">
        {visible.map(([name, value]) => (
          <div key={name} className="contents">
            <dt className="text-muted-foreground">{name}</dt>
            <dd className="min-w-0 break-all text-foreground/80">{String(value)}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

export function GameContinuityPanel({ chatId, metadata, className }: GameContinuityPanelProps) {
  const { t, i18n } = useUiTranslation();
  const queryClient = useQueryClient();
  const updateMetadata = useMutation({
    mutationFn: (gameContinuity: ContinuityConfigPatch) => api.patch(`/game/${chatId}/continuity`, gameContinuity),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: continuityKeys.status(chatId) });
      void queryClient.invalidateQueries({ queryKey: chatKeys.detail(chatId) });
    },
  });
  const connections = useConnections();
  const coverageIssuesRef = useRef<HTMLDivElement>(null);
  const connectionSelectRef = useRef<HTMLSelectElement>(null);
  const [expandedBatchId, setExpandedBatchId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsNavigationRequest, setSettingsNavigationRequest] = useState(0);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [batchesOpen, setBatchesOpen] = useState(false);
  const [filter, setFilter] = useState<BatchFilter>("attention");
  const [visibleCount, setVisibleCount] = useState(BATCH_PAGE);
  const [retryAllResult, setRetryAllResult] = useState<ContinuityRetryAllResult | "nothing" | null>(null);
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

  useEffect(() => {
    if (!settingsOpen || settingsNavigationRequest === 0) return;
    const connectionSelect = connectionSelectRef.current;
    if (connectionSelect) {
      connectionSelect.focus({ preventScroll: true });
      connectionSelect.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    setSettingsNavigationRequest(0);
  }, [settingsOpen, settingsNavigationRequest]);

  // Batch views and save errors belong to the chat they were opened in.
  const { reset: resetSave } = updateMetadata;
  useEffect(() => {
    setExpandedBatchId(null);
    setVisibleCount(BATCH_PAGE);
    setRetryAllResult(null);
    resetSave();
  }, [chatId, resetSave]);

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
  // Retry all: a dry run for the confirmation, then the run. Null when the player cancelled.
  const retryAll = useMutation({
    mutationFn: async (): Promise<ContinuityRetryAllResult | "nothing" | null> => {
      const plan = await api.post<ContinuityRetryAllSummary>(`/game/${chatId}/continuity/retry-all`, { dryRun: true });
      if (plan.counts.batches === 0) return "nothing";
      const lines = [
        t("ui.game.continuityPanel.retryAll.confirmModel", {
          defaultValue:
            "{{count}} need a new read: about {{calls}} AI calls on the memory connection, more if the checker asks for fixes.",
          count: plan.counts.modelBatches,
          calls: plan.estimatedModelCalls,
        }),
      ];
      if (plan.counts.publishOnly > 0)
        lines.push(
          t("ui.game.continuityPanel.retryAll.confirmPublishOnly", {
            defaultValue: "{{count}} were already checked and only need saving again: no AI call.",
            count: plan.counts.publishOnly,
          }),
        );
      if (plan.counts.superseded > 0)
        lines.push(
          t("ui.game.continuityPanel.retryAll.confirmSuperseded", {
            defaultValue: "{{count}} skipped: a newer remembered turn already covers them.",
            count: plan.counts.superseded,
          }),
        );
      if (plan.budget.limit > 0)
        lines.push(
          t("ui.game.continuityPanel.retryAll.confirmCap", {
            defaultValue:
              "Hourly call cap: {{used}} of {{limit}} used. Reads wait for a free slot instead of going over.",
            used: plan.budget.used,
            limit: plan.budget.limit,
          }),
        );
      const confirmed = await showConfirmDialog({
        title: t("ui.game.continuityPanel.retryAll.confirmTitle", {
          defaultValue: "Retry {{count}} turns?",
          count: plan.counts.batches,
        }),
        message: lines.join("\n\n"),
        confirmLabel: t("ui.game.continuityPanel.retryAll.button", { defaultValue: "Retry all" }),
      });
      if (!confirmed) return null;
      return api.post<ContinuityRetryAllResult>(`/game/${chatId}/continuity/retry-all`, { confirm: true });
    },
    onSuccess: (result) => {
      if (result) setRetryAllResult(result);
      void queryClient.invalidateQueries({ queryKey: continuityKeys.status(chatId) });
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
  const batches = useMemo(() => status.data?.batches ?? [], [status.data?.batches]);
  const gaps = useMemo(() => status.data?.gaps ?? [], [status.data?.gaps]);
  const verifiedThroughMessageId = status.data?.verifiedThroughMessageId ?? null;
  const summaryRefreshes = (status.data?.summaryRefreshes ?? []).filter((item) => summaryRefreshBadge(item.status));

  const dirty =
    draft.mode !== config.mode ||
    (draft.extractorConnectionId ?? "") !== (config.extractorConnectionId ?? "") ||
    (draft.verifierConnectionId ?? "") !== (config.verifierConnectionId ?? "") ||
    (draft.extractionInstructions ?? "") !== (config.extractionInstructions ?? "") ||
    (draft.verificationInstructions ?? "") !== (config.verificationInstructions ?? "");

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
  const discardDraft = () =>
    setDraft({
      mode: config.mode,
      extractorConnectionId: config.extractorConnectionId,
      verifierConnectionId: config.verifierConnectionId,
      extractionInstructions: config.extractionInstructions,
      verificationInstructions: config.verificationInstructions,
    });

  // Problems that pause the whole pipeline show up on batches that are waiting or failed.
  const blockingProblem = useMemo(() => {
    let connection = 0;
    let limit = 0;
    let budget = 0;
    // The first batch parked by a rejected key: the header's Retry releases that chat's parked work.
    let credentialsBatchId: string | null = null;
    for (const batch of batches) {
      if (!(batch.status === "failed" || activeStatuses.has(batch.status))) continue;
      const kind = problemKind(batch.errorCode, batch.error);
      if (kind === "connection") connection += 1;
      else if (kind === "credentials" && activeStatuses.has(batch.status)) credentialsBatchId ??= batch.id;
      else if (kind === "limit" && activeStatuses.has(batch.status)) limit += 1;
      else if (kind === "budget" && activeStatuses.has(batch.status)) budget += 1;
    }
    return { connection, limit, budget, credentialsBatchId };
  }, [batches]);

  const health: Health =
    config.mode === "off"
      ? "off"
      : status.isError
        ? "error"
        : status.isPending
          ? "loading"
          : blockingProblem.connection > 0 || status.data?.connectionAvailable === false
            ? "connection"
            : blockingProblem.credentialsBatchId
              ? "credentials"
              : blockingProblem.limit > 0 && counts.pending > 0
                ? "limit"
                : blockingProblem.budget > 0 && counts.pending > 0
                  ? "budget"
                  : counts.attention > 0
                    ? "attention"
                    : counts.pending > 0
                      ? "catchingUp"
                      : counts.stale > 0
                        ? "stale"
                        : gaps.some((gap) => gap.reason !== "CONTINUITY_BATCH_NOT_PUBLISHED")
                          ? "attention"
                          : counts.total === 0
                            ? "empty"
                            : "ok";

  const openBatches = (next: BatchFilter) => {
    setFilter(next);
    setVisibleCount(BATCH_PAGE);
    setBatchesOpen(true);
  };

  const headline: Record<Health, string> = {
    loading: t("ui.game.continuityPanel.health.loading", { defaultValue: "Checking memory..." }),
    off: t("ui.game.continuityPanel.health.off", { defaultValue: "Memory is off" }),
    error: t("ui.game.continuityPanel.health.error", { defaultValue: "Memory status is unavailable" }),
    connection: t("ui.game.continuityPanel.health.connection", { defaultValue: "Paused: no memory connection" }),
    credentials: t("ui.game.continuityPanel.health.credentials", { defaultValue: "Paused: API key rejected" }),
    budget: t("ui.game.continuityPanel.health.budget", { defaultValue: "Paused: hourly call cap reached" }),
    limit: t("ui.game.continuityPanel.health.limit", { defaultValue: "Paused: usage limit reached" }),
    attention: t("ui.game.continuityPanel.health.coverageAttention", {
      defaultValue: "Memory needs attention",
    }),
    catchingUp: t("ui.game.continuityPanel.health.pendingBatches", {
      defaultValue: "Catching up: {{count}} batches waiting",
      count: counts.pending,
    }),
    stale: t("ui.game.continuityPanel.health.staleBatches", {
      defaultValue: "{{count}} batches changed since they were checked",
      count: counts.stale,
    }),
    empty: t("ui.game.continuityPanel.health.empty", { defaultValue: "Nothing remembered yet" }),
    ok: t("ui.game.continuityPanel.health.batchesChecked", { defaultValue: "Recorded batches checked" }),
  };
  const explanation: Record<Health, string> = {
    loading: "",
    off: t("ui.game.continuityPanel.explain.off", {
      defaultValue: "Turn it on so the game keeps track of promises, decisions and who knows what.",
    }),
    error: t("ui.game.continuity.statusUnavailable"),
    connection: t("ui.game.continuityPanel.explain.connection", {
      defaultValue: "Pick an AI connection for memory in the settings below, then retry the stopped turns.",
    }),
    credentials: t("ui.game.continuityPanel.explain.credentials", {
      defaultValue:
        "The memory connection refused its API key. Fix the key in Connections, then press Retry. Nothing is lost: waiting turns are kept.",
    }),
    budget: t("ui.game.continuityPanel.explain.budget", {
      defaultValue:
        "Automatic AI calls reached the hourly cap. Nothing is lost: waiting turns resume on their own when a slot frees.",
    }),
    limit: t("ui.game.continuityPanel.explain.limit", {
      defaultValue: "Your AI connection hit its usage limit. Nothing is lost: waiting turns resume on their own.",
    }),
    attention: t("ui.game.continuityPanel.explain.coverageAttention", {
      defaultValue: "Some memory work or source coverage needs attention. Review the details below.",
    }),
    catchingUp:
      counts.working > 0
        ? t("ui.game.continuityPanel.explain.catchingUpWorking", {
            defaultValue: "Working on {{count}} now. This runs in the background while you play.",
            count: counts.working,
          })
        : t("ui.game.continuityPanel.explain.catchingUp", {
            defaultValue: "Turns are queued and will be read in the background while you play.",
          }),
    stale: t("ui.game.continuityPanel.explain.stale", {
      defaultValue: "You edited or swiped messages after they were read. Recheck to bring memory in line.",
    }),
    empty: t("ui.game.continuityPanel.explain.empty", {
      defaultValue: "Memory starts with your next turn.",
    }),
    ok: t("ui.game.continuityPanel.explain.batchesChecked", {
      defaultValue: "All recorded batches have finished checking. Full-turn coverage is shown below.",
    }),
  };

  const recheckButton = (
    <button type="button" onClick={() => reconcile.mutate()} disabled={reconcile.isPending} className={secondaryButton}>
      <RefreshCw size={13} className={reconcile.isPending ? "animate-spin" : ""} aria-hidden="true" />
      {reconcile.isPending ? t("ui.game.continuity.rechecking") : t("ui.game.continuity.recheck")}
    </button>
  );

  // Retry all copies the Recheck action above (recheckButton in this file): same secondaryButton classes,
  // 13px RefreshCw that spins while pending, and the shared showConfirmDialog for the cost confirmation.
  const showRetryAll =
    config.mode !== "off" &&
    !status.isError &&
    (counts.attention > 0 || counts.stale > 0 || Boolean(blockingProblem.credentialsBatchId));
  const retryAllButton = (
    <button
      type="button"
      onClick={() => {
        setRetryAllResult(null);
        retryAll.mutate();
      }}
      disabled={retryAll.isPending}
      className={secondaryButton}
    >
      <RefreshCw size={13} className={retryAll.isPending ? "animate-spin" : ""} aria-hidden="true" />
      {t("ui.game.continuityPanel.retryAll.button", { defaultValue: "Retry all" })}
    </button>
  );
  const retryAllFailed =
    retryAllResult && retryAllResult !== "nothing"
      ? retryAllResult.skipped.filter((item) => item.reason !== "superseded" && item.reason !== "split").length
      : 0;

  const action: ReactNode =
    health === "off" ? (
      <button
        type="button"
        className={primaryButton}
        onClick={() => {
          setDraft((value) => ({ ...value, mode: "active" }));
          setSettingsOpen(true);
        }}
      >
        {t("ui.game.continuityPanel.action.turnOn", { defaultValue: "Turn on memory" })}
      </button>
    ) : health === "error" ? (
      <button type="button" className={secondaryButton} onClick={() => void status.refetch()}>
        <RefreshCw size={13} aria-hidden="true" />
        {t("ui.game.continuity.retry")}
      </button>
    ) : health === "connection" ? (
      <button
        type="button"
        className={primaryButton}
        onClick={() => {
          setSettingsOpen(true);
          setSettingsNavigationRequest((request) => request + 1);
        }}
      >
        <Settings2 size={13} aria-hidden="true" />
        {t("ui.game.continuityPanel.action.chooseConnection", { defaultValue: "Choose a connection" })}
      </button>
    ) : health === "credentials" && blockingProblem.credentialsBatchId ? (
      <button
        type="button"
        className={primaryButton}
        onClick={() => retry.mutate(blockingProblem.credentialsBatchId!)}
        disabled={retry.isPending}
      >
        <RefreshCw size={13} className={retry.isPending ? "animate-spin" : ""} aria-hidden="true" />
        {t("ui.game.continuity.retry")}
      </button>
    ) : health === "attention" ? (
      <button
        type="button"
        className={primaryButton}
        onClick={() => {
          if (counts.attention > 0) openBatches("attention");
          else {
            coverageIssuesRef.current?.focus({ preventScroll: true });
            coverageIssuesRef.current?.scrollIntoView({ block: "nearest" });
          }
        }}
      >
        {t("ui.game.continuityPanel.action.showProblems", { defaultValue: "Show problems" })}
      </button>
    ) : health === "stale" ? (
      recheckButton
    ) : health === "catchingUp" || health === "limit" || health === "budget" ? (
      <button type="button" className={secondaryButton} onClick={() => openBatches("waiting")}>
        {t("ui.game.continuityPanel.action.showProgress", { defaultValue: "See progress" })}
      </button>
    ) : null;

  const HealthIcon = HEALTH_TONE[health].icon;
  const spinning = health === "loading" || (health === "catchingUp" && counts.working > 0);
  const progressTotal = counts.total;
  const pct = (value: number) => (progressTotal > 0 ? (value / progressTotal) * 100 : 0);

  const modeLabel: Record<ContinuityMode, string> = {
    off: t("ui.game.continuityPanel.mode.off", { defaultValue: "Off" }),
    shadow: t("ui.game.continuityPanel.mode.shadow", { defaultValue: "Check only" }),
    active: t("ui.game.continuityPanel.mode.active", { defaultValue: "On" }),
  };
  const modeHelp: Record<ContinuityMode, string> = {
    off: t("ui.game.continuityPanel.mode.offHelp", {
      defaultValue: "Nothing is read or remembered. Uses no AI quota.",
    }),
    shadow: t("ui.game.continuityPanel.mode.shadowHelp", {
      defaultValue:
        "Reads and double-checks each turn so you can see the results, but the story does not use them yet.",
    }),
    active: t("ui.game.continuityPanel.mode.activeHelp", {
      defaultValue: "Reads each turn, double-checks it, and feeds what it learned back into the story.",
    }),
  };

  // Batch list: filter, attention first, then newest.
  const filterCounts: Record<BatchFilter, number> = {
    attention: counts.attention,
    waiting: counts.pending,
    done: counts.reviewed,
    stale: counts.stale,
    all: batches.length,
  };
  const filteredBatches = useMemo(() => {
    const matches = batches.filter((batch) => {
      if (filter === "attention") return batch.status === "failed" || batch.status === "unresolved";
      if (filter === "waiting") return activeStatuses.has(batch.status);
      if (filter === "done") return doneStatuses.has(batch.status);
      if (filter === "stale") return batch.status === "stale";
      return true;
    });
    const rank = (batch: ContinuityBatchSummary) =>
      batch.status === "failed" || batch.status === "unresolved"
        ? 0
        : batch.status === "extracting" || batch.status === "reviewing" || batch.status === "repairing"
          ? 1
          : batch.status === "stale"
            ? 2
            : 3;
    return [...matches].sort((left, right) => {
      const byRank = rank(left) - rank(right);
      if (byRank) return byRank;
      return (right.updatedAt ?? right.createdAt ?? "").localeCompare(left.updatedAt ?? left.createdAt ?? "");
    });
  }, [batches, filter]);
  const effectiveFilter: BatchFilter = filterCounts[filter] > 0 || filter === "all" ? filter : "all";
  const shownBatches = (effectiveFilter === filter ? filteredBatches : batches).slice(0, visibleCount);
  const filterTabs: Array<{ id: BatchFilter; label: string }> = [
    { id: "attention", label: t("ui.game.continuityPanel.filter.attention", { defaultValue: "Needs attention" }) },
    { id: "waiting", label: t("ui.game.continuityPanel.filter.waiting", { defaultValue: "Waiting" }) },
    { id: "done", label: t("ui.game.continuityPanel.filter.done", { defaultValue: "Remembered" }) },
    { id: "stale", label: t("ui.game.continuityPanel.filter.stale", { defaultValue: "Out of date" }) },
    { id: "all", label: t("ui.game.continuityPanel.filter.all", { defaultValue: "All" }) },
  ];

  // Gaps: group by reason; "not published yet" is the normal waiting state and is already in the headline.
  const gapGroups = useMemo(() => {
    const groups = new Map<string, ContinuityGap[]>();
    for (const gap of gaps) {
      if (gap.reason === "CONTINUITY_BATCH_NOT_PUBLISHED") continue;
      groups.set(gap.reason, [...(groups.get(gap.reason) ?? []), gap]);
    }
    return [...groups.entries()];
  }, [gaps]);
  const gapText = (reason: string) => {
    if (reason === "CONTINUITY_TURN_NOT_ENQUEUED") return t("ui.game.continuity.turnNotEnqueued");
    if (reason === "CONTINUITY_SOURCE_CHANGED")
      return t("ui.game.continuityPanel.gap.sourceChanged", {
        defaultValue: "Messages were edited after they were read",
      });
    if (reason === "CONTINUITY_PUBLICATION_INVALID")
      return t("ui.game.continuityPanel.gap.invalid", {
        defaultValue: "A saved memory no longer matches its turn",
      });
    if (reason === "CONTINUITY_REVIEW_WITHHELD")
      return t("ui.game.continuityPanel.gap.withheldFacts", {
        defaultValue: "Some proposed facts were withheld during review. Accepted facts remain available.",
      });
    return t("ui.game.continuityPanel.gap.coverage", { defaultValue: "Memory coverage needs attention" });
  };

  return (
    <section
      className={className ?? "overflow-hidden rounded-xl border border-border bg-[var(--secondary)]/45"}
      aria-labelledby="game-continuity-title"
      data-component="GameContinuityPanel"
      data-health={health}
    >
      {/* Title */}
      <div className="flex flex-wrap items-center gap-2 px-3 pt-3">
        <ShieldCheck size={16} className="text-muted-foreground" aria-hidden="true" />
        <h3 id="game-continuity-title" className="text-sm font-bold text-foreground">
          {t("ui.game.continuityPanel.title", { defaultValue: "Story memory" })}
        </h3>
        <WikiChip tone={config.mode === "active" ? "success" : config.mode === "shadow" ? "info" : "neutral"}>
          {modeLabel[config.mode]}
        </WikiChip>
        <span className="basis-full text-xs text-muted-foreground">
          {t("ui.game.continuityPanel.description", {
            defaultValue: "Keeps track of what happened so the story stays consistent.",
          })}
        </span>
      </div>

      {/* Health headline */}
      <div
        className="flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center"
        data-component="GameContinuityPanel.Health"
        aria-live="polite"
      >
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span
            className={cn(
              "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full",
              HEALTH_TONE[health].className,
            )}
            aria-hidden="true"
          >
            <HealthIcon size={20} className={spinning ? "animate-spin" : ""} />
          </span>
          <div className="min-w-0">
            <p className="text-base font-bold leading-snug text-foreground">{headline[health]}</p>
            {explanation[health] && (
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{explanation[health]}</p>
            )}
            {config.mode === "shadow" && health !== "off" && (
              <p className="mt-0.5 text-xs leading-5 text-sky-200">
                {t("ui.game.continuityPanel.shadowNote", {
                  defaultValue: "Check only: results are shown here but not used in the story yet.",
                })}
              </p>
            )}
          </div>
        </div>
        {(action || showRetryAll) && (
          <div className="flex shrink-0 flex-wrap gap-2">
            {action}
            {showRetryAll && retryAllButton}
          </div>
        )}
      </div>

      {config.mode !== "off" && status.data && progressTotal > 0 && (
        <div className="px-3 pb-3">
          <div
            role="progressbar"
            aria-label={t("ui.game.continuityPanel.batchProgressLabel", { defaultValue: "Memory batch progress" })}
            aria-valuemin={0}
            aria-valuemax={progressTotal}
            aria-valuenow={counts.reviewed}
            className="flex h-2.5 w-full overflow-hidden rounded-full bg-secondary"
          >
            <span className="h-full bg-emerald-400/80" style={{ width: `${pct(counts.reviewed)}%` }} />
            <span className="h-full bg-sky-400/70" style={{ width: `${pct(counts.pending)}%` }} />
            <span className="h-full bg-amber-400/80" style={{ width: `${pct(counts.attention + counts.stale)}%` }} />
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {t("ui.game.continuityPanel.batchProgressText", {
              defaultValue: "{{done}} of {{total}} memory batches checked",
              done: counts.reviewed.toLocaleString(),
              total: progressTotal.toLocaleString(),
            })}
          </p>

          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {(
              [
                {
                  id: "done" as const,
                  value: counts.reviewed,
                  dot: "bg-emerald-400",
                  label: t("ui.game.continuityPanel.count.checkedBatches", { defaultValue: "Checked batches" }),
                },
                {
                  id: "waiting" as const,
                  value: counts.pending,
                  dot: "bg-sky-400",
                  label: t("ui.game.continuityPanel.count.waiting", { defaultValue: "Waiting" }),
                },
                {
                  id: "attention" as const,
                  value: counts.attention,
                  dot: "bg-amber-400",
                  label: t("ui.game.continuityPanel.count.attention", { defaultValue: "Needs attention" }),
                },
                {
                  id: "stale" as const,
                  value: counts.stale,
                  dot: "bg-amber-300/70",
                  label: t("ui.game.continuityPanel.count.stale", { defaultValue: "Out of date" }),
                },
              ] satisfies Array<{ id: BatchFilter; value: number; dot: string; label: string }>
            ).map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => openBatches(item.id)}
                disabled={item.value === 0}
                className="flex min-h-11 min-w-0 flex-col items-start rounded-lg border border-border bg-secondary/40 px-2.5 py-1.5 text-left transition-colors hover:border-primary/50 hover:bg-secondary/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-default disabled:hover:border-border disabled:hover:bg-secondary/40"
              >
                <span className="flex items-center gap-1.5 text-[0.6875rem] font-medium text-muted-foreground">
                  <span className={cn("h-2 w-2 shrink-0 rounded-full", item.dot)} aria-hidden="true" />
                  <span className="truncate">{item.label}</span>
                </span>
                <span className="text-lg font-bold tabular-nums leading-tight text-foreground">
                  {item.value.toLocaleString()}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {config.mode !== "off" && status.data && (
        <div
          data-component="GameContinuityPanel.Watermark"
          className="flex flex-wrap items-center gap-x-2 border-t border-border px-3 py-2 text-xs text-muted-foreground"
        >
          <CheckCircle2 size={13} className="shrink-0" aria-hidden="true" />
          <span>
            {verifiedThroughMessageId
              ? t("ui.game.continuityPanel.coverageWatermark", {
                  defaultValue: "Continuous checked coverage reaches the recorded turn.",
                })
              : t("ui.game.continuityPanel.coverageWatermarkNone")}
          </span>
          {verifiedThroughMessageId && (
            <TechnicalDetails
              label={t("ui.game.continuityPanel.technical", { defaultValue: "Technical details" })}
              lines={[
                [
                  t("ui.game.continuityPanel.tech.checkedThrough", { defaultValue: "Checked through message" }),
                  verifiedThroughMessageId,
                ],
              ]}
            />
          )}
        </div>
      )}

      {reconcile.isError && (
        <p role="alert" className="border-t border-border px-3 py-2 text-xs text-destructive">
          {t("ui.game.continuity.recheckFailed")}
        </p>
      )}
      {retry.isError && (
        <p role="alert" className="border-t border-border px-3 py-2 text-xs text-destructive">
          {t("ui.game.continuity.retryFailed")}
        </p>
      )}
      {retryAll.isError && (
        <p role="alert" className="border-t border-border px-3 py-2 text-xs text-destructive">
          {t("ui.game.continuityPanel.retryAll.failed", { defaultValue: "Could not retry the turns." })}
        </p>
      )}
      {retryAllResult && (
        <p role="status" className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
          {retryAllResult === "nothing"
            ? t("ui.game.continuityPanel.retryAll.nothing", { defaultValue: "Nothing to retry." })
            : t("ui.game.continuityPanel.retryAll.result", {
                defaultValue:
                  "Retry all: {{queued}} queued, {{published}} saved again, {{superseded}} skipped as already covered, {{failed}} could not retry.",
                queued: retryAllResult.retried.length,
                published: retryAllResult.published.length,
                superseded: retryAllResult.counts.superseded,
                failed: retryAllFailed,
              })}
        </p>
      )}

      {!!gapGroups.length && (
        <div
          ref={coverageIssuesRef}
          tabIndex={-1}
          className="border-t border-border px-3 py-2.5 text-xs"
          data-component="GameContinuityPanel.Gaps"
        >
          <p className="flex items-center gap-1.5 font-semibold text-foreground">
            <AlertTriangle size={13} className="text-amber-300" aria-hidden="true" />
            {t("ui.game.continuityPanel.coverageIssuesTitle", { defaultValue: "Memory coverage issues" })}
          </p>
          <ul className="mt-1 flex flex-col gap-1">
            {gapGroups.map(([reason, items]) => (
              <li key={reason} className="text-muted-foreground">
                {t("ui.game.continuityPanel.gapLine", {
                  defaultValue: "{{reason}} ({{count}})",
                  reason: gapText(reason),
                  count: items.length,
                })}
              </li>
            ))}
          </ul>
          <TechnicalDetails
            label={t("ui.game.continuityPanel.technical", { defaultValue: "Technical details" })}
            lines={gapGroups.flatMap(([reason, items]) =>
              items
                .slice(0, 20)
                .map((gap, index): [string, string] => [`${reason} ${index + 1}`, gap.messageId ?? gap.batchId]),
            )}
          />
        </div>
      )}

      {!!summaryRefreshes.length && (
        <div
          data-component="GameContinuityPanel.SummaryRefreshes"
          className="border-t border-border px-3 py-2.5 text-xs"
        >
          <p className="mb-1.5 font-semibold text-foreground">
            {t("ui.game.continuityPanel.summariesTitle", { defaultValue: "Session summaries" })}
          </p>
          <ul className="flex flex-col gap-1.5">
            {summaryRefreshes.map((item) => (
              <li key={item.sessionNumber} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-medium text-foreground">
                  {t("ui.game.continuity.summaryRefreshSession", { value1: item.sessionNumber })}
                </span>
                <SessionSummaryRefreshBadge state={item} />
                {item.reason && (
                  <span className="basis-full text-muted-foreground sm:basis-auto">
                    {t(`ui.game.continuity.summaryRefreshReason.${item.reason}`)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Batches */}
      {status.isError ? null : batches.length > 0 ? (
        <Disclosure
          open={batchesOpen}
          onToggle={() => setBatchesOpen((value) => !value)}
          dataComponent="GameContinuityPanel.Batches"
          title={t("ui.game.continuityPanel.batchesTitle", { defaultValue: "Turn by turn" })}
          hint={t("ui.game.continuityPanel.batchesHint", {
            defaultValue: "See what was remembered from each turn and what the checker flagged.",
          })}
          extra={
            counts.attention > 0 ? (
              <WikiChip tone="warning">{counts.attention.toLocaleString()}</WikiChip>
            ) : (
              <WikiChip>{batches.length.toLocaleString()}</WikiChip>
            )
          }
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div
              role="tablist"
              aria-label={t("ui.game.continuityPanel.filterLabel", { defaultValue: "Show turns" })}
              className="flex max-w-full gap-1 overflow-x-auto pb-1 [scrollbar-width:thin]"
            >
              {filterTabs
                .filter((tab) => tab.id === "all" || filterCounts[tab.id] > 0)
                .map((tab) => {
                  const active = tab.id === effectiveFilter;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => {
                        setFilter(tab.id);
                        setVisibleCount(BATCH_PAGE);
                      }}
                      className={cn(
                        "inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                        active
                          ? "border-primary/50 bg-primary/15 text-foreground"
                          : "border-transparent text-muted-foreground hover:bg-secondary/70 hover:text-foreground",
                      )}
                    >
                      {tab.label}
                      <span
                        className={cn(
                          "rounded-full px-1.5 text-[0.625rem] tabular-nums",
                          active ? "bg-primary/25" : "bg-secondary",
                        )}
                      >
                        {filterCounts[tab.id].toLocaleString()}
                      </span>
                    </button>
                  );
                })}
            </div>
            {config.mode !== "off" && recheckButton}
          </div>

          <ul className="mt-2 flex flex-col divide-y divide-border rounded-lg border border-border">
            {shownBatches.map((batch) => {
              const open = expandedBatchId === batch.id;
              const note = batchNote(t, batch);
              const when = relativeTime(batch.updatedAt ?? batch.createdAt, i18n.language);
              const working =
                batch.status === "extracting" || batch.status === "reviewing" || batch.status === "repairing";
              return (
                <li key={batch.id} data-component="GameContinuityPanel.Batch" data-status={batch.status}>
                  <div className="flex items-center gap-2 px-2.5 py-1.5">
                    <button
                      type="button"
                      onClick={() => setExpandedBatchId(open ? null : batch.id)}
                      className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-md text-left text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                      aria-expanded={open}
                    >
                      {open ? (
                        <ChevronDown size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
                      ) : (
                        <ChevronRight size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <WikiChip
                            tone={statusTone(batch.status)}
                            icon={
                              working ? <Loader2 size={11} className="animate-spin" aria-hidden="true" /> : undefined
                            }
                          >
                            {statusLabel(t, batch.status)}
                          </WikiChip>
                          {batch.sessionNumber != null && (
                            <span className="font-medium">
                              {t("ui.game.continuity.summaryRefreshSession", { value1: batch.sessionNumber })}
                            </span>
                          )}
                          {when && <span className="text-muted-foreground">{when}</span>}
                        </span>
                        {note && (
                          <span className="mt-0.5 block text-[0.6875rem] leading-4 text-muted-foreground">{note}</span>
                        )}
                      </span>
                    </button>
                    {(retryableStatuses.has(batch.status) ||
                      (activeStatuses.has(batch.status) &&
                        problemKind(batch.errorCode, batch.error) === "credentials")) && (
                      <button
                        type="button"
                        onClick={() => retry.mutate(batch.id)}
                        disabled={retry.isPending}
                        className={cn(secondaryButton, "shrink-0 px-2.5")}
                      >
                        <RefreshCw
                          size={12}
                          className={retry.isPending && retry.variables === batch.id ? "animate-spin" : ""}
                          aria-hidden="true"
                        />
                        {t("ui.game.continuity.retry")}
                      </button>
                    )}
                  </div>
                  {open && (
                    <div className="border-t border-border bg-background/40 px-3 py-3">
                      {receipt.isLoading ? (
                        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                          {t("ui.game.continuityPanel.detail.loading", { defaultValue: "Loading details..." })}
                        </p>
                      ) : receipt.isError ? (
                        <p className="text-xs text-destructive">{t("ui.game.continuity.receiptUnavailable")}</p>
                      ) : (
                        <ReceiptDetails receipt={receipt.data} />
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {(effectiveFilter === filter ? filteredBatches.length : batches.length) > shownBatches.length && (
            <button
              type="button"
              className={cn(secondaryButton, "mt-2 w-full")}
              onClick={() => setVisibleCount((value) => value + BATCH_PAGE)}
            >
              {t("ui.game.continuityPanel.showMore", {
                defaultValue: "Show more ({{count}} left)",
                count: (effectiveFilter === filter ? filteredBatches.length : batches.length) - shownBatches.length,
              })}
            </button>
          )}
        </Disclosure>
      ) : config.mode !== "off" && status.data ? (
        <p className="border-t border-border px-3 py-2.5 text-xs text-muted-foreground">
          {t("ui.game.continuityPanel.noBatches", { defaultValue: "No turns have been read yet." })}
        </p>
      ) : null}

      {/* Settings */}
      <Disclosure
        open={settingsOpen}
        onToggle={() => setSettingsOpen((value) => !value)}
        dataComponent="GameContinuityPanel.Settings"
        icon={<Settings2 size={15} className="shrink-0 text-muted-foreground" aria-hidden="true" />}
        title={t("ui.game.continuityPanel.settingsTitle", { defaultValue: "Memory settings" })}
        hint={t("ui.game.continuityPanel.settingsHint", {
          defaultValue: "Mode, AI connections and how the GM uses memory.",
        })}
        extra={
          dirty ? (
            <WikiChip tone="warning">{t("ui.game.continuityPanel.unsaved", { defaultValue: "Unsaved" })}</WikiChip>
          ) : undefined
        }
      >
        <div className="flex flex-col gap-3">
          <div role="radiogroup" aria-label={t("ui.game.continuity.mode")} className="grid gap-2 sm:grid-cols-3">
            {(["off", "shadow", "active"] as const).map((mode) => {
              const selected = draft.mode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={updateMetadata.isPending}
                  onClick={() => setDraft((value) => ({ ...value, mode }))}
                  className={cn(
                    "flex min-h-11 flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:opacity-50",
                    selected
                      ? "border-primary/60 bg-primary/15"
                      : "border-border bg-secondary/40 hover:border-primary/40 hover:bg-secondary/70",
                  )}
                >
                  <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                    <span
                      className={cn(
                        "inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border",
                        selected ? "border-primary" : "border-muted-foreground/60",
                      )}
                      aria-hidden="true"
                    >
                      {selected && <span className="h-1.5 w-1.5 rounded-full bg-primary" />}
                    </span>
                    {modeLabel[mode]}
                  </span>
                  <span className="text-[0.6875rem] leading-4 text-muted-foreground">{modeHelp[mode]}</span>
                </button>
              );
            })}
          </div>

          {draft.mode !== "off" && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                {(["extractorConnectionId", "verifierConnectionId"] as const).map((field) => (
                  <label key={field} className="flex flex-col gap-1 text-xs">
                    <span className="font-semibold text-foreground">
                      {field === "extractorConnectionId"
                        ? t("ui.game.continuityPanel.extractorLabel", { defaultValue: "Reader connection" })
                        : t("ui.game.continuityPanel.verifierLabel", { defaultValue: "Checker connection" })}
                    </span>
                    <select
                      ref={field === "extractorConnectionId" ? connectionSelectRef : undefined}
                      value={draft[field] ?? ""}
                      onChange={(event) =>
                        setDraft((value) => ({ ...value, [field]: event.target.value || undefined }))
                      }
                      disabled={updateMetadata.isPending || connections.isLoading}
                      aria-label={t(
                        `ui.game.continuity.${field === "extractorConnectionId" ? "extractor" : "verifier"}`,
                      )}
                      className={fieldClass}
                    >
                      <option value="">{t("ui.game.continuity.useDefaultConnection")}</option>
                      {connectionOptions.map((connection) => (
                        <option key={String(connection.id)} value={String(connection.id)}>
                          {connectionLabel(connection)}
                        </option>
                      ))}
                    </select>
                    <span className="leading-4 text-muted-foreground">
                      {field === "extractorConnectionId"
                        ? t("ui.game.continuityPanel.extractorHelp", {
                            defaultValue: "Reads each turn and writes down what happened.",
                          })
                        : t("ui.game.continuityPanel.verifierHelp", {
                            defaultValue: "Double-checks the notes against the story before they are kept.",
                          })}
                    </span>
                  </label>
                ))}
              </div>
              <p className="rounded-lg bg-secondary/50 px-3 py-2 text-[0.6875rem] leading-4 text-muted-foreground">
                {t("ui.game.continuityPanel.quotaNote", {
                  defaultValue:
                    "Each turn uses your AI connection twice (read and check), so memory counts against your quota.",
                })}
              </p>

              <div>
                <button
                  type="button"
                  aria-expanded={advancedOpen}
                  onClick={() => setAdvancedOpen((value) => !value)}
                  className="inline-flex min-h-9 items-center gap-1 rounded-md text-xs font-semibold text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                >
                  {advancedOpen ? (
                    <ChevronDown size={13} aria-hidden="true" />
                  ) : (
                    <ChevronRight size={13} aria-hidden="true" />
                  )}
                  {t("ui.game.continuityPanel.advanced", { defaultValue: "Custom instructions (optional)" })}
                </button>
                {advancedOpen && (
                  <div className="mt-1 grid gap-3 sm:grid-cols-2">
                    {(["extractionInstructions", "verificationInstructions"] as const).map((field) => (
                      <label key={field} className="flex flex-col gap-1 text-xs">
                        <span className="font-semibold text-foreground">
                          {field === "extractionInstructions"
                            ? t("ui.game.continuityPanel.extractionInstructionsLabel", {
                                defaultValue: "Extra instructions for the reader",
                              })
                            : t("ui.game.continuityPanel.verificationInstructionsLabel", {
                                defaultValue: "Extra instructions for the checker",
                              })}
                        </span>
                        <textarea
                          value={draft[field] ?? ""}
                          onChange={(event) =>
                            setDraft((value) => ({ ...value, [field]: event.target.value || undefined }))
                          }
                          rows={3}
                          aria-label={t(
                            `ui.game.continuity.${field === "extractionInstructions" ? "extractionInstructions" : "verificationInstructions"}`,
                          )}
                          placeholder={t("ui.game.continuityPanel.instructionsPlaceholder", {
                            defaultValue: "Leave empty to use the defaults.",
                          })}
                          className={cn(fieldClass, "resize-y")}
                        />
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void saveConfig()}
              disabled={updateMetadata.isPending || !dirty}
              className={primaryButton}
            >
              {updateMetadata.isPending && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
              {updateMetadata.isPending ? t("ui.game.continuity.saving") : t("ui.game.continuity.save")}
            </button>
            {dirty && !updateMetadata.isPending && (
              <button type="button" onClick={discardDraft} className={secondaryButton}>
                {t("ui.game.continuityPanel.discard", { defaultValue: "Discard changes" })}
              </button>
            )}
            {updateMetadata.isError && (
              <span role="alert" className="text-xs text-destructive">
                {t("ui.game.continuity.saveFailed")}
              </span>
            )}
          </div>

          <GameMemorySettings
            chatId={chatId}
            metadata={metadata}
            mode={config.mode}
            ownership={status.data?.config?.ownership ?? null}
            ownershipLoaded={Boolean(status.data)}
            onContinuityChanged={() => void queryClient.invalidateQueries({ queryKey: continuityKeys.status(chatId) })}
          />
        </div>
      </Disclosure>
    </section>
  );
}

function RecordItem({ record, tone }: { record: GameContinuityRecord; tone?: "withheld" }) {
  const { t } = useUiTranslation();
  return (
    <li className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-1.5">
        <WikiChip tone={factKindTone(record.kind)}>{t(`ui.game.continuity.recordKind.${record.kind}`)}</WikiChip>
        {record.status !== "asserted" && <WikiChip>{t(`ui.game.continuity.recordStatus.${record.status}`)}</WikiChip>}
        {tone === "withheld" && (
          <WikiChip tone="warning">
            {t("ui.game.continuityPanel.detail.heldBack", { defaultValue: "Held back" })}
          </WikiChip>
        )}
      </div>
      <p className="text-sm leading-6 text-foreground">{record.text}</p>
      {record.conditions.length > 0 && (
        <p className="text-muted-foreground">
          {t("ui.game.continuityPanel.detail.onlyIf", {
            defaultValue: "Only if: {{conditions}}",
            conditions: record.conditions.join("; "),
          })}
        </p>
      )}
      {record.knowledge && (
        <p className="text-muted-foreground">
          {record.knowledge.holders.length > 0
            ? t("ui.game.continuityPanel.detail.whoKnows", {
                defaultValue: "{{scope}}: known to {{holders}}",
                scope: t(`ui.game.continuity.knowledgeScope.${record.knowledge.scope}`),
                holders: record.knowledge.holders.join(", "),
              })
            : t(`ui.game.continuity.knowledgeScope.${record.knowledge.scope}`)}
        </p>
      )}
      {record.evidence.map((evidence) => (
        <blockquote
          key={`${record.id}-${evidence.messageId}-${evidence.quote}`}
          className="rounded-lg bg-secondary/60 px-2.5 py-1.5 italic leading-5 text-muted-foreground"
        >
          {t("ui.game.continuityPanel.detail.quote", { defaultValue: "“{{quote}}”", quote: evidence.quote })}
        </blockquote>
      ))}
    </li>
  );
}

function ReceiptDetails({ receipt }: { receipt?: GameContinuityReceipt }) {
  const { t } = useUiTranslation();
  const [sourcesOpen, setSourcesOpen] = useState(false);
  if (!receipt) return <p className="text-xs text-muted-foreground">{t("ui.game.continuity.receiptUnavailable")}</p>;
  const findings = receipt.review?.findings ?? [];
  const withheld = receipt.review?.withheld?.records ?? [];
  const problem = problemKind(receipt.errorCode, receipt.error);
  const technical = t("ui.game.continuityPanel.technical", { defaultValue: "Technical details" });
  return (
    <div className="flex flex-col gap-3 text-xs text-foreground">
      {(receipt.errorCode || receipt.error) && (
        <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2">
          <p className="flex items-start gap-1.5 font-medium text-destructive">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
            {problem ? problemText(t, problem) : t("ui.game.continuity.receiptFailed")}
          </p>
          <TechnicalDetails
            label={technical}
            lines={[
              [t("ui.game.continuityPanel.tech.code", { defaultValue: "Code" }), receipt.errorCode],
              [t("ui.game.continuityPanel.tech.message", { defaultValue: "Message" }), receipt.error],
            ]}
          />
        </div>
      )}

      {!!receipt.records.length && (
        <section>
          <p className="mb-1.5 font-semibold text-foreground">
            {t("ui.game.continuityPanel.detail.remembered", {
              defaultValue: "What it noted ({{count}})",
              count: receipt.records.length,
            })}
          </p>
          <ul className="flex flex-col divide-y divide-border">
            {receipt.records.map((record) => (
              <RecordItem key={record.id} record={record} />
            ))}
          </ul>
        </section>
      )}
      {!receipt.records.length && !activeStatuses.has(receipt.status) && !receipt.errorCode && (
        <p className="text-muted-foreground">
          {t("ui.game.continuityPanel.detail.nothingNoted", {
            defaultValue: "Nothing in this turn needed remembering.",
          })}
        </p>
      )}
      {activeStatuses.has(receipt.status) && !receipt.records.length && (
        <p className="flex items-center gap-1.5 text-muted-foreground">
          <Loader2 size={12} className="animate-spin" aria-hidden="true" />
          {t("ui.game.continuityPanel.detail.notReadYet", { defaultValue: "This turn has not been read yet." })}
        </p>
      )}

      {!!findings.length && (
        <section>
          <p className="mb-1.5 font-semibold text-foreground">
            {t("ui.game.continuityPanel.detail.flagged", { defaultValue: "What the checker flagged" })}
          </p>
          <ul className="flex flex-col divide-y divide-border">
            {findings.map((finding) => (
              <li
                key={`${finding.messageId}-${finding.quote}-${finding.kind}`}
                className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0"
              >
                <WikiChip tone={finding.kind === "omission" ? "info" : "warning"} className="self-start">
                  {findingLabel(t, finding.kind)}
                </WikiChip>
                <p className="leading-5 text-foreground">{finding.detail}</p>
                {finding.quote && (
                  <blockquote className="rounded-lg bg-secondary/60 px-2.5 py-1.5 italic leading-5 text-muted-foreground">
                    {t("ui.game.continuityPanel.detail.quote", { defaultValue: "“{{quote}}”", quote: finding.quote })}
                  </blockquote>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {!findings.length && receipt.status === "verified" && (
        <p className="flex items-center gap-1.5 text-emerald-200">
          <CheckCircle2 size={13} aria-hidden="true" />
          {t("ui.game.continuity.reviewedNoIssues")}
        </p>
      )}

      {!!withheld.length && (
        <section>
          <p className="mb-0.5 font-semibold text-foreground">
            {t("ui.game.continuityPanel.detail.withheldTitle", { defaultValue: "Held back from memory" })}
          </p>
          <p className="mb-1.5 text-muted-foreground">
            {t("ui.game.continuityPanel.detail.withheldHint", {
              defaultValue: "The checker still had doubts about these, so they were left out and the rest was kept.",
            })}
          </p>
          <ul className="flex flex-col divide-y divide-border">
            {withheld.map((record) => (
              <RecordItem key={record.id} record={record} tone="withheld" />
            ))}
          </ul>
        </section>
      )}

      {!!receipt.sources.length && (
        <section>
          <button
            type="button"
            aria-expanded={sourcesOpen}
            onClick={() => setSourcesOpen((value) => !value)}
            className="inline-flex min-h-9 items-center gap-1 rounded-md font-semibold text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            {sourcesOpen ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
            {t("ui.game.continuityPanel.detail.sources", {
              defaultValue: "Messages it read ({{count}})",
              count: receipt.sources.length,
            })}
          </button>
          {sourcesOpen && (
            <ul className="mt-1 flex flex-col gap-1.5">
              {receipt.sources.map((source) => (
                <li
                  key={`${source.messageId}-${source.swipeIndex}-${source.hash}`}
                  className="rounded-lg bg-secondary/50 px-2.5 py-2"
                >
                  <span className="mb-0.5 block text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
                    {roleLabel(t, source.role)}
                  </span>
                  <p className="whitespace-pre-line leading-5 text-foreground/90">{source.content.trim()}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <TechnicalDetails
        label={technical}
        lines={[
          [t("ui.game.continuityPanel.tech.batch", { defaultValue: "Batch" }), receipt.id],
          [t("ui.game.continuityPanel.tech.status", { defaultValue: "Status" }), receipt.status],
          [t("ui.game.continuityPanel.tech.attempts", { defaultValue: "Attempts" }), receipt.attempts],
          [t("ui.game.continuityPanel.tech.repairs", { defaultValue: "Fix attempts" }), receipt.repairAttempts],
          [t("ui.game.continuityPanel.tech.model", { defaultValue: "Model" }), receipt.config.extractor?.model ?? null],
          [
            t("ui.game.continuityPanel.tech.messages", { defaultValue: "Message ids" }),
            receipt.sources.map((source) => source.messageId).join(", "),
          ],
        ]}
      />
    </div>
  );
}
