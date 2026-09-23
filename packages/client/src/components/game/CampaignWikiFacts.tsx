import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Ban,
  ChevronDown,
  Loader2,
  MessageSquareQuote,
  PenLine,
  Pin,
  PinOff,
  ScrollText,
  Search,
  X,
} from "lucide-react";
import type {
  CampaignMemoryEntity,
  CampaignMemoryEntityDetail,
  CampaignMemoryEpistemicState,
  CampaignMemoryFact,
  CampaignMemoryJson,
} from "@marinara-engine/shared";
import { useTranslation as useUiTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import { wikiValueRecord } from "../../lib/campaign-wiki-value";
import {
  useCampaignMemoryEntityFacts,
  useUpdateCampaignMemoryFact,
  type CampaignMemoryEntityDetailWithSessions,
  type CampaignMemoryFactChanges,
  type CampaignMemoryFactFilters,
  type CampaignMemoryFactWithCoHolders,
} from "../../hooks/use-campaign-memory";
import { CampaignWikiEvidence } from "./CampaignWikiEvidence";
import {
  EntityChipButton,
  FactLabelBadge,
  RAW_ID,
  WhenChip,
  WikiErrorState,
  enumLabel,
  type FactLabel,
  type TFn,
} from "./CampaignWikiReaderParts";
import {
  WikiChip,
  WikiEmpty,
  crossSessionReferenceDetail,
  crossSessionReferenceText,
  factDisplay,
  factKindTone,
  isWikiRevisionConflict,
  recordOrigin,
  recordWriteChatId,
  type FactDisplay,
  type WikiTone,
} from "./campaign-wiki-ui";

type Fact = CampaignMemoryFactWithCoHolders;
type SourceChecks = NonNullable<CampaignMemoryEntityDetail["sourceChecks"]>;
type Freshness = SourceChecks[string]["state"];

/** Server maximum per page. */
const FACT_PAGE_SIZE = 100;
/** Without server filters every fact is loaded (then filtered here) up to this many. */
const LEGACY_AUTOLOAD_LIMIT = 2000;
const SEARCH_DEBOUNCE_MS = 300;
/** Kind chips shown inline; rarer kinds go into a "More kinds" menu. */
const KIND_CHIPS = 5;
const NO_SESSION = "none";
/** `factQuery` is a substring over the JSON value, so this finds pinned facts on any session. */
const PINNED_QUERY = '"pinned":true';

const DOT_TONE: Record<WikiTone, string> = {
  neutral: "bg-muted-foreground/45",
  accent: "bg-primary",
  success: "bg-emerald-400",
  warning: "bg-amber-400",
  danger: "bg-destructive",
  info: "bg-sky-400",
};

function operationId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `campaign-wiki-fact-${Date.now()}`;
}

/** Same kind the server filters on: the continuity value.kind, otherwise the predicate without "continuity.". */
export function factKindOf(fact: Pick<CampaignMemoryFact, "predicate" | "value">): string {
  const record = wikiValueRecord(fact.value);
  if (record && typeof record.kind === "string" && record.kind) return record.kind;
  return fact.predicate.replace(/^continuity\./u, "") || "other";
}

/** Pinned canon: locked by hand AND flagged `pinned` in its value. */
export function isPinnedFact(fact: Pick<CampaignMemoryFact, "manualLock" | "status" | "value">) {
  if (fact.status === "retracted" || fact.status === "superseded") return false;
  return fact.manualLock && wikiValueRecord(fact.value)?.pinned === true;
}

/** A value object that can carry the `pinned` flag (plain values cannot be pinned without changing their meaning). */
function pinnableValue(value: CampaignMemoryJson): Record<string, CampaignMemoryJson> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function newestFirst(left: Fact, right: Fact) {
  return (
    (right.validFromOrder ?? "").localeCompare(left.validFromOrder ?? "") ||
    right.createdAt.localeCompare(left.createdAt)
  );
}

function sessionKey(fact: Fact) {
  const session = recordOrigin(fact).sessionNumber;
  return session === null ? NO_SESSION : String(session);
}

function sessionOrder(left: string, right: string) {
  return left === NO_SESSION ? 1 : right === NO_SESSION ? -1 : Number(right) - Number(left);
}

function matchesQuery(fact: Fact, display: FactDisplay, query: string) {
  if (!query) return true;
  const haystack = [
    fact.predicate,
    JSON.stringify(fact.value),
    display.text,
    display.label ?? "",
    ...display.conditions,
    ...fact.evidence.map((item) => item.quote),
  ]
    .join("\n")
    .toLocaleLowerCase();
  return haystack.includes(query.toLocaleLowerCase());
}

/** Successive fact pages for one filter set, flattened (deduplicated) with their source checks merged. */
function useFactList(
  chatId: string,
  entityId: string,
  filters: CampaignMemoryFactFilters,
  options: { enabled: boolean; seed?: CampaignMemoryEntityDetail; autoload?: number },
) {
  const query = useCampaignMemoryEntityFacts(chatId, entityId, {
    ...filters,
    limit: FACT_PAGE_SIZE,
    enabled: options.enabled,
    initialPage: options.enabled ? options.seed : undefined,
  });
  const pages = query.data?.pages;
  const facts = useMemo(() => {
    const seen = new Set<string>();
    const result: Fact[] = [];
    for (const page of pages ?? [])
      for (const fact of page.facts.items as Fact[])
        if (!seen.has(fact.factId)) {
          seen.add(fact.factId);
          result.push(fact);
        }
    return result;
  }, [pages]);
  const checks = useMemo(() => {
    const merged: SourceChecks = {};
    for (const page of pages ?? []) Object.assign(merged, page.sourceChecks ?? {});
    return merged;
  }, [pages]);
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = query;
  // fetchNextPage ignores `enabled`, so a disabled list must never page on its own.
  const autoload = options.enabled ? (options.autoload ?? 0) : 0;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isFetchNextPageError && facts.length < autoload) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, facts.length, autoload, fetchNextPage]);
  return {
    facts,
    checks,
    total: pages?.[0]?.facts.total ?? 0,
    loading: query.isLoading,
    error: query.isError && !isFetchNextPageError,
    hasMore: Boolean(hasNextPage),
    loadingMore: isFetchingNextPage,
    loadMoreError: isFetchNextPageError,
    loadMore: () => void fetchNextPage(),
    retry: () => void query.refetch(),
  };
}

export interface CampaignWikiFactsProps {
  chatId: string;
  entity: CampaignMemoryEntity;
  /** The loaded detail page; its facts seed the unfiltered list when it is the first page. */
  detail: CampaignMemoryEntityDetailWithSessions;
  labelFor: (fact: Fact, freshness: Freshness | undefined, peers: readonly Fact[]) => FactLabel;
  holderStateFor: (fact: Fact) => CampaignMemoryEpistemicState | undefined;
  perspectiveActive: boolean;
  related: Map<string, Pick<CampaignMemoryEntity, "entityId" | "kind" | "owner">>;
  portraits: Map<string, string>;
  onSelect: (id: string) => void;
  onCorrect: (fact: Fact) => void;
}

type RowProps = CampaignWikiFactsProps & {
  expanded: string | null;
  setExpanded: (id: string | null) => void;
};

/**
 * The article body of a wiki page: pinned canon, a search / kind / session toolbar and the facts as compact rows
 * grouped by the session that recorded them (newest first). Rows expand in place to show the story quotes and the
 * fact actions. With a server that reports `factSessions`, each session group loads its own facts when opened and
 * search / kind filters run on the server; older servers get everything loaded and filtered here.
 */
export function CampaignWikiFacts(props: CampaignWikiFactsProps) {
  const { chatId, entity, detail } = props;
  const { t } = useUiTranslation();
  const [searchText, setSearchText] = useState("");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const [session, setSession] = useState("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(searchText.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchText]);
  const serverSessions = Array.isArray(detail.factSessions) ? detail.factSessions : null;
  const serverKinds = Array.isArray(detail.factKinds) ? detail.factKinds : null;
  const server = serverSessions !== null;
  const filterActive = Boolean(query) || kind !== "all" || session !== "all";
  const total = detail.facts.total;
  const seed = detail.facts.offset === 0 ? detail : undefined;

  // Older servers: one unfiltered list, loaded in full and filtered / grouped here.
  const legacy = useFactList(chatId, entity.entityId, {}, { enabled: !server, seed, autoload: LEGACY_AUTOLOAD_LIMIT });
  // Newer servers: filters run on the server; pinned facts come from their own query.
  const filters: CampaignMemoryFactFilters = {
    ...(query ? { factQuery: query } : {}),
    ...(kind !== "all" ? { factKind: kind } : {}),
    ...(session !== "all" && session !== NO_SESSION ? { session: Number(session) } : {}),
  };
  const filtered = useFactList(chatId, entity.entityId, filters, { enabled: server && filterActive });
  const pinnedList = useFactList(chatId, entity.entityId, { factQuery: PINNED_QUERY }, { enabled: server });

  const kinds = useMemo(() => {
    if (serverKinds) return serverKinds.map((row) => [row.kind, row.total] as [string, number]);
    const counts = new Map<string, number>();
    for (const fact of legacy.facts) counts.set(factKindOf(fact), (counts.get(factKindOf(fact)) ?? 0) + 1);
    return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  }, [serverKinds, legacy.facts]);
  const chipKinds = kinds.filter(([item], index) => index < KIND_CHIPS || item === kind);
  const moreKinds = kinds.filter(([item], index) => index >= KIND_CHIPS && item !== kind);
  const sessionKeys = useMemo(() => {
    if (serverSessions)
      return serverSessions.map((row) => (row.sessionNumber === null ? NO_SESSION : String(row.sessionNumber)));
    return [...new Set(legacy.facts.map(sessionKey))].sort(sessionOrder);
  }, [serverSessions, legacy.facts]);
  const legacyMatches = useMemo(
    () =>
      server
        ? []
        : legacy.facts.filter((fact) => {
            if (kind !== "all" && factKindOf(fact) !== kind) return false;
            if (session !== "all" && sessionKey(fact) !== session) return false;
            return matchesQuery(fact, factDisplay(fact), query);
          }),
    [server, legacy.facts, kind, session, query],
  );
  const pinned = useMemo(
    () => (server ? pinnedList.facts : legacy.facts).filter(isPinnedFact).sort(newestFirst),
    [server, pinnedList.facts, legacy.facts],
  );
  const pinnedChecks = server ? pinnedList.checks : legacy.checks;
  const rowProps: RowProps = { ...props, expanded, setExpanded };
  const sessionLabel = (key: string) =>
    key === NO_SESSION
      ? t("ui.game.campaignWiki.facts.earlier", { defaultValue: "Earlier" })
      : t("ui.game.campaignWiki.evidence.session", { defaultValue: "Session {{number}}", number: Number(key) });

  return (
    <section
      className="min-w-0 space-y-4"
      aria-label={t("ui.game.campaignWiki.facts")}
      data-component="campaign-wiki-facts"
    >
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative order-1 block min-w-0 flex-1 basis-64">
          <Search
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            placeholder={t("ui.game.campaignWiki.facts.search", {
              defaultValue: "Search {{formattedCount}} facts",
              count: total,
              formattedCount: total.toLocaleString(),
            })}
            aria-label={t("ui.game.campaignWiki.facts.searchLabel", { defaultValue: "Search the facts on this page" })}
            className="min-h-10 w-full rounded-lg border border-border bg-background py-2 pl-9 pr-9 text-sm outline-none transition-colors focus:border-primary"
          />
          {searchText && (
            <button
              type="button"
              onClick={() => setSearchText("")}
              aria-label={t("ui.game.campaignWiki.reader.clearSearch", { defaultValue: "Clear search" })}
              className="absolute right-1 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary"
            >
              <X size={13} />
            </button>
          )}
        </label>
        <div className="contents">
          <div
            className="order-3 flex min-w-0 basis-full flex-wrap gap-1"
            role="group"
            aria-label={t("ui.game.campaignWiki.facts.filterKind", { defaultValue: "Filter facts by kind" })}
          >
            {[["all", total] as [string, number], ...chipKinds].map(([item, count]) => (
              <button
                type="button"
                key={item}
                onClick={() => setKind(item)}
                aria-pressed={kind === item}
                className={cn(
                  "inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-semibold transition-colors",
                  kind === item
                    ? "border-primary/60 bg-primary/15 text-foreground"
                    : "border-border text-muted-foreground hover:bg-secondary hover:text-foreground",
                )}
              >
                {item !== "all" && (
                  <span className={cn("h-1.5 w-1.5 rounded-full", DOT_TONE[factKindTone(item)])} aria-hidden="true" />
                )}
                {item === "all"
                  ? t("ui.game.campaignWiki.facts.allKinds", { defaultValue: "All" })
                  : enumLabel(t as TFn, "factKind", item)}
                <span className="font-normal tabular-nums text-muted-foreground">{count.toLocaleString()}</span>
              </button>
            ))}
          </div>
          {(moreKinds.length > 0 || sessionKeys.length > 1) && (
            <div className="order-2 flex shrink-0 items-center gap-2">
              {moreKinds.length > 0 && (
                <select
                  value={moreKinds.some(([item]) => item === kind) ? kind : ""}
                  onChange={(event) => event.target.value && setKind(event.target.value)}
                  aria-label={t("ui.game.campaignWiki.facts.moreKinds", { defaultValue: "More kinds" })}
                  className="min-h-8 w-28 rounded-lg border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary"
                >
                  <option value="">{t("ui.game.campaignWiki.facts.moreKinds", { defaultValue: "More kinds" })}</option>
                  {moreKinds.map(([item, count]) => (
                    <option key={item} value={item}>
                      {[enumLabel(t as TFn, "factKind", item), count.toLocaleString()].join(" · ")}
                    </option>
                  ))}
                </select>
              )}
              {sessionKeys.length > 1 && (
                <select
                  value={session}
                  onChange={(event) => setSession(event.target.value)}
                  aria-label={t("ui.game.campaignWiki.facts.sessionFilter", { defaultValue: "Show one session" })}
                  className="min-h-8 w-28 rounded-lg border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary"
                >
                  <option value="all">
                    {t("ui.game.campaignWiki.facts.allSessions", { defaultValue: "All sessions" })}
                  </option>
                  {sessionKeys.map((key) => (
                    <option key={key} value={key}>
                      {sessionLabel(key)}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
        </div>
      </div>

      {!filterActive && pinned.length > 0 && (
        <section
          aria-label={t("ui.game.campaignWiki.facts.pinned", { defaultValue: "Pinned canon" })}
          data-component="campaign-wiki-pinned"
          className="rounded-xl border border-primary/35 bg-primary/[0.06] px-1.5 pb-1.5 pt-2.5"
        >
          <h4 className="flex flex-wrap items-baseline gap-x-2 px-2 text-xs font-bold uppercase tracking-wide text-foreground">
            <span className="inline-flex items-center gap-1.5">
              <Pin size={12} className="text-primary" aria-hidden="true" />
              {t("ui.game.campaignWiki.facts.pinned", { defaultValue: "Pinned canon" })}
            </span>
            <span className="text-[0.6875rem] font-normal normal-case tracking-normal text-muted-foreground">
              {t("ui.game.campaignWiki.facts.pinnedHint", { defaultValue: "Always kept, never changed automatically" })}
            </span>
          </h4>
          <FactRows {...rowProps} facts={pinned} checks={pinnedChecks} scope="pinned" />
        </section>
      )}

      {server && !filterActive && serverSessions && (
        <div className="space-y-1.5">
          {serverSessions.length === 0 && <NoFacts />}
          {serverSessions.map((row, index) => (
            <SessionGroup
              key={row.sessionNumber ?? NO_SESSION}
              {...rowProps}
              sessionNumber={row.sessionNumber}
              total={row.total}
              label={sessionLabel(row.sessionNumber === null ? NO_SESSION : String(row.sessionNumber))}
              defaultOpen={index === 0}
              flat={serverSessions.length === 1 && row.sessionNumber === null}
              seed={row.sessionNumber === null && serverSessions.length === 1 ? seed : undefined}
            />
          ))}
        </div>
      )}

      {server && filterActive && (
        <LoadedGroups
          {...rowProps}
          facts={
            session === NO_SESSION ? filtered.facts.filter((fact) => sessionKey(fact) === NO_SESSION) : filtered.facts
          }
          checks={filtered.checks}
          total={filtered.total}
          allOpen
          loading={filtered.loading}
          error={filtered.error}
          onRetry={filtered.retry}
          footer={<LoadMore list={filtered} matching />}
          sessionLabel={sessionLabel}
        />
      )}

      {!server && (
        <LoadedGroups
          {...rowProps}
          facts={legacyMatches}
          checks={legacy.checks}
          total={filterActive ? legacyMatches.length : legacy.total}
          allOpen={filterActive}
          loading={legacy.loading && legacy.facts.length === 0}
          error={legacy.error}
          onRetry={legacy.retry}
          footer={<LoadMore list={legacy} />}
          sessionLabel={sessionLabel}
          unfilteredCount={legacy.facts.length}
        />
      )}
    </section>
  );
}

function NoFacts() {
  const { t } = useUiTranslation();
  return (
    <WikiEmpty
      icon={<ScrollText size={22} />}
      title={t("ui.game.campaignWiki.reader.noFactsTitle", { defaultValue: "Nothing recorded yet" })}
      hint={t("ui.game.campaignWiki.reader.noFactsHint", {
        defaultValue: "Facts appear here once the story mentions this page and the memory review accepts them.",
      })}
    />
  );
}

function LoadMore({ list, matching }: { list: ReturnType<typeof useFactList>; matching?: boolean }) {
  const { t } = useUiTranslation();
  if (!list.hasMore && !list.loadingMore && !list.loadMoreError) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-2 pt-2">
      <p className="text-xs text-muted-foreground" data-component="campaign-wiki-facts-loaded">
        {matching
          ? t("ui.game.campaignWiki.facts.loadedMatching", {
              defaultValue: "Showing {{loaded}} of {{total}} matching facts",
              loaded: list.facts.length.toLocaleString(),
              total: list.total.toLocaleString(),
            })
          : t("ui.game.campaignWiki.facts.loaded", {
              defaultValue: "Showing {{loaded}} of {{total}} facts",
              loaded: list.facts.length.toLocaleString(),
              total: list.total.toLocaleString(),
            })}
      </p>
      {list.loadMoreError ? (
        <WikiErrorState onRetry={list.loadMore} />
      ) : list.loadingMore ? (
        <span className="inline-flex min-h-9 items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 size={13} className="animate-spin" aria-hidden="true" />
          {t("ui.game.campaignWiki.facts.loadingMore", { defaultValue: "Loading more facts" })}
        </span>
      ) : (
        <button
          type="button"
          onClick={list.loadMore}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-semibold hover:border-primary/50 hover:bg-secondary"
        >
          {t("ui.game.campaignWiki.facts.loadMore", { defaultValue: "Load more facts" })}
        </button>
      )}
    </div>
  );
}

function GroupHeader({
  label,
  count,
  open,
  onToggle,
}: {
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useUiTranslation();
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className="sticky top-0 z-[1] flex min-h-10 w-full items-center gap-2 rounded-lg bg-[color-mix(in_srgb,var(--background)_90%,var(--secondary))] px-2.5 text-left transition-colors hover:bg-secondary"
    >
      <ChevronDown
        size={14}
        aria-hidden="true"
        className={cn("shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")}
      />
      <span className="text-sm font-bold text-foreground">{label}</span>
      <span className="text-xs text-muted-foreground">
        {t("ui.game.campaignWiki.facts.count", {
          defaultValue: "{{formattedCount}} facts",
          count,
          formattedCount: count.toLocaleString(),
        })}
      </span>
    </button>
  );
}

/** One session of a newer server: a header with the session's total; its facts load when it is opened. */
function SessionGroup({
  sessionNumber,
  total,
  label,
  defaultOpen,
  flat,
  seed,
  ...props
}: RowProps & {
  sessionNumber: number | null;
  total: number;
  label: string;
  defaultOpen: boolean;
  flat: boolean;
  seed?: CampaignMemoryEntityDetail;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const shown = flat || open;
  // Facts without a session cannot be asked for by number: read the unfiltered list and keep those here.
  const list = useFactList(
    props.chatId,
    props.entity.entityId,
    sessionNumber === null ? {} : { session: sessionNumber },
    { enabled: shown, seed, autoload: sessionNumber === null ? LEGACY_AUTOLOAD_LIMIT : 0 },
  );
  const facts = sessionNumber === null ? list.facts.filter((fact) => sessionKey(fact) === NO_SESSION) : list.facts;
  return (
    <section aria-label={flat ? undefined : label} data-component="campaign-wiki-session-group">
      {!flat && <GroupHeader label={label} count={total} open={open} onToggle={() => setOpen((current) => !current)} />}
      {shown && (
        <div className={cn(!flat && "mt-0.5")}>
          {list.loading && (
            <p className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
              <Loader2 size={13} className="animate-spin" aria-hidden="true" />
              {label}
            </p>
          )}
          {list.error && <WikiErrorState onRetry={list.retry} />}
          <FactRows {...props} facts={facts} checks={list.checks} scope={label} />
          <LoadMore list={list} />
        </div>
      )}
    </section>
  );
}

/** Already loaded facts grouped here by session (search results, or everything on an older server). */
function LoadedGroups({
  facts,
  checks,
  total,
  allOpen,
  loading,
  error,
  onRetry,
  footer,
  sessionLabel,
  unfilteredCount,
  ...props
}: RowProps & {
  facts: Fact[];
  checks: SourceChecks;
  total: number;
  allOpen: boolean;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  footer: ReactNode;
  sessionLabel: (key: string) => string;
  unfilteredCount?: number;
}) {
  const { t } = useUiTranslation();
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const groups = useMemo(() => {
    const byKey = new Map<string, Fact[]>();
    for (const fact of facts) {
      const key = sessionKey(fact);
      const list = byKey.get(key);
      if (list) list.push(fact);
      else byKey.set(key, [fact]);
    }
    return [...byKey.keys()].sort(sessionOrder).map((key) => ({ key, facts: byKey.get(key) ?? [] }));
  }, [facts]);
  const flat = groups.length === 1 && groups[0]?.key === NO_SESSION;
  if (loading) {
    return (
      <p className="flex items-center gap-2 px-1 py-3 text-xs text-muted-foreground">
        <Loader2 size={13} className="animate-spin" aria-hidden="true" />
        {t("ui.game.campaignWiki.loading")}
      </p>
    );
  }
  if (error) return <WikiErrorState onRetry={onRetry} />;
  if (facts.length === 0) {
    return unfilteredCount === 0 || (unfilteredCount === undefined && total === 0 && !allOpen) ? (
      <NoFacts />
    ) : (
      <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
        {t("ui.game.campaignWiki.facts.noMatches", { defaultValue: "No facts match these filters." })}
      </p>
    );
  }
  return (
    <div className="space-y-1.5">
      {groups.map((group, index) => {
        const open = flat || allOpen || (openGroups[group.key] ?? index === 0);
        return (
          <section key={group.key} aria-label={flat ? undefined : sessionLabel(group.key)}>
            {!flat && (
              <GroupHeader
                label={sessionLabel(group.key)}
                count={group.facts.filter((fact) => fact.status !== "retracted").length}
                open={open}
                onToggle={() => setOpenGroups((current) => ({ ...current, [group.key]: !open }))}
              />
            )}
            {open && (
              <div className={cn(!flat && "mt-0.5")}>
                <FactRows {...props} facts={group.facts} checks={checks} scope={group.key} />
              </div>
            )}
          </section>
        );
      })}
      {footer}
    </div>
  );
}

/** Live rows newest first, then the withdrawn ones behind a one-line disclosure. */
function FactRows({
  facts,
  checks,
  scope,
  ...props
}: RowProps & { facts: Fact[]; checks: SourceChecks; scope: string }) {
  const { t } = useUiTranslation();
  const [showWithdrawn, setShowWithdrawn] = useState(false);
  const visible = props.perspectiveActive ? facts.filter((fact) => props.holderStateFor(fact) !== undefined) : facts;
  const hidden = facts.length - visible.length;
  const sorted = visible.slice().sort(newestFirst);
  const live = sorted.filter((fact) => fact.status !== "retracted");
  const withdrawn = sorted.filter((fact) => fact.status === "retracted");
  const row = (fact: Fact, rowScope: string) => {
    const id = `${rowScope}:${fact.factId}`;
    return (
      <CampaignWikiFactRow
        key={id}
        {...props}
        fact={fact}
        label={props.labelFor(fact, checks[fact.factId]?.state, facts)}
        open={props.expanded === id}
        onToggle={() => props.setExpanded(props.expanded === id ? null : id)}
      />
    );
  };
  return (
    <>
      <ul>{live.map((fact) => row(fact, scope))}</ul>
      {hidden > 0 && (
        <p className="px-2.5 py-1 text-xs text-muted-foreground">
          {t("ui.game.campaignWiki.perspectiveHidden", { count: hidden })}
        </p>
      )}
      {withdrawn.length > 0 && (
        <div>
          <button
            type="button"
            aria-expanded={showWithdrawn}
            onClick={() => setShowWithdrawn((current) => !current)}
            className="ml-1 inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
          >
            <Ban size={12} aria-hidden="true" />
            {t("ui.game.campaignWiki.facts.withdrawn", {
              defaultValue: "{{count}} withdrawn",
              count: withdrawn.length,
            })}
            <ChevronDown
              size={12}
              aria-hidden="true"
              className={cn("transition-transform", showWithdrawn && "rotate-180")}
            />
          </button>
          {showWithdrawn && <ul className="opacity-75">{withdrawn.map((fact) => row(fact, `${scope}-withdrawn`))}</ul>}
        </div>
      )}
    </>
  );
}

function CampaignWikiFactRow({
  fact,
  label,
  open,
  onToggle,
  ...props
}: RowProps & { fact: Fact; label: FactLabel; open: boolean; onToggle: () => void }) {
  const { t } = useUiTranslation();
  const display = factDisplay(fact);
  const kind = factKindOf(fact);
  const holderState = props.perspectiveActive ? props.holderStateFor(fact) : undefined;
  const quotes = fact.evidence.length;
  const pinned = isPinnedFact(fact);
  const withdrawn = fact.status === "retracted";
  return (
    <li
      className={cn(
        "rounded-lg transition-colors",
        open ? "bg-secondary/55 ring-1 ring-border/70" : "hover:bg-secondary/30",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex min-h-10 w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
      >
        <span
          aria-hidden="true"
          title={enumLabel(t as TFn, "factKind", kind)}
          className={cn("mt-[0.55rem] h-2 w-2 shrink-0 rounded-full", DOT_TONE[factKindTone(kind)])}
        />
        <span
          className={cn(
            "min-w-0 flex-1 text-sm leading-6 text-foreground",
            withdrawn && "text-muted-foreground line-through decoration-muted-foreground/50",
          )}
        >
          {display.label && (
            <>
              <span className="font-semibold">{display.label}</span>
              <span className="text-muted-foreground">: </span>
            </>
          )}
          <span>{display.text}</span>
          {(label !== "verified" || holderState || display.conditions.length > 0) && (
            <span className="ml-1.5 inline-flex flex-wrap gap-1 align-[1px]">
              {label !== "verified" && <FactLabelBadge label={label} />}
              {holderState && <WikiChip tone="info">{enumLabel(t as TFn, "epistemicState", holderState)}</WikiChip>}
              {display.conditions.length > 0 && (
                <WikiChip tone="warning">
                  {t("ui.game.campaignWiki.reader.onlyIf", { defaultValue: "Only if" })}
                </WikiChip>
              )}
            </span>
          )}
        </span>
        <span className="mt-0.5 flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          {pinned && (
            <Pin
              size={12}
              className="text-primary"
              aria-label={t("ui.game.campaignWiki.facts.pinnedMark", { defaultValue: "Pinned" })}
            />
          )}
          {quotes > 0 && (
            <span
              className="inline-flex items-center gap-0.5 tabular-nums"
              title={t("ui.game.campaignWiki.facts.quotes", {
                defaultValue: "{{count}} quotes from the story",
                count: quotes,
              })}
            >
              <MessageSquareQuote size={13} aria-hidden="true" />
              {quotes}
            </span>
          )}
          <ChevronDown size={14} aria-hidden="true" className={cn("transition-transform", open && "rotate-180")} />
        </span>
      </button>
      {open && <FactDetails {...props} fact={fact} display={display} kind={kind} pinned={pinned} />}
    </li>
  );
}

function FactDetails({
  fact,
  display,
  kind,
  pinned,
  chatId,
  related,
  portraits,
  onSelect,
  onCorrect,
}: RowProps & { fact: Fact; display: FactDisplay; kind: string; pinned: boolean }) {
  const { t } = useUiTranslation();
  const queryClient = useQueryClient();
  const update = useUpdateCampaignMemoryFact(recordWriteChatId(fact, chatId));
  const [confirmWrong, setConfirmWrong] = useState(false);
  const [error, setError] = useState<"conflict" | "generic" | "crossSession" | null>(null);
  // The server's reason when the write names a record of another session that this fact's session lacks.
  const [crossSessionDetail, setCrossSessionDetail] = useState("");
  const coHolders = (fact.coHolders ?? []).filter((holder) => holder.alias && !RAW_ID.test(holder.alias));
  const withdrawn = fact.status === "retracted";
  const valueObject = pinnableValue(fact.value);
  const run = (changes: CampaignMemoryFactChanges, reason: string) => {
    setError(null);
    update.mutate(
      { fact, changes, reason, operationId: operationId() },
      {
        onSuccess: () => setConfirmWrong(false),
        onError: (failure) => {
          const detail = crossSessionReferenceDetail(failure);
          setCrossSessionDetail(detail ?? "");
          setError(detail !== null ? "crossSession" : isWikiRevisionConflict(failure) ? "conflict" : "generic");
        },
      },
    );
  };
  const pin = () => {
    if (!valueObject) return;
    // Remember an earlier hand lock so unpinning gives it back instead of unlocking.
    const value = { ...valueObject, pinned: true, ...(fact.manualLock ? { lockedBeforePin: true } : {}) };
    run(
      {
        value,
        manualLock: true,
        ...(fact.status === "proposed" || fact.status === "held" ? { status: "verified" as const } : {}),
      },
      "Pinned as canon in the Campaign Wiki",
    );
  };
  const unpin = () => {
    if (!valueObject) return;
    const { lockedBeforePin, ...rest } = valueObject;
    run({ value: { ...rest, pinned: false }, manualLock: lockedBeforePin === true }, "Unpinned in the Campaign Wiki");
  };
  const actionClass =
    "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border bg-background/40 px-2.5 text-xs font-semibold text-foreground transition-colors hover:border-primary/50 hover:bg-secondary disabled:opacity-50";
  const claim = display.claimStatus && display.claimStatus !== "asserted" && display.claimStatus !== "accepted";
  return (
    <div className="space-y-3 px-2.5 pb-3 pl-7" data-component="campaign-wiki-fact-details">
      <div className="flex flex-wrap items-center gap-1.5">
        <WikiChip tone={factKindTone(kind)}>{enumLabel(t as TFn, "factKind", kind)}</WikiChip>
        {claim && <WikiChip tone="neutral">{enumLabel(t as TFn, "claimStatus", display.claimStatus ?? "")}</WikiChip>}
        <WhenChip order={fact.validFromOrder} />
      </div>
      {display.conditions.length > 0 && (
        <div className="rounded-lg bg-amber-400/5 px-3 py-2">
          <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-amber-200/90">
            {t("ui.game.campaignWiki.reader.onlyIf", { defaultValue: "Only if" })}
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs leading-5 text-foreground/90">
            {display.conditions.map((condition, index) => (
              <li key={`${fact.factId}-condition-${index}`}>{condition}</li>
            ))}
          </ul>
        </div>
      )}
      {coHolders.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[0.6875rem] text-muted-foreground">{t("ui.game.campaignWiki.coHolders")}</span>
          {coHolders.map((holder) => (
            <EntityChipButton
              key={holder.entityId}
              entity={related.get(holder.entityId) ?? null}
              name={holder.alias}
              portraits={portraits}
              onClick={() => onSelect(holder.entityId)}
              suffix={
                holder.epistemicState !== "knows" ? (
                  <span className="text-muted-foreground">
                    ({enumLabel(t as TFn, "epistemicState", holder.epistemicState)})
                  </span>
                ) : undefined
              }
            />
          ))}
        </div>
      )}
      <CampaignWikiEvidence
        chatId={chatId}
        sourceChatId={recordOrigin(fact).chatId ?? chatId}
        evidence={fact.evidence}
        defaultOpen
        className="mt-0"
      />
      {confirmWrong ? (
        <div
          role="group"
          aria-label={t("ui.game.campaignWiki.facts.wrongConfirmLabel", { defaultValue: "Confirm marking as wrong" })}
          className="flex flex-wrap items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2"
        >
          <p className="min-w-0 flex-1 basis-48 text-xs text-foreground">
            {t("ui.game.campaignWiki.facts.wrongConfirm", {
              defaultValue: "Mark as wrong? The memory will stop using it.",
            })}
          </p>
          <button
            type="button"
            disabled={update.isPending}
            onClick={() => run({ status: "retracted", manualLock: true }, "Marked wrong in the Campaign Wiki")}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-destructive px-3 text-xs font-semibold text-white disabled:opacity-50"
          >
            {update.isPending && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
            {t("ui.game.campaignWiki.facts.wrongConfirmAction", { defaultValue: "Mark as wrong" })}
          </button>
          <button
            type="button"
            disabled={update.isPending}
            onClick={() => setConfirmWrong(false)}
            className="inline-flex min-h-9 items-center rounded-lg px-2.5 text-xs font-semibold text-muted-foreground hover:bg-secondary"
          >
            {t("ui.game.campaignWiki.facts.cancel", { defaultValue: "Cancel" })}
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          {!withdrawn &&
            valueObject &&
            (pinned ? (
              <button type="button" disabled={update.isPending} onClick={unpin} className={actionClass}>
                <PinOff size={13} aria-hidden="true" />
                {t("ui.game.campaignWiki.facts.unpin", { defaultValue: "Unpin" })}
              </button>
            ) : (
              <button type="button" disabled={update.isPending} onClick={pin} className={actionClass}>
                <Pin size={13} aria-hidden="true" />
                {t("ui.game.campaignWiki.facts.pin", { defaultValue: "Pin as canon" })}
              </button>
            ))}
          <button type="button" onClick={() => onCorrect(fact)} className={actionClass}>
            <PenLine size={13} aria-hidden="true" />
            {t("ui.game.campaignWiki.facts.correct", { defaultValue: "Correct" })}
          </button>
          {!withdrawn && (
            <button
              type="button"
              disabled={update.isPending}
              onClick={() => setConfirmWrong(true)}
              className={cn(actionClass, "text-destructive hover:border-destructive/50 hover:bg-destructive/10")}
            >
              <Ban size={13} aria-hidden="true" />
              {t("ui.game.campaignWiki.facts.wrong", { defaultValue: "Wrong" })}
            </button>
          )}
          {update.isPending && <Loader2 size={13} className="animate-spin text-muted-foreground" aria-hidden="true" />}
        </div>
      )}
      {error && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive">
          <span>
            {error === "crossSession"
              ? crossSessionReferenceText(t as TFn, crossSessionDetail)
              : error === "conflict"
                ? t("ui.game.campaignWiki.facts.conflict", {
                    defaultValue: "This fact changed since it was loaded. Reload the page and try again.",
                  })
                : t("ui.game.campaignWiki.facts.saveError", {
                    defaultValue: "The change could not be saved. Try again.",
                  })}
          </span>
          {error === "conflict" && (
            <button
              type="button"
              onClick={() => {
                setError(null);
                void queryClient.invalidateQueries({ queryKey: ["campaign-memory"] });
              }}
              className="inline-flex min-h-9 items-center rounded-lg border border-border px-2.5 font-semibold text-foreground hover:bg-secondary"
            >
              {t("ui.game.campaignWiki.facts.reload", { defaultValue: "Reload" })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
