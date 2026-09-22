import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  BookMarked,
  ChevronRight,
  Database,
  Eye,
  History,
  Link2,
  Loader2,
  MapPin,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Search,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import type {
  CampaignMemoryBacklink,
  CampaignMemoryEntityDetail,
  CampaignMemoryEntityKind,
  CampaignMemoryFact,
} from "@marinara-engine/shared";
import type { CampaignMemoryBranchHeldRecordType } from "@marinara-engine/shared";
import { useTranslation as useUiTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import { ApiError } from "../../lib/api-client";
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
import { useChat } from "../../hooks/use-chats";
import type { CampaignWikiNavigationProps } from "./CampaignWikiWindow";
import { CampaignWikiEditor } from "./CampaignWikiEditor";
import { CampaignWikiOwnerLink } from "./CampaignWikiOwnerLink";
import { CampaignWikiEvidence } from "./CampaignWikiEvidence";
import { CampaignWikiCommitments } from "./CampaignWikiCommitments";
import { CampaignWikiFacts } from "./CampaignWikiFacts";
import { CampaignWikiInfobox, type CampaignWikiView } from "./CampaignWikiInfobox";
import {
  EntityChipButton,
  EntityRefName,
  FactLabelBadge,
  Pager,
  RAW_ID,
  SessionChip,
  WhenChip,
  WikiErrorState as ErrorState,
  displayEntityName,
  enumLabel,
  kindLabel,
  portraitFor,
  readableValue,
  stateTargetId,
  useCharacterPortraits,
  type FactLabel,
  type TFn,
} from "./CampaignWikiReaderParts";
import {
  ENTITY_KIND_ICONS,
  EntityAvatar,
  WikiCard,
  WikiChip,
  WikiEmpty,
  WikiSectionHeader,
  WikiSkeleton,
  WikiStat,
  entitySessionNumbers,
  factDisplay,
  formatCaptureOrder,
  formatSessionRanges,
  humanizeKey,
  recordOrigin,
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

/** Event text for the reader; an id stored in place of a summary is never shown. */
function eventSummary(t: TFn, summary: string | null | undefined): string {
  const text = summary?.trim();
  const idsOnly = text?.split(/\s+/u).every((token) => RAW_ID.test(token));
  return text && !idsOnly ? text : t("ui.game.campaignWiki.eventRecorded");
}

/** Name of a page that is not in the loaded detail; shows a neutral label until it arrives. */
type SourceFreshness = "current" | "stale" | "legacy" | "manual";

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

/** Page size of the entity detail route (every section shares one offset; the server allows up to 100). */
const DETAIL_PAGE_SIZE = 50;

function Detail({
  detail,
  chatId,
  onSelect,
  onPageChange,
  onEdit,
  onCorrectFact,
  portraits,
}: {
  detail: CampaignMemoryEntityDetail;
  chatId: string;
  onBack: () => void;
  onSelect: (id: string) => void;
  onPageChange: (offset: number) => void;
  onEdit: () => void;
  onCorrectFact: (fact: CampaignMemoryFactWithCoHolders) => void;
  portraits: Map<string, string>;
}) {
  const { t } = useUiTranslation();
  const { entity, knowledge, events, relationships, relatedEntities } = detail;
  const facts = detail.facts.items as CampaignMemoryFactWithCoHolders[];
  const factTotal = detail.facts.total;
  const sourceChecks = detail.sourceChecks ?? {};
  const [view, setView] = useState<CampaignWikiView>("facts");
  // Display-only perspective: "gm" shows everything; a holder id filters facts to what that holder knows.
  const [perspective, setPerspective] = useState("gm");
  const holders = useMemo(() => {
    const byId = new Map<string, CampaignMemoryCoHolder>();
    if (entity.kind === "character" || entity.kind === "persona") {
      byId.set(entity.entityId, {
        entityId: entity.entityId,
        alias: displayEntityName(t, entity),
        epistemicState: "knows",
      });
    }
    for (const fact of facts)
      for (const holder of fact.coHolders ?? []) if (!byId.has(holder.entityId)) byId.set(holder.entityId, holder);
    return [...byId.values()].filter((holder) => holder.alias && !RAW_ID.test(holder.alias));
  }, [entity, facts, t]);
  const holderState = (fact: CampaignMemoryFactWithCoHolders) =>
    perspective === entity.entityId
      ? knowledge.items.find((item) => item.factId === fact.factId)?.epistemicState
      : fact.coHolders?.find((holder) => holder.entityId === perspective)?.epistemicState;
  const referencedFactById = new Map(detail.referencedFacts.map((fact) => [fact.factId, fact]));
  const related = new Map(relatedEntities.map((item) => [item.entityId, item]));
  const nameOf = (id: string) => {
    const found = related.get(id) ?? (id === entity.entityId ? entity : undefined);
    return found ? displayEntityName(t, found) : null;
  };
  const detailOffset = Math.max(
    detail.facts.offset,
    knowledge.offset,
    events.offset,
    detail.currentState.offset,
    relationships.offset,
  );
  const detailLimit = Math.max(
    detail.facts.limit,
    knowledge.limit,
    events.limit,
    detail.currentState.limit,
    relationships.limit,
  );
  const sessions = entitySessionNumbers(entity);
  const name = displayEntityName(t, entity);
  const KindIcon = ENTITY_KIND_ICONS[entity.kind];
  const otherAliases = entity.aliases.filter((alias) => alias !== name && !RAW_ID.test(alias));
  const body = (entity as { body?: string }).body;
  const person = entity.kind === "character" || entity.kind === "persona";
  const pager = (shown: number, total: number) => (
    <Pager offset={detailOffset} limit={detailLimit} total={total} shown={shown} onChange={onPageChange} />
  );
  const showView = (next: CampaignWikiView) => {
    setView(next);
    // One offset pages every section; a page from another view would skip or empty this one.
    if (detailOffset > 0) onPageChange(0);
  };
  // Stored events carry no prose; a fact citing the same message and quote says what happened.
  const factTextByEvidence = new Map<string, string>();
  for (const fact of facts) {
    if (fact.status === "retracted" || fact.status === "superseded") continue;
    for (const item of fact.evidence) {
      const key = `${item.messageId}|${item.quote ?? ""}`;
      if (!factTextByEvidence.has(key)) factTextByEvidence.set(key, factDisplay(fact).text);
    }
  }
  const meta = [
    <span key="kind" className="inline-flex items-center gap-1">
      <KindIcon size={13} aria-hidden="true" />
      {kindLabel(t, entity.kind)}
    </span>,
    sessions.length > 0 &&
      t("ui.game.campaignWiki.reader.sessions", {
        defaultValue: "Sessions {{list}}",
        list: formatSessionRanges(sessions),
      }),
    t("ui.game.campaignWiki.article.factCount", {
      defaultValue: "{{formattedCount}} facts",
      count: factTotal,
      formattedCount: factTotal.toLocaleString(),
    }),
    knowledge.total > 0 &&
      t("ui.game.campaignWiki.article.secretCount", {
        defaultValue: "{{formattedCount}} secrets",
        count: knowledge.total,
        formattedCount: knowledge.total.toLocaleString(),
      }),
  ].filter(Boolean);
  const viewTitle: Record<Exclude<CampaignWikiView, "facts">, string> = {
    knowledge: person
      ? t("ui.game.campaignWiki.reader.tabKnows", { defaultValue: "What they know" })
      : t("ui.game.campaignWiki.reader.tabKnowledge", { defaultValue: "Who knows" }),
    events: t("ui.game.campaignWiki.reader.tabEvents", { defaultValue: "Events" }),
    connections: t("ui.game.campaignWiki.reader.tabConnections", { defaultValue: "Connections" }),
    timeline: t("ui.game.campaignWiki.timeline"),
    commitments: t("ui.game.campaignWiki.reader.tabCommitments", { defaultValue: "Promises & quests" }),
    details: t("ui.game.campaignWiki.reader.tabDetails", { defaultValue: "Details" }),
  };
  const lead = (entity.summary || body) && (
    <section className="space-y-3 [grid-area:lead]">
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
  );

  return (
    <article
      className="@container mx-auto w-full min-w-0 max-w-[68rem] space-y-5 pb-10 [overflow-wrap:anywhere]"
      data-component="campaign-wiki-article"
    >
      <header className="flex flex-col gap-4 border-b border-border pb-5 @xl:flex-row @xl:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-4">
          <EntityAvatar
            name={name}
            kind={entity.kind}
            size={88}
            imageUrl={portraitFor(entity, portraits)}
            className="shadow-[0_0_16px_color-mix(in_srgb,var(--primary)_24%,transparent)]"
          />
          <div className="min-w-0 flex-1">
            <h2 className="text-2xl font-bold leading-tight text-foreground @xl:text-[1.75rem]">{name}</h2>
            {otherAliases.length > 0 && (
              <p className="mt-0.5 text-sm italic text-muted-foreground">
                {t("ui.game.campaignWiki.reader.alsoKnownAs", {
                  defaultValue: "Also known as {{names}}",
                  names: otherAliases.join(", "),
                })}
              </p>
            )}
            <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
              {meta.map((part, index) => (
                <span key={index} className="inline-flex items-center gap-2">
                  {index > 0 && <span aria-hidden="true">·</span>}
                  {part}
                </span>
              ))}
            </p>
            {(entity.status === "archived" || entity.manualLock) && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {entity.status === "archived" && (
                  <WikiChip tone="warning">{enumLabel(t, "recordStatus", "archived")}</WikiChip>
                )}
                {entity.manualLock && (
                  <WikiChip tone="info">
                    {t("ui.game.campaignWiki.reader.locked", { defaultValue: "Protected from automatic changes" })}
                  </WikiChip>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 @xl:max-w-[22rem] @xl:justify-end">
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
            <label className="inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-lg border border-border px-2 text-xs">
              <Eye size={13} className="shrink-0 text-muted-foreground" />
              <span className="sr-only">{t("ui.game.campaignWiki.perspective")}</span>
              <select
                value={perspective}
                onChange={(event) => setPerspective(event.target.value)}
                title={t("ui.game.campaignWiki.perspectiveNote")}
                className="min-h-8 min-w-0 max-w-[12rem] bg-transparent text-xs outline-none"
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
      </header>

      <div
        className={cn(
          "grid gap-5 @3xl:grid-cols-[minmax(0,1fr)_16rem] @3xl:grid-rows-[auto_1fr] @3xl:items-start",
          lead
            ? "[grid-template-areas:'lead'_'box'_'main'] @3xl:[grid-template-areas:'lead_box'_'main_box']"
            : "[grid-template-areas:'box'_'main'] @3xl:[grid-template-areas:'main_box'_'main_box']",
        )}
      >
        {lead}
        <div className="min-w-0 [grid-area:box] @3xl:sticky @3xl:top-2">
          <CampaignWikiInfobox
            chatId={chatId}
            detail={detail}
            view={view}
            onView={showView}
            onSelect={onSelect}
            portraits={portraits}
            factTotal={factTotal}
          />
        </div>
        <div className="min-w-0 space-y-4 [grid-area:main]">
          {view !== "facts" && (
            <div className="flex flex-wrap items-center gap-2 border-b border-border pb-2">
              <button
                type="button"
                onClick={() => showView("facts")}
                className="-ml-2 inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <ArrowLeft size={14} aria-hidden="true" />
                {t("ui.game.campaignWiki.article.allFacts", { defaultValue: "All facts" })}
              </button>
              <h3 className="text-base font-bold text-foreground">{viewTitle[view]}</h3>
            </div>
          )}

          {view === "facts" && (
            <CampaignWikiFacts
              chatId={chatId}
              entity={entity}
              detail={detail}
              labelFor={factLabel}
              holderStateFor={holderState}
              perspectiveActive={perspective !== "gm"}
              related={related}
              portraits={portraits}
              onSelect={onSelect}
              onCorrect={onCorrectFact}
            />
          )}

          {view === "knowledge" && (
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

          {view === "events" && (
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
                  const happened = item.evidence
                    .map((evidence) => factTextByEvidence.get(`${evidence.messageId}|${evidence.quote ?? ""}`))
                    .find(Boolean);
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
                      {(happened || !quote) && (
                        <p className="mt-2 text-sm leading-6 text-foreground">
                          {happened || t("ui.game.campaignWiki.eventRecorded")}
                        </p>
                      )}
                      {quote && (
                        <p
                          className={cn(
                            "italic",
                            happened
                              ? "mt-1 text-xs leading-5 text-muted-foreground"
                              : "mt-2 text-sm leading-6 text-foreground/90",
                          )}
                        >
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
                      {item.evidence.length > (quote ? 1 : 0) && (
                        <CampaignWikiEvidence
                          chatId={chatId}
                          sourceChatId={recordOrigin(item).chatId ?? chatId}
                          evidence={quote ? item.evidence.slice(1) : item.evidence}
                        />
                      )}
                    </WikiCard>
                  );
                })}
              {pager(events.items.length, events.total)}
            </section>
          )}

          {view === "connections" && (
            <section className="space-y-2.5" aria-label={t("ui.game.campaignWiki.relationships")}>
              {relationships.items.length === 0 && (
                <WikiEmpty
                  icon={<Link2 size={22} />}
                  title={t("ui.game.campaignWiki.reader.noConnectionsTitle", {
                    defaultValue: "No recorded connections",
                  })}
                />
              )}
              <div className="grid gap-2 @xl:grid-cols-2">
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

          {view === "timeline" && (
            <CampaignWikiTimeline
              chatId={chatId}
              entityId={entity.kind === "location" ? undefined : entity.entityId}
              locationId={entity.kind === "location" ? entity.entityId : undefined}
              heading={t("ui.game.campaignWiki.timeline")}
              onSelect={onSelect}
              portraits={portraits}
            />
          )}

          {view === "commitments" && (
            <CampaignWikiCommitments chatId={chatId} entityId={entity.entityId} onNavigate={onSelect} />
          )}

          {view === "details" && (
            <section className="space-y-3">
              <WikiCard>
                <dl className="grid gap-x-6 gap-y-2 text-sm @xl:grid-cols-2">
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
                    <div className="@xl:col-span-2">
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
              </details>
            </section>
          )}
        </div>
      </div>
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
                      {item.location && item.location.alias && !RAW_ID.test(item.location.alias) && (
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
                      {item.stateChanges.map((change, index) => {
                        const target = stateTargetId(change.value);
                        const known = target
                          ? [item.location, ...item.participants].find((ref) => ref?.entityId === target)?.alias
                          : undefined;
                        return (
                          <li key={`${change.entityId}-${change.key}-${index}`}>
                            {humanizeKey(change.key)}:{" "}
                            {!target ? (
                              readableValue(change.value)
                            ) : known && !RAW_ID.test(known) ? (
                              known
                            ) : (
                              <EntityRefName chatId={chatId} entityId={target} />
                            )}
                          </li>
                        );
                      })}
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
  // The reader's "Correct" action opens the editor on one fact (possibly from a later fact page).
  const [correctingFact, setCorrectingFact] = useState<CampaignMemoryFactWithCoHolders | null>(null);
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
  const detail = useCampaignMemoryEntity(chatId, selectedId, { offset: detailOffset, limit: DETAIL_PAGE_SIZE });
  // Paging changes the query key; keep the loaded page on screen meanwhile so the open tab and perspective survive.
  const [keptDetail, setKeptDetail] = useState<CampaignMemoryEntityDetail | null>(null);
  if (detail.data && detail.data !== keptDetail) setKeptDetail(detail.data);
  const shownDetail =
    detail.data ?? (detail.isLoading && keptDetail?.entity.entityId === selectedId ? keptDetail : undefined);
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
            {selectedId && detail.isLoading && !shownDetail && (
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
              shownDetail &&
              (editing ? (
                <CampaignWikiEditor
                  chatId={chatId}
                  detail={
                    correctingFact
                      ? {
                          ...shownDetail,
                          facts: {
                            ...shownDetail.facts,
                            items: [
                              correctingFact,
                              ...shownDetail.facts.items.filter((fact) => fact.factId !== correctingFact.factId),
                            ],
                          },
                        }
                      : shownDetail
                  }
                  initialFactId={correctingFact?.factId}
                  initialTab={correctingFact ? "correction" : undefined}
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
                  key={shownDetail.entity.entityId}
                  chatId={chatId}
                  detail={shownDetail}
                  onBack={() => void closeReading()}
                  onSelect={selectEntity}
                  onPageChange={setDetailOffset}
                  onEdit={() => {
                    setCorrectingFact(null);
                    setEditorDirty(false);
                    setEditing(true);
                  }}
                  onCorrectFact={(fact) => {
                    setCorrectingFact(fact);
                    setEditorDirty(false);
                    setEditing(true);
                  }}
                  portraits={portraits}
                />
              ))}
            {selected && !shownDetail && !detail.isLoading && !detail.isError && (
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
