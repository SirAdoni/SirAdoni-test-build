import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Award,
  Bookmark,
  Briefcase,
  CalendarClock,
  Check,
  ChevronDown,
  Gift,
  Handshake,
  History,
  Loader2,
  Mail,
  RotateCw,
  ScrollText,
  type LucideIcon,
} from "lucide-react";
import { useTranslation as useUiTranslation } from "react-i18next";
import { ApiError } from "../../lib/api-client";
import { cn } from "../../lib/utils";
import {
  useCampaignMemoryCommitments,
  useTransitionCampaignMemoryCommitment,
  type CampaignMemoryCommitmentItem,
  type CampaignMemoryCommitmentKind,
  type CampaignMemoryCommitmentState,
} from "../../hooks/use-campaign-memory";
import { CampaignWikiEvidence } from "./CampaignWikiEvidence";
import {
  EntityAvatar,
  WikiCard,
  WikiChip,
  WikiEmpty,
  WikiSectionHeader,
  WikiSkeleton,
  formatCaptureOrder,
  humanizeKey,
  recordOrigin,
  recordWriteChatId,
  type WikiTone,
} from "./campaign-wiki-ui";

/**
 * Pulse 8 quest/commitment view. Items are grouped by state; a transition is a new
 * superseding fact created by the server, never an edit of the shown record.
 */
const STATE_GROUPS: readonly CampaignMemoryCommitmentState[] = [
  "proposed",
  "accepted",
  "active",
  "unresolved",
  "completed",
  "declined",
  "cancelled",
];
/** Mirrors the server machine (campaign-memory-commitments.ts); the server is authoritative and answers 400 otherwise. */
const NEXT_STATES: Record<CampaignMemoryCommitmentState, readonly CampaignMemoryCommitmentState[]> = {
  proposed: ["accepted", "active", "declined", "cancelled", "unresolved"],
  accepted: ["active", "completed", "cancelled", "unresolved"],
  active: ["completed", "cancelled", "unresolved"],
  completed: [],
  declined: [],
  cancelled: [],
  unresolved: ["proposed", "accepted", "active", "completed", "declined", "cancelled"],
};

type Bucket = "open" | "done" | "closed";
const BUCKETS: ReadonlyArray<{ id: Bucket; states: readonly CampaignMemoryCommitmentState[] }> = [
  { id: "open", states: ["proposed", "accepted", "active", "unresolved"] },
  { id: "done", states: ["completed"] },
  { id: "closed", states: ["declined", "cancelled"] },
];

const STATE_TONES: Record<CampaignMemoryCommitmentState, WikiTone> = {
  proposed: "info",
  accepted: "accent",
  active: "accent",
  unresolved: "warning",
  completed: "success",
  declined: "neutral",
  cancelled: "neutral",
};

const STATE_DOT: Record<WikiTone, string> = {
  neutral: "bg-muted-foreground/60",
  accent: "bg-primary",
  success: "bg-emerald-400",
  warning: "bg-amber-400",
  danger: "bg-destructive",
  info: "bg-sky-400",
};

const KIND_ICONS: Record<CampaignMemoryCommitmentKind, LucideIcon> = {
  quest: ScrollText,
  promise: Handshake,
  offer: Gift,
  invitation: Mail,
  employment: Briefcase,
  candidacy: Award,
  other: Bookmark,
};

export function CampaignWikiCommitments({
  chatId,
  entityId,
  onNavigate,
  className,
}: {
  chatId: string;
  entityId?: string;
  onNavigate?: (entityId: string) => void;
  className?: string;
}) {
  const { t } = useUiTranslation();
  // Cursor history like the timeline: last entry is the current page.
  const [cursors, setCursors] = useState<string[]>([]);
  const commitments = useCampaignMemoryCommitments(chatId, { entityId, cursor: cursors[cursors.length - 1] });
  const page = commitments.data;
  const groups = STATE_GROUPS.map((state) => ({
    state,
    items: (page?.items ?? []).filter((item) => item.state === state),
  })).filter((group) => group.items.length > 0);
  const buckets = BUCKETS.map((bucket) => ({
    ...bucket,
    groups: groups.filter((group) => bucket.states.includes(group.state)),
  }))
    .map((bucket) => ({ ...bucket, items: bucket.groups.flatMap((group) => group.items) }))
    .filter((bucket) => bucket.items.length > 0);
  const bucketTitle = (bucket: Bucket) =>
    bucket === "open"
      ? t("ui.game.campaignWiki.commitments.bucket.open", { defaultValue: "Open" })
      : bucket === "done"
        ? t("ui.game.campaignWiki.commitments.bucket.done", { defaultValue: "Done" })
        : t("ui.game.campaignWiki.commitments.bucket.closed", { defaultValue: "Declined or cancelled" });

  return (
    <section
      data-component="campaign-wiki-commitments"
      className={cn("space-y-4", className)}
      aria-label={t("ui.game.campaignWiki.commitments.title")}
    >
      <WikiSectionHeader
        title={t("ui.game.campaignWiki.commitments.title")}
        className="mb-0"
        action={
          cursors.length > 0 ? (
            <span className="text-[0.6875rem] text-muted-foreground">
              {t("ui.game.campaignWiki.commitments.page", { page: cursors.length + 1 })}
            </span>
          ) : undefined
        }
      />
      {commitments.isLoading && (
        <div role="status" aria-label={t("ui.game.campaignWiki.commitments.loading")}>
          <WikiSkeleton rows={3} />
        </div>
      )}
      {commitments.isError && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-xs text-destructive"
        >
          <span>{t("ui.game.campaignWiki.commitments.error")}</span>
          <button
            type="button"
            onClick={() => void commitments.refetch()}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-muted-foreground hover:bg-secondary/70 hover:text-foreground"
          >
            <RotateCw size={13} aria-hidden="true" />
            {t("ui.game.campaignWiki.commitments.reload")}
          </button>
        </div>
      )}
      {page && page.items.length === 0 && (
        <WikiEmpty icon={<ScrollText size={22} />} title={t("ui.game.campaignWiki.commitments.empty")} />
      )}
      {buckets.map((bucket) => (
        <div key={bucket.id} className="space-y-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h5 className="text-xs font-bold uppercase tracking-wide text-foreground">
              {bucketTitle(bucket.id)}
              <span className="ml-1.5 font-semibold text-muted-foreground">{bucket.items.length}</span>
            </h5>
            <p className="flex flex-wrap gap-x-2 text-[0.6875rem] text-muted-foreground">
              {bucket.groups.map((group) => (
                <span key={group.state}>
                  {t(`ui.game.campaignWiki.commitments.state.${group.state}`)} ({group.items.length})
                </span>
              ))}
            </p>
          </div>
          <ul className="space-y-2.5">
            {bucket.items.map((item) => (
              <CommitmentCard key={item.commitmentId} pageChatId={chatId} item={item} onNavigate={onNavigate} />
            ))}
          </ul>
        </div>
      ))}
      {page && (cursors.length > 0 || page.nextCursor) && (
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            disabled={cursors.length === 0}
            onClick={() => setCursors((list) => list.slice(0, -1))}
            className="inline-flex min-h-9 items-center rounded-lg border border-border px-3 text-xs font-medium hover:bg-secondary/70 disabled:opacity-40"
          >
            {t("ui.game.campaignWiki.commitments.previousPage")}
          </button>
          <button
            type="button"
            disabled={!page.nextCursor}
            onClick={() => page.nextCursor && setCursors((list) => [...list, page.nextCursor as string])}
            className="inline-flex min-h-9 items-center rounded-lg border border-border px-3 text-xs font-medium hover:bg-secondary/70 disabled:opacity-40"
          >
            {t("ui.game.campaignWiki.commitments.nextPage")}
          </button>
        </div>
      )}
    </section>
  );
}

function CommitmentCard({
  pageChatId,
  item,
  onNavigate,
}: {
  pageChatId: string;
  item: CampaignMemoryCommitmentItem;
  onNavigate?: (entityId: string) => void;
}) {
  const { t, i18n } = useUiTranslation();
  // Records projected from an earlier session are read and written through the chat they came from.
  const chatId = recordWriteChatId(item, pageChatId);
  const origin = recordOrigin(item);
  const [menuOpen, setMenuOpen] = useState(false);
  const [target, setTarget] = useState<CampaignMemoryCommitmentState | null>(null);
  const nextStates = NEXT_STATES[item.state];
  const KindIcon = KIND_ICONS[item.kind] ?? Bookmark;
  const openSince = formatCaptureOrder(item.openSince, i18n.language);
  const stateLabel = (state: CampaignMemoryCommitmentState) => t(`ui.game.campaignWiki.commitments.state.${state}`);

  return (
    <WikiCard as="li" className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <WikiChip tone={STATE_TONES[item.state]}>{stateLabel(item.state)}</WikiChip>
        <WikiChip icon={<KindIcon size={11} aria-hidden="true" />}>
          {t(`ui.game.campaignWiki.commitments.kind.${item.kind}`)}
        </WikiChip>
        {typeof origin.sessionNumber === "number" && (
          <WikiChip>
            {t("ui.game.campaignWiki.commitments.session", {
              number: origin.sessionNumber,
              defaultValue: "Session {{number}}",
            })}
          </WikiChip>
        )}
        {item.historical && <WikiChip tone="warning">{t("ui.game.campaignWiki.commitments.historical")}</WikiChip>}
      </div>

      <p className="break-words text-sm font-semibold leading-6 text-foreground">{item.title}</p>

      {(item.deadline || openSince) && (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {item.deadline && (
            <span className="inline-flex items-center gap-1 text-foreground/85">
              <CalendarClock size={13} aria-hidden="true" />
              {t("ui.game.campaignWiki.commitments.due", { deadline: item.deadline, defaultValue: "Due {{deadline}}" })}
            </span>
          )}
          {openSince && (
            <span>
              {t("ui.game.campaignWiki.commitments.openSinceDate", {
                date: openSince,
                defaultValue: "Open since {{date}}",
              })}
            </span>
          )}
        </p>
      )}

      {item.conditions.length > 0 && (
        <div className="text-xs">
          <p className="font-semibold text-muted-foreground">
            {t("ui.game.campaignWiki.commitments.onlyIf", { defaultValue: "Only if" })}
          </p>
          <ul className="mt-1 space-y-0.5">
            {item.conditions.map((condition, index) => (
              <li key={`${index}-${condition}`} className="flex gap-1.5 break-words text-foreground/90">
                <span aria-hidden="true" className="mt-[0.45rem] h-1 w-1 shrink-0 rounded-full bg-muted-foreground" />
                <span className="min-w-0">{condition}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {item.participants.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-1.5"
          aria-label={t("ui.game.campaignWiki.commitments.participantsLabel", { defaultValue: "People involved" })}
          role="group"
        >
          {item.participants.map((participant) => {
            const name =
              participant.alias || t("ui.game.campaignWiki.commitments.unnamed", { defaultValue: "Unnamed" });
            return (
              <button
                type="button"
                key={`${participant.entityId}-${participant.role}`}
                onClick={() => onNavigate?.(participant.entityId)}
                disabled={!onNavigate}
                title={participant.role ? humanizeKey(participant.role) : undefined}
                className="inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-full border border-border bg-secondary/40 py-0.5 pl-0.5 pr-2.5 text-xs text-foreground transition-colors hover:border-primary/50 hover:bg-secondary/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-default disabled:hover:border-border disabled:hover:bg-secondary/40"
              >
                <EntityAvatar name={name} kind="character" size={26} />
                <span className="truncate font-medium">{name}</span>
                {participant.role && participant.role !== "subject" && (
                  <span className="shrink-0 text-[0.6875rem] text-muted-foreground">
                    {humanizeKey(participant.role)}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {item.notes && (
        <p className="whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">{item.notes}</p>
      )}

      <CampaignWikiEvidence chatId={chatId} evidence={item.evidence} />

      <details className="group/history">
        <summary className="inline-flex min-h-9 cursor-pointer list-none items-center gap-1.5 rounded-lg px-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 [&::-webkit-details-marker]:hidden">
          <History size={14} aria-hidden="true" />
          {t("ui.game.campaignWiki.commitments.history", { count: item.transitions.length })}
          <ChevronDown size={13} aria-hidden="true" className="transition-transform group-open/history:rotate-180" />
        </summary>
        <ol className="mt-1.5 space-y-0 pl-2">
          {item.transitions.map((transition, index) => {
            const when = formatCaptureOrder(transition.sourceOrder, i18n.language);
            const last = index === item.transitions.length - 1;
            return (
              <li key={transition.factId} className="relative flex gap-2.5 pb-2 last:pb-0">
                {!last && <span aria-hidden="true" className="absolute left-[4px] top-3 h-full w-px bg-border" />}
                <span
                  aria-hidden="true"
                  className={cn(
                    "relative mt-1 h-[9px] w-[9px] shrink-0 rounded-full",
                    STATE_DOT[STATE_TONES[transition.state]],
                  )}
                />
                <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-xs">
                  <span className="font-medium text-foreground">{stateLabel(transition.state)}</span>
                  <span className="text-muted-foreground">
                    {when ?? t("ui.game.campaignWiki.commitments.whenUnknown", { defaultValue: "date unknown" })}
                  </span>
                </span>
              </li>
            );
          })}
        </ol>
      </details>

      {nextStates.length === 0 ? (
        <p className="inline-flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
          <Check size={12} aria-hidden="true" />
          {t("ui.game.campaignWiki.commitments.closedNote", { defaultValue: "Closed. This can no longer change." })}
        </p>
      ) : target ? (
        <TransitionForm
          chatId={chatId}
          item={item}
          state={target}
          onClose={() => {
            setTarget(null);
            setMenuOpen(false);
          }}
        />
      ) : (
        <div>
          <button
            type="button"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((value) => !value)}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-medium text-foreground transition-colors hover:bg-secondary/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            {t("ui.game.campaignWiki.commitments.transition")}
            <ChevronDown
              size={13}
              aria-hidden="true"
              className={cn("transition-transform", menuOpen && "rotate-180")}
            />
          </button>
          {menuOpen && (
            <div
              role="menu"
              aria-label={t("ui.game.campaignWiki.commitments.moveTo", { defaultValue: "Move to" })}
              className="mt-2 flex flex-wrap gap-1.5"
            >
              {nextStates.map((state) => (
                <button
                  key={state}
                  type="button"
                  role="menuitem"
                  onClick={() => setTarget(state)}
                  className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-border bg-secondary/40 px-3 text-xs font-medium text-foreground transition-colors hover:border-primary/50 hover:bg-secondary/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                >
                  <span aria-hidden="true" className={cn("h-2 w-2 rounded-full", STATE_DOT[STATE_TONES[state]])} />
                  {stateLabel(state)}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </WikiCard>
  );
}

function TransitionForm({
  chatId,
  item,
  state,
  onClose,
}: {
  chatId: string;
  item: CampaignMemoryCommitmentItem;
  state: CampaignMemoryCommitmentState;
  onClose: () => void;
}) {
  const { t } = useUiTranslation();
  const transition = useTransitionCampaignMemoryCommitment(chatId);
  const queryClient = useQueryClient();
  const [conditions, setConditions] = useState(item.conditions.join("\n"));
  const [deadline, setDeadline] = useState(item.deadline ?? "");
  const [messageId, setMessageId] = useState("");
  const [quote, setQuote] = useState("");
  const [reason, setReason] = useState("");
  const errorStatus = transition.error instanceof ApiError ? transition.error.status : undefined;
  const conflict = errorStatus === 409;
  const evidenceIncomplete = (messageId.trim() === "") !== (quote.trim() === "");
  const canSubmit = reason.trim() !== "" && !evidenceIncomplete && !transition.isPending && !conflict;
  const stateLabel = t(`ui.game.campaignWiki.commitments.state.${state}`);
  // After a 409 the shown revision is stale: refetch before closing so the next attempt uses the new revision.
  const reload = () => {
    void queryClient.invalidateQueries({ queryKey: ["campaign-memory"] });
    onClose();
  };
  const submit = () => {
    const evidence = messageId.trim() && quote.trim() ? [{ messageId: messageId.trim(), quote: quote.trim() }] : [];
    transition.mutate(
      {
        commitmentId: item.commitmentId,
        expectedRevision: item.revision,
        state,
        conditions: conditions
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
        deadline: deadline.trim() || null,
        evidence,
        reason: reason.trim(),
      },
      { onSuccess: onClose },
    );
  };
  const field =
    "mt-1 w-full rounded-lg border border-border bg-background px-2.5 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60";
  const labelClass = "block text-xs font-medium text-muted-foreground";
  return (
    <div className="space-y-3 rounded-lg bg-secondary/35 p-3" role="group" aria-label={stateLabel}>
      <p className="text-sm font-semibold text-foreground">
        {t("ui.game.campaignWiki.commitments.confirmTitle", {
          state: stateLabel,
          defaultValue: "Mark as {{state}}?",
        })}
      </p>
      {conflict && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 text-xs text-destructive">
          <span>{t("ui.game.campaignWiki.commitments.conflict")}</span>
          <button
            type="button"
            onClick={reload}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-muted-foreground hover:bg-secondary/70"
          >
            <RotateCw size={12} aria-hidden="true" />
            {t("ui.game.campaignWiki.commitments.reload")}
          </button>
        </div>
      )}
      {transition.isError && !conflict && (
        <p role="alert" className="text-xs text-destructive">
          {errorStatus === 400
            ? t("ui.game.campaignWiki.commitments.illegal")
            : t("ui.game.campaignWiki.commitments.applyError")}
        </p>
      )}
      <label className={labelClass}>
        {t("ui.game.campaignWiki.commitments.why", { defaultValue: "Why? (required)" })}
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder={t("ui.game.campaignWiki.commitments.whyPlaceholder", {
            defaultValue: "For example: she delivered the drawing",
          })}
          className={field}
        />
      </label>
      <details className="group/more">
        <summary className="inline-flex min-h-9 cursor-pointer list-none items-center gap-1.5 rounded-lg px-1.5 text-xs font-medium text-muted-foreground hover:bg-secondary/60 hover:text-foreground [&::-webkit-details-marker]:hidden">
          {t("ui.game.campaignWiki.commitments.moreOptions", { defaultValue: "Conditions, deadline and quote" })}
          <ChevronDown size={13} aria-hidden="true" className="transition-transform group-open/more:rotate-180" />
        </summary>
        <div className="mt-2 space-y-2.5">
          <label className={labelClass}>
            {t("ui.game.campaignWiki.commitments.conditionsHelp")}
            <textarea
              value={conditions}
              onChange={(event) => setConditions(event.target.value)}
              rows={2}
              className={field}
            />
          </label>
          <label className={labelClass}>
            {t("ui.game.campaignWiki.commitments.deadlineInput")}
            <input value={deadline} onChange={(event) => setDeadline(event.target.value)} className={field} />
          </label>
          <label className={labelClass}>
            {t("ui.game.campaignWiki.commitments.evidenceQuote")}
            <textarea value={quote} onChange={(event) => setQuote(event.target.value)} rows={2} className={field} />
          </label>
          <label className={labelClass}>
            {t("ui.game.campaignWiki.commitments.evidenceMessageId")}
            <input value={messageId} onChange={(event) => setMessageId(event.target.value)} className={field} />
          </label>
          {evidenceIncomplete && (
            <p className="text-xs text-muted-foreground">{t("ui.game.campaignWiki.commitments.evidenceHelp")}</p>
          )}
        </div>
      </details>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={!canSubmit}
          onClick={submit}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {transition.isPending && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
          {t("ui.game.campaignWiki.commitments.confirmApply", {
            state: stateLabel,
            defaultValue: "Mark as {{state}}",
          })}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex min-h-9 items-center rounded-lg border border-border px-3 text-xs font-medium hover:bg-secondary/70"
        >
          {t("ui.game.campaignWiki.commitments.cancel")}
        </button>
      </div>
    </div>
  );
}
