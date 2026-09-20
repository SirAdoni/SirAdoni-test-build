import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useTranslation as useUiTranslation } from "react-i18next";
import { api } from "../../lib/api-client";
import { useUpdateChatMetadata } from "../../hooks/use-chats";
import { Modal } from "../ui/Modal";

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

const buttonClass =
  "inline-flex min-h-9 items-center gap-1.5 rounded-md border border-[var(--border)] px-3 text-xs text-[var(--foreground)] hover:bg-[var(--secondary)] disabled:opacity-40";
const primaryButtonClass =
  "inline-flex min-h-9 items-center gap-1.5 rounded-md bg-[var(--primary)] px-3 text-xs font-medium text-[var(--primary-foreground)] hover:opacity-90 disabled:opacity-40";
const cellClass = "px-2 py-1.5 text-left align-top";

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
    onSuccess: invalidate,
  });

  const running = job?.status === "running";
  const currentChatId = job && running ? job.order[job.currentIndex] : null;
  const currentChat = game?.chats.find((chat) => chat.chatId === currentChatId) ?? null;
  const toggle = (key: keyof CampaignIndexSteps) =>
    setSteps((current) => (current ? { ...current, [key]: !current[key] } : current));
  const canStart = !!steps && (steps.registerOwners || steps.backfill || steps.publishVerified) && !run.isPending;

  return (
    <Modal open onClose={onClose} title={t("ui.game.campaignIndex.title")} width="max-w-3xl">
      <div className="flex flex-col gap-3 text-sm" data-campaign-index-dialog>
        {plan.isPending && (
          <p role="status" className="flex items-center gap-1.5 text-xs text-[var(--muted-foreground)]">
            <Loader2 size={13} className="animate-spin" aria-hidden="true" />
            {t("ui.game.campaignIndex.loading")}
          </p>
        )}
        {plan.isError && (
          <div className="flex items-center justify-between gap-2 text-xs text-[var(--destructive)]">
            <span>{t("ui.game.campaignIndex.loadError")}</span>
            <button type="button" className={buttonClass} onClick={() => void plan.refetch()}>
              {t("ui.game.campaignIndex.retry")}
            </button>
          </div>
        )}
        {game && !job && steps && (
          <>
            <p className="text-xs text-[var(--muted-foreground)]">{t("ui.game.campaignIndex.intro")}</p>
            <div className="overflow-x-auto rounded-md border border-[var(--border)]">
              <table className="w-full text-xs">
                <thead className="bg-[var(--secondary)] text-[var(--muted-foreground)]">
                  <tr>
                    <th className={cellClass}>{t("ui.game.campaignIndex.column.session")}</th>
                    <th className={cellClass}>{t("ui.game.campaignIndex.column.messages")}</th>
                    <th className={cellClass}>{t("ui.game.campaignIndex.column.owners")}</th>
                    <th className={cellClass}>{t("ui.game.campaignIndex.column.coverage")}</th>
                    <th className={cellClass}>{t("ui.game.campaignIndex.column.turns")}</th>
                  </tr>
                </thead>
                <tbody>
                  {game.chats.map((chat) => (
                    <tr key={chat.chatId} className="border-t border-[var(--border)]">
                      <td className={cellClass}>
                        <span className="font-medium">{sessionLabel(t, chat)}</span>
                        <span className="block text-[var(--muted-foreground)]">{chat.name}</span>
                      </td>
                      <td className={cellClass}>{chat.preparedMessages}</td>
                      <td className={cellClass}>
                        {chat.ownersRegistered === null
                          ? t("ui.game.campaignIndex.ownersUnknown")
                          : chat.ownersRegistered
                            ? t("ui.game.campaignIndex.ownersRegistered")
                            : t("ui.game.campaignIndex.ownersPending", { count: chat.ownersPlanned ?? 0 })}
                      </td>
                      <td className={cellClass}>
                        {t("ui.game.campaignIndex.coverage", {
                          covered: chat.preparedMessages - chat.uncoveredMessages,
                          total: chat.preparedMessages,
                        })}
                      </td>
                      <td className={cellClass}>{chat.estimate.turns}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!game.needsIndexing && (
              <p role="status" className="text-xs text-[var(--muted-foreground)]">
                {t("ui.game.campaignIndex.upToDate")}
              </p>
            )}
            <fieldset className="flex flex-col gap-2">
              <legend className="sr-only">{t("ui.game.campaignIndex.stepsLegend")}</legend>
              <label className="flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={steps.registerOwners}
                  onChange={() => toggle("registerOwners")}
                />
                {t("ui.game.campaignIndex.step.registerOwners")}
              </label>
              <label className="flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={steps.backfill}
                  disabled={!game.continuityConfigured}
                  onChange={() => toggle("backfill")}
                />
                {t("ui.game.campaignIndex.step.backfill")}
              </label>
              <label className="flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={steps.publishVerified}
                  onChange={() => toggle("publishVerified")}
                />
                {t("ui.game.campaignIndex.step.publishVerified")}
              </label>
            </fieldset>
            {!game.continuityConfigured && (
              <p className="rounded-md border border-[var(--border)] px-3 py-2 text-xs text-[var(--destructive)]">
                {t("ui.game.campaignIndex.notConfigured")}
              </p>
            )}
            <p className="rounded-md border border-[var(--border)] bg-[var(--secondary)] px-3 py-2 text-xs">
              {t("ui.game.campaignIndex.costNote")}
            </p>
            <p className="text-xs text-[var(--muted-foreground)]">{t("ui.game.campaignIndex.orderNote")}</p>
            {run.isError && (
              <p className="text-xs text-[var(--destructive)]">{t("ui.game.campaignIndex.startError")}</p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
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
            <p className="text-xs text-[var(--muted-foreground)]">{t("ui.game.campaignIndex.progressNote")}</p>
            {running && currentChat && (
              <p role="status" className="flex items-center gap-1.5 text-xs">
                <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                {t("ui.game.campaignIndex.currentSession", { session: sessionLabel(t, currentChat) })}
              </p>
            )}
            {job.status === "paused" && (
              <p className="text-xs text-[var(--destructive)]">{t("ui.game.campaignIndex.jobPaused")}</p>
            )}
            {job.status === "done" && <p className="text-xs">{t("ui.game.campaignIndex.jobDone")}</p>}
            {job.status === "cancelled" && <p className="text-xs">{t("ui.game.campaignIndex.jobCancelled")}</p>}
            <ul className="flex flex-col divide-y divide-[var(--border)] rounded-md border border-[var(--border)]">
              {game.chats.map((chat) => {
                const session = job.sessions[chat.chatId];
                const owner = owners.find((item) => item.chatId === chat.chatId);
                return (
                  <li
                    key={chat.chatId}
                    className={`flex flex-col gap-0.5 px-3 py-2 text-xs ${
                      chat.chatId === currentChatId ? "bg-[var(--secondary)]" : ""
                    }`}
                  >
                    <span className="font-medium">
                      {t("ui.game.campaignIndex.sessionState", {
                        session: sessionLabel(t, chat),
                        state: t(`ui.game.campaignIndex.state.${session?.status ?? "pending"}`),
                      })}
                    </span>
                    <span className="text-[var(--muted-foreground)]">{receiptSummary(t, chat.receiptCounts)}</span>
                    {chat.manifests.length > 1 &&
                      chat.manifests.map((manifest, index) => (
                        <span key={manifest.id} className="text-[var(--muted-foreground)]">
                          {t("ui.game.campaignIndex.manifestLine", {
                            index: index + 1,
                            total: chat.manifests.length,
                            summary: receiptSummary(t, manifest.countsByStatus),
                          })}
                        </span>
                      ))}
                    {chat.totals && (
                      <span className="text-[var(--muted-foreground)]">
                        {t("ui.game.campaignIndex.totals", chat.totals)}
                      </span>
                    )}
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
                    {(owner?.status === "failed" || session?.status === "failed") && (
                      <span className="text-[var(--destructive)]">
                        {t("ui.game.campaignIndex.result.failed", {
                          code: owner?.error ?? session?.failed?.[0]?.error ?? "",
                        })}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            {cancel.isError && (
              <p className="text-xs text-[var(--destructive)]">{t("ui.game.campaignIndex.cancelError")}</p>
            )}
            <div className="flex flex-wrap items-center justify-end gap-2">
              {status.isFetching && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
              {(job.status === "running" || job.status === "paused") && (
                <button
                  type="button"
                  className={buttonClass}
                  disabled={cancel.isPending}
                  onClick={() => cancel.mutate(job.gameId)}
                >
                  {cancel.isPending ? t("ui.game.campaignIndex.cancelling") : t("ui.game.campaignIndex.cancel")}
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
