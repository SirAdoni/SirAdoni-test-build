import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CircleSlash,
  Clock3,
  Loader2,
  MinusCircle,
  PauseCircle,
  Square,
} from "lucide-react";
import { useTranslation as useUiTranslation } from "react-i18next";
import { api } from "../../lib/api-client";
import { useUpdateChatMetadata } from "../../hooks/use-chats";
import { Modal } from "../ui/Modal";
import { cn } from "../../lib/utils";
import { WikiChip, WikiSkeleton, WikiStat, type WikiTone } from "./campaign-wiki-ui";

/**
 * Guided first-run indexing: shows what the campaign-index plan still needs per
 * session, lets the user pick the three steps and start a server-side job that walks
 * the sessions in order. Progress is polled from the job; the runtime does the work.
 * Nothing runs without a click; dismissal is stored in chat metadata by the auto
 * prompt so a game is offered indexing once.
 */

interface CampaignIndexManifest {
  id: string;
  live: boolean;
  receipts: number;
  countsByStatus: Record<string, number>;
  published: number;
  publishable: boolean;
  pending: boolean;
}

interface CampaignIndexChat {
  chatId: string;
  name: string;
  sessionNumber: number | null;
  preparedMessages: number;
  ownersRegistered: boolean | null;
  ownersPlanned: number | null;
  receiptCounts: Record<string, number>;
  published: number;
  manifests: CampaignIndexManifest[];
  uncoveredMessages: number;
  estimate: { turns: number; receipts: number };
  continuityConfigured: boolean;
  totals: { entities: number; facts: number } | null;
}

interface CampaignIndexSessionProgress {
  status: "pending" | "enqueued" | "terminal" | "published" | "skipped" | "failed";
  reason?: string;
  backfillIds: string[];
  acceptedTurns: number;
  published?: number;
  failed?: Array<{ error: string }>;
}

interface CampaignIndexJob {
  jobId: string;
  gameId: string;
  order: string[];
  currentIndex: number;
  status: "running" | "paused" | "done" | "cancelled";
  steps?: CampaignIndexSteps;
  sessions: Record<string, CampaignIndexSessionProgress | undefined>;
}

interface CampaignIndexGame {
  gameId: string;
  promptDismissedAt: string | null;
  continuityConfigured: boolean;
  needsIndexing: boolean;
  pending: boolean;
  job: CampaignIndexJob | null;
  chats: CampaignIndexChat[];
}

interface CampaignIndexSteps {
  registerOwners: boolean;
  backfill: boolean;
  publishVerified: boolean;
}

interface CampaignIndexOwnerResult {
  chatId: string;
  status: "registered" | "skipped" | "failed";
  created?: number;
  error?: string;
}

const campaignIndexKeys = {
  plan: (chatId: string) => ["campaign-index", "plan", chatId] as const,
  status: (chatId: string) => ["campaign-index", "status", chatId] as const,
};
const RECEIPT_STATUSES = [
  "queued",
  "extracting",
  "reviewing",
  "repairing",
  "verified",
  "published",
  "unresolved",
  "failed",
  "stale",
] as const;
const STATUS_POLL_MS = 3000;

function useCampaignIndexPlan(chatId: string, enabled = true) {
  return useQuery({
    queryKey: campaignIndexKeys.plan(chatId),
    queryFn: () =>
      api.get<{ games: CampaignIndexGame[] }>(`/game/campaign-index/plan?chatId=${encodeURIComponent(chatId)}`),
    enabled: enabled && !!chatId,
    staleTime: 5 * 60_000,
  });
}

function sessionLabel(t: (key: string, options?: Record<string, unknown>) => string, chat: CampaignIndexChat) {
  return chat.sessionNumber === null
    ? t("ui.game.campaignIndex.sessionUnknown")
    : t("ui.game.campaignIndex.sessionLabel", { number: chat.sessionNumber });
}

function receiptSummary(t: (key: string) => string, counts: Record<string, number>) {
  const parts = RECEIPT_STATUSES.filter((status) => (counts[status] ?? 0) > 0).map(
    (status) => `${counts[status]} ${t(`ui.game.campaignIndex.receiptStatus.${status}`)}`,
  );
  return parts.length ? parts.join(", ") : t("ui.game.campaignIndex.noReceipts");
}

const buttonBase =
  "inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg px-3.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-40";
const buttonClass = cn(buttonBase, "border border-border bg-secondary/50 text-foreground hover:bg-secondary");
const primaryButtonClass = cn(buttonBase, "bg-primary text-primary-foreground shadow-sm hover:opacity-90");
const dangerButtonClass = cn(buttonBase, "border border-destructive/50 text-destructive hover:bg-destructive/10");

type StepState = "todo" | "done" | "optional";

function SessionStateChip({ status, current }: { status: CampaignIndexSessionProgress["status"]; current: boolean }) {
  const { t } = useUiTranslation();
  const tone: WikiTone =
    status === "published" || status === "terminal"
      ? "success"
      : status === "failed"
        ? "danger"
        : status === "enqueued"
          ? "info"
          : "neutral";
  const Icon =
    status === "published" || status === "terminal"
      ? CheckCircle2
      : status === "failed"
        ? AlertTriangle
        : status === "enqueued"
          ? Loader2
          : status === "skipped"
            ? MinusCircle
            : Clock3;
  return (
    <WikiChip
      tone={tone}
      icon={<Icon size={11} className={status === "enqueued" && current ? "animate-spin" : ""} aria-hidden="true" />}
    >
      {t(`ui.game.campaignIndex.state.${status}`)}
    </WikiChip>
  );
}

function ProgressBar({ value, total, label }: { value: number; total: number; label: string }) {
  const pct = total > 0 ? Math.min(100, (value / total) * 100) : 0;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={value}
      className="h-2 w-full overflow-hidden rounded-full bg-secondary"
    >
      <span className="block h-full rounded-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
    </div>
  );
}

interface CampaignIndexDialogProps {
  chatId: string;
  onClose: () => void;
}

export function CampaignIndexDialog({ chatId, onClose }: CampaignIndexDialogProps) {
  const { t } = useUiTranslation();
  const qc = useQueryClient();
  const plan = useCampaignIndexPlan(chatId);
  const planGame = plan.data?.games[0] ?? null;
  const [steps, setSteps] = useState<CampaignIndexSteps | null>(null);
  const [owners, setOwners] = useState<CampaignIndexOwnerResult[]>([]);
  const [confirmCancel, setConfirmCancel] = useState(false);
  useEffect(() => {
    if (!planGame || steps) return;
    setSteps({
      registerOwners: planGame.chats.some((chat) => chat.ownersRegistered === false),
      backfill: planGame.continuityConfigured && planGame.chats.some((chat) => chat.uncoveredMessages > 0),
      publishVerified: false,
    });
  }, [planGame, steps]);
  const tracking = !!planGame?.job;
  const status = useQuery({
    queryKey: campaignIndexKeys.status(chatId),
    queryFn: () =>
      api.get<{ games: CampaignIndexGame[] }>(`/game/campaign-index/status?chatId=${encodeURIComponent(chatId)}`),
    enabled: tracking,
    refetchInterval: (query) => (query.state.data?.games[0]?.pending === false ? false : STATUS_POLL_MS),
  });
  const game = status.data?.games[0] ?? planGame;
  const job = game?.job ?? null;
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: campaignIndexKeys.plan(chatId) });
    qc.invalidateQueries({ queryKey: campaignIndexKeys.status(chatId) });
    qc.invalidateQueries({ queryKey: ["campaign-memory"] });
  };
  const run = useMutation({
    mutationFn: (body: CampaignIndexSteps) =>
      api.post<{ jobs: Array<{ owners: CampaignIndexOwnerResult[]; job: CampaignIndexJob }> }>(
        "/game/campaign-index/run",
        { chatId, steps: body },
      ),
    onSuccess: (data) => {
      setOwners(data.jobs[0]?.owners ?? []);
      invalidate();
    },
  });
  const cancel = useMutation({
    mutationFn: (gameId: string) =>
      api.post<{ retired: number; removedManifests: string[] }>("/game/campaign-index/cancel", { gameId }),
    onSuccess: () => {
      setConfirmCancel(false);
      invalidate();
    },
  });

  const running = job?.status === "running";
  const currentChatId = job && running ? job.order[job.currentIndex] : null;
  const currentChat = game?.chats.find((chat) => chat.chatId === currentChatId) ?? null;
  const toggle = (key: keyof CampaignIndexSteps) =>
    setSteps((current) => (current ? { ...current, [key]: !current[key] } : current));
  const canStart = !!steps && (steps.registerOwners || steps.backfill || steps.publishVerified) && !run.isPending;

  // Plan totals for the overview and the cost warning.
  const chats = game?.chats ?? [];
  const totalMessages = chats.reduce((sum, chat) => sum + chat.preparedMessages, 0);
  const unreadMessages = chats.reduce((sum, chat) => sum + chat.uncoveredMessages, 0);
  const sessionsToRead = chats.filter((chat) => chat.uncoveredMessages > 0);
  const turnsToRead = sessionsToRead.reduce((sum, chat) => sum + chat.estimate.turns, 0);
  const batchesToRead = sessionsToRead.reduce((sum, chat) => sum + chat.estimate.receipts, 0);
  const ownersToRegister = chats.filter((chat) => chat.ownersRegistered === false).length;
  const stepStates: Record<keyof CampaignIndexSteps, StepState> = {
    registerOwners: ownersToRegister > 0 ? "todo" : "done",
    backfill: unreadMessages > 0 ? "todo" : "done",
    publishVerified: "optional",
  };

  // Job progress.
  const jobOrder = job?.order ?? [];
  const finishedSessions = jobOrder.filter((id) => {
    const state = job?.sessions[id]?.status;
    return state === "published" || state === "terminal" || state === "skipped" || state === "failed";
  }).length;
  const failedSessions = jobOrder.filter((id) => job?.sessions[id]?.status === "failed").length;
  const jobHeadline = !job
    ? ""
    : job.status === "running"
      ? t("ui.game.campaignIndex.jobHeadline.running", { defaultValue: "Indexing in progress" })
      : job.status === "paused"
        ? t("ui.game.campaignIndex.jobHeadline.paused", { defaultValue: "Indexing paused" })
        : job.status === "done"
          ? t("ui.game.campaignIndex.jobHeadline.done", { defaultValue: "Indexing finished" })
          : t("ui.game.campaignIndex.jobHeadline.cancelled", { defaultValue: "Indexing stopped" });
  const JobIcon = !job
    ? Loader2
    : job.status === "running"
      ? Loader2
      : job.status === "paused"
        ? PauseCircle
        : job.status === "done"
          ? CheckCircle2
          : CircleSlash;
  const jobIconClass = !job
    ? ""
    : job.status === "running"
      ? "bg-sky-400/15 text-sky-200"
      : job.status === "paused"
        ? "bg-amber-400/15 text-amber-200"
        : job.status === "done"
          ? "bg-emerald-400/15 text-emerald-200"
          : "bg-secondary text-muted-foreground";

  const stepDefs: Array<{
    key: keyof CampaignIndexSteps;
    number: number;
    title: string;
    help: string;
    status: string;
  }> = [
    {
      key: "registerOwners",
      number: 1,
      title: t("ui.game.campaignIndex.step.registerOwners"),
      help: t("ui.game.campaignIndex.stepHelp.registerOwners", {
        defaultValue:
          "Adds the characters, places and items your game already knows to the wiki, so new facts have a page to go on. Usually quick.",
      }),
      status:
        ownersToRegister > 0
          ? t("ui.game.campaignIndex.stepStatus.ownersTodo", {
              defaultValue: "{{count}} sessions have people or places to add",
              count: ownersToRegister,
            })
          : t("ui.game.campaignIndex.stepStatus.ownersDone", { defaultValue: "Nothing new to add" }),
    },
    {
      key: "backfill",
      number: 2,
      title: t("ui.game.campaignIndex.step.backfill"),
      help: t("ui.game.campaignIndex.stepHelp.backfill", {
        defaultValue:
          "Your AI connection reads every past turn and notes what happened. This is the slow step and it uses your AI quota.",
      }),
      status:
        unreadMessages > 0
          ? t("ui.game.campaignIndex.stepStatus.backfillTodo", {
              defaultValue: "{{messages}} messages in {{sessions}} sessions not read yet",
              messages: unreadMessages.toLocaleString(),
              sessions: sessionsToRead.length,
            })
          : t("ui.game.campaignIndex.stepStatus.backfillDone", { defaultValue: "Every message has been read" }),
    },
    {
      key: "publishVerified",
      number: 3,
      title: t("ui.game.campaignIndex.step.publishVerified"),
      help: t("ui.game.campaignIndex.stepHelp.publishVerified", {
        defaultValue:
          "Adds a session's facts to the wiki as soon as all of its turns are checked. Leave it off if you want to look them over first.",
      }),
      status: t("ui.game.campaignIndex.stepStatus.optional", { defaultValue: "Optional" }),
    },
  ];

  return (
    <Modal open onClose={onClose} title={t("ui.game.campaignIndex.title")} width="max-w-3xl" mobileFullscreen>
      <div className="flex flex-col gap-4 text-sm" data-campaign-index-dialog>
        {plan.isPending && (
          <div className="flex flex-col gap-3">
            <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 size={13} className="animate-spin" aria-hidden="true" />
              {t("ui.game.campaignIndex.loading")}
            </p>
            <WikiSkeleton rows={3} />
          </div>
        )}
        {plan.isError && (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-xs text-destructive"
          >
            <span className="flex items-center gap-1.5">
              <AlertTriangle size={14} aria-hidden="true" />
              {t("ui.game.campaignIndex.loadError")}
            </span>
            <button type="button" className={buttonClass} onClick={() => void plan.refetch()}>
              {t("ui.game.campaignIndex.retry")}
            </button>
          </div>
        )}

        {game && !job && steps && (
          <>
            <p className="text-sm leading-6 text-muted-foreground">{t("ui.game.campaignIndex.intro")}</p>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <WikiStat
                label={t("ui.game.campaignIndex.stat.sessions", { defaultValue: "Sessions" })}
                value={chats.length.toLocaleString()}
              />
              <WikiStat label={t("ui.game.campaignIndex.column.messages")} value={totalMessages.toLocaleString()} />
              <WikiStat
                label={t("ui.game.campaignIndex.stat.unread", { defaultValue: "Not read yet" })}
                value={unreadMessages.toLocaleString()}
              />
              <WikiStat label={t("ui.game.campaignIndex.column.turns")} value={turnsToRead.toLocaleString()} />
            </div>

            {!game.needsIndexing && (
              <p
                role="status"
                className="flex items-center gap-2 rounded-xl border border-emerald-400/35 bg-emerald-400/10 px-3 py-2.5 text-xs text-emerald-200"
              >
                <CheckCircle2 size={15} className="shrink-0" aria-hidden="true" />
                {t("ui.game.campaignIndex.upToDate")}
              </p>
            )}

            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-sm font-bold text-foreground">
                {t("ui.game.campaignIndex.stepsLegend")}
              </legend>
              <ol className="flex flex-col gap-2">
                {stepDefs.map((step) => {
                  const checked = steps[step.key];
                  const state = stepStates[step.key];
                  const disabled = step.key === "backfill" && !game.continuityConfigured;
                  return (
                    <li key={step.key}>
                      <label
                        className={cn(
                          "flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-3 transition-colors",
                          checked
                            ? "border-primary/50 bg-primary/10"
                            : "border-border bg-secondary/30 hover:bg-secondary/50",
                          disabled && "cursor-not-allowed opacity-70",
                        )}
                      >
                        <span
                          className={cn(
                            "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold",
                            checked ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground",
                          )}
                          aria-hidden="true"
                        >
                          {step.number}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-semibold text-foreground">{step.title}</span>
                          <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{step.help}</span>
                          <span className="mt-1.5 flex flex-wrap gap-1.5">
                            <WikiChip tone={state === "done" ? "success" : state === "todo" ? "accent" : "neutral"}>
                              {step.status}
                            </WikiChip>
                          </span>
                          {step.key === "backfill" && !game.continuityConfigured && (
                            <span className="mt-2 flex items-start gap-1.5 text-xs leading-5 text-destructive">
                              <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                              {t("ui.game.campaignIndex.notConfigured")}
                            </span>
                          )}
                        </span>
                        {step.key === "backfill" ? (
                          <input
                            type="checkbox"
                            className="mt-1 h-5 w-5 shrink-0 accent-[var(--primary)]"
                            checked={steps.backfill}
                            disabled={!game.continuityConfigured}
                            onChange={() => toggle("backfill")}
                          />
                        ) : (
                          <input
                            type="checkbox"
                            className="mt-1 h-5 w-5 shrink-0 accent-[var(--primary)]"
                            checked={checked}
                            onChange={() => toggle(step.key)}
                          />
                        )}
                      </label>
                    </li>
                  );
                })}
              </ol>
            </fieldset>

            <section aria-labelledby="campaign-index-sessions">
              <h4 id="campaign-index-sessions" className="mb-2 text-sm font-bold text-foreground">
                {t("ui.game.campaignIndex.sessionsTitle", { defaultValue: "Your sessions" })}
              </h4>
              <ul
                aria-label={t("ui.game.campaignIndex.column.session")}
                className="flex flex-col divide-y divide-border rounded-xl border border-border"
              >
                {chats.map((chat) => {
                  const covered = chat.preparedMessages - chat.uncoveredMessages;
                  return (
                    <li key={chat.chatId} className="flex flex-col gap-1.5 px-3 py-2.5 text-xs">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                        <span className="min-w-0">
                          <span className="font-semibold text-foreground">{sessionLabel(t, chat)}</span>
                          <span className="ml-2 break-words text-muted-foreground">{chat.name}</span>
                        </span>
                        <span className="text-muted-foreground">
                          {t("ui.game.campaignIndex.coverage", { covered, total: chat.preparedMessages })}
                        </span>
                      </div>
                      <ProgressBar
                        value={covered}
                        total={chat.preparedMessages}
                        label={t("ui.game.campaignIndex.column.coverage")}
                      />
                      <div className="flex flex-wrap gap-1.5">
                        <WikiChip>
                          {t("ui.game.campaignIndex.chipValue", {
                            defaultValue: "{{label}}: {{value}}",
                            label: t("ui.game.campaignIndex.column.messages"),
                            value: chat.preparedMessages.toLocaleString(),
                          })}
                        </WikiChip>
                        <WikiChip tone={chat.ownersRegistered === false ? "accent" : "neutral"}>
                          {t("ui.game.campaignIndex.chipValue", {
                            defaultValue: "{{label}}: {{value}}",
                            label: t("ui.game.campaignIndex.column.owners"),
                            value:
                              chat.ownersRegistered === null
                                ? t("ui.game.campaignIndex.ownersUnknown")
                                : chat.ownersRegistered
                                  ? t("ui.game.campaignIndex.ownersRegistered")
                                  : t("ui.game.campaignIndex.ownersPending", { count: chat.ownersPlanned ?? 0 }),
                          })}
                        </WikiChip>
                        {chat.uncoveredMessages > 0 && (
                          <WikiChip tone="accent">
                            {t("ui.game.campaignIndex.chipValue", {
                              defaultValue: "{{label}}: {{value}}",
                              label: t("ui.game.campaignIndex.column.turns"),
                              value: chat.estimate.turns.toLocaleString(),
                            })}
                          </WikiChip>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-2 text-xs text-muted-foreground">{t("ui.game.campaignIndex.orderNote")}</p>
            </section>

            <div
              className="flex items-start gap-3 rounded-xl border border-amber-400/35 bg-amber-400/10 px-3 py-3 text-xs text-foreground"
              data-campaign-index-cost
            >
              <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-300" aria-hidden="true" />
              <div className="flex min-w-0 flex-col gap-1">
                <p className="text-sm font-semibold text-amber-100">
                  {t("ui.game.campaignIndex.costTitle", { defaultValue: "This uses your AI quota" })}
                </p>
                {steps.backfill && turnsToRead > 0 && (
                  <p className="leading-5">
                    {t("ui.game.campaignIndex.costEstimate", {
                      defaultValue:
                        "About {{turns}} past turns in {{batches}} memory batches will be read and double-checked. That is at least {{requests}} AI requests, and a long campaign can take several hours.",
                      turns: turnsToRead.toLocaleString(),
                      batches: batchesToRead.toLocaleString(),
                      requests: (batchesToRead * 2).toLocaleString(),
                    })}
                  </p>
                )}
                <p className="leading-5 text-muted-foreground">{t("ui.game.campaignIndex.costNote")}</p>
              </div>
            </div>

            {run.isError && (
              <p role="alert" className="text-xs text-destructive">
                {t("ui.game.campaignIndex.startError")}
              </p>
            )}
            <div className="sticky bottom-0 -mx-1 flex flex-wrap justify-end gap-2 bg-[color-mix(in_srgb,var(--background)_92%,transparent)] px-1 py-2">
              <button type="button" className={buttonClass} onClick={onClose}>
                {t("ui.game.campaignIndex.notNow")}
              </button>
              <button
                type="button"
                className={primaryButtonClass}
                disabled={!canStart}
                onClick={() => steps && run.mutate(steps)}
              >
                {run.isPending && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
                {run.isPending ? t("ui.game.campaignIndex.starting") : t("ui.game.campaignIndex.start")}
              </button>
            </div>
          </>
        )}

        {game && job && (
          <>
            <div className="flex items-start gap-3" aria-live="polite">
              <span
                className={cn("inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full", jobIconClass)}
                aria-hidden="true"
              >
                <JobIcon size={20} className={running ? "animate-spin" : ""} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-base font-bold text-foreground">{jobHeadline}</p>
                {running && currentChat && (
                  <p role="status" className="mt-0.5 flex items-center gap-1.5 text-xs text-sky-200">
                    {t("ui.game.campaignIndex.currentSession", { session: sessionLabel(t, currentChat) })}
                  </p>
                )}
                {job.status === "paused" && (
                  <p className="mt-0.5 text-xs leading-5 text-amber-200">{t("ui.game.campaignIndex.jobPaused")}</p>
                )}
                {job.status === "done" && (
                  <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{t("ui.game.campaignIndex.jobDone")}</p>
                )}
                {job.status === "cancelled" && (
                  <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                    {t("ui.game.campaignIndex.jobCancelled")}
                  </p>
                )}
              </div>
            </div>

            {jobOrder.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <ProgressBar
                  value={finishedSessions}
                  total={jobOrder.length}
                  label={t("ui.game.campaignIndex.progressLabel", { defaultValue: "Sessions indexed" })}
                />
                <p className="text-xs text-muted-foreground">
                  {t("ui.game.campaignIndex.progressText", {
                    defaultValue: "{{done}} of {{total}} sessions done",
                    done: finishedSessions,
                    total: jobOrder.length,
                  })}
                  {failedSessions > 0 &&
                    ` ${t("ui.game.campaignIndex.progressFailed", {
                      defaultValue: "({{count}} with problems)",
                      count: failedSessions,
                    })}`}
                </p>
              </div>
            )}

            {job.steps && (
              <ol
                className="grid grid-cols-1 gap-1.5 sm:grid-cols-3"
                aria-label={t("ui.game.campaignIndex.stepsLegend")}
              >
                {stepDefs.map((step) => {
                  const included = job.steps?.[step.key] ?? false;
                  return (
                    <li
                      key={step.key}
                      className={cn(
                        "flex items-center gap-2 rounded-lg border px-2.5 py-2 text-xs",
                        included
                          ? "border-primary/40 bg-primary/10 text-foreground"
                          : "border-border text-muted-foreground",
                      )}
                    >
                      <span
                        className={cn(
                          "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[0.6875rem] font-bold",
                          included ? "bg-primary text-primary-foreground" : "bg-secondary",
                        )}
                        aria-hidden="true"
                      >
                        {step.number}
                      </span>
                      <span className="min-w-0 flex-1 leading-4">{step.title}</span>
                      <span className="shrink-0 text-[0.6875rem]">
                        {included
                          ? t("ui.game.campaignIndex.stepIncluded", { defaultValue: "Included" })
                          : t("ui.game.campaignIndex.stepSkipped", { defaultValue: "Skipped" })}
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}

            <p className="text-xs leading-5 text-muted-foreground">{t("ui.game.campaignIndex.progressNote")}</p>

            <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
              {game.chats.map((chat) => {
                const session = job.sessions[chat.chatId];
                const owner = owners.find((item) => item.chatId === chat.chatId);
                const isCurrent = chat.chatId === currentChatId;
                const failed = owner?.status === "failed" || session?.status === "failed";
                const failureCode = owner?.error ?? session?.failed?.[0]?.error ?? session?.reason ?? "";
                return (
                  <li
                    key={chat.chatId}
                    data-campaign-index-session={session?.status ?? "pending"}
                    aria-current={isCurrent ? "step" : undefined}
                    className={cn("flex flex-col gap-1 px-3 py-2.5 text-xs", isCurrent && "bg-primary/10")}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                      <span className="min-w-0">
                        <span className="sr-only">
                          {t("ui.game.campaignIndex.sessionState", {
                            session: sessionLabel(t, chat),
                            state: t(`ui.game.campaignIndex.state.${session?.status ?? "pending"}`),
                          })}
                        </span>
                        <span aria-hidden="true" className="font-semibold text-foreground">
                          {sessionLabel(t, chat)}
                        </span>
                        <span aria-hidden="true" className="ml-2 text-muted-foreground">
                          {chat.name}
                        </span>
                      </span>
                      <SessionStateChip status={session?.status ?? "pending"} current={isCurrent} />
                    </div>
                    <span className="text-muted-foreground">{receiptSummary(t, chat.receiptCounts)}</span>
                    <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-foreground/90">
                      {chat.totals && <span>{t("ui.game.campaignIndex.totals", chat.totals)}</span>}
                      {owner?.status === "registered" && (
                        <span>{t("ui.game.campaignIndex.result.ownersRegistered", { count: owner.created ?? 0 })}</span>
                      )}
                      {session && session.acceptedTurns > 0 && (
                        <span>
                          {t("ui.game.campaignIndex.result.turnsQueued", {
                            count: session.acceptedTurns,
                            ranges: session.backfillIds.length,
                          })}
                        </span>
                      )}
                      {(session?.published ?? 0) > 0 && (
                        <span>{t("ui.game.campaignIndex.published", { count: session?.published ?? 0 })}</span>
                      )}
                    </span>
                    {failed && (
                      <span className="flex items-start gap-1.5 text-destructive">
                        <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
                        {t("ui.game.campaignIndex.sessionFailed", {
                          defaultValue: "Something went wrong in this session. Resume to try it again.",
                        })}
                      </span>
                    )}
                    {(chat.manifests.length > 1 || (failed && failureCode)) && (
                      <details className="group text-[0.6875rem] text-muted-foreground">
                        <summary className="inline-flex min-h-8 cursor-pointer select-none items-center gap-1 rounded-md hover:text-foreground">
                          <ChevronRight
                            size={12}
                            className="transition-transform group-open:rotate-90"
                            aria-hidden="true"
                          />
                          {t("ui.game.campaignIndex.technical", { defaultValue: "Technical details" })}
                        </summary>
                        <div className="mt-1 flex flex-col gap-0.5 rounded-lg bg-secondary/50 px-2.5 py-2">
                          {chat.manifests.length > 1 &&
                            chat.manifests.map((manifest, index) => (
                              <span key={manifest.id}>
                                {t("ui.game.campaignIndex.manifestLine", {
                                  index: index + 1,
                                  total: chat.manifests.length,
                                  summary: receiptSummary(t, manifest.countsByStatus),
                                })}
                              </span>
                            ))}
                          {failed && failureCode && (
                            <span className="break-all font-mono">
                              {t("ui.game.campaignIndex.result.failed", { code: failureCode })}
                            </span>
                          )}
                        </div>
                      </details>
                    )}
                  </li>
                );
              })}
            </ul>

            {cancel.isError && (
              <p role="alert" className="text-xs text-destructive">
                {t("ui.game.campaignIndex.cancelError")}
              </p>
            )}
            {confirmCancel && (job.status === "running" || job.status === "paused") && (
              <div
                role="alertdialog"
                aria-label={t("ui.game.campaignIndex.cancelConfirmTitle", { defaultValue: "Stop indexing?" })}
                className="flex flex-col gap-2 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-3 text-xs"
              >
                <p className="text-sm font-semibold text-foreground">
                  {t("ui.game.campaignIndex.cancelConfirmTitle", { defaultValue: "Stop indexing?" })}
                </p>
                <p className="leading-5 text-muted-foreground">
                  {t("ui.game.campaignIndex.cancelConfirmBody", {
                    defaultValue:
                      "Turns that were already read stay in memory. Turns still waiting are dropped, and you can start again later.",
                  })}
                </p>
                <div className="flex flex-wrap justify-end gap-2">
                  <button type="button" className={buttonClass} onClick={() => setConfirmCancel(false)}>
                    {t("ui.game.campaignIndex.keepGoing", { defaultValue: "Keep going" })}
                  </button>
                  <button
                    type="button"
                    className={dangerButtonClass}
                    disabled={cancel.isPending}
                    onClick={() => cancel.mutate(job.gameId)}
                  >
                    {cancel.isPending && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
                    {cancel.isPending ? t("ui.game.campaignIndex.cancelling") : t("ui.game.campaignIndex.cancel")}
                  </button>
                </div>
              </div>
            )}
            <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center justify-end gap-2 bg-[color-mix(in_srgb,var(--background)_92%,transparent)] px-1 py-2">
              {status.isFetching && (
                <Loader2 size={13} className="mr-auto animate-spin text-muted-foreground" aria-hidden="true" />
              )}
              {(job.status === "running" || job.status === "paused") && (
                <button
                  type="button"
                  className={dangerButtonClass}
                  disabled={cancel.isPending || confirmCancel}
                  onClick={() => setConfirmCancel(true)}
                >
                  <Square size={12} aria-hidden="true" />
                  {t("ui.game.campaignIndex.cancel")}
                </button>
              )}
              {job.status !== "running" && (
                <button
                  type="button"
                  className={buttonClass}
                  disabled={!steps || run.isPending}
                  onClick={() => steps && run.mutate(steps)}
                >
                  {run.isPending ? t("ui.game.campaignIndex.starting") : t("ui.game.campaignIndex.resume")}
                </button>
              )}
              <button type="button" className={primaryButtonClass} onClick={onClose}>
                {t("ui.game.campaignIndex.close")}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

/**
 * Offers indexing once per game: opens the dialog when the plan still has
 * unregistered owners or uncovered history and no chat of the game stores a
 * dismissal. Closing writes `campaignIndexPrompt.dismissedAt` to chat metadata.
 */
export function CampaignIndexAutoPrompt({ chatId }: { chatId: string }) {
  const plan = useCampaignIndexPlan(chatId);
  const updateMetadata = useUpdateChatMetadata();
  const [open, setOpen] = useState(false);
  const offeredRef = useRef(false);
  const game = plan.data?.games[0] ?? null;
  useEffect(() => {
    if (!game || offeredRef.current) return;
    offeredRef.current = true;
    if (game.needsIndexing && !game.promptDismissedAt) setOpen(true);
  }, [game]);
  if (!open) return null;
  const close = () => {
    setOpen(false);
    updateMetadata.mutate({ id: chatId, campaignIndexPrompt: { dismissedAt: new Date().toISOString() } });
  };
  return <CampaignIndexDialog chatId={chatId} onClose={close} />;
}
