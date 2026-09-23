import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, ChevronRight, Layers, Loader2, MessageSquareQuote, Pin, RotateCw } from "lucide-react";
import type { CampaignMemoryFact } from "@marinara-engine/shared";
import { useTranslation as useUiTranslation } from "react-i18next";
import { ApiError } from "../../lib/api-client";
import { cn } from "../../lib/utils";
import { parseChatMetadata } from "../../lib/chat-display";
import { useChat, useChats } from "../../hooks/use-chats";
import {
  useCampaignMemoryDuplicateRecords,
  useCampaignMemoryDuplicates,
  useCampaignMemoryEntity,
  useResolveCampaignMemoryDuplicates,
  type CampaignMemorySessionChat,
  type CampaignMemorySessionDuplicateGroup,
} from "../../hooks/use-campaign-memory";
import { factKindOf, isPinnedFact } from "./CampaignWikiFacts";
import {
  FactLabelBadge,
  WhenChip,
  WikiErrorState as ErrorState,
  displayEntityName,
  enumLabel,
  kindLabel,
  portraitFor,
  readableValue,
  type FactLabel,
  type TFn,
} from "./CampaignWikiReaderParts";
import {
  EntityAvatar,
  WikiChip,
  WikiEmpty,
  WikiSkeleton,
  crossSessionReferenceDetail,
  crossSessionReferenceText,
  factDisplay,
  humanizeKey,
  isWikiRevisionConflict,
} from "./campaign-wiki-ui";

/**
 * Duplicate review: groups of near-identical facts (same page, same kind of fact, same source message or nearly the
 * same words). The player keeps one; the server supersedes the others in the session chat they were recorded in.
 */

const PENDING_LABEL: FactLabel = "pending";

function sessionNumberOf(metadata: unknown): number | null {
  const value = parseChatMetadata(metadata).gameSessionNumber;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The campaign's session chats up to this one (the game group's chats, one per session number, skipping branches),
 * this chat always included. Without a group or a chat list it is just this chat.
 */
export function useCampaignSessionChats(chatId: string): { sessions: CampaignMemorySessionChat[]; ready: boolean } {
  const chat = useChat(chatId);
  const chats = useChats();
  const ready = !chat.isLoading && !chats.isLoading;
  const sessions = useMemo(() => {
    const current = chat.data;
    const currentNumber = current ? sessionNumberOf(current.metadata) : null;
    const own = { chatId, sessionNumber: currentNumber };
    if (!current?.groupId || !Array.isArray(chats.data)) return [own];
    const bySession = new Map<number, { chatId: string; updatedAt: string }>();
    for (const candidate of chats.data) {
      if (candidate.id === chatId || candidate.mode !== "game" || candidate.groupId !== current.groupId) continue;
      const metadata = parseChatMetadata(candidate.metadata);
      if (typeof metadata.branchName === "string" && metadata.branchName.trim()) continue;
      const number = sessionNumberOf(metadata);
      if (number === null || number === currentNumber) continue;
      if (currentNumber !== null && number > currentNumber) continue;
      const known = bySession.get(number);
      if (!known || String(candidate.updatedAt ?? "") > known.updatedAt)
        bySession.set(number, { chatId: candidate.id, updatedAt: String(candidate.updatedAt ?? "") });
    }
    const others = [...bySession.entries()]
      .sort((left, right) => right[0] - left[0])
      .map(([sessionNumber, value]) => ({ chatId: value.chatId, sessionNumber }));
    return [own, ...others];
  }, [chat.data, chats.data, chatId]);
  return { sessions, ready };
}

/** Portrait and name of a page, linking to it; used by the review and canon pages. */
export function CampaignWikiSubjectLink({
  chatId,
  entityId,
  fallbackName,
  onSelect,
  portraits,
  meta,
}: {
  chatId: string;
  entityId: string;
  fallbackName?: string;
  onSelect: (id: string) => void;
  portraits: Map<string, string>;
  meta?: string;
}) {
  const { t } = useUiTranslation();
  const detail = useCampaignMemoryEntity(chatId, entityId, { limit: 1 });
  const entity = detail.data?.entity;
  const name = entity
    ? displayEntityName(t as TFn, entity)
    : fallbackName?.trim() && fallbackName !== entityId
      ? fallbackName
      : detail.isError
        ? t("ui.game.campaignWiki.reader.unknownPage", { defaultValue: "Unknown page" })
        : "…";
  return (
    <button
      type="button"
      onClick={() => onSelect(entity?.entityId ?? entityId)}
      className="group -mx-1.5 flex min-h-11 min-w-0 max-w-full items-center gap-2.5 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
    >
      <EntityAvatar
        name={name}
        kind={entity?.kind ?? "character"}
        size={34}
        imageUrl={entity ? portraitFor(entity, portraits) : null}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-bold leading-5 text-foreground group-hover:text-primary">
          {name}
        </span>
        {(meta || entity) && (
          <span className="block truncate text-[0.6875rem] leading-4 text-muted-foreground">
            {meta ?? (entity ? kindLabel(t as TFn, entity.kind) : "")}
          </span>
        )}
      </span>
      <ChevronRight size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
  );
}

/** How many duplicate groups wait for review across the campaign (null while unknown or unsupported). */
export function useCampaignDuplicateCount(chatId: string): number | null {
  const { sessions, ready } = useCampaignSessionChats(chatId);
  const duplicates = useCampaignMemoryDuplicates(sessions, { enabled: ready });
  if (!duplicates.data || duplicates.data.unsupported) return null;
  return duplicates.data.groups.length;
}

type ResolveError = "conflict" | "missing" | "crossSession" | "generic";

export function CampaignWikiReview({
  chatId,
  onSelect,
  portraits,
}: {
  chatId: string;
  onSelect: (id: string) => void;
  portraits: Map<string, string>;
}) {
  const { t } = useUiTranslation();
  const { sessions, ready } = useCampaignSessionChats(chatId);
  const duplicates = useCampaignMemoryDuplicates(sessions, { enabled: ready });
  const [skipped, setSkipped] = useState<Set<string>>(() => new Set());
  const [resolved, setResolved] = useState<Set<string>>(() => new Set());
  const [lastResolved, setLastResolved] = useState<number | null>(null);
  const groups = (duplicates.data?.groups ?? []).filter((group) => !resolved.has(`${group.chatId}:${group.groupId}`));
  const visible = groups.filter((group) => !skipped.has(`${group.chatId}:${group.groupId}`));
  const skippedCount = groups.length - visible.length;
  const multiSession = new Set(groups.map((group) => group.chatId)).size > 1 || sessions.length > 1;

  return (
    <div className="@container mx-auto w-full min-w-0 max-w-[60rem] space-y-4 pb-10 pt-1" data-campaign-wiki-review>
      <header className="space-y-1.5 border-b border-border pb-4">
        <h2 className="flex flex-wrap items-center gap-2 text-2xl font-bold leading-tight">
          {t("ui.game.campaignWiki.review.title", { defaultValue: "Review duplicates" })}
          {duplicates.data && !duplicates.data.unsupported && (
            <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-semibold tabular-nums text-muted-foreground">
              {groups.length.toLocaleString()}
            </span>
          )}
        </h2>
        <p className="max-w-[65ch] text-sm leading-6 text-muted-foreground">
          {t("ui.game.campaignWiki.review.intro", {
            defaultValue:
              "The same fact recorded more than once. Keep the best version; the others are retired and the memory stops using them.",
          })}
        </p>
      </header>

      {lastResolved !== null && (
        <p
          role="status"
          className="flex items-center gap-2 rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-xs text-emerald-200"
        >
          <Check size={14} aria-hidden="true" />
          {t("ui.game.campaignWiki.review.resolved", {
            defaultValue: "Kept one fact and retired {{count}}.",
            count: lastResolved,
          })}
        </p>
      )}

      {(!ready || duplicates.isLoading) && <WikiSkeleton rows={3} />}
      {duplicates.isError && <ErrorState onRetry={() => void duplicates.refetch()} />}
      {duplicates.data?.unsupported && (
        <WikiEmpty
          icon={<Layers size={24} />}
          title={t("ui.game.campaignWiki.review.unsupportedTitle", {
            defaultValue: "Duplicate review needs a server update",
          })}
          hint={t("ui.game.campaignWiki.review.unsupportedHint", {
            defaultValue: "This server cannot look for duplicate facts yet. Update Marinara to use this page.",
          })}
        />
      )}
      {duplicates.data && !duplicates.data.unsupported && groups.length === 0 && (
        <WikiEmpty
          icon={<Check size={24} />}
          title={t("ui.game.campaignWiki.review.emptyTitle", { defaultValue: "No duplicates to review" })}
          hint={t("ui.game.campaignWiki.review.emptyHint", {
            defaultValue:
              "Every fact in this campaign is recorded once. New duplicates show up here as the story goes on.",
          })}
        />
      )}

      {visible.length > 0 && (
        <ol className="space-y-4">
          {visible.map((group) => (
            <li key={`${group.chatId}:${group.groupId}`}>
              <DuplicateGroup
                chatId={chatId}
                group={group}
                showSession={multiSession}
                onSelect={onSelect}
                portraits={portraits}
                onSkip={() => setSkipped((current) => new Set(current).add(`${group.chatId}:${group.groupId}`))}
                onResolved={(count) => {
                  setLastResolved(count);
                  setResolved((current) => new Set(current).add(`${group.chatId}:${group.groupId}`));
                }}
              />
            </li>
          ))}
        </ol>
      )}

      {skippedCount > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>
            {t("ui.game.campaignWiki.review.skipped", { defaultValue: "{{count}} skipped", count: skippedCount })}
          </span>
          <button
            type="button"
            onClick={() => setSkipped(new Set())}
            className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 font-semibold text-primary hover:bg-secondary"
          >
            <RotateCw size={12} aria-hidden="true" />
            {t("ui.game.campaignWiki.review.showSkipped", { defaultValue: "Show again" })}
          </button>
        </div>
      )}
      {duplicates.data?.truncated && (
        <p className="text-xs text-muted-foreground">
          {t("ui.game.campaignWiki.review.truncated", {
            defaultValue: "Showing the first groups only. Resolve some to see the rest.",
          })}
        </p>
      )}
    </div>
  );
}

/** The version kept by default: a pinned one, else the one with the most quotes, else the newest. */
function defaultKeep(group: CampaignMemorySessionDuplicateGroup, records: Map<string, CampaignMemoryFact> | undefined) {
  let best = group.facts[group.facts.length - 1]?.factId ?? null;
  let bestScore = -1;
  group.facts.forEach((fact, index) => {
    const record = records?.get(fact.factId);
    const pinned = record && isPinnedFact(record) ? 1000 : 0;
    const quotes = record?.evidence.length ?? fact.evidenceMessageIds.length;
    const score = pinned + quotes * 10 + index / 100;
    if (score > bestScore) {
      bestScore = score;
      best = fact.factId;
    }
  });
  return best;
}

/** A duplicate's readable text: the stored record when loaded, else the group's text (never raw JSON). */
function duplicateText(text: string, record: CampaignMemoryFact | undefined) {
  if (record) {
    // The group header already names what kind of fact this is, so only the value is shown.
    return factDisplay(record).text;
  }
  const trimmed = text.trim();
  if (/^[[{"]/u.test(trimmed)) {
    try {
      return readableValue(JSON.parse(trimmed));
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function DuplicateGroup({
  chatId,
  group,
  showSession,
  onSelect,
  portraits,
  onSkip,
  onResolved,
}: {
  chatId: string;
  group: CampaignMemorySessionDuplicateGroup;
  showSession: boolean;
  onSelect: (id: string) => void;
  portraits: Map<string, string>;
  onSkip: () => void;
  onResolved: (retired: number) => void;
}) {
  const { t } = useUiTranslation();
  const queryClient = useQueryClient();
  const records = useCampaignMemoryDuplicateRecords(group);
  const resolve = useResolveCampaignMemoryDuplicates();
  const [chosen, setChosen] = useState<string | null>(null);
  const [error, setError] = useState<ResolveError | null>(null);
  const [crossSessionDetail, setCrossSessionDetail] = useState("");
  const keep = chosen ?? defaultKeep(group, records.data);
  const firstRecord = records.data?.get(group.facts[0]?.factId ?? "");
  const kind = firstRecord ? factKindOf(firstRecord) : group.predicate.replace(/^continuity\./u, "");
  const kindText = kind && kind !== "record" ? enumLabel(t as TFn, "factKind", kind) : humanizeKey(group.predicate);
  const missingRevision = group.facts.some((fact) => !records.data?.get(fact.factId));
  const retire = group.facts.filter((fact) => fact.factId !== keep).map((fact) => fact.factId);
  const reasonText =
    group.reason === "overlapping-evidence"
      ? t("ui.game.campaignWiki.review.reasonSameSource", { defaultValue: "Same source message" })
      : group.similarity !== null
        ? t("ui.game.campaignWiki.review.reasonSimilarPercent", {
            defaultValue: "{{percent}}% the same wording",
            percent: Math.round(group.similarity * 100),
          })
        : t("ui.game.campaignWiki.review.reasonSimilar", { defaultValue: "Nearly the same wording" });

  const submit = () => {
    if (!keep || !records.data || missingRevision) return;
    setError(null);
    const expectedRevisions = Object.fromEntries(
      group.facts.map((fact) => [fact.factId, records.data!.get(fact.factId)!.revision]),
    );
    resolve.mutate(
      { chatId: group.chatId, groupId: group.groupId, keepFactId: keep, retireFactIds: retire, expectedRevisions },
      {
        onSuccess: () => onResolved(retire.length),
        onError: (failure) => {
          const detail = crossSessionReferenceDetail(failure);
          setCrossSessionDetail(detail ?? "");
          setError(
            detail !== null
              ? "crossSession"
              : isWikiRevisionConflict(failure)
                ? "conflict"
                : failure instanceof ApiError && failure.status === 404
                  ? "missing"
                  : "generic",
          );
        },
      },
    );
  };

  return (
    <section
      data-campaign-wiki-duplicate-group={group.groupId}
      aria-label={t("ui.game.campaignWiki.review.groupLabel", { defaultValue: "Duplicate facts" })}
      className="rounded-xl border border-border bg-[color-mix(in_srgb,var(--background)_82%,var(--secondary))]"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/70 px-3.5 py-2.5">
        <div className="min-w-0 flex-1 basis-56">
          <CampaignWikiSubjectLink
            chatId={chatId}
            entityId={group.subjectEntityId}
            onSelect={onSelect}
            portraits={portraits}
            meta={kindText}
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {showSession && group.sessionNumber !== null && (
            <WikiChip tone="neutral">
              {t("ui.game.campaignWiki.review.session", {
                defaultValue: "Session {{session}}",
                session: group.sessionNumber,
              })}
            </WikiChip>
          )}
          <WikiChip tone={group.reason === "overlapping-evidence" ? "info" : "neutral"}>{reasonText}</WikiChip>
        </div>
      </header>

      <div
        role="radiogroup"
        aria-labelledby={`keep-label-${group.chatId}-${group.groupId}`}
        className="px-3.5 pb-3.5 pt-3"
      >
        <p
          id={`keep-label-${group.chatId}-${group.groupId}`}
          className="mb-2 text-[0.6875rem] font-bold uppercase tracking-wide text-muted-foreground"
        >
          {t("ui.game.campaignWiki.review.chooseKeep", { defaultValue: "Choose the version to keep" })}
        </p>
        {records.isLoading && <WikiSkeleton rows={group.facts.length} />}
        {!records.isLoading && (
          <div className="grid gap-2 @xl:grid-cols-2">
            {group.facts.map((fact) => {
              const record = records.data?.get(fact.factId);
              const kept = fact.factId === keep;
              const quotes = record?.evidence.length ?? fact.evidenceMessageIds.length;
              const status = record?.status ?? fact.status;
              return (
                <label
                  key={fact.factId}
                  data-campaign-wiki-duplicate-option={kept ? "keep" : "retire"}
                  className={cn(
                    "relative flex min-w-0 cursor-pointer flex-col gap-2 rounded-lg border px-3 py-2.5 transition-colors focus-within:ring-2 focus-within:ring-primary/60",
                    kept
                      ? "border-primary/60 bg-primary/10"
                      : "border-border bg-background/30 hover:border-primary/35 hover:bg-secondary/40",
                  )}
                >
                  <input
                    type="radio"
                    name={`keep-${group.chatId}-${group.groupId}`}
                    value={fact.factId}
                    checked={kept}
                    onChange={() => setChosen(fact.factId)}
                    className="sr-only"
                  />
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className={cn(
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                        kept ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/60",
                      )}
                    >
                      {kept && <Check size={11} strokeWidth={3} />}
                    </span>
                    <span
                      className={cn(
                        "text-[0.6875rem] font-bold uppercase tracking-wide",
                        kept ? "text-primary" : "text-muted-foreground",
                      )}
                    >
                      {kept
                        ? t("ui.game.campaignWiki.review.keep", { defaultValue: "Keep" })
                        : t("ui.game.campaignWiki.review.retire", { defaultValue: "Retire" })}
                    </span>
                  </span>
                  <span className={cn("text-sm leading-6", kept ? "text-foreground" : "text-foreground/80")}>
                    {duplicateText(fact.text, record)}
                  </span>
                  <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                    <WhenChip order={record?.validFromOrder ?? fact.sourceOrder} />
                    <span className="inline-flex items-center gap-1 text-[0.6875rem] text-muted-foreground">
                      <MessageSquareQuote size={11} aria-hidden="true" />
                      {t("ui.game.campaignWiki.facts.quotes", {
                        defaultValue: "{{count}} quotes from the story",
                        count: quotes,
                      })}
                    </span>
                    {record && isPinnedFact(record) && (
                      <WikiChip tone="accent" icon={<Pin size={10} aria-hidden="true" />}>
                        {t("ui.game.campaignWiki.facts.pinnedMark", { defaultValue: "Pinned" })}
                      </WikiChip>
                    )}
                    {(status === "proposed" || status === "held") && <FactLabelBadge label={PENDING_LABEL} />}
                    {fact.historical && (
                      <WikiChip tone="neutral">
                        {t("ui.game.campaignWiki.review.historical", { defaultValue: "Earlier state" })}
                      </WikiChip>
                    )}
                  </span>
                </label>
              );
            })}
          </div>
        )}
        {records.isError && (
          <div className="mt-2">
            <ErrorState onRetry={() => void records.refetch()} />
          </div>
        )}
      </div>

      <footer className="flex flex-wrap items-center gap-2 border-t border-border/70 px-3.5 py-2.5">
        <button
          type="button"
          onClick={submit}
          disabled={resolve.isPending || records.isLoading || missingRevision || !keep}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground transition-opacity disabled:opacity-50"
        >
          {resolve.isPending ? (
            <Loader2 size={13} className="animate-spin" aria-hidden="true" />
          ) : (
            <Check size={13} aria-hidden="true" />
          )}
          {t("ui.game.campaignWiki.review.resolve", {
            defaultValue: "Keep selected, retire {{count}}",
            count: retire.length,
          })}
        </button>
        <button
          type="button"
          onClick={onSkip}
          disabled={resolve.isPending}
          className="inline-flex min-h-9 items-center rounded-lg px-3 text-xs font-semibold text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50"
        >
          {t("ui.game.campaignWiki.review.skip", { defaultValue: "Skip" })}
        </button>
        {error && (
          <div role="alert" className="flex w-full flex-wrap items-center gap-2 text-xs text-destructive">
            <span className="min-w-0 flex-1 basis-48">
              {error === "crossSession"
                ? crossSessionReferenceText(t as TFn, crossSessionDetail)
                : error === "conflict"
                  ? t("ui.game.campaignWiki.review.conflict", {
                      defaultValue: "These facts changed since they were loaded. Reload them and choose again.",
                    })
                  : error === "missing"
                    ? t("ui.game.campaignWiki.review.missing", {
                        defaultValue: "One of these facts no longer exists. Reload the list.",
                      })
                    : t("ui.game.campaignWiki.facts.saveError", {
                        defaultValue: "The change could not be saved. Try again.",
                      })}
            </span>
            {(error === "conflict" || error === "missing") && (
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setChosen(null);
                  void queryClient.invalidateQueries({ queryKey: ["campaign-memory"] });
                }}
                className="inline-flex min-h-9 items-center rounded-lg border border-border px-2.5 font-semibold text-foreground hover:bg-secondary"
              >
                {t("ui.game.campaignWiki.facts.reload", { defaultValue: "Reload" })}
              </button>
            )}
          </div>
        )}
      </footer>
    </section>
  );
}
