import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, History, House, Loader2, PanelLeftClose, Search, X } from "lucide-react";
import type { CampaignMemoryEntityKind } from "@marinara-engine/shared";
import { useTranslation as useUiTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import {
  useCampaignMemoryEntities,
  type CampaignMemoryEntityListItem,
  type CampaignMemoryEntityListPage,
  type CampaignMemoryMatchTier,
} from "../../hooks/use-campaign-memory";
import {
  Pager,
  WikiErrorState as ErrorState,
  displayEntityName,
  enumLabel,
  kindLabel,
  kindSectionLabel,
  portraitFor,
} from "./CampaignWikiReaderParts";
import {
  ENTITY_KIND_ICONS,
  EntityAvatar,
  WikiSkeleton,
  entitySessionNumbers,
  formatSessionRanges,
} from "./campaign-wiki-ui";

/**
 * Left rail of the Campaign Wiki: search, compact kind chips and the page list. With no search and no kind picked
 * it groups pages by kind, people and places first, each section collapsible and growing on demand, so a thousand
 * imported lore entries never bury the cast.
 */

/** Section order of the grouped list (and tie-break order of search results). */
export const KIND_ORDER: CampaignMemoryEntityKind[] = [
  "character",
  "persona",
  "location",
  "organization",
  "item",
  "quest",
  "lore",
  "note",
];
const OPEN_BY_DEFAULT = new Set<CampaignMemoryEntityKind>(["character", "persona", "location"]);
const SECTION_FIRST = 8;
const SECTION_STEP = 24;
/** The list route answers at most 100 rows; past that "See all" switches to the paged kind list. */
const SECTION_MAX = 100;
const SECTIONS_STORAGE_KEY = "marinara.campaignWiki.railSections";

export type KindTotals = Partial<Record<CampaignMemoryEntityKind | "all", number>>;

/**
 * Entity totals per kind. Newer servers label every kind in one list response (`kindTotals`); older ones need one
 * tiny request per kind, which only runs while `fallback` is on.
 */
export function useKindTotals(chatId: string, served: CampaignMemoryEntityListPage | undefined): KindTotals {
  // Keep the last served totals while a new search or kind page loads, so chips and sections do not flicker.
  const [lastServed, setLastServed] = useState(served?.kindTotals);
  if (served?.kindTotals && served.kindTotals !== lastServed) setLastServed(served.kindTotals);
  const servedTotals = served?.kindTotals ?? lastServed;
  const fallback = Boolean(served) && !served?.kindTotals;
  const options = (kind: CampaignMemoryEntityKind) => ({ kind, limit: 1, enabled: fallback });
  const character = useCampaignMemoryEntities(chatId, options("character"));
  const location = useCampaignMemoryEntities(chatId, options("location"));
  const organization = useCampaignMemoryEntities(chatId, options("organization"));
  const item = useCampaignMemoryEntities(chatId, options("item"));
  const quest = useCampaignMemoryEntities(chatId, options("quest"));
  const lore = useCampaignMemoryEntities(chatId, options("lore"));
  const persona = useCampaignMemoryEntities(chatId, options("persona"));
  const note = useCampaignMemoryEntities(chatId, options("note"));
  if (servedTotals) {
    const totals: KindTotals = { ...servedTotals };
    for (const kind of KIND_ORDER) totals[kind] ??= 0;
    totals.all = KIND_ORDER.reduce((sum, kind) => sum + (servedTotals[kind] ?? 0), 0);
    return totals;
  }
  return {
    all: undefined,
    character: character.data?.total,
    location: location.data?.total,
    organization: organization.data?.total,
    item: item.data?.total,
    quest: quest.data?.total,
    lore: lore.data?.total,
    persona: persona.data?.total,
    note: note.data?.total,
  };
}

function readOpenSections(): Partial<Record<CampaignMemoryEntityKind, boolean>> {
  try {
    const raw = window.localStorage.getItem(SECTIONS_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" ? (parsed as Partial<Record<CampaignMemoryEntityKind, boolean>>) : {};
  } catch {
    return {};
  }
}

function writeOpenSections(value: Partial<Record<CampaignMemoryEntityKind, boolean>>) {
  try {
    window.localStorage.setItem(SECTIONS_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Storage can be unavailable (private window); the rail still works for this visit.
  }
}

/** One page in the rail: portrait or initials, name, one muted line (kind · sessions). */
export function CampaignWikiEntityRow({
  entity,
  active,
  onSelect,
  portraits,
  sameNameCount,
}: {
  entity: CampaignMemoryEntityListItem;
  active: boolean;
  onSelect: (id: string) => void;
  portraits: Map<string, string>;
  /** Pages in this list sharing the name; shown as "N pages" on the collapsed row. */
  sameNameCount?: number;
}) {
  const { t } = useUiTranslation();
  const name = displayEntityName(t, entity);
  const sessions = entitySessionNumbers(entity);
  const meta = [
    kindLabel(t, entity.kind),
    sessions.length > 0 &&
      t("ui.game.campaignWiki.reader.sessions", {
        defaultValue: "Sessions {{list}}",
        list: formatSessionRanges(sessions),
      }),
    entity.status === "archived" && enumLabel(t, "recordStatus", "archived"),
    sameNameCount !== undefined &&
      sameNameCount > 1 &&
      t("ui.game.campaignWiki.rail.samePages", {
        defaultValue: "{{count}} pages",
        count: sameNameCount,
      }),
  ].filter(Boolean);
  const line = meta.join(" · ");
  return (
    <button
      type="button"
      onClick={() => onSelect(entity.entityId)}
      aria-current={active ? "page" : undefined}
      data-campaign-wiki-entity-row={entity.kind}
      className={cn(
        "flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2 py-1 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
        active ? "bg-primary/15 text-foreground" : "hover:bg-secondary/70",
        entity.status === "archived" && !active && "opacity-70",
      )}
    >
      <EntityAvatar name={name} kind={entity.kind} size={32} imageUrl={portraitFor(entity, portraits)} />
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-[0.8125rem] font-semibold leading-5", active && "text-primary")}>
          {name}
        </span>
        <span className="block truncate text-[0.6875rem] leading-4 text-muted-foreground">{line}</span>
      </span>
    </button>
  );
}

/** Pages of one kind with the same name, in first-seen order (imports often repeat a title many times). */
function clusterByName(
  items: CampaignMemoryEntityListItem[],
  nameOf: (entity: CampaignMemoryEntityListItem) => string,
): CampaignMemoryEntityListItem[][] {
  const byKey = new Map<string, CampaignMemoryEntityListItem[]>();
  for (const entity of items) {
    const key = `${entity.kind}|${nameOf(entity).trim().toLocaleLowerCase()}`;
    const list = byKey.get(key);
    if (list) list.push(entity);
    else byKey.set(key, [entity]);
  }
  return [...byKey.values()];
}

/** One row for many same-named pages; the toggle lists each page. */
function SameNameCluster({
  items,
  selectedId,
  onSelect,
  portraits,
}: {
  items: CampaignMemoryEntityListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  portraits: Map<string, string>;
}) {
  const { t } = useUiTranslation();
  const containsSelected = items.some((entity) => entity.entityId === selectedId);
  const [open, setOpen] = useState(containsSelected);
  const first = items[0]!;
  const label = t("ui.game.campaignWiki.rail.showSamePages", {
    defaultValue: "Show all {{count}} pages named {{name}}",
    count: items.length,
    name: displayEntityName(t, first),
  });
  return (
    <div data-campaign-wiki-same-name={items.length}>
      <div className="flex items-center gap-0.5">
        <div className="min-w-0 flex-1">
          <CampaignWikiEntityRow
            entity={first}
            active={selectedId === first.entityId}
            onSelect={onSelect}
            portraits={portraits}
            sameNameCount={items.length}
          />
        </div>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-label={label}
          title={label}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
        </button>
      </div>
      {open && (
        <div className="ml-5 space-y-px border-l border-border pl-1.5">
          {items.slice(1).map((entity) => (
            <CampaignWikiEntityRow
              key={entity.entityId}
              entity={entity}
              active={selectedId === entity.entityId}
              onSelect={onSelect}
              portraits={portraits}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RailRows({
  items,
  selectedId,
  onSelect,
  portraits,
}: {
  items: CampaignMemoryEntityListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  portraits: Map<string, string>;
}) {
  const { t } = useUiTranslation();
  return (
    <>
      {clusterByName(items, (entity) => displayEntityName(t, entity)).map((cluster) =>
        cluster.length === 1 ? (
          <CampaignWikiEntityRow
            key={cluster[0]!.entityId}
            entity={cluster[0]!}
            active={selectedId === cluster[0]!.entityId}
            onSelect={onSelect}
            portraits={portraits}
          />
        ) : (
          <SameNameCluster
            key={cluster[0]!.entityId}
            items={cluster}
            selectedId={selectedId}
            onSelect={onSelect}
            portraits={portraits}
          />
        ),
      )}
    </>
  );
}

function RailSection({
  chatId,
  kind,
  total,
  open,
  onToggle,
  selectedId,
  onSelect,
  onSeeAll,
  portraits,
}: {
  chatId: string;
  kind: CampaignMemoryEntityKind;
  total: number;
  open: boolean;
  onToggle: () => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onSeeAll: () => void;
  portraits: Map<string, string>;
}) {
  const { t } = useUiTranslation();
  const [limit, setLimit] = useState(SECTION_FIRST);
  const list = useCampaignMemoryEntities(chatId, { kind, limit, enabled: open });
  // Growing the section changes the query key; keep the rows already shown until the longer page arrives.
  const [kept, setKept] = useState<CampaignMemoryEntityListPage | null>(null);
  if (list.data && list.data !== kept) setKept(list.data);
  const page = list.data ?? kept;
  const items = page?.items ?? [];
  const Icon = ENTITY_KIND_ICONS[kind];
  const title = kindSectionLabel(t, kind);
  const canGrow = total > items.length && limit < SECTION_MAX;
  return (
    <section data-campaign-wiki-rail-section={kind} aria-label={title}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="sticky top-0 z-[1] flex min-h-9 w-full items-center gap-2 rounded-lg bg-background px-2 text-left text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
      >
        {open ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
        <Icon size={13} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <span className="rounded-full bg-secondary px-1.5 py-px text-[0.625rem] pointer-coarse:text-[0.6875rem] tabular-nums">
          {total.toLocaleString()}
        </span>
      </button>
      {open && (
        <div className="space-y-px pb-2">
          {list.isLoading && !page && <WikiSkeleton rows={3} className="px-1 [&>div]:h-10" />}
          {list.isError && !page && <ErrorState onRetry={() => void list.refetch()} />}
          <RailRows items={items} selectedId={selectedId} onSelect={onSelect} portraits={portraits} />
          {total > items.length && page && (
            <div className="flex flex-wrap items-center gap-1 px-1 pt-0.5">
              {canGrow && (
                <button
                  type="button"
                  onClick={() => setLimit((current) => Math.min(SECTION_MAX, current + SECTION_STEP))}
                  disabled={list.isFetching}
                  className="inline-flex min-h-8 pointer-coarse:min-h-9 items-center gap-1.5 rounded-lg px-2 text-xs font-semibold text-primary hover:bg-secondary disabled:opacity-60"
                >
                  {list.isFetching && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
                  {t("ui.game.campaignWiki.rail.showMore", {
                    defaultValue: "Show {{count}} more",
                    count: Math.min(SECTION_STEP, total - items.length),
                  })}
                </button>
              )}
              <button
                type="button"
                onClick={onSeeAll}
                className="ml-auto inline-flex min-h-8 pointer-coarse:min-h-9 items-center rounded-lg px-2 text-xs font-semibold text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                {t("ui.game.campaignWiki.rail.seeAllKind", {
                  defaultValue: "See all {{formattedCount}}",
                  formattedCount: total.toLocaleString(),
                })}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export interface CampaignWikiRailProps {
  chatId: string;
  searchText: string;
  onSearchText: (value: string) => void;
  query: string;
  kind: CampaignMemoryEntityKind | "all";
  onKind: (kind: CampaignMemoryEntityKind | "all") => void;
  kindTotals: KindTotals;
  entities: {
    data: CampaignMemoryEntityListPage | undefined;
    isLoading: boolean;
    isError: boolean;
    refetch: () => unknown;
  };
  listGroups: Array<{ tier: CampaignMemoryMatchTier | null; items: CampaignMemoryEntityListItem[] }>;
  entityOffset: number;
  onEntityOffset: (offset: number) => void;
  pageSize: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  portraits: Map<string, string>;
  timelineActive: boolean;
  onShowTimeline: () => void;
  /** The front page is on screen (desktop) or open (phone). */
  homeActive: boolean;
  onShowHome: () => void;
  onCollapse: () => void;
  className?: string;
}

export function CampaignWikiRail({
  chatId,
  searchText,
  onSearchText,
  query,
  kind,
  onKind,
  kindTotals,
  entities,
  listGroups,
  entityOffset,
  onEntityOffset,
  pageSize,
  selectedId,
  onSelect,
  portraits,
  timelineActive,
  onShowTimeline,
  homeActive,
  onShowHome,
  onCollapse,
  className,
}: CampaignWikiRailProps) {
  const { t } = useUiTranslation();
  const [openSections, setOpenSections] = useState(readOpenSections);
  const grouped = kind === "all" && !query;
  const isOpen = (section: CampaignMemoryEntityKind) => openSections[section] ?? OPEN_BY_DEFAULT.has(section);
  const toggleSection = (section: CampaignMemoryEntityKind) => {
    const next = { ...openSections, [section]: !isOpen(section) };
    setOpenSections(next);
    writeOpenSections(next);
  };
  const sections = KIND_ORDER.filter((section) => (kindTotals[section] ?? 0) > 0);
  const totalsKnown = KIND_ORDER.every((section) => kindTotals[section] !== undefined);
  const allTotal =
    kindTotals.all ?? (totalsKnown ? KIND_ORDER.reduce((sum, k) => sum + (kindTotals[k] ?? 0), 0) : null);
  const flat = !grouped;
  const data = entities.data;

  let body: ReactNode;
  if (grouped) {
    body = (
      <>
        {!totalsKnown && entities.isLoading && <WikiSkeleton rows={6} className="[&>div]:h-10" />}
        {entities.isError && <ErrorState onRetry={() => void entities.refetch()} />}
        {totalsKnown && sections.length === 0 && !entities.isError && (
          <p className="px-1 py-6 text-center text-xs text-muted-foreground">{t("ui.game.campaignWiki.empty")}</p>
        )}
        {sections.map((section) => (
          <RailSection
            key={section}
            chatId={chatId}
            kind={section}
            total={kindTotals[section] ?? 0}
            open={isOpen(section)}
            onToggle={() => toggleSection(section)}
            selectedId={selectedId}
            onSelect={onSelect}
            onSeeAll={() => onKind(section)}
            portraits={portraits}
          />
        ))}
      </>
    );
  } else {
    body = (
      <>
        {entities.isLoading && (
          <div className="space-y-2">
            <p className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
              <Loader2 size={13} className="animate-spin" />
              {t("ui.game.campaignWiki.loading")}
            </p>
            <WikiSkeleton rows={6} className="[&>div]:h-10" />
          </div>
        )}
        {entities.isError && <ErrorState onRetry={() => void entities.refetch()} />}
        {!entities.isLoading && !entities.isError && data && data.items.length === 0 && (
          <p className="px-1 py-6 text-center text-xs text-muted-foreground">
            {query
              ? t("ui.game.campaignWiki.reader.noMatches", { defaultValue: "No pages match “{{query}}”.", query })
              : t("ui.game.campaignWiki.empty")}
          </p>
        )}
        {!entities.isLoading && data && data.items.length > 0 && (
          <p className="px-2 pb-1 pt-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
            {query
              ? t("ui.game.campaignWiki.rail.results", {
                  defaultValue: "{{formattedCount}} results",
                  count: data.total,
                  formattedCount: data.total.toLocaleString(),
                })
              : kind !== "all" && `${kindSectionLabel(t, kind)} · ${data.total.toLocaleString()}`}
          </p>
        )}
        {listGroups.map((group) => (
          <div key={group.tier ?? "all"} className="space-y-px">
            {group.tier && (
              <p className="px-2 pb-1 pt-3 text-[0.625rem] pointer-coarse:text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
                {t(`ui.game.campaignWiki.matchTier.${group.tier}`)}
              </p>
            )}
            <RailRows items={group.items} selectedId={selectedId} onSelect={onSelect} portraits={portraits} />
          </div>
        ))}
      </>
    );
  }

  return (
    <section className={cn("flex min-h-0 min-w-0 flex-col", className)} aria-label={t("ui.game.campaignWiki.entities")}>
      <div className="mb-2 flex items-center gap-2">
        <h3 className="flex min-w-0 flex-1 items-baseline gap-1.5 truncate text-sm font-bold">
          {t("ui.game.campaignWiki.rail.title", { defaultValue: "Pages" })}
          {allTotal !== null && (
            <span className="text-xs font-normal tabular-nums text-muted-foreground">{allTotal.toLocaleString()}</span>
          )}
        </h3>
        <button
          type="button"
          onClick={onShowHome}
          aria-pressed={homeActive}
          aria-label={t("ui.game.campaignWiki.rail.frontPage", { defaultValue: "Front page" })}
          title={t("ui.game.campaignWiki.rail.frontPage", { defaultValue: "Front page" })}
          className={cn(
            "inline-flex min-h-9 items-center gap-1 rounded-lg border px-2.5 text-xs font-semibold",
            homeActive
              ? "border-border hover:bg-secondary md:border-primary/60 md:bg-primary/15"
              : "border-border hover:bg-secondary",
          )}
        >
          <House size={13} aria-hidden="true" />
          <span className="md:hidden">{t("ui.game.campaignWiki.rail.frontPage", { defaultValue: "Front page" })}</span>
        </button>
        <button
          type="button"
          onClick={onShowTimeline}
          aria-pressed={timelineActive}
          title={t("ui.game.campaignWiki.campaignTimeline")}
          className={cn(
            "inline-flex min-h-9 items-center gap-1 rounded-lg border px-2.5 text-xs font-semibold",
            timelineActive ? "border-primary/60 bg-primary/15" : "border-border hover:bg-secondary",
          )}
        >
          <History size={13} />
          {t("ui.game.campaignWiki.timeline")}
        </button>
        <button
          type="button"
          onClick={onCollapse}
          aria-label={t("ui.game.campaignWiki.navCollapse")}
          title={t("ui.game.campaignWiki.navCollapse")}
          className="hidden min-h-9 min-w-9 items-center justify-center rounded-lg border border-border px-2 text-muted-foreground hover:bg-secondary md:inline-flex"
        >
          <PanelLeftClose size={14} />
        </button>
      </div>
      <label className="relative block">
        <Search
          size={14}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <input
          value={searchText}
          onChange={(event) => onSearchText(event.target.value)}
          placeholder={t("ui.game.campaignWiki.rail.search", { defaultValue: "Search people, places, lore" })}
          aria-label={t("ui.game.campaignWiki.rail.search", { defaultValue: "Search people, places, lore" })}
          className="min-h-10 w-full rounded-lg border border-border bg-background py-2 pl-9 pr-9 text-sm outline-none transition-colors focus:border-primary"
        />
        {searchText && (
          <button
            type="button"
            onClick={() => onSearchText("")}
            aria-label={t("ui.game.campaignWiki.reader.clearSearch", { defaultValue: "Clear search" })}
            className="absolute right-1.5 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary"
          >
            <X size={13} />
          </button>
        )}
      </label>
      <div className="mt-2 flex flex-wrap gap-1 pb-1" role="group" aria-label={t("ui.game.campaignWiki.filterByKind")}>
        {(["all", ...KIND_ORDER] as const)
          .filter((item) => item === "all" || item === kind || kindTotals[item] !== 0)
          .map((item) => {
            const Icon = item === "all" ? null : ENTITY_KIND_ICONS[item];
            const total = item === "all" ? allTotal : kindTotals[item];
            return (
              <button
                type="button"
                key={item}
                onClick={() => onKind(item)}
                aria-pressed={kind === item}
                className={cn(
                  "inline-flex min-h-8 pointer-coarse:min-h-9 pointer-coarse:min-w-9 shrink-0 justify-center items-center gap-1 rounded-full border px-2 text-[0.6875rem] font-semibold transition-colors",
                  kind === item
                    ? "border-primary/60 bg-primary/15 text-foreground"
                    : "border-border text-muted-foreground hover:bg-secondary hover:text-foreground",
                )}
              >
                {Icon && <Icon size={11} aria-hidden="true" />}
                {kindLabel(t, item)}
                {typeof total === "number" && (
                  <span className="font-normal tabular-nums opacity-75">{total.toLocaleString()}</span>
                )}
              </button>
            );
          })}
      </div>
      <div
        className="-mr-1 mt-1 min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-1 [scrollbar-width:thin]"
        data-campaign-wiki-entity-list
        data-campaign-wiki-list-mode={grouped ? "grouped" : query ? "search" : "kind"}
      >
        {body}
      </div>
      {flat && data && data.total > data.items.length && (
        <Pager
          offset={entityOffset}
          limit={data.limit || pageSize}
          total={data.total}
          shown={data.items.length}
          onChange={onEntityOffset}
        />
      )}
    </section>
  );
}
