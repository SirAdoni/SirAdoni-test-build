import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  BookMarked,
  CalendarClock,
  ChevronRight,
  Clock3,
  Database,
  Eye,
  History,
  Link2,
  Loader2,
  MapPin,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  RotateCw,
  ScrollText,
  Search,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import type {
  CampaignMemoryBacklink,
  CampaignMemoryEntity,
  CampaignMemoryEntityDetail,
  CampaignMemoryEntityKind,
  CampaignMemoryFact,
  CampaignMemoryJson,
  CampaignMemoryPage,
} from "@marinara-engine/shared";
import type { CampaignMemoryBranchHeldRecordType } from "@marinara-engine/shared";
import { useTranslation as useUiTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import { ApiError } from "../../lib/api-client";
import { wikiValueRecord, wikiValueSummary } from "../../lib/campaign-wiki-value";
import {
  useApplyCampaignMemoryImport,
  useCampaignMemoryEntities,
  useCampaignMemoryEntity,
  useCampaignMemoryTimeline,
  usePreviewCampaignMemoryImport,
  type CampaignMemoryCoHolder,
  type CampaignMemoryEntityListItem,
  type CampaignMemoryFactWithCoHolders,
  type CampaignMemoryImportPreview,
  type CampaignMemoryMatchTier,
  type CampaignMemoryTimelineItem,
} from "../../hooks/use-campaign-memory";
import { useCharacters } from "../../hooks/use-characters";
import { useChat } from "../../hooks/use-chats";
import type { CampaignWikiNavigationProps } from "./CampaignWikiWindow";
import { CampaignWikiEditor } from "./CampaignWikiEditor";
import { CampaignWikiOwnerLink } from "./CampaignWikiOwnerLink";
import { CampaignWikiEvidence } from "./CampaignWikiEvidence";
import { CampaignWikiCommitments } from "./CampaignWikiCommitments";
import {
  ENTITY_KIND_ICONS,
  EntityAvatar,
  WikiCard,
  WikiChip,
  WikiEmpty,
  WikiSectionHeader,
  WikiSkeleton,
  WikiStat,
  WikiTabs,
  entitySessionNumbers,
  factDisplay,
  factKindTone,
  formatCaptureOrder,
  formatSessionRanges,
  humanizeKey,
  recordOrigin,
  type WikiTone,
} from "./campaign-wiki-ui";

/**
 * Navigation props are optional: standalone the reader owns its selection; under
 * CampaignWikiWindow `selectedEntityId` drives the page and every page change
 * (list, related, co-holder, timeline, back) is reported through `onSelectedEntityChange`.
 */
interface CampaignWikiProps extends Partial<CampaignWikiNavigationProps> {
  chatId: string;
  onDirtyChange?: (dirty: boolean) => void;
}

type TFn = (key: string, options?: Record<string, unknown>) => string;

const KINDS: Array<CampaignMemoryEntityKind | "all"> = [
  "all",
  "character",
  "persona",
  "location",
  "organization",
  "item",
  "quest",
  "lore",
  "note",
];

const ENTITY_PAGE_SIZE = 40;

function enumLabel(t: TFn, group: string, value: string) {
  return t(`ui.game.campaignWiki.${group}.${value}`, { defaultValue: humanizeKey(value) });
}

function kindLabel(t: TFn, kind: CampaignMemoryEntityKind | "all") {
  return enumLabel(t, "kind", kind);
}

const RAW_ID = /^(cme_|cmf_|cmk_|cmev_|cmt_|legacy-|gcb_|gch_|gcr_)[\w-]+$/iu;
/** A stored value that is itself a wiki page id (current state often records a location this way). */
const ENTITY_ID = /^(cme_|legacy-)[0-9a-f]{16,}$/iu;

/** Event text for the reader; an id stored in place of a summary is never shown. */
function eventSummary(t: TFn, summary: string | null | undefined): string {
  const text = summary?.trim();
  return text && !RAW_ID.test(text) ? text : t("ui.game.campaignWiki.eventRecorded");
}

/** Name of a page that is not in the loaded detail; shows a neutral label until it arrives. */
function EntityRefName({ chatId, entityId }: { chatId: string; entityId: string }) {
  const { t } = useUiTranslation();
  const detail = useCampaignMemoryEntity(chatId, entityId, { limit: 1 });
  if (detail.data?.entity) return <>{displayEntityName(t, detail.data.entity)}</>;
  return <>{detail.isError ? t("ui.game.campaignWiki.reader.unknownPage", { defaultValue: "Unknown page" }) : "…"}</>;
}

function displayEntityName(t: TFn, entity: Pick<CampaignMemoryEntityListItem, "aliases" | "entityId" | "kind">) {
  const alias = entity.aliases.find((value) => value.trim() && !RAW_ID.test(value.trim()));
  return alias || t("ui.game.campaignWiki.untitledEntity", { kind: kindLabel(t, entity.kind) });
}

/** Readable text for any stored value, never raw JSON. */
function readableValue(value: CampaignMemoryJson | undefined): string {
  return wikiValueSummary(value);
}

type SourceFreshness = "current" | "stale" | "legacy" | "manual";
/** Reader vocabulary (plan): verified | pending | disputed | stale | legacy. Plain supersession keeps its own label. */
type FactLabel = "verified" | "pending" | "disputed" | "stale" | "legacy" | "superseded";

function factLabel(
  fact: CampaignMemoryFact,
  freshness: SourceFreshness | undefined,
  factsOnPage: readonly CampaignMemoryFact[],
): FactLabel {
  const conflicting =
    (fact.supersedesFactId !== undefined &&
      factsOnPage.some((other) => other.factId === fact.supersedesFactId && other.status !== "superseded")) ||
    (fact.status !== "superseded" && factsOnPage.some((other) => other.supersedesFactId === fact.factId));
  if (fact.status === "retracted" || conflicting) return "disputed";
  if (fact.status === "held" || fact.status === "proposed") return "pending";
  if (freshness === "stale") return "stale";
  if (freshness === "legacy" || fact.provenance.actor === "import") return "legacy";
  if (fact.status === "superseded") return "superseded";
  return "verified";
}

const STALE_LABEL: FactLabel = "stale";

const FACT_LABEL_TONE: Record<FactLabel, WikiTone> = {
  verified: "success",
  pending: "warning",
  disputed: "danger",
  stale: "danger",
  legacy: "neutral",
  superseded: "neutral",
};

function FactLabelBadge({ label }: { label: FactLabel }) {
  const { t } = useUiTranslation();
  return (
    <WikiChip tone={FACT_LABEL_TONE[label]} title={t(`ui.game.campaignWiki.factLabelHint.${label}`)}>
      {t(`ui.game.campaignWiki.factLabel.${label}`)}
    </WikiChip>
  );
}

function SessionChip({ record }: { record: unknown }) {
  const { t } = useUiTranslation();
  const origin = recordOrigin(record);
  if (origin.sessionNumber === null) return null;
  return (
    <WikiChip
      tone="neutral"
      title={t("ui.game.campaignWiki.reader.sessionHint", {
        defaultValue: "Recorded in session {{session}}",
        session: origin.sessionNumber,
      })}
    >
      {t("ui.game.campaignWiki.reader.sessionShort", { defaultValue: "S{{session}}", session: origin.sessionNumber })}
    </WikiChip>
  );
}

function WhenChip({ order }: { order: string | null | undefined }) {
  const { i18n } = useUiTranslation();
  const label = formatCaptureOrder(order, i18n.language);
  if (!label) return null;
  return (
    <span className="inline-flex items-center gap-1 text-[0.6875rem] text-muted-foreground">
      <Clock3 size={11} />
      {label}
    </span>
  );
}

/** Portraits for library characters, keyed by character id. */
function useCharacterPortraits(): Map<string, string> {
  const characters = useCharacters();
  return useMemo(() => {
    const result = new Map<string, string>();
    for (const row of (characters.data ?? []) as Array<{ id?: unknown; avatarPath?: unknown }>) {
      if (typeof row.id === "string" && typeof row.avatarPath === "string" && row.avatarPath.trim()) {
        result.set(row.id, row.avatarPath);
      }
    }
    return result;
  }, [characters.data]);
}

function portraitFor(entity: Pick<CampaignMemoryEntity, "owner">, portraits: Map<string, string>): string | null {
  if (entity.owner.type === "existing" && entity.owner.store === "characters") {
    return portraits.get(entity.owner.recordId) ?? null;
  }
  return null;
}

function EntityChipButton({
  entity,
  name,
  onClick,
  portraits,
  suffix,
}: {
  entity: Pick<CampaignMemoryEntity, "entityId" | "kind" | "owner"> | null;
  name: string;
  onClick: () => void;
  portraits: Map<string, string>;
  suffix?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-full border border-border bg-secondary/50 py-0.5 pl-0.5 pr-2.5 text-xs text-foreground transition-colors hover:border-primary/50 hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
    >
      <EntityAvatar
        name={name}
        kind={entity?.kind ?? "character"}
        size={24}
        imageUrl={entity ? portraitFor(entity, portraits) : null}
      />
      <span className="truncate">{name}</span>
      {suffix}
    </button>
  );
}

function Pager({
  offset,
  limit,
  total,
  shown,
  onChange,
}: {
  offset: number;
  limit: number;
  total: number;
  shown: number;
  onChange: (offset: number) => void;
}) {
  const { t } = useUiTranslation();
  if (total <= limit && offset === 0) return null;
  return (
    <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-3">
      <p className="text-xs text-muted-foreground">
        {t("ui.game.campaignWiki.reader.pageRange", {
          defaultValue: "{{from}}–{{to}} of {{total}}",
          from: total === 0 ? 0 : offset + 1,
          to: Math.min(offset + shown, total),
          total: total.toLocaleString(),
        })}
      </p>
      <div className="flex gap-1.5">
        <button
          type="button"
          disabled={offset === 0}
          onClick={() => onChange(Math.max(0, offset - limit))}
          className="min-h-9 rounded-lg border border-border px-3 text-xs font-semibold hover:bg-secondary disabled:opacity-40"
        >
          {t("ui.game.campaignWiki.previous")}
        </button>
        <button
          type="button"
          disabled={offset + shown >= total}
          onClick={() => onChange(offset + limit)}
          className="min-h-9 rounded-lg border border-border px-3 text-xs font-semibold hover:bg-secondary disabled:opacity-40"
        >
          {t("ui.game.campaignWiki.next")}
        </button>
      </div>
    </div>
  );
}

type DetailTab = "story" | "knowledge" | "events" | "connections" | "timeline" | "commitments" | "details";

function Detail({
  detail,
  chatId,
  onSelect,
  onPageChange,
  onEdit,
  portraits,
}: {
  detail: CampaignMemoryEntityDetail;
  chatId: string;
  onBack: () => void;
  onSelect: (id: string) => void;
  onPageChange: (offset: number) => void;
  onEdit: () => void;
  portraits: Map<string, string>;
}) {
  const { t } = useUiTranslation();
  const { entity, knowledge, events, currentState, relationships, relatedEntities } = detail;
  const facts = detail.facts as CampaignMemoryPage<CampaignMemoryFactWithCoHolders>;
  const [tab, setTab] = useState<DetailTab>("story");
  // Display-only perspective: "gm" shows everything; a holder id filters facts to what that holder knows.
  const [perspective, setPerspective] = useState("gm");
  const holders = useMemo(() => {
    const byId = new Map<string, CampaignMemoryCoHolder>();
    if (entity.kind === "character" || entity.kind === "persona") {
      byId.set(entity.entityId, {
        entityId: entity.entityId,
        alias: entity.aliases[0] || "",
        epistemicState: "knows",
      });
    }
    for (const fact of facts.items)
      for (const holder of fact.coHolders ?? []) if (!byId.has(holder.entityId)) byId.set(holder.entityId, holder);
    return [...byId.values()].filter((holder) => holder.alias && !RAW_ID.test(holder.alias));
  }, [entity, facts.items]);
  const holderState = (fact: CampaignMemoryFactWithCoHolders) =>
    perspective === entity.entityId
      ? knowledge.items.find((item) => item.factId === fact.factId)?.epistemicState
      : fact.coHolders?.find((holder) => holder.entityId === perspective)?.epistemicState;
  const visibleFacts = (
    perspective === "gm" ? facts.items : facts.items.filter((fact) => holderState(fact) !== undefined)
  )
    .slice()
    .sort((left, right) => (right.validFromOrder ?? "").localeCompare(left.validFromOrder ?? ""));
  const referencedEvents = detail.referencedEvents ?? [];
  const referencedEventById = new Map(referencedEvents.map((item) => [item.eventId, item]));
  const sourceChecks = detail.sourceChecks ?? {};
  const referencedFactById = new Map(detail.referencedFacts.map((fact) => [fact.factId, fact]));
  const related = new Map(relatedEntities.map((item) => [item.entityId, item]));
  const nameOf = (id: string) => {
    const found = related.get(id) ?? (id === entity.entityId ? entity : undefined);
    return found ? displayEntityName(t, found) : null;
  };
  const detailOffset = Math.max(
    facts.offset,
    knowledge.offset,
    events.offset,
    currentState.offset,
    relationships.offset,
  );
  const detailLimit = Math.max(facts.limit, knowledge.limit, events.limit, currentState.limit, relationships.limit);
  const sessions = entitySessionNumbers(entity);
  const name = displayEntityName(t, entity);
  const KindIcon = ENTITY_KIND_ICONS[entity.kind];
  const otherAliases = entity.aliases.filter((alias) => alias !== name && !RAW_ID.test(alias));
  const body = (entity as { body?: string }).body;
  const tabs = [
    {
      id: "story" as const,
      label: t("ui.game.campaignWiki.reader.tabStory", { defaultValue: "Story" }),
      count: facts.total,
    },
    {
      id: "knowledge" as const,
      label:
        entity.kind === "character" || entity.kind === "persona"
          ? t("ui.game.campaignWiki.reader.tabKnows", { defaultValue: "What they know" })
          : t("ui.game.campaignWiki.reader.tabKnowledge", { defaultValue: "Who knows" }),
      count: knowledge.total,
    },
    {
      id: "events" as const,
      label: t("ui.game.campaignWiki.reader.tabEvents", { defaultValue: "Events" }),
      count: events.total,
    },
    {
      id: "connections" as const,
      label: t("ui.game.campaignWiki.reader.tabConnections", { defaultValue: "Connections" }),
      count: relationships.total,
    },
    { id: "timeline" as const, label: t("ui.game.campaignWiki.timeline") },
    {
      id: "commitments" as const,
      label: t("ui.game.campaignWiki.reader.tabCommitments", { defaultValue: "Promises & quests" }),
    },
    { id: "details" as const, label: t("ui.game.campaignWiki.reader.tabDetails", { defaultValue: "Details" }) },
  ];
  const pager = (shown: number, total: number) => (
    <Pager offset={detailOffset} limit={detailLimit} total={total} shown={shown} onChange={onPageChange} />
  );
  const renderFact = (fact: (typeof facts.items)[number]) => {
    const display = factDisplay(fact);
    const label = factLabel(fact, sourceChecks[fact.factId]?.state, facts.items);
    const coHolders = (fact.coHolders ?? []).filter((holder) => holder.alias && !RAW_ID.test(holder.alias));
    return (
      <WikiCard as="article" key={fact.factId}>
        <div className="flex flex-wrap items-center gap-1.5">
          {display.kind && (
            <WikiChip tone={factKindTone(display.kind)}>{enumLabel(t, "factKind", display.kind)}</WikiChip>
          )}
          {label !== "verified" && <FactLabelBadge label={label} />}
          {display.claimStatus && display.claimStatus !== "asserted" && display.claimStatus !== "accepted" && (
            <WikiChip tone="neutral">{enumLabel(t, "claimStatus", display.claimStatus)}</WikiChip>
          )}
          {perspective !== "gm" && holderState(fact) && (
            <WikiChip tone="info">{enumLabel(t, "epistemicState", holderState(fact) ?? "unknown")}</WikiChip>
          )}
          <span className="ml-auto flex items-center gap-2">
            <SessionChip record={fact} />
            <WhenChip order={fact.validFromOrder} />
          </span>
        </div>
        {display.label && (
          <p className="mt-2 text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
            {display.label}
          </p>
        )}
        <p className={cn("text-sm leading-6 text-foreground", display.label ? "mt-0.5" : "mt-2")}>{display.text}</p>
        {display.conditions.length > 0 && (
          <div className="mt-2 rounded-lg bg-amber-400/5 px-3 py-2">
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
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
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
                      ({enumLabel(t, "epistemicState", holder.epistemicState)})
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
        />
      </WikiCard>
    );
  };
  const liveFacts = visibleFacts.filter((fact) => fact.status !== "retracted");
  const withdrawnFacts = visibleFacts.filter((fact) => fact.status === "retracted");

  return (
    <article className="mx-auto w-full min-w-0 max-w-[62rem] space-y-5 pb-10 [overflow-wrap:anywhere]">
      <header className="flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:items-start">
        <EntityAvatar
          name={name}
          kind={entity.kind}
          size={72}
          imageUrl={portraitFor(entity, portraits)}
          className="shadow-[0_0_12px_color-mix(in_srgb,var(--primary)_22%,transparent)]"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <WikiChip tone="accent" icon={<KindIcon size={11} />}>
              {kindLabel(t, entity.kind)}
            </WikiChip>
            {sessions.length > 0 && (
              <WikiChip tone="neutral" icon={<CalendarClock size={11} />}>
                {t("ui.game.campaignWiki.reader.sessions", {
                  defaultValue: "Sessions {{list}}",
                  list: formatSessionRanges(sessions),
                })}
              </WikiChip>
            )}
            {entity.status === "archived" && (
              <WikiChip tone="warning">{enumLabel(t, "recordStatus", "archived")}</WikiChip>
            )}
            {entity.manualLock && (
              <WikiChip tone="info">
                {t("ui.game.campaignWiki.reader.locked", { defaultValue: "Protected from automatic changes" })}
              </WikiChip>
            )}
          </div>
          <h2 className="mt-2 text-2xl font-bold leading-tight text-foreground">{name}</h2>
          {otherAliases.length > 0 && (
            <p className="mt-1 text-sm text-muted-foreground">
              {t("ui.game.campaignWiki.reader.alsoKnownAs", {
                defaultValue: "Also known as {{names}}",
                names: otherAliases.join(", "),
              })}
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onEdit}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-semibold hover:border-primary/50 hover:bg-secondary"
            >
              <Pencil size={13} />
              {t("ui.game.campaignWiki.editor.edit")}
            </button>
            <CampaignWikiOwnerLink owner={entity.owner} fallbackName={name} />
            {holders.length > 1 && (
              <label className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-2 text-xs">
                <Eye size={13} className="text-muted-foreground" />
                <span className="sr-only">{t("ui.game.campaignWiki.perspective")}</span>
                <select
                  value={perspective}
                  onChange={(event) => setPerspective(event.target.value)}
                  title={t("ui.game.campaignWiki.perspectiveNote")}
                  className="min-h-8 max-w-[12rem] bg-transparent text-xs outline-none"
                >
                  <option value="gm">{t("ui.game.campaignWiki.perspective.gm")}</option>
                  {holders.map((holder) => (
                    <option key={holder.entityId} value={holder.entityId}>
                      {t("ui.game.campaignWiki.perspective.holder", { name: holder.alias })}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        </div>
      </header>

      {(entity.summary || body) && (
        <section className="space-y-3">
          {entity.summary && <p className="text-[0.95rem] leading-7 text-foreground">{entity.summary}</p>}
          {body && (
            <div>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t("ui.game.campaignWiki.notes")}
              </h4>
              <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-7 text-foreground">
                {(entity as { body?: string }).body}
              </pre>
            </div>
          )}
        </section>
      )}

      {currentState.items.length > 0 && (
        <section aria-label={t("ui.game.campaignWiki.currentState")}>
          <WikiSectionHeader
            title={t("ui.game.campaignWiki.reader.rightNow", { defaultValue: "Right now" })}
            hint={t("ui.game.campaignWiki.reader.rightNowHint", {
              defaultValue: "The latest state recorded in the story. It overrides older card text.",
            })}
          />
          <div className="grid gap-2 sm:grid-cols-2">
            {currentState.items.map((item) => {
              const sourceEvent = referencedEventById.get(item.sourceEventId);
              const valueRecord = wikiValueRecord(item.value);
              const target =
                valueRecord && typeof valueRecord.entityId === "string"
                  ? valueRecord.entityId
                  : typeof item.value === "string" && ENTITY_ID.test(item.value.trim())
                    ? item.value.trim()
                    : undefined;
              const targetName = target ? nameOf(target) : null;
              return (
                <WikiCard key={item.stateId} className="p-3">
                  <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
                    {humanizeKey(item.property)}
                  </p>
                  {target ? (
                    <button
                      type="button"
                      onClick={() => onSelect(target)}
                      className="mt-1 inline-flex items-center gap-1 text-left text-sm font-semibold text-foreground hover:text-primary"
                    >
                      <MapPin size={13} className="shrink-0" />
                      {targetName ?? <EntityRefName chatId={chatId} entityId={target} />}
                    </button>
                  ) : (
                    <p className="mt-1 text-sm font-semibold text-foreground">{readableValue(item.value)}</p>
                  )}
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    <SessionChip record={item} />
                    <WhenChip order={item.validAtOrder} />
                    {sourceChecks[item.stateId]?.state === "stale" && <FactLabelBadge label={STALE_LABEL} />}
                  </div>
                  {sourceEvent && (
                    <CampaignWikiEvidence
                      chatId={chatId}
                      sourceChatId={recordOrigin(sourceEvent).chatId ?? chatId}
                      evidence={sourceEvent.evidence}
                    />
                  )}
                </WikiCard>
              );
            })}
          </div>
        </section>
      )}

      <WikiTabs
        tabs={tabs}
        value={tab}
        onChange={setTab}
        label={t("ui.game.campaignWiki.reader.sections", { defaultValue: "Sections" })}
      />

      {tab === "story" && (
        <section className="space-y-2.5" aria-label={t("ui.game.campaignWiki.facts")}>
          {perspective !== "gm" && visibleFacts.length < facts.items.length && (
            <p className="text-xs text-muted-foreground">
              {t("ui.game.campaignWiki.perspectiveHidden", { count: facts.items.length - visibleFacts.length })}
            </p>
          )}
          {visibleFacts.length === 0 && (
            <WikiEmpty
              icon={<ScrollText size={22} />}
              title={t("ui.game.campaignWiki.reader.noFactsTitle", { defaultValue: "Nothing recorded yet" })}
              hint={t("ui.game.campaignWiki.reader.noFactsHint", {
                defaultValue: "Facts appear here once the story mentions this page and the memory review accepts them.",
              })}
            />
          )}
          {liveFacts.map(renderFact)}
          {withdrawnFacts.length > 0 && (
            <details className="rounded-xl border border-border/60 px-3 py-2">
              <summary className="cursor-pointer text-xs font-semibold text-muted-foreground">
                {t("ui.game.campaignWiki.reader.withdrawnFacts", {
                  defaultValue: "Withdrawn by the memory check ({{count}})",
                  count: withdrawnFacts.length,
                })}
              </summary>
              <div className="mt-2 space-y-2.5 opacity-80">{withdrawnFacts.map(renderFact)}</div>
            </details>
          )}
          {pager(facts.items.length, facts.total)}
        </section>
      )}

      {tab === "knowledge" && (
        <section className="space-y-2.5" aria-label={t("ui.game.campaignWiki.knowledge")}>
          {knowledge.items.length === 0 && (
            <WikiEmpty
              icon={<Users size={22} />}
              title={t("ui.game.campaignWiki.reader.noKnowledgeTitle", { defaultValue: "No recorded knowledge" })}
            />
          )}
          {knowledge.items.map((item) => {
            const fact = item.factId ? referencedFactById.get(item.factId) : undefined;
            const text = item.attributedClaim
              ? readableValue(item.attributedClaim.value)
              : fact
                ? factDisplay(fact as CampaignMemoryFact).text
                : t("ui.game.campaignWiki.knowledgeClaimUnavailable");
            const holderName = nameOf(item.holderEntityId);
            return (
              <WikiCard as="article" key={item.knowledgeId}>
                <div className="flex flex-wrap items-center gap-1.5">
                  {holderName && item.holderEntityId !== entity.entityId && (
                    <EntityChipButton
                      entity={related.get(item.holderEntityId) ?? null}
                      name={holderName}
                      portraits={portraits}
                      onClick={() => onSelect(item.holderEntityId)}
                    />
                  )}
                  <WikiChip
                    tone={
                      item.epistemicState === "knows"
                        ? "success"
                        : item.epistemicState === "unknown"
                          ? "neutral"
                          : "info"
                    }
                  >
                    {enumLabel(t, "epistemicState", item.epistemicState)}
                  </WikiChip>
                  {item.confidence && item.confidence !== "high" && (
                    <WikiChip tone="neutral">{enumLabel(t, "confidence", item.confidence)}</WikiChip>
                  )}
                  {sourceChecks[item.knowledgeId]?.state === "stale" && <FactLabelBadge label={STALE_LABEL} />}
                  <span className="ml-auto flex items-center gap-2">
                    <SessionChip record={item} />
                    <WhenChip order={item.learnedAtOrder} />
                  </span>
                </div>
                <p className="mt-2 text-sm leading-6 text-foreground">{text}</p>
                <CampaignWikiEvidence
                  chatId={chatId}
                  sourceChatId={recordOrigin(item).chatId ?? chatId}
                  evidence={item.learnedFrom}
                />
              </WikiCard>
            );
          })}
          {pager(knowledge.items.length, knowledge.total)}
        </section>
      )}

      {tab === "events" && (
        <section className="space-y-2.5" aria-label={t("ui.game.campaignWiki.events")}>
          {events.items.length === 0 && (
            <WikiEmpty
              icon={<History size={22} />}
              title={t("ui.game.campaignWiki.reader.noEventsTitle", { defaultValue: "No recorded events" })}
            />
          )}
          {[...events.items]
            .sort((left, right) => right.occurrenceOrder.localeCompare(left.occurrenceOrder))
            .map((item) => {
              const quote = item.evidence[0]?.quote;
              const participants = item.participantEntityIds.filter((id) => id !== entity.entityId);
              const locationName = item.locationEntityId ? nameOf(item.locationEntityId) : null;
              return (
                <WikiCard as="article" key={item.eventId}>
                  <div className="flex flex-wrap items-center gap-2">
                    {item.campaignTime && <WikiChip tone="accent">{item.campaignTime}</WikiChip>}
                    {locationName && item.locationEntityId && (
                      <EntityChipButton
                        entity={related.get(item.locationEntityId) ?? null}
                        name={locationName}
                        portraits={portraits}
                        onClick={() => onSelect(item.locationEntityId!)}
                      />
                    )}
                    <span className="ml-auto flex items-center gap-2">
                      <SessionChip record={item} />
                      <WhenChip order={item.occurrenceOrder} />
                    </span>
                  </div>
                  {quote && (
                    <p className="mt-2 text-sm italic leading-6 text-foreground/90">
                      {t("ui.game.detail.value1", { value1: quote })}
                    </p>
                  )}
                  {participants.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {participants.map((id) => {
                        const participantName = nameOf(id);
                        return participantName ? (
                          <EntityChipButton
                            key={id}
                            entity={related.get(id) ?? null}
                            name={participantName}
                            portraits={portraits}
                            onClick={() => onSelect(id)}
                          />
                        ) : null;
                      })}
                    </div>
                  )}
                  {item.evidence.length > 1 && (
                    <CampaignWikiEvidence
                      chatId={chatId}
                      sourceChatId={recordOrigin(item).chatId ?? chatId}
                      evidence={item.evidence.slice(1)}
                    />
                  )}
                </WikiCard>
              );
            })}
          {pager(events.items.length, events.total)}
        </section>
      )}

      {tab === "connections" && (
        <section className="space-y-2.5" aria-label={t("ui.game.campaignWiki.relationships")}>
          {relationships.items.length === 0 && (
            <WikiEmpty
              icon={<Link2 size={22} />}
              title={t("ui.game.campaignWiki.reader.noConnectionsTitle", { defaultValue: "No recorded connections" })}
            />
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            {relationships.items.map((item: CampaignMemoryBacklink) => {
              const targetId = item.direction === "outgoing" ? item.targetEntityId : item.sourceEntityId;
              const target = related.get(targetId);
              const targetName = target ? displayEntityName(t, target) : null;
              if (!targetName) return null;
              return (
                <WikiCard as="article" key={item.relationshipId} className="p-3">
                  <button
                    type="button"
                    onClick={() => onSelect(targetId)}
                    className="flex w-full items-center gap-3 text-left"
                  >
                    <EntityAvatar
                      name={targetName}
                      kind={target?.kind ?? "character"}
                      size={40}
                      imageUrl={target ? portraitFor(target, portraits) : null}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
                        {item.label || humanizeKey(item.type)}
                      </span>
                      <span className="block truncate text-sm font-semibold text-foreground">{targetName}</span>
                    </span>
                    <ChevronRight size={15} className="shrink-0 text-muted-foreground" />
                  </button>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {item.status !== "active" && (
                      <WikiChip tone={item.status === "ended" ? "neutral" : "warning"}>
                        {enumLabel(t, "relationshipStatus", item.status)}
                      </WikiChip>
                    )}
                    <SessionChip record={item} />
                    <WhenChip order={item.effectiveFrom} />
                  </div>
                  <CampaignWikiEvidence
                    chatId={chatId}
                    sourceChatId={recordOrigin(item).chatId ?? chatId}
                    evidence={item.evidence}
                  />
                </WikiCard>
              );
            })}
          </div>
          {pager(relationships.items.length, relationships.total)}
        </section>
      )}

      {tab === "timeline" && (
        <CampaignWikiTimeline
          chatId={chatId}
          entityId={entity.kind === "location" ? undefined : entity.entityId}
          locationId={entity.kind === "location" ? entity.entityId : undefined}
          heading={t("ui.game.campaignWiki.timeline")}
          onSelect={onSelect}
          portraits={portraits}
        />
      )}

      {tab === "commitments" && (
        <CampaignWikiCommitments chatId={chatId} entityId={entity.entityId} onNavigate={onSelect} />
      )}

      {tab === "details" && (
        <section className="space-y-3">
          <WikiCard>
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
                  {t("ui.game.campaignWiki.reader.recordType", { defaultValue: "Type" })}
                </dt>
                <dd>{kindLabel(t, entity.kind)}</dd>
              </div>
              <div>
                <dt className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
                  {t("ui.game.campaignWiki.reader.recordStatus", { defaultValue: "Status" })}
                </dt>
                <dd>{enumLabel(t, "recordStatus", entity.status)}</dd>
              </div>
              <div>
                <dt className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
                  {t("ui.game.campaignWiki.reader.addedBy", { defaultValue: "Added by" })}
                </dt>
                <dd>{enumLabel(t, "actor", entity.provenance.actor)}</dd>
              </div>
              <div>
                <dt className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
                  {t("ui.game.campaignWiki.reader.updated", { defaultValue: "Last updated" })}
                </dt>
                <dd>{new Date(entity.updatedAt).toLocaleString()}</dd>
              </div>
              {entity.tags.length > 0 && (
                <div className="sm:col-span-2">
                  <dt className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
                    {t("ui.game.campaignWiki.reader.tags", { defaultValue: "Tags" })}
                  </dt>
                  <dd className="mt-1 flex flex-wrap gap-1">
                    {entity.tags.map((tag) => (
                      <WikiChip key={tag}>{humanizeKey(tag)}</WikiChip>
                    ))}
                  </dd>
                </div>
              )}
            </dl>
          </WikiCard>
          <details className="rounded-xl border border-border px-3 py-2">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              {t("ui.game.campaignWiki.sourceDetails")}
            </summary>
            <p className="mt-2 break-all text-[0.6875rem] text-muted-foreground">
              {t("ui.game.campaignWiki.sourceInfo", {
                source: entity.provenance.source,
                revision: entity.provenance.sourceRevision,
              })}
            </p>
            <p className="mt-1 break-all text-[0.6875rem] text-muted-foreground">{entity.entityId}</p>
          </details>
        </section>
      )}
    </article>
  );
}

function groupTimelineByDay(items: CampaignMemoryTimelineItem[], locale: string | undefined) {
  const groups: Array<{ key: string; label: string; items: CampaignMemoryTimelineItem[] }> = [];
  for (const item of items) {
    const label = item.campaignTime || formatCaptureOrder(item.occurrenceOrder, locale) || "";
    const last = groups[groups.length - 1];
    if (last && last.key === label) last.items.push(item);
    else groups.push({ key: label, label, items: [item] });
  }
  return groups;
}

function CampaignWikiTimeline({
  chatId,
  entityId,
  locationId,
  heading,
  onSelect,
  portraits,
}: {
  chatId: string;
  entityId?: string;
  locationId?: string;
  heading: string;
  onSelect: (id: string) => void;
  portraits: Map<string, string>;
}) {
  const { t, i18n } = useUiTranslation();
  // Cursor history: the last entry is the current page; Previous pops, Next pushes nextCursor.
  const [cursors, setCursors] = useState<string[]>([]);
  const timeline = useCampaignMemoryTimeline(chatId, { entityId, locationId, cursor: cursors[cursors.length - 1] });
  const page = timeline.data;
  const nextCursor = page?.nextCursor ?? null;
  const groups = useMemo(() => groupTimelineByDay(page?.items ?? [], i18n.language), [page, i18n.language]);
  return (
    <section className="space-y-3" aria-label={heading}>
      <WikiSectionHeader
        title={heading}
        action={
          cursors.length > 0 ? (
            <span className="text-xs text-muted-foreground">
              {t("ui.game.campaignWiki.timelinePage", { page: cursors.length + 1 })}
            </span>
          ) : undefined
        }
      />
      {timeline.isLoading && (
        <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
          <Loader2 size={14} className="animate-spin" />
          {t("ui.game.campaignWiki.timelineLoading")}
        </div>
      )}
      {timeline.isError && <ErrorState onRetry={() => void timeline.refetch()} />}
      {page && page.items.length === 0 && (
        <WikiEmpty icon={<History size={22} />} title={t("ui.game.campaignWiki.timelineEmpty")} />
      )}
      {groups.length > 0 && (
        <ol className="relative space-y-5 border-l border-border pl-5">
          {groups.map((group) => (
            <li key={`${group.key}-${group.items[0]?.eventId}`} className="space-y-2">
              {group.label && (
                <p className="relative -ml-5 flex items-center gap-2 text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
                  <span className="h-2.5 w-2.5 -translate-x-[5px] rounded-full border border-primary/60 bg-primary/40" />
                  {group.label}
                </p>
              )}
              {group.items.map((item) => (
                <WikiCard as="article" key={item.eventId} className="p-3">
                  <p className="text-sm leading-6 text-foreground">{eventSummary(t, item.summary)}</p>
                  {(item.location || item.participants.length > 0) && (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {item.location && item.location.alias && (
                        <EntityChipButton
                          entity={null}
                          name={item.location.alias}
                          portraits={portraits}
                          onClick={() => onSelect(item.location!.entityId)}
                          suffix={<MapPin size={11} className="text-muted-foreground" />}
                        />
                      )}
                      {item.participants
                        .filter((participant) => participant.alias && !RAW_ID.test(participant.alias))
                        .map((participant) => (
                          <EntityChipButton
                            key={participant.entityId}
                            entity={null}
                            name={participant.alias}
                            portraits={portraits}
                            onClick={() => onSelect(participant.entityId)}
                          />
                        ))}
                    </div>
                  )}
                  {item.stateChanges.length > 0 && (
                    <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
                      {item.stateChanges.map((change, index) => (
                        <li key={`${change.entityId}-${change.key}-${index}`}>
                          {humanizeKey(change.key)}: {readableValue(change.value)}
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <SessionChip record={item} />
                    {item.campaignTime && <WhenChip order={item.occurrenceOrder} />}
                  </div>
                </WikiCard>
              ))}
            </li>
          ))}
        </ol>
      )}
      {page && (cursors.length > 0 || nextCursor) && (
        <div className="flex justify-end gap-1.5">
          <button
            type="button"
            disabled={cursors.length === 0}
            onClick={() => setCursors((current) => current.slice(0, -1))}
            className="min-h-9 rounded-lg border border-border px-3 text-xs font-semibold hover:bg-secondary disabled:opacity-40"
          >
            {t("ui.game.campaignWiki.previous")}
          </button>
          <button
            type="button"
            disabled={!nextCursor}
            onClick={() => nextCursor && setCursors((current) => [...current, nextCursor])}
            className="min-h-9 rounded-lg border border-border px-3 text-xs font-semibold hover:bg-secondary disabled:opacity-40"
          >
            {t("ui.game.campaignWiki.next")}
          </button>
        </div>
      )}
    </section>
  );
}

const MATCH_TIERS: CampaignMemoryMatchTier[] = ["id", "alias", "prefix", "text"];

function groupByMatchTier(items: CampaignMemoryEntityListItem[], query: string) {
  if (!query || !items.some((item) => item.matchTier)) return [{ tier: null, items }];
  const groups: Array<{ tier: CampaignMemoryMatchTier | null; items: CampaignMemoryEntityListItem[] }> =
    MATCH_TIERS.map((tier) => ({ tier, items: items.filter((item) => item.matchTier === tier) }));
  groups.push({ tier: null, items: items.filter((item) => !item.matchTier) });
  return groups.filter((group) => group.items.length > 0);
}

/** Entity totals per kind for the overview tiles (one tiny request each; cached by React Query). */
function useKindTotals(chatId: string) {
  const character = useCampaignMemoryEntities(chatId, { kind: "character", limit: 1 });
  const location = useCampaignMemoryEntities(chatId, { kind: "location", limit: 1 });
  const organization = useCampaignMemoryEntities(chatId, { kind: "organization", limit: 1 });
  const item = useCampaignMemoryEntities(chatId, { kind: "item", limit: 1 });
  const quest = useCampaignMemoryEntities(chatId, { kind: "quest", limit: 1 });
  const lore = useCampaignMemoryEntities(chatId, { kind: "lore", limit: 1 });
  const persona = useCampaignMemoryEntities(chatId, { kind: "persona", limit: 1 });
  const note = useCampaignMemoryEntities(chatId, { kind: "note", limit: 1 });
  const all = useCampaignMemoryEntities(chatId, { limit: 1 });
  return {
    all: all.data?.total,
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

function Overview({
  chatId,
  onSelect,
  onShowKind,
  onShowTimeline,
  portraits,
  tools,
}: {
  chatId: string;
  onSelect: (id: string) => void;
  onShowKind: (kind: CampaignMemoryEntityKind) => void;
  onShowTimeline: () => void;
  portraits: Map<string, string>;
  tools: ReactNode;
}) {
  const { t } = useUiTranslation();
  const totals = useKindTotals(chatId);
  const people = useCampaignMemoryEntities(chatId, { kind: "character", limit: 12 });
  const places = useCampaignMemoryEntities(chatId, { kind: "location", limit: 8 });
  const count = (value: number | undefined) => (value === undefined ? "…" : value.toLocaleString());
  const empty = totals.all === 0;
  const Tile = ({ kind, value }: { kind: CampaignMemoryEntityKind; value: number | undefined }) => {
    const Icon = ENTITY_KIND_ICONS[kind];
    return (
      <WikiStat
        label={kindLabel(t, kind)}
        value={count(value)}
        icon={<Icon size={12} />}
        onClick={() => onShowKind(kind)}
      />
    );
  };
  return (
    <div data-campaign-wiki-overview className="mx-auto w-full max-w-[62rem] space-y-7 pb-10 pt-2">
      <header>
        <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.16em] text-primary">
          <Sparkles size={13} />
          {t("ui.game.campaignWiki.overviewEyebrow")}
        </p>
        <h2 className="mt-1 text-2xl font-bold tracking-tight">{t("ui.game.campaignWiki.title")}</h2>
        <p className="mt-2 max-w-[65ch] text-sm leading-6 text-muted-foreground">
          {t("ui.game.campaignWiki.reader.overviewIntro", {
            defaultValue:
              "Everything the story has established so far: who people are, where things happened, what was promised and who knows what. The GM reads this memory every turn.",
          })}
        </p>
      </header>

      {empty ? (
        <WikiEmpty
          icon={<Database size={26} />}
          title={t("ui.game.campaignWiki.reader.emptyTitle", { defaultValue: "The wiki is empty" })}
          hint={t("ui.game.campaignWiki.reader.emptyHint", {
            defaultValue:
              "Turn on continuity for this session, or index the campaign history, and pages will appear here as the story is read.",
          })}
          action={tools}
        />
      ) : (
        <>
          <section
            aria-label={t("ui.game.campaignWiki.overviewCounts")}
            className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2"
          >
            <WikiStat
              label={t("ui.game.campaignWiki.reader.allPages", { defaultValue: "All pages" })}
              value={count(totals.all)}
              icon={<Database size={12} />}
            />
            {(["character", "persona", "location", "organization", "item", "quest", "lore", "note"] as const)
              .filter((kind) => totals[kind] !== 0)
              .map((kind) => (
                <Tile key={kind} kind={kind} value={totals[kind]} />
              ))}
          </section>

          {people.data && people.data.items.length > 0 && (
            <section>
              <WikiSectionHeader
                title={t("ui.game.campaignWiki.reader.people", { defaultValue: "People" })}
                count={people.data.total}
                action={
                  <button
                    type="button"
                    onClick={() => onShowKind("character")}
                    className="min-h-8 rounded-lg px-2 text-xs font-semibold text-primary hover:bg-secondary"
                  >
                    {t("ui.game.campaignWiki.reader.seeAll", { defaultValue: "See all" })}
                  </button>
                }
              />
              <div className="grid grid-cols-[repeat(auto-fill,minmax(11.5rem,1fr))] gap-2">
                {people.data.items.map((entity) => {
                  const name = displayEntityName(t, entity);
                  const sessions = entitySessionNumbers(entity);
                  return (
                    <button
                      type="button"
                      key={entity.entityId}
                      onClick={() => onSelect(entity.entityId)}
                      className="flex min-w-0 items-center gap-2.5 rounded-xl border border-border bg-secondary/30 p-2.5 text-left transition-colors hover:border-primary/50 hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                    >
                      <EntityAvatar
                        name={name}
                        kind={entity.kind}
                        size={40}
                        imageUrl={portraitFor(entity, portraits)}
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold">{name}</span>
                        <span className="block truncate text-[0.6875rem] text-muted-foreground">
                          {sessions.length
                            ? t("ui.game.campaignWiki.reader.sessions", {
                                defaultValue: "Sessions {{list}}",
                                list: formatSessionRanges(sessions),
                              })
                            : entity.summary || kindLabel(t, entity.kind)}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {places.data && places.data.items.length > 0 && (
            <section>
              <WikiSectionHeader
                title={t("ui.game.campaignWiki.reader.places", { defaultValue: "Places" })}
                count={places.data.total}
                action={
                  <button
                    type="button"
                    onClick={() => onShowKind("location")}
                    className="min-h-8 rounded-lg px-2 text-xs font-semibold text-primary hover:bg-secondary"
                  >
                    {t("ui.game.campaignWiki.reader.seeAll", { defaultValue: "See all" })}
                  </button>
                }
              />
              <div className="flex flex-wrap gap-1.5">
                {places.data.items.map((entity) => (
                  <EntityChipButton
                    key={entity.entityId}
                    entity={entity}
                    name={displayEntityName(t, entity)}
                    portraits={portraits}
                    onClick={() => onSelect(entity.entityId)}
                  />
                ))}
              </div>
            </section>
          )}

          <section>
            <WikiSectionHeader
              title={t("ui.game.campaignWiki.reader.recentEvents", { defaultValue: "Latest in the story" })}
              action={
                <button
                  type="button"
                  onClick={onShowTimeline}
                  className="min-h-8 rounded-lg px-2 text-xs font-semibold text-primary hover:bg-secondary"
                >
                  {t("ui.game.campaignWiki.reader.fullTimeline", { defaultValue: "Full timeline" })}
                </button>
              }
            />
            <RecentEvents chatId={chatId} onSelect={onSelect} />
          </section>

          <section>
            <CampaignWikiCommitments chatId={chatId} onNavigate={onSelect} />
          </section>

          <details className="rounded-xl border border-border px-3 py-2">
            <summary className="cursor-pointer text-xs font-semibold text-muted-foreground">
              {t("ui.game.campaignWiki.reader.tools", { defaultValue: "Tools" })}
            </summary>
            <div className="mt-3">{tools}</div>
          </details>
        </>
      )}
    </div>
  );
}

function RecentEvents({ chatId, onSelect }: { chatId: string; onSelect: (id: string) => void }) {
  const { t } = useUiTranslation();
  const timeline = useCampaignMemoryTimeline(chatId, { limit: 6 });
  if (timeline.isLoading) return <WikiSkeleton rows={3} />;
  if (timeline.isError) return <ErrorState onRetry={() => void timeline.refetch()} />;
  const items = timeline.data?.items ?? [];
  if (!items.length) return <p className="text-xs text-muted-foreground">{t("ui.game.campaignWiki.timelineEmpty")}</p>;
  return (
    <ol className="space-y-1.5">
      {items.map((item) => (
        <li key={item.eventId} className="flex items-start gap-3 rounded-lg px-2 py-1.5 hover:bg-secondary/40">
          <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/70" />
          <div className="min-w-0 flex-1">
            <p className="text-sm leading-6 text-foreground">{eventSummary(t, item.summary)}</p>
            {item.participants.length > 0 && (
              <p className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                {item.participants
                  .filter((participant) => participant.alias && !RAW_ID.test(participant.alias))
                  .slice(0, 6)
                  .map((participant) => (
                    <button
                      key={participant.entityId}
                      type="button"
                      onClick={() => onSelect(participant.entityId)}
                      className="hover:text-primary"
                    >
                      {participant.alias}
                    </button>
                  ))}
              </p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

type ReaderView = "home" | "timeline";

export function CampaignWiki({
  chatId,
  onDirtyChange,
  selectedEntityId,
  onSelectedEntityChange,
  initialSearch,
  initialKind,
}: CampaignWikiProps) {
  const { t } = useUiTranslation();
  const chat = useChat(chatId);
  const portraits = useCharacterPortraits();
  const [searchText, setSearchText] = useState(initialSearch ?? "");
  const [query, setQuery] = useState((initialSearch ?? "").trim());
  const [kind, setKind] = useState<CampaignMemoryEntityKind | "all">(initialKind ?? "all");
  const [selectedId, setSelectedId] = useState<string | null>(selectedEntityId ?? null);
  const [detailOffset, setDetailOffset] = useState(0);
  const [entityOffset, setEntityOffset] = useState(0);
  const [editing, setEditing] = useState(false);
  const [editorDirty, setEditorDirty] = useState(false);
  const [campaignTimeline, setCampaignTimeline] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(false);
  const kindTotals = useKindTotals(chatId);
  useEffect(() => onDirtyChange?.(editorDirty), [editorDirty, onDirtyChange]);
  const [importPreview, setImportPreview] = useState<CampaignMemoryImportPreview | null>(null);
  const [importOperationId, setImportOperationId] = useState<string | null>(null);
  const [importError, setImportError] = useState<"generic" | "sourceChanged" | null>(null);
  const importPreviewMutation = usePreviewCampaignMemoryImport(chatId);
  const importApplyMutation = useApplyCampaignMemoryImport(chatId);
  const confirmEditorExit = () => !editorDirty || window.confirm(t("ui.game.campaignWiki.editor.unsavedConfirm"));
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(searchText.trim());
      setEntityOffset(0);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [searchText]);
  const mountedChatIdRef = useRef(chatId);
  useEffect(() => {
    // Mount keeps the seeded navigation state; only a later chat switch resets the reader.
    if (mountedChatIdRef.current === chatId) return;
    mountedChatIdRef.current = chatId;
    setSelectedId(null);
    setEntityOffset(0);
    setDetailOffset(0);
    setEditing(false);
    setEditorDirty(false);
    setCampaignTimeline(false);
    setSearchText("");
    setQuery("");
    setKind("all");
    setImportPreview(null);
    setImportOperationId(null);
    setImportError(null);
  }, [chatId]);
  // Deep-link prefill: applied when the values arrive (mount, or once an owner lookup settles).
  const appliedInitialRef = useRef({ search: initialSearch, kind: initialKind });
  useEffect(() => {
    if (initialSearch !== undefined && appliedInitialRef.current.search !== initialSearch) {
      appliedInitialRef.current.search = initialSearch;
      setSearchText(initialSearch);
    }
    if (initialKind !== undefined && appliedInitialRef.current.kind !== initialKind) {
      appliedInitialRef.current.kind = initialKind;
      setKind(initialKind);
      setEntityOffset(0);
    }
  }, [initialSearch, initialKind]);
  // Controlled page: an outside change of `selectedEntityId` (deep link, history) jumps the reader.
  const externalSelectedRef = useRef(selectedEntityId);
  useEffect(() => {
    if (selectedEntityId === undefined || externalSelectedRef.current === selectedEntityId) return;
    externalSelectedRef.current = selectedEntityId;
    setSelectedId(selectedEntityId);
    setCampaignTimeline(false);
    setDetailOffset(0);
    setEditing(false);
    setEditorDirty(false);
  }, [selectedEntityId]);
  const reportSelection = (id: string | null) => {
    externalSelectedRef.current = id;
    onSelectedEntityChange?.(id);
  };
  const entities = useCampaignMemoryEntities(chatId, { query, kind, offset: entityOffset, limit: ENTITY_PAGE_SIZE });
  const detail = useCampaignMemoryEntity(chatId, selectedId, { offset: detailOffset });
  const selected = useMemo(
    () => entities.data?.items.find((entity) => entity.entityId === selectedId),
    [entities.data, selectedId],
  );
  const listError = entities.isError;
  const listGroups = useMemo(() => groupByMatchTier(entities.data?.items ?? [], query), [entities.data, query]);
  const reading = Boolean(selectedId) || campaignTimeline;
  const view: ReaderView = campaignTimeline && !selectedId ? "timeline" : "home";
  const closeReading = () => {
    if (!confirmEditorExit()) return false;
    setSelectedId(null);
    setCampaignTimeline(false);
    setEditing(false);
    setEditorDirty(false);
    reportSelection(null);
    return true;
  };
  const selectEntity = (id: string) => {
    if (editing && !confirmEditorExit()) return;
    setSelectedId(id);
    setCampaignTimeline(false);
    setDetailOffset(0);
    setEditing(false);
    setEditorDirty(false);
    reportSelection(id);
  };
  const showKind = (next: CampaignMemoryEntityKind) => {
    setKind(next);
    setEntityOffset(0);
    setNavCollapsed(false);
  };
  const showTimeline = () => {
    if (!closeReading()) return;
    setCampaignTimeline(true);
  };
  const previewImport = () => {
    const operationId =
      importOperationId ??
      (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `campaign-import-${Date.now()}`);
    setImportOperationId(operationId);
    setImportError(null);
    void importPreviewMutation
      .mutateAsync({ operationId })
      .then(setImportPreview)
      .catch(() => setImportError("generic"));
  };
  const applyImport = () => {
    if (!importPreview || !importOperationId) return;
    setImportError(null);
    void importApplyMutation
      .mutateAsync({ operationId: importOperationId, expectedSourceHash: importPreview.manifest.legacySourceHash })
      .then(() => {
        setImportPreview(null);
        setImportOperationId(null);
        void entities.refetch();
      })
      .catch((error) => {
        if (error instanceof ApiError && error.status === 409) {
          setImportPreview(null);
          setImportError("sourceChanged");
        } else {
          setImportError("generic");
        }
      });
  };
  const importTools = (
    <div className="space-y-2 text-xs text-muted-foreground">
      <p>
        {t("ui.game.campaignWiki.reader.importHint", {
          defaultValue:
            "Bring existing character cards, NPCs and lorebook entries into the wiki as pages. Nothing is overwritten.",
        })}
      </p>
      <button
        type="button"
        onClick={previewImport}
        disabled={importPreviewMutation.isPending || importApplyMutation.isPending}
        className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-primary/60 px-3 font-semibold text-foreground hover:bg-primary/10 disabled:opacity-50"
      >
        <BookMarked size={13} />
        {importPreviewMutation.isPending
          ? t("ui.game.campaignWiki.importPreviewing")
          : t("ui.game.campaignWiki.importExisting")}
      </button>
      {importError && (
        <p className="text-destructive">
          {importError === "sourceChanged"
            ? t("ui.game.campaignWiki.importSourceChanged")
            : t("ui.game.campaignWiki.importError")}
        </p>
      )}
      {importPreview && (
        <div className="space-y-2 rounded-lg border border-border p-3">
          <p>{t("ui.game.campaignWiki.importSummary", { count: importPreview.manifest.counts.planned ?? 0 })}</p>
          <button
            type="button"
            onClick={applyImport}
            disabled={importApplyMutation.isPending}
            className="min-h-9 rounded-lg bg-primary px-3 font-semibold text-primary-foreground disabled:opacity-50"
          >
            {importApplyMutation.isPending
              ? t("ui.game.campaignWiki.importApplying")
              : t("ui.game.campaignWiki.importApply")}
          </button>
        </div>
      )}
    </div>
  );
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden text-foreground">
      <CampaignMemoryBranchNotice chat={chat} />
      <div className="flex min-h-0 flex-1 flex-col gap-3 md:flex-row">
        <section
          className={cn(
            "flex min-h-0 min-w-0 flex-1 flex-col md:w-[21rem] md:shrink-0 md:flex-none md:border-r md:border-border md:pr-3",
            reading && "hidden md:flex",
            navCollapsed && "md:hidden",
          )}
          aria-label={t("ui.game.campaignWiki.entities")}
        >
          <div className="mb-2 flex items-center gap-2">
            <Database size={15} className="text-primary" />
            <h3 className="min-w-0 flex-1 truncate text-sm font-bold">{t("ui.game.campaignWiki.entities")}</h3>
            <button
              type="button"
              onClick={showTimeline}
              aria-pressed={campaignTimeline}
              title={t("ui.game.campaignWiki.campaignTimeline")}
              className={cn(
                "inline-flex min-h-9 items-center gap-1 rounded-lg border px-2.5 text-xs font-semibold",
                campaignTimeline ? "border-primary/60 bg-primary/15" : "border-border hover:bg-secondary",
              )}
            >
              <History size={13} />
              {t("ui.game.campaignWiki.timeline")}
            </button>
            <button
              type="button"
              onClick={() => setNavCollapsed(true)}
              aria-label={t("ui.game.campaignWiki.navCollapse")}
              title={t("ui.game.campaignWiki.navCollapse")}
              className="hidden min-h-9 items-center rounded-lg border border-border px-2 text-muted-foreground hover:bg-secondary md:inline-flex"
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
              onChange={(event) => setSearchText(event.target.value)}
              placeholder={t("ui.game.campaignWiki.searchPlaceholder")}
              aria-label={t("ui.game.campaignWiki.searchPlaceholder")}
              className="min-h-10 w-full rounded-lg border border-border bg-background py-2 pl-9 pr-9 text-sm outline-none transition-colors focus:border-primary"
            />
            {searchText && (
              <button
                type="button"
                onClick={() => setSearchText("")}
                aria-label={t("ui.game.campaignWiki.reader.clearSearch", { defaultValue: "Clear search" })}
                className="absolute right-1.5 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary"
              >
                <X size={13} />
              </button>
            )}
          </label>
          <div
            className="mt-2 flex gap-1 overflow-x-auto pb-1.5 [scrollbar-width:thin]"
            role="group"
            aria-label={t("ui.game.campaignWiki.filterByKind")}
          >
            {KINDS.filter((item) => item === kind || kindTotals[item] !== 0).map((item) => {
              const Icon = item === "all" ? null : ENTITY_KIND_ICONS[item];
              const total = kindTotals[item];
              return (
                <button
                  type="button"
                  key={item}
                  onClick={() => {
                    setKind(item);
                    setEntityOffset(0);
                  }}
                  aria-pressed={kind === item}
                  className={cn(
                    "inline-flex min-h-8 shrink-0 items-center gap-1 rounded-full border px-2.5 text-xs font-semibold transition-colors",
                    kind === item
                      ? "border-primary/60 bg-primary/15 text-foreground"
                      : "border-border text-muted-foreground hover:bg-secondary hover:text-foreground",
                  )}
                >
                  {Icon && <Icon size={12} />}
                  {kindLabel(t, item)}
                  {typeof total === "number" && (
                    <span className="font-normal tabular-nums text-muted-foreground">{total.toLocaleString()}</span>
                  )}
                </button>
              );
            })}
          </div>
          {entities.isLoading && (
            <div className="mt-2 space-y-2">
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 size={13} className="animate-spin" />
                {t("ui.game.campaignWiki.loading")}
              </p>
              <WikiSkeleton rows={6} />
            </div>
          )}
          {listError && <ErrorState onRetry={() => void entities.refetch()} />}
          {!entities.isLoading && !listError && entities.data && entities.data.items.length === 0 && (
            <p className="px-1 py-6 text-center text-xs text-muted-foreground">
              {query
                ? t("ui.game.campaignWiki.reader.noMatches", { defaultValue: "No pages match “{{query}}”.", query })
                : t("ui.game.campaignWiki.empty")}
            </p>
          )}
          <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-1" data-campaign-wiki-entity-list>
            {listGroups.map((group) => (
              <div key={group.tier ?? "all"} className="space-y-0.5">
                {group.tier && (
                  <p className="px-2 pb-1 pt-3 text-[0.625rem] font-semibold uppercase tracking-wide text-muted-foreground">
                    {t(`ui.game.campaignWiki.matchTier.${group.tier}`)}
                  </p>
                )}
                {group.items.map((entity) => {
                  const name = displayEntityName(t, entity);
                  const sessions = entitySessionNumbers(entity);
                  const active = selectedId === entity.entityId;
                  return (
                    <button
                      type="button"
                      key={entity.entityId}
                      onClick={() => selectEntity(entity.entityId)}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex min-h-12 w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors",
                        active ? "bg-primary/15 text-foreground" : "hover:bg-secondary/70",
                      )}
                    >
                      <EntityAvatar
                        name={name}
                        kind={entity.kind}
                        size={34}
                        imageUrl={portraitFor(entity, portraits)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className={cn("block truncate text-sm font-semibold", active && "text-primary")}>
                          {name}
                        </span>
                        <span className="block truncate text-[0.6875rem] text-muted-foreground">
                          {kindLabel(t, entity.kind)}
                          {sessions.length > 0 &&
                            ` · ${t("ui.game.campaignWiki.reader.sessions", { defaultValue: "Sessions {{list}}", list: formatSessionRanges(sessions) })}`}
                          {entity.status === "archived" && ` · ${enumLabel(t, "recordStatus", "archived")}`}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          {entities.data && entities.data.total > entities.data.items.length && (
            <Pager
              offset={entityOffset}
              limit={entities.data.limit || ENTITY_PAGE_SIZE}
              total={entities.data.total}
              shown={entities.data.items.length}
              onChange={setEntityOffset}
            />
          )}
        </section>
        <section
          className={cn("flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden", !reading && "hidden md:flex")}
          aria-live="polite"
        >
          <div className="flex items-center gap-2">
            {reading && (
              <button
                type="button"
                onClick={closeReading}
                className="mb-2 inline-flex min-h-10 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-muted-foreground hover:bg-secondary md:hidden"
              >
                <ArrowLeft size={14} />
                {t("ui.game.campaignWiki.backToEntities")}
              </button>
            )}
            {navCollapsed && (
              <button
                type="button"
                onClick={() => setNavCollapsed(false)}
                className="mb-2 hidden min-h-9 items-center gap-1 rounded-lg border border-border px-2.5 text-xs font-semibold text-muted-foreground hover:bg-secondary md:inline-flex"
              >
                <PanelLeftOpen size={14} />
                {t("ui.game.campaignWiki.navExpand")}
              </button>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1 md:px-6 lg:px-10" data-campaign-wiki-scroll="reader">
            {view === "timeline" && (
              <div className="mx-auto w-full max-w-[62rem] space-y-8 pb-10 pt-2">
                <CampaignWikiTimeline
                  chatId={chatId}
                  heading={t("ui.game.campaignWiki.campaignTimeline")}
                  onSelect={selectEntity}
                  portraits={portraits}
                />
                <CampaignWikiCommitments chatId={chatId} onNavigate={selectEntity} />
              </div>
            )}
            {selectedId && detail.isLoading && (
              <div className="mx-auto max-w-[62rem] space-y-3 pt-2">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 size={14} className="animate-spin" />
                  {t("ui.game.campaignWiki.loadingDetail")}
                </div>
                <WikiSkeleton rows={5} />
              </div>
            )}
            {selectedId && detail.isError && <ErrorState onRetry={() => void detail.refetch()} />}
            {!reading && !selectedId && (
              <Overview
                chatId={chatId}
                onSelect={selectEntity}
                onShowKind={showKind}
                onShowTimeline={showTimeline}
                portraits={portraits}
                tools={importTools}
              />
            )}
            {selectedId &&
              detail.data &&
              (editing ? (
                <CampaignWikiEditor
                  chatId={chatId}
                  detail={detail.data}
                  onClose={() => {
                    setEditing(false);
                    setEditorDirty(false);
                  }}
                  onDirtyChange={setEditorDirty}
                  onReload={() => {
                    setEditing(false);
                    setEditorDirty(false);
                    void detail.refetch();
                  }}
                />
              ) : (
                <Detail
                  key={detail.data.entity.entityId}
                  chatId={chatId}
                  detail={detail.data}
                  onBack={() => void closeReading()}
                  onSelect={selectEntity}
                  onPageChange={setDetailOffset}
                  onEdit={() => {
                    setEditorDirty(false);
                    setEditing(true);
                  }}
                  portraits={portraits}
                />
              ))}
            {selected && !detail.data && !detail.isLoading && !detail.isError && (
              <p className="text-xs text-muted-foreground">{selected.summary}</p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

const branchRecordTypeLabels: Record<CampaignMemoryBranchHeldRecordType, string> = {
  entity: "entity",
  fact: "fact",
  knowledge: "knowledge record",
  event: "event",
  "current-state": "current state record",
  relationship: "relationship",
};

function CampaignMemoryBranchNotice({ chat }: { chat: ReturnType<typeof useChat> }) {
  const { t } = useUiTranslation();
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const branch = chat.data?.metadata?.campaignMemoryBranch;
  if (chat.isLoading && !chat.data) {
    return <p className="text-[0.6875rem] text-muted-foreground">{t("ui.game.campaignWiki.branchStatusLoading")}</p>;
  }
  if (chat.isError && !branch) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground">
        <span>{t("ui.game.campaignWiki.branchStatusError")}</span>
        <button
          type="button"
          onClick={() => void chat.refetch()}
          className="min-h-8 rounded-lg border border-border px-2 hover:bg-secondary"
        >
          {t("ui.game.campaignWiki.retry")}
        </button>
      </div>
    );
  }
  if (!branch?.held.length) return null;
  return (
    <aside className="rounded-xl border border-destructive/50 bg-destructive/5 px-3 py-2 text-xs">
      {chat.isError && (
        <div className="mb-2 flex items-center justify-between gap-2 text-destructive">
          <span>{t("ui.game.campaignWiki.branchStatusError")}</span>
          <button
            type="button"
            onClick={() => void chat.refetch()}
            className="min-h-8 rounded-lg border border-border px-2 text-muted-foreground hover:bg-secondary"
          >
            {t("ui.game.campaignWiki.retry")}
          </button>
        </div>
      )}
      <p className="font-semibold">{t("ui.game.campaignWiki.branchHeldWarning")}</p>
      <p className="mt-1 text-muted-foreground">{t("ui.game.campaignWiki.branchHeldSummary")}</p>
      <details
        className="mt-2"
        open={diagnosticsOpen}
        onToggle={(event) => setDiagnosticsOpen(event.currentTarget.open)}
      >
        <summary className="cursor-pointer text-muted-foreground">
          {t("ui.game.campaignWiki.branchHeldRecords", { count: branch.held.length })}
        </summary>
        <ul className="mt-2 space-y-2">
          {branch.held.map((record, index) => (
            <li
              key={`${record.recordType}-${record.recordId}-${index}`}
              className="rounded-lg border border-border p-2"
            >
              <strong>
                {t(
                  `ui.game.campaignWiki.branchRecordType.${record.recordType === "current-state" ? "currentState" : record.recordType}`,
                  {
                    defaultValue: branchRecordTypeLabels[record.recordType],
                  },
                )}
              </strong>
              <p className="mt-1 text-muted-foreground">{record.reason}</p>
              <details className="mt-1 text-[0.625rem] text-muted-foreground">
                <summary className="cursor-pointer">{t("ui.game.campaignWiki.branchDiagnosticDetails")}</summary>
                <code className="mt-1 block break-all">{record.recordId}</code>
              </details>
            </li>
          ))}
        </ul>
      </details>
    </aside>
  );
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  const { t } = useUiTranslation();
  return (
    <div className="flex items-center justify-between gap-2 rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-3 text-xs text-destructive">
      <span>{t("ui.game.campaignWiki.error")}</span>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex min-h-8 items-center gap-1 rounded-lg border border-border px-2 text-muted-foreground hover:bg-secondary"
      >
        <RotateCw size={12} />
        {t("ui.game.campaignWiki.retry")}
      </button>
    </div>
  );
}
