import { useState } from "react";
import { Loader2, RotateCw } from "lucide-react";
import { useTranslation as useUiTranslation } from "react-i18next";
import { ApiError } from "../../lib/api-client";
import {
  useCampaignMemoryCommitments,
  useTransitionCampaignMemoryCommitment,
  type CampaignMemoryCommitmentItem,
  type CampaignMemoryCommitmentState,
} from "../../hooks/use-campaign-memory";
import { CampaignWikiEvidence } from "./CampaignWikiEvidence";

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

export function CampaignWikiCommitments({
  chatId,
  entityId,
  onNavigate,
}: {
  chatId: string;
  entityId?: string;
  onNavigate?: (entityId: string) => void;
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
  return (
    <section className="space-y-2" aria-label={t("ui.game.campaignWiki.commitments.title")}>
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold text-[var(--foreground)]">
          {t("ui.game.campaignWiki.commitments.title")}
        </h4>
        {cursors.length > 0 && (
          <p className="text-[0.625rem] text-[var(--muted-foreground)]">
            {t("ui.game.campaignWiki.commitments.page", { page: cursors.length + 1 })}
          </p>
        )}
      </div>
      {commitments.isLoading && (
        <div className="flex items-center gap-2 py-3 text-xs text-[var(--muted-foreground)]">
          <Loader2 size={14} className="animate-spin" />
          {t("ui.game.campaignWiki.commitments.loading")}
        </div>
      )}
      {commitments.isError && (
        <div className="flex items-center justify-between gap-2 py-3 text-xs text-[var(--destructive)]">
          <span>{t("ui.game.campaignWiki.commitments.error")}</span>
          <button
            type="button"
            onClick={() => void commitments.refetch()}
            className="inline-flex min-h-8 items-center gap-1 rounded-md border border-[var(--border)] px-2 text-[var(--muted-foreground)] hover:bg-[var(--secondary)]"
          >
            <RotateCw size={12} />
            {t("ui.game.campaignWiki.commitments.reload")}
          </button>
        </div>
      )}
      {page && page.items.length === 0 && (
        <p className="text-xs text-[var(--muted-foreground)]">{t("ui.game.campaignWiki.commitments.empty")}</p>
      )}
      {groups.map((group) => (
        <div key={group.state} className="space-y-1">
          <h5 className="text-[0.625rem] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
            {t(`ui.game.campaignWiki.commitments.state.${group.state}`)} ({group.items.length})
          </h5>
          <ul className="space-y-2">
            {group.items.map((item) => (
              <CommitmentCard key={item.commitmentId} chatId={chatId} item={item} onNavigate={onNavigate} />
            ))}
          </ul>
        </div>
      ))}
      {page && (cursors.length > 0 || page.nextCursor) && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={cursors.length === 0}
            onClick={() => setCursors((list) => list.slice(0, -1))}
            className="min-h-8 rounded border border-[var(--border)] px-2 text-[0.625rem] hover:bg-[var(--secondary)] disabled:opacity-50"
          >
            {t("ui.game.campaignWiki.commitments.previousPage")}
          </button>
          <button
            type="button"
            disabled={!page.nextCursor}
            onClick={() => page.nextCursor && setCursors((list) => [...list, page.nextCursor as string])}
            className="min-h-8 rounded border border-[var(--border)] px-2 text-[0.625rem] hover:bg-[var(--secondary)] disabled:opacity-50"
          >
            {t("ui.game.campaignWiki.commitments.nextPage")}
          </button>
        </div>
      )}
    </section>
  );
}

function CommitmentCard({
  chatId,
  item,
  onNavigate,
}: {
  chatId: string;
  item: CampaignMemoryCommitmentItem;
  onNavigate?: (entityId: string) => void;
}) {
  const { t } = useUiTranslation();
  const [editing, setEditing] = useState(false);
  const nextStates = NEXT_STATES[item.state];
  return (
    <li className="rounded-md border border-[var(--border)] p-2 text-xs">
      <div className="flex flex-wrap items-center gap-1">
        <span className="inline-flex rounded border border-[var(--border)] px-1.5 py-0.5 text-[0.625rem] text-[var(--muted-foreground)]">
          {t(`ui.game.campaignWiki.commitments.kind.${item.kind}`)}
        </span>
        <span className="font-medium break-words">{item.title}</span>
        {item.historical && (
          <span className="inline-flex rounded border border-[var(--border)] px-1.5 py-0.5 text-[0.625rem] text-[var(--muted-foreground)]">
            {t("ui.game.campaignWiki.commitments.historical")}
          </span>
        )}
      </div>
      <p className="mt-1 text-[0.625rem] text-[var(--muted-foreground)]">
        {item.deadline
          ? t("ui.game.campaignWiki.commitments.deadline", { deadline: item.deadline })
          : t("ui.game.campaignWiki.commitments.noDeadline")}
        {item.openSince && (
          <span className="ml-2">{t("ui.game.campaignWiki.commitments.openSince", { order: item.openSince })}</span>
        )}
      </p>
      {item.conditions.length > 0 && (
        <div className="mt-1">
          <p className="text-[0.625rem] text-[var(--muted-foreground)]">
            {t("ui.game.campaignWiki.commitments.conditions")}
          </p>
          <ul className="list-disc pl-4">
            {item.conditions.map((condition, index) => (
              <li key={`${index}-${condition}`} className="break-words">
                {condition}
              </li>
            ))}
          </ul>
        </div>
      )}
      {item.participants.length > 0 && (
        <p className="mt-1 flex flex-wrap items-center gap-1 text-[0.625rem] text-[var(--muted-foreground)]">
          <span>{t("ui.game.campaignWiki.commitments.participants")}</span>
          {item.participants.map((participant) => (
            <button
              type="button"
              key={`${participant.entityId}-${participant.role}`}
              onClick={() => onNavigate?.(participant.entityId)}
              disabled={!onNavigate}
              className="min-h-8 rounded border border-[var(--border)] px-2 hover:bg-[var(--secondary)] disabled:cursor-default"
            >
              {participant.alias || participant.entityId} · {participant.role}
            </button>
          ))}
        </p>
      )}
      {item.notes && (
        <p className="mt-1 whitespace-pre-wrap break-words text-[var(--muted-foreground)]">{item.notes}</p>
      )}
      <CampaignWikiEvidence chatId={chatId} evidence={item.evidence} />
      <details className="mt-2 rounded-md border border-[var(--border)] px-2 py-1.5">
        <summary className="cursor-pointer text-[0.625rem] text-[var(--muted-foreground)]">
          {t("ui.game.campaignWiki.commitments.history", { count: item.transitions.length })}
        </summary>
        <ol className="mt-1 space-y-1 text-[0.625rem] text-[var(--muted-foreground)]">
          {item.transitions.map((transition) => (
            <li key={transition.factId} className="break-words">
              {transition.sourceOrder
                ? t("ui.game.campaignWiki.commitments.transitionAt", {
                    state: t(`ui.game.campaignWiki.commitments.state.${transition.state}`),
                    order: transition.sourceOrder,
                  })
                : t("ui.game.campaignWiki.commitments.transitionUnknownOrder", {
                    state: t(`ui.game.campaignWiki.commitments.state.${transition.state}`),
                  })}
              <span className="ml-1 opacity-60">({transition.factId})</span>
              {transition.evidenceMessageIds.length > 0 && (
                <span className="ml-1 opacity-60">[{transition.evidenceMessageIds.join(", ")}]</span>
              )}
            </li>
          ))}
        </ol>
      </details>
      {nextStates.length === 0 ? (
        <p className="mt-2 text-[0.625rem] text-[var(--muted-foreground)]">
          {t("ui.game.campaignWiki.commitments.terminal")}
        </p>
      ) : editing ? (
        <TransitionForm chatId={chatId} item={item} nextStates={nextStates} onClose={() => setEditing(false)} />
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="mt-2 min-h-8 rounded border border-[var(--border)] px-2 text-[0.625rem] hover:bg-[var(--secondary)]"
        >
          {t("ui.game.campaignWiki.commitments.transition")}
        </button>
      )}
    </li>
  );
}

function TransitionForm({
  chatId,
  item,
  nextStates,
  onClose,
}: {
  chatId: string;
  item: CampaignMemoryCommitmentItem;
  nextStates: readonly CampaignMemoryCommitmentState[];
  onClose: () => void;
}) {
  const { t } = useUiTranslation();
  const transition = useTransitionCampaignMemoryCommitment(chatId);
  const [state, setState] = useState<CampaignMemoryCommitmentState>(nextStates[0]!);
  const [conditions, setConditions] = useState(item.conditions.join("\n"));
  const [deadline, setDeadline] = useState(item.deadline ?? "");
  const [messageId, setMessageId] = useState("");
  const [quote, setQuote] = useState("");
  const [reason, setReason] = useState("");
  const errorStatus = transition.error instanceof ApiError ? transition.error.status : undefined;
  const conflict = errorStatus === 409;
  const evidenceIncomplete = (messageId.trim() === "") !== (quote.trim() === "");
  const canSubmit = reason.trim() !== "" && !evidenceIncomplete && !transition.isPending && !conflict;
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
  const field = "mt-1 w-full rounded border border-[var(--border)] bg-[var(--background)] px-2 py-1 text-xs";
  return (
    <div className="mt-2 space-y-2 rounded-md border border-[var(--border)] p-2">
      {conflict && (
        <div role="alert" className="flex items-center justify-between gap-2 text-[0.625rem] text-[var(--destructive)]">
          <span>{t("ui.game.campaignWiki.commitments.conflict")}</span>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex min-h-8 items-center gap-1 rounded border border-[var(--border)] px-2 text-[var(--muted-foreground)] hover:bg-[var(--secondary)]"
          >
            <RotateCw size={12} />
            {t("ui.game.campaignWiki.commitments.reload")}
          </button>
        </div>
      )}
      {transition.isError && !conflict && (
        <p role="alert" className="text-[0.625rem] text-[var(--destructive)]">
          {errorStatus === 400
            ? t("ui.game.campaignWiki.commitments.illegal")
            : t("ui.game.campaignWiki.commitments.applyError")}
        </p>
      )}
      <label className="block text-[0.625rem] text-[var(--muted-foreground)]">
        {t("ui.game.campaignWiki.commitments.newState")}
        <select
          value={state}
          onChange={(event) => setState(event.target.value as CampaignMemoryCommitmentState)}
          className={field}
        >
          {nextStates.map((option) => (
            <option key={option} value={option}>
              {t(`ui.game.campaignWiki.commitments.state.${option}`)}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-[0.625rem] text-[var(--muted-foreground)]">
        {t("ui.game.campaignWiki.commitments.conditionsHelp")}
        <textarea
          value={conditions}
          onChange={(event) => setConditions(event.target.value)}
          rows={2}
          className={field}
        />
      </label>
      <label className="block text-[0.625rem] text-[var(--muted-foreground)]">
        {t("ui.game.campaignWiki.commitments.deadlineInput")}
        <input value={deadline} onChange={(event) => setDeadline(event.target.value)} className={field} />
      </label>
      <label className="block text-[0.625rem] text-[var(--muted-foreground)]">
        {t("ui.game.campaignWiki.commitments.evidenceMessageId")}
        <input value={messageId} onChange={(event) => setMessageId(event.target.value)} className={field} />
      </label>
      <label className="block text-[0.625rem] text-[var(--muted-foreground)]">
        {t("ui.game.campaignWiki.commitments.evidenceQuote")}
        <textarea value={quote} onChange={(event) => setQuote(event.target.value)} rows={2} className={field} />
      </label>
      {evidenceIncomplete && (
        <p className="text-[0.625rem] text-[var(--muted-foreground)]">
          {t("ui.game.campaignWiki.commitments.evidenceHelp")}
        </p>
      )}
      <label className="block text-[0.625rem] text-[var(--muted-foreground)]">
        {t("ui.game.campaignWiki.commitments.reason")}
        <input value={reason} onChange={(event) => setReason(event.target.value)} className={field} />
      </label>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={!canSubmit}
          onClick={submit}
          className="min-h-8 rounded border border-[var(--primary)] px-2 text-[0.625rem] hover:bg-[var(--secondary)] disabled:opacity-50"
        >
          {transition.isPending && <Loader2 size={12} className="mr-1 inline animate-spin" />}
          {t("ui.game.campaignWiki.commitments.apply")}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="min-h-8 rounded border border-[var(--border)] px-2 text-[0.625rem] hover:bg-[var(--secondary)]"
        >
          {t("ui.game.campaignWiki.commitments.cancel")}
        </button>
      </div>
    </div>
  );
}
