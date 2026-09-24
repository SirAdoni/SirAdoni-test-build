import { useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  BookOpen,
  CalendarClock,
  ChevronRight,
  Database,
  History,
  Layers,
  MapPin,
  Pin,
  ScrollText,
  Sparkles,
  Wrench,
} from "lucide-react";
import type { CampaignMemoryEntityKind } from "@marinara-engine/shared";
import { useTranslation as useUiTranslation } from "react-i18next";
import { api } from "../../lib/api-client";
import { cn } from "../../lib/utils";
import {
  useCampaignMemoryCommitments,
  useCampaignMemoryEntities,
  type CampaignMemoryCommitmentItem,
  type CampaignMemoryEntityListItem,
  type CampaignMemoryTimelineItem,
  type CampaignMemoryTimelinePage,
} from "../../hooks/use-campaign-memory";
import {
  RAW_ID,
  WikiErrorState as ErrorState,
  displayEntityName,
  eventSummary,
  kindLabel,
  kindSectionLabel,
  portraitFor,
} from "./CampaignWikiReaderParts";
import { KIND_ORDER, type KindTotals } from "./CampaignWikiRail";
import {
  ENTITY_KIND_ICONS,
  EntityAvatar,
  WikiChip,
  WikiEmpty,
  WikiSectionHeader,
  WikiSkeleton,
  WikiStat,
  entitySessionNumbers,
  formatCaptureOrder,
  formatSessionRanges,
  recordOrigin,
} from "./campaign-wiki-ui";

/**
 * The Campaign Wiki front page: who is in the story, where it happens, what just happened, what is still promised
 * and what changed lately. Everything links into the article pages; nothing here writes.
 */

const OPEN_COMMITMENT_STATES = new Set(["proposed", "accepted", "active", "unresolved"]);
const LATEST_COUNT = 5;
/** One `order=desc` request of this size answers "Latest in the story" on current servers. */
const LATEST_REQUEST = 10;
/** Page size and page cap of the fallback walk for servers that ignore `order` and page oldest first. */
const LATEST_PAGE = 100;
const LATEST_MAX_PAGES = 30;

/**
 * The newest timeline events, newest first, from one `order=desc&limit=10` request. The ascending cursor walk to the
 * end is only a fallback for an older server that ignored `order` (its page comes back oldest first with more to
 * read); the section then says when that walk stopped short of the end.
 */
function useLatestTimeline(chatId: string) {
  return useQuery({
    queryKey: ["campaign-memory", "timeline-latest", chatId, LATEST_COUNT] as const,
    queryFn: async () => {
      const first = await api.get<CampaignMemoryTimelinePage>(
        `/game/${chatId}/memory/timeline?order=desc&limit=${LATEST_REQUEST}`,
      );
      const items = first.items;
      const ignoredOrder =
        items.length > 1 && items[0]!.occurrenceOrder.localeCompare(items[items.length - 1]!.occurrenceOrder) < 0;
      if (!ignoredOrder) return { items: items.slice(0, LATEST_COUNT), complete: true };
      if (!first.nextCursor) return { items: items.slice(-LATEST_COUNT).reverse(), complete: true };
      let tail = items;
      let cursor: string | null = first.nextCursor;
      for (let pages = 1; cursor && pages < LATEST_MAX_PAGES; pages += 1) {
        const next: CampaignMemoryTimelinePage = await api.get<CampaignMemoryTimelinePage>(
          `/game/${chatId}/memory/timeline?limit=${LATEST_PAGE}&cursor=${encodeURIComponent(cursor)}`,
        );
        if (next.items.length > 0) tail = [...tail.slice(-LATEST_COUNT), ...next.items];
        cursor = next.nextCursor;
      }
      return { items: tail.slice(-LATEST_COUNT).reverse(), complete: !cursor };
    },
    enabled: Boolean(chatId),
    staleTime: 60_000,
  });
}

function byStoryWeight(portraits: Map<string, string>) {
  return (left: CampaignMemoryEntityListItem, right: CampaignMemoryEntityListItem) =>
    Number(Boolean(portraitFor(right, portraits))) - Number(Boolean(portraitFor(left, portraits))) ||
    entitySessionNumbers(right).length - entitySessionNumbers(left).length ||
    right.updatedAt.localeCompare(left.updatedAt);
}

function useRankedPages(chatId: string, kind: CampaignMemoryEntityKind, enabled: boolean) {
  return useCampaignMemoryEntities(chatId, { kind, limit: 100, enabled });
}

function metaLine(t: ReturnType<typeof useUiTranslation>["t"], entity: CampaignMemoryEntityListItem) {
  const sessions = entitySessionNumbers(entity);
  if (sessions.length > 0)
    return t("ui.game.campaignWiki.reader.sessions", {
      defaultValue: "Sessions {{list}}",
      list: formatSessionRanges(sessions),
    });
  return entity.summary?.trim() || kindLabel(t, entity.kind);
}

function LinkButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex min-h-8 pointer-coarse:min-h-9 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-primary hover:bg-secondary"
    >
      {children}
    </button>
  );
}

export function CampaignWikiOverview({
  chatId,
  campaignName,
  totals,
  onSelect,
  onShowKind,
  onShowTimeline,
  onShowPromises,
  onShowCanon,
  onShowReview,
  reviewCount,
  portraits,
  tools,
}: {
  chatId: string;
  campaignName?: string | null;
  totals: KindTotals;
  onSelect: (id: string) => void;
  onShowKind: (kind: CampaignMemoryEntityKind) => void;
  onShowTimeline: () => void;
  onShowPromises: () => void;
  onShowCanon: () => void;
  onShowReview: () => void;
  /** Duplicate groups waiting for review; null while unknown or on a server without review. */
  reviewCount?: number | null;
  portraits: Map<string, string>;
  tools: ReactNode;
}) {
  const { t, i18n } = useUiTranslation();
  const has = (kind: CampaignMemoryEntityKind) => (totals[kind] ?? 0) > 0;
  const people = useRankedPages(chatId, "character", true);
  const places = useRankedPages(chatId, "location", true);
  const organizations = useRankedPages(chatId, "organization", has("organization"));
  const items = useRankedPages(chatId, "item", has("item"));
  const quests = useRankedPages(chatId, "quest", has("quest"));
  const personas = useRankedPages(chatId, "persona", has("persona"));
  const count = (value: number | undefined) => (value === undefined ? "…" : value.toLocaleString());
  const empty = totals.all === 0;
  const topPeople = useMemo(
    () => [...(people.data?.items ?? [])].sort(byStoryWeight(portraits)).slice(0, 12),
    [people.data, portraits],
  );
  const topPlaces = useMemo(
    () => [...(places.data?.items ?? [])].sort(byStoryWeight(portraits)).slice(0, 8),
    [places.data, portraits],
  );
  const recent = useMemo(
    () =>
      [people.data, places.data, organizations.data, items.data, quests.data, personas.data]
        .flatMap((page) => page?.items ?? [])
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, 6),
    [people.data, places.data, organizations.data, items.data, quests.data, personas.data],
  );
  const heroParts = [
    totals.all !== undefined &&
      t("ui.game.campaignWiki.overview.pageCount", {
        defaultValue: "{{formattedCount}} pages",
        count: totals.all,
        formattedCount: totals.all.toLocaleString(),
      }),
    has("character") &&
      t("ui.game.campaignWiki.overview.peopleCount", {
        defaultValue: "{{formattedCount}} people",
        count: totals.character,
        formattedCount: (totals.character ?? 0).toLocaleString(),
      }),
    has("location") &&
      t("ui.game.campaignWiki.overview.placeCount", {
        defaultValue: "{{formattedCount}} places",
        count: totals.location,
        formattedCount: (totals.location ?? 0).toLocaleString(),
      }),
  ].filter(Boolean);

  return (
    <div data-campaign-wiki-overview className="@container mx-auto w-full min-w-0 max-w-[68rem] pb-10 pt-1">
      <header className="border-b border-border pb-5">
        <p className="flex items-center gap-1.5 text-[0.6875rem] font-semibold uppercase tracking-[0.16em] text-primary">
          <Sparkles size={13} aria-hidden="true" />
          {t("ui.game.campaignWiki.title")}
        </p>
        <h2 className="mt-1 text-2xl font-bold leading-tight tracking-tight [overflow-wrap:anywhere] @xl:text-[1.75rem]">
          {campaignName?.trim() || t("ui.game.campaignWiki.overview.untitled", { defaultValue: "Your campaign" })}
        </h2>
        {heroParts.length > 0 && (
          <p className="mt-1.5 flex flex-wrap gap-x-2 text-sm text-muted-foreground">
            {heroParts.map((part, index) => (
              <span key={index} className="inline-flex items-center gap-2">
                {index > 0 && <span aria-hidden="true">·</span>}
                {part}
              </span>
            ))}
          </p>
        )}
        <p className="mt-2 max-w-[65ch] text-sm leading-6 text-muted-foreground">
          {t("ui.game.campaignWiki.overview.intro", {
            defaultValue:
              "Who people are, where things happened, what was promised and who knows what. The GM reads this every turn.",
          })}
        </p>
      </header>

      {empty ? (
        <div className="pt-6">
          <WikiEmpty
            icon={<Database size={26} />}
            title={t("ui.game.campaignWiki.reader.emptyTitle", { defaultValue: "The wiki is empty" })}
            hint={t("ui.game.campaignWiki.reader.emptyHint", {
              defaultValue:
                "Turn on continuity for this session, or index the campaign history, and pages will appear here as the story is read.",
            })}
            action={tools}
          />
        </div>
      ) : (
        <>
          <section
            aria-label={t("ui.game.campaignWiki.overviewCounts")}
            className="grid grid-cols-[repeat(auto-fit,minmax(7.5rem,1fr))] gap-2 pt-5"
            data-campaign-wiki-overview-stats
          >
            {KIND_ORDER.filter((kind) => kind !== "note" && (totals[kind] === undefined || has(kind))).map((kind) => {
              const Icon = ENTITY_KIND_ICONS[kind];
              return (
                <WikiStat
                  key={kind}
                  label={kindSectionLabel(t, kind)}
                  value={count(totals[kind])}
                  icon={<Icon size={12} aria-hidden="true" />}
                  onClick={() => onShowKind(kind)}
                />
              );
            })}
          </section>

          <div className="mt-7 grid gap-x-8 gap-y-8 @3xl:grid-cols-[minmax(0,1fr)_17rem] @5xl:grid-cols-[minmax(0,1fr)_19rem]">
            <div className="min-w-0 space-y-8">
              <section data-campaign-wiki-overview-people aria-label={kindSectionLabel(t, "character")}>
                <WikiSectionHeader
                  title={kindSectionLabel(t, "character")}
                  count={totals.character}
                  action={
                    has("character") ? (
                      <LinkButton onClick={() => onShowKind("character")}>
                        {t("ui.game.campaignWiki.reader.seeAll", { defaultValue: "See all" })}
                        <ArrowRight size={12} aria-hidden="true" />
                      </LinkButton>
                    ) : undefined
                  }
                />
                {people.isLoading && <WikiSkeleton rows={2} />}
                {people.isError && <ErrorState onRetry={() => void people.refetch()} />}
                {people.data && topPeople.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    {t("ui.game.campaignWiki.overview.noPeople", { defaultValue: "No people recorded yet." })}
                  </p>
                )}
                {topPeople.length > 0 && (
                  <ul className="grid grid-cols-2 gap-2 @xl:grid-cols-3">
                    {topPeople.map((entity, index) => {
                      const name = displayEntityName(t, entity);
                      return (
                        <li key={entity.entityId} className={cn("min-w-0", index >= 6 && "hidden @xl:block")}>
                          <button
                            type="button"
                            onClick={() => onSelect(entity.entityId)}
                            className="flex h-full w-full min-w-0 items-center gap-3 rounded-xl border border-border bg-secondary/30 p-2.5 text-left transition-colors hover:border-primary/50 hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                          >
                            <EntityAvatar
                              name={name}
                              kind={entity.kind}
                              size={44}
                              imageUrl={portraitFor(entity, portraits)}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-semibold leading-5">{name}</span>
                              <span className="block truncate text-[0.6875rem] leading-4 text-muted-foreground">
                                {metaLine(t, entity)}
                              </span>
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              <section
                aria-label={t("ui.game.campaignWiki.reader.recentEvents", { defaultValue: "Latest in the story" })}
              >
                <WikiSectionHeader
                  title={t("ui.game.campaignWiki.reader.recentEvents", { defaultValue: "Latest in the story" })}
                  action={
                    <LinkButton onClick={onShowTimeline}>
                      {t("ui.game.campaignWiki.reader.fullTimeline", { defaultValue: "Full timeline" })}
                      <ArrowRight size={12} aria-hidden="true" />
                    </LinkButton>
                  }
                />
                <LatestEvents chatId={chatId} onSelect={onSelect} portraits={portraits} people={people.data?.items} />
              </section>
            </div>

            <aside className="min-w-0 space-y-8">
              <OpenPromises chatId={chatId} onSelect={onSelect} onShowAll={onShowPromises} />

              {topPlaces.length > 0 && (
                <section data-campaign-wiki-overview-places aria-label={kindSectionLabel(t, "location")}>
                  <WikiSectionHeader
                    title={kindSectionLabel(t, "location")}
                    count={totals.location}
                    action={
                      <LinkButton onClick={() => onShowKind("location")}>
                        {t("ui.game.campaignWiki.reader.seeAll", { defaultValue: "See all" })}
                        <ArrowRight size={12} aria-hidden="true" />
                      </LinkButton>
                    }
                  />
                  <ul className="-mx-2 space-y-px">
                    {topPlaces.map((entity) => (
                      <li key={entity.entityId}>
                        <PageRow entity={entity} onSelect={onSelect} portraits={portraits} line={metaLine(t, entity)} />
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {recent.length > 0 && (
                <section
                  data-campaign-wiki-overview-recent
                  aria-label={t("ui.game.campaignWiki.overview.recentlyChanged", { defaultValue: "Recently changed" })}
                >
                  <WikiSectionHeader
                    title={t("ui.game.campaignWiki.overview.recentlyChanged", { defaultValue: "Recently changed" })}
                  />
                  <ul className="-mx-2 space-y-px">
                    {recent.map((entity) => {
                      const when = new Date(entity.updatedAt);
                      const date = Number.isFinite(when.getTime())
                        ? when.toLocaleDateString(i18n.language, { month: "short", day: "numeric" })
                        : null;
                      return (
                        <li key={entity.entityId}>
                          <PageRow
                            entity={entity}
                            onSelect={onSelect}
                            portraits={portraits}
                            line={[kindLabel(t, entity.kind), date].filter(Boolean).join(" · ")}
                          />
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}

              <section aria-label={t("ui.game.campaignWiki.overview.quickLinks", { defaultValue: "Quick links" })}>
                <WikiSectionHeader
                  title={t("ui.game.campaignWiki.overview.quickLinks", { defaultValue: "Quick links" })}
                />
                <ul className="-mx-2 space-y-px text-sm">
                  <li>
                    <QuickLink icon={<History size={15} />} onClick={onShowTimeline}>
                      {t("ui.game.campaignWiki.campaignTimeline")}
                    </QuickLink>
                  </li>
                  <li>
                    <QuickLink icon={<ScrollText size={15} />} onClick={onShowPromises}>
                      {t("ui.game.campaignWiki.reader.tabCommitments", { defaultValue: "Promises & quests" })}
                    </QuickLink>
                  </li>
                  <li>
                    <QuickLink icon={<Pin size={15} />} onClick={onShowCanon}>
                      {t("ui.game.campaignWiki.canon.title", { defaultValue: "Canon" })}
                    </QuickLink>
                  </li>
                  {has("lore") && (
                    <li>
                      <QuickLink icon={<BookOpen size={15} />} onClick={() => onShowKind("lore")}>
                        {t("ui.game.campaignWiki.overview.browseLore", {
                          defaultValue: "Browse {{formattedCount}} lore entries",
                          count: totals.lore,
                          formattedCount: (totals.lore ?? 0).toLocaleString(),
                        })}
                      </QuickLink>
                    </li>
                  )}
                </ul>
                <details data-campaign-wiki-overview-tools className="mt-3 rounded-xl border border-border px-3 py-2">
                  <summary className="flex min-h-8 pointer-coarse:min-h-9 cursor-pointer items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                    <Wrench size={13} aria-hidden="true" />
                    <span className="flex-1">{t("ui.game.campaignWiki.reader.tools", { defaultValue: "Tools" })}</span>
                    {typeof reviewCount === "number" && reviewCount > 0 && (
                      <span
                        data-campaign-wiki-review-badge
                        title={t("ui.game.campaignWiki.review.badge", {
                          defaultValue: "{{count}} duplicates to review",
                          count: reviewCount,
                        })}
                        className="rounded-full bg-primary/20 px-1.5 py-px text-[0.6875rem] font-bold tabular-nums text-foreground"
                      >
                        {reviewCount > 99 ? "99+" : reviewCount}
                      </span>
                    )}
                  </summary>
                  <div className="mt-2 space-y-3 pb-1">
                    <button
                      type="button"
                      onClick={onShowReview}
                      className="flex min-h-10 w-full items-center gap-2.5 rounded-lg border border-border px-2.5 text-left text-sm font-medium text-foreground transition-colors hover:border-primary/50 hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                    >
                      <Layers size={15} className="shrink-0 text-primary" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate">
                        {t("ui.game.campaignWiki.review.title", { defaultValue: "Review duplicates" })}
                      </span>
                      {typeof reviewCount === "number" && reviewCount > 0 && (
                        <span className="rounded-full bg-primary/20 px-1.5 py-px text-[0.6875rem] font-bold tabular-nums">
                          {reviewCount > 99 ? "99+" : reviewCount}
                        </span>
                      )}
                      <ChevronRight size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
                    </button>
                    {tools}
                  </div>
                </details>
              </section>
            </aside>
          </div>
        </>
      )}
    </div>
  );
}

function PageRow({
  entity,
  onSelect,
  portraits,
  line,
}: {
  entity: CampaignMemoryEntityListItem;
  onSelect: (id: string) => void;
  portraits: Map<string, string>;
  line: string;
}) {
  const { t } = useUiTranslation();
  const name = displayEntityName(t, entity);
  return (
    <button
      type="button"
      onClick={() => onSelect(entity.entityId)}
      className="flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2 py-1 text-left transition-colors hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
    >
      <EntityAvatar name={name} kind={entity.kind} size={30} imageUrl={portraitFor(entity, portraits)} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[0.8125rem] font-semibold leading-5">{name}</span>
        <span className="block truncate text-[0.6875rem] leading-4 text-muted-foreground">{line}</span>
      </span>
      <ChevronRight size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
  );
}

function QuickLink({ icon, onClick, children }: { icon: ReactNode; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2 text-left font-medium text-foreground transition-colors hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
    >
      <span className="text-primary" aria-hidden="true">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <ChevronRight size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
  );
}

/** Participants and place of a timeline event as small portrait chips (portraits come from loaded people pages). */
export function TimelineEventPeople({
  item,
  onSelect,
  portraits,
  peopleById,
  max = 6,
}: {
  item: CampaignMemoryTimelineItem;
  onSelect: (id: string) => void;
  portraits: Map<string, string>;
  peopleById: Map<string, CampaignMemoryEntityListItem>;
  max?: number;
}) {
  const participants = item.participants.filter((participant) => participant.alias && !RAW_ID.test(participant.alias));
  const location = item.location && item.location.alias && !RAW_ID.test(item.location.alias) ? item.location : null;
  if (!location && participants.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {location && (
        <button
          type="button"
          onClick={() => onSelect(location.entityId)}
          className="inline-flex min-h-7 pointer-coarse:min-h-9 max-w-full items-center gap-1 rounded-full border border-border px-2 text-[0.6875rem] font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
        >
          <MapPin size={11} aria-hidden="true" />
          <span className="truncate">{location.alias}</span>
        </button>
      )}
      {participants.slice(0, max).map((participant) => {
        const known = peopleById.get(participant.entityId);
        return (
          <button
            key={participant.entityId}
            type="button"
            onClick={() => onSelect(participant.entityId)}
            className="inline-flex min-h-7 pointer-coarse:min-h-9 max-w-full items-center gap-1.5 rounded-full border border-border bg-secondary/40 py-0.5 pl-0.5 pr-2 text-[0.6875rem] font-medium text-foreground transition-colors hover:border-primary/50 hover:bg-secondary"
          >
            <EntityAvatar
              name={participant.alias}
              kind={known?.kind ?? "character"}
              size={20}
              imageUrl={known ? portraitFor(known, portraits) : null}
            />
            <span className="truncate">{participant.alias}</span>
          </button>
        );
      })}
      {participants.length > max && (
        <span className="text-[0.6875rem] text-muted-foreground">+{participants.length - max}</span>
      )}
    </div>
  );
}

function LatestEvents({
  chatId,
  onSelect,
  portraits,
  people,
}: {
  chatId: string;
  onSelect: (id: string) => void;
  portraits: Map<string, string>;
  people: CampaignMemoryEntityListItem[] | undefined;
}) {
  const { t, i18n } = useUiTranslation();
  const latest = useLatestTimeline(chatId);
  const peopleById = useMemo(() => new Map((people ?? []).map((entity) => [entity.entityId, entity])), [people]);
  if (latest.isLoading) return <WikiSkeleton rows={3} />;
  if (latest.isError) return <ErrorState onRetry={() => void latest.refetch()} />;
  const items = latest.data?.items ?? [];
  if (!items.length)
    return (
      <p className="rounded-xl border border-dashed border-border px-4 py-5 text-center text-xs text-muted-foreground">
        {t("ui.game.campaignWiki.timelineEmpty")}
      </p>
    );
  return (
    <>
      <ol className="divide-y divide-border overflow-hidden rounded-xl border border-border" data-campaign-wiki-latest>
        {items.map((item) => {
          const session = recordOrigin(item).sessionNumber;
          const when = item.campaignTime || formatCaptureOrder(item.occurrenceOrder, i18n.language);
          return (
            <li
              key={item.eventId}
              className="space-y-2 bg-[color-mix(in_srgb,var(--background)_82%,var(--secondary))] px-3.5 py-3"
            >
              {(when || session !== null) && (
                <p className="flex flex-wrap items-center gap-x-2 text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
                  {session !== null && (
                    <span>
                      {t("ui.game.campaignWiki.evidence.session", {
                        defaultValue: "Session {{number}}",
                        number: session,
                      })}
                    </span>
                  )}
                  {session !== null && when && <span aria-hidden="true">·</span>}
                  {when && (
                    <span className="inline-flex items-center gap-1">
                      <CalendarClock size={11} aria-hidden="true" />
                      {when}
                    </span>
                  )}
                </p>
              )}
              <p className="line-clamp-4 text-sm leading-6 text-foreground">{eventSummary(t, item.summary)}</p>
              <TimelineEventPeople item={item} onSelect={onSelect} portraits={portraits} peopleById={peopleById} />
            </li>
          );
        })}
      </ol>
      {latest.data && !latest.data.complete && (
        <p className="mt-2 text-[0.6875rem] text-muted-foreground">
          {t("ui.game.campaignWiki.overview.latestPartial", {
            defaultValue:
              "The story is long; these are the latest events found so far. The full timeline has everything.",
          })}
        </p>
      )}
    </>
  );
}

function OpenPromises({
  chatId,
  onSelect,
  onShowAll,
}: {
  chatId: string;
  onSelect: (id: string) => void;
  onShowAll: () => void;
}) {
  const { t } = useUiTranslation();
  const commitments = useCampaignMemoryCommitments(chatId);
  const open = (commitments.data?.items ?? []).filter((item) => OPEN_COMMITMENT_STATES.has(item.state));
  const title = t("ui.game.campaignWiki.infobox.openPromises", { defaultValue: "Open promises" });
  return (
    <section data-campaign-wiki-overview-promises aria-label={title}>
      <WikiSectionHeader
        title={title}
        count={commitments.data ? open.length : undefined}
        action={
          <LinkButton onClick={onShowAll}>
            {t("ui.game.campaignWiki.reader.seeAll", { defaultValue: "See all" })}
            <ArrowRight size={12} aria-hidden="true" />
          </LinkButton>
        }
      />
      {commitments.isLoading && <WikiSkeleton rows={2} />}
      {commitments.isError && <ErrorState onRetry={() => void commitments.refetch()} />}
      {commitments.data && open.length === 0 && (
        <p className="text-xs text-muted-foreground">
          {t("ui.game.campaignWiki.overview.noOpenPromises", { defaultValue: "Nothing is waiting to be kept." })}
        </p>
      )}
      {open.length > 0 && (
        <ul className="space-y-2">
          {open.slice(0, 5).map((item) => (
            <PromiseRow key={item.commitmentId} item={item} onSelect={onSelect} />
          ))}
        </ul>
      )}
      {commitments.data && (open.length > 5 || commitments.data.nextCursor) && (
        <button
          type="button"
          onClick={onShowAll}
          className="mt-2 inline-flex min-h-8 pointer-coarse:min-h-9 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          {t("ui.game.campaignWiki.infobox.seeAllPromises", { defaultValue: "See all promises and quests" })}
        </button>
      )}
    </section>
  );
}

function PromiseRow({ item, onSelect }: { item: CampaignMemoryCommitmentItem; onSelect: (id: string) => void }) {
  const { t } = useUiTranslation();
  const people = item.participants.filter((participant) => participant.alias && !RAW_ID.test(participant.alias));
  return (
    <li className="rounded-xl border border-border bg-[color-mix(in_srgb,var(--background)_82%,var(--secondary))] px-3 py-2.5">
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-sm font-semibold leading-5 text-foreground">{item.title}</p>
        <WikiChip tone={item.state === "unresolved" ? "warning" : item.state === "proposed" ? "info" : "accent"}>
          {t(`ui.game.campaignWiki.commitments.state.${item.state}`)}
        </WikiChip>
      </div>
      <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[0.6875rem] text-muted-foreground">
        <span>{t(`ui.game.campaignWiki.commitments.kind.${item.kind}`)}</span>
        {item.deadline && (
          <>
            <span aria-hidden="true">·</span>
            <span>
              {t("ui.game.campaignWiki.commitments.due", { deadline: item.deadline, defaultValue: "Due {{deadline}}" })}
            </span>
          </>
        )}
        {people.slice(0, 3).map((participant) => (
          <span key={participant.entityId} className="inline-flex items-center gap-1.5">
            <span aria-hidden="true">·</span>
            <button
              type="button"
              onClick={() => onSelect(participant.entityId)}
              className={cn("min-h-6 rounded font-medium text-foreground/90 hover:text-primary")}
            >
              {participant.alias}
            </button>
          </span>
        ))}
      </p>
    </li>
  );
}
