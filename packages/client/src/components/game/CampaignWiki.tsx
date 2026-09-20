import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ChevronRight,
  Database,
  History,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  RotateCw,
  Search,
} from "lucide-react";
import type {
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
} from "../../hooks/use-campaign-memory";
import { useChat } from "../../hooks/use-chats";
import type { CampaignWikiNavigationProps } from "./CampaignWikiWindow";
import { CampaignWikiEditor } from "./CampaignWikiEditor";
import { CampaignWikiOwnerLink } from "./CampaignWikiOwnerLink";
import { CampaignWikiEvidence } from "./CampaignWikiEvidence";
import { CampaignWikiCommitments } from "./CampaignWikiCommitments";

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

function valueText(value: CampaignMemoryJson | undefined): string {
  return wikiValueSummary(value);
}

function WikiValue({ value }: { value: CampaignMemoryJson | undefined }) {
  const { t } = useUiTranslation();
  const record = wikiValueRecord(value);
  return (
    <div className="min-w-0 [overflow-wrap:anywhere]">
      {valueText(value)}
      {record && (
        <details className="mt-1 text-xs text-[var(--muted-foreground)]">
          <summary className="cursor-pointer">{t("ui.game.campaignWiki.rawRecord")}</summary>
          <pre className="mt-1 max-w-full overflow-x-auto whitespace-pre-wrap break-all">
            {JSON.stringify(record, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

function enumLabel(t: (key: string, options?: Record<string, unknown>) => string, group: string, value: string) {
  return t(`ui.game.campaignWiki.${group}.${value}`, { defaultValue: value });
}

function displayEntityName(
  t: (key: string, options?: Record<string, unknown>) => string,
  entity: Pick<CampaignMemoryEntityListItem, "aliases" | "entityId" | "kind">,
) {
  const alias = entity.aliases.find((value) => value.trim() && !/^cme_[a-f0-9-]+$/i.test(value.trim()));
  return alias || t("ui.game.campaignWiki.untitledEntity", { kind: enumLabel(t, "kind", entity.kind) });
}

function PageTotal({ page, label }: { page: CampaignMemoryPage<unknown>; label: string }) {
  const { t } = useUiTranslation();
  return (
    <p className="text-[0.625rem] text-[var(--muted-foreground)]">
      {t("ui.game.campaignWiki.sectionTotal", { label, shown: page.items.length, total: page.total })}
    </p>
  );
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

function FactLabelBadge({ label }: { label: FactLabel }) {
  const { t } = useUiTranslation();
  const className =
    label === "disputed" || label === "stale"
      ? "border-[var(--destructive)] text-[var(--destructive)]"
      : label === "verified"
        ? "border-[var(--primary)] text-[var(--foreground)]"
        : "border-[var(--border)] text-[var(--muted-foreground)]";
  return (
    <span
      role="status"
      title={t(`ui.game.campaignWiki.factLabelHint.${label}`)}
      className={`inline-flex rounded border px-1.5 py-0.5 text-[0.625rem] ${className}`}
    >
      {t(`ui.game.campaignWiki.factLabel.${label}`)}
    </span>
  );
}

function SourceFreshnessBadge({ state }: { state: SourceFreshness }) {
  const { t } = useUiTranslation();
  const label = t(`ui.game.campaignWiki.sourceFreshness.${state}`);
  const className =
    state === "stale"
      ? "border-[var(--destructive)] text-[var(--destructive)]"
      : "border-[var(--border)] text-[var(--muted-foreground)]";
  return (
    <span role="status" className={`ml-2 inline-flex rounded border px-1.5 py-0.5 text-[0.625rem] ${className}`}>
      {label}
    </span>
  );
}

function Detail({
  detail,
  chatId,
  onSelect,
  onPageChange,
  onEdit,
}: {
  detail: CampaignMemoryEntityDetail;
  chatId: string;
  onBack: () => void;
  onSelect: (id: string) => void;
  onPageChange: (offset: number) => void;
  onEdit: () => void;
}) {
  const { t } = useUiTranslation();
  const { entity, knowledge, events, currentState, relationships, relatedEntities } = detail;
  const facts = detail.facts as CampaignMemoryPage<CampaignMemoryFactWithCoHolders>;
  // Display-only perspective: "gm" shows everything; a holder id filters facts to what that holder knows.
  const [perspective, setPerspective] = useState("gm");
  const holders = useMemo(() => {
    const byId = new Map<string, CampaignMemoryCoHolder>();
    if (entity.kind === "character" || entity.kind === "persona") {
      byId.set(entity.entityId, {
        entityId: entity.entityId,
        alias: entity.aliases[0] || entity.entityId,
        epistemicState: "knows",
      });
    }
    for (const fact of facts.items)
      for (const holder of fact.coHolders ?? []) if (!byId.has(holder.entityId)) byId.set(holder.entityId, holder);
    return [...byId.values()];
  }, [entity, facts.items]);
  const holderState = (fact: CampaignMemoryFactWithCoHolders) =>
    perspective === entity.entityId
      ? knowledge.items.find((item) => item.factId === fact.factId)?.epistemicState
      : fact.coHolders?.find((holder) => holder.entityId === perspective)?.epistemicState;
  const visibleFacts =
    perspective === "gm" ? facts.items : facts.items.filter((fact) => holderState(fact) !== undefined);
  const referencedEvents = detail.referencedEvents ?? [];
  const referencedEventById = new Map(referencedEvents.map((item) => [item.eventId, item]));
  const sourceChecks = detail.sourceChecks ?? {};
  const referencedFacts =
    (
      detail as CampaignMemoryEntityDetail & {
        referencedFacts?: Array<{ factId: string; predicate: string; value: CampaignMemoryJson }>;
      }
    ).referencedFacts ?? [];
  const referencedFactById = new Map(referencedFacts.map((fact) => [fact.factId, fact]));
  const related = new Map(relatedEntities.map((item) => [item.entityId, item]));
  const detailTotal = Math.max(facts.total, knowledge.total, events.total, currentState.total, relationships.total);
  const detailOffset = Math.max(
    facts.offset,
    knowledge.offset,
    events.offset,
    currentState.offset,
    relationships.offset,
  );
  const detailLimit = Math.max(facts.limit, knowledge.limit, events.limit, currentState.limit, relationships.limit);
  return (
    <div className="mx-auto w-full min-w-0 max-w-[80ch] space-y-5 pb-6 [overflow-wrap:anywhere]">
      <header className="border-b border-[var(--border)] pb-3">
        <p className="text-[0.625rem] uppercase tracking-wide text-[var(--muted-foreground)]">
          {enumLabel(t, "kind", entity.kind)}
        </p>
        <h3 className="text-xl font-semibold tracking-tight text-[var(--foreground)]">
          {displayEntityName(t, entity)}
        </h3>
        {entity.aliases.length > 1 && (
          <p className="mt-1 text-xs text-[var(--muted-foreground)]">{entity.aliases.join(" · ")}</p>
        )}
        <CampaignWikiOwnerLink owner={entity.owner} fallbackName={entity.aliases[0] || entity.entityId} />
        <button
          type="button"
          onClick={onEdit}
          className="mt-3 min-h-10 rounded-md border border-[var(--border)] px-3 text-xs hover:bg-[var(--secondary)]"
        >
          {t("ui.game.campaignWiki.editor.edit")}
        </button>
        <details className="mt-2 text-[0.625rem] text-[var(--muted-foreground)]">
          <summary className="cursor-pointer">{t("ui.game.campaignWiki.sourceDetails")}</summary>
          <p className="mt-1 break-all">
            {t("ui.game.campaignWiki.sourceInfo", {
              source: entity.provenance.source,
              revision: entity.provenance.sourceRevision,
            })}
          </p>
        </details>
      </header>
      {entity.summary && (
        <section>
          <h4 className="mb-1 text-sm font-semibold">{t("ui.game.campaignWiki.summary")}</h4>
          <p className="text-sm leading-7 text-[var(--foreground)]">{entity.summary}</p>
        </section>
      )}
      {(entity as { body?: string }).body && (
        <section>
          <h4 className="mb-1 text-xs font-semibold">{t("ui.game.campaignWiki.notes")}</h4>
          <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-7 text-[var(--foreground)]">
            {(entity as { body?: string }).body}
          </pre>
        </section>
      )}
      {holders.length > 0 && (
        <div className="rounded-md border border-[var(--border)] p-2 text-xs">
          <label className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{t("ui.game.campaignWiki.perspective")}</span>
            <select
              value={perspective}
              onChange={(event) => setPerspective(event.target.value)}
              className="min-h-9 min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 text-xs"
            >
              <option value="gm">{t("ui.game.campaignWiki.perspective.gm")}</option>
              {holders.map((holder) => (
                <option key={holder.entityId} value={holder.entityId}>
                  {t("ui.game.campaignWiki.perspective.holder", { name: holder.alias || holder.entityId })}
                </option>
              ))}
            </select>
          </label>
          <p className="mt-1 text-[0.625rem] text-[var(--muted-foreground)]">
            {t("ui.game.campaignWiki.perspectiveNote")}
          </p>
        </div>
      )}
      <WikiSection title={t("ui.game.campaignWiki.facts")} page={facts}>
        {perspective !== "gm" && visibleFacts.length < facts.items.length && (
          <p className="text-xs text-[var(--muted-foreground)]">
            {t("ui.game.campaignWiki.perspectiveHidden", { count: facts.items.length - visibleFacts.length })}
          </p>
        )}
        {visibleFacts.map((fact) => (
          <div key={fact.factId} className="rounded-md border border-[var(--border)] p-3 text-sm">
            <div>
              <strong>{fact.predicate}</strong>: <WikiValue value={fact.value} />
            </div>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--muted-foreground)]">
              <FactLabelBadge label={factLabel(fact, sourceChecks[fact.factId]?.state, facts.items)} />
              <span>{t("ui.game.campaignWiki.status", { status: enumLabel(t, "factStatus", fact.status) })}</span>
              {wikiValueRecord(fact.value)?.status !== undefined && (
                <span>
                  {t("ui.game.campaignWiki.claimStatus", { status: String(wikiValueRecord(fact.value)?.status) })}
                </span>
              )}
              {sourceChecks[fact.factId] && <SourceFreshnessBadge state={sourceChecks[fact.factId].state} />}
              {perspective !== "gm" && holderState(fact) && (
                <span>{enumLabel(t, "epistemicState", holderState(fact) ?? "unknown")}</span>
              )}
              {fact.conditions.length
                ? t("ui.characters.characterversionhistorypanel.value1", {
                    value1: t("ui.game.campaignWiki.conditions", { count: fact.conditions.length }),
                  })
                : ""}
            </p>
            {fact.coHolders && fact.coHolders.length > 0 && (
              <p className="mt-2 flex flex-wrap items-center gap-1 text-[0.625rem] text-[var(--muted-foreground)]">
                <span>{t("ui.game.campaignWiki.coHolders")}</span>
                {fact.coHolders.map((holder) => (
                  <button
                    type="button"
                    key={holder.entityId}
                    onClick={() => onSelect(holder.entityId)}
                    className="min-h-8 rounded border border-[var(--border)] px-2 hover:bg-[var(--secondary)]"
                  >
                    {holder.alias || holder.entityId} · {enumLabel(t, "epistemicState", holder.epistemicState)}
                  </button>
                ))}
              </p>
            )}
            {fact.conditions.length > 0 && (
              <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-[var(--muted-foreground)]">
                {fact.conditions.map((condition, index) => (
                  <li key={`${condition.kind}-${index}`}>
                    {condition.kind}: <WikiValue value={condition.value} />
                  </li>
                ))}
              </ul>
            )}
            <CampaignWikiEvidence chatId={chatId} evidence={fact.evidence} />
          </div>
        ))}
      </WikiSection>
      <WikiSection title={t("ui.game.campaignWiki.knowledge")} page={knowledge}>
        {knowledge.items.map((item) => {
          const fact = item.factId ? referencedFactById.get(item.factId) : undefined;
          return (
            <div key={item.knowledgeId} className="rounded-md border border-[var(--border)] p-3 text-sm">
              <p>
                <strong>{enumLabel(t, "epistemicState", item.epistemicState)}</strong>
                {sourceChecks[item.knowledgeId] && (
                  <SourceFreshnessBadge state={sourceChecks[item.knowledgeId].state} />
                )}
                {item.confidence
                  ? t("ui.characters.characterversionhistorypanel.value1", {
                      value1: enumLabel(t, "confidence", item.confidence),
                    })
                  : ""}
              </p>
              {item.attributedClaim ? (
                <div className="mt-1 text-[var(--muted-foreground)]">
                  {item.attributedClaim.predicate}: <WikiValue value={item.attributedClaim.value} />
                </div>
              ) : fact ? (
                <div className="mt-1 text-[var(--muted-foreground)]">
                  {fact.predicate}: <WikiValue value={fact.value} />
                </div>
              ) : item.factId ? (
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                  {t("ui.game.campaignWiki.knownFactReference", { factId: item.factId })}
                </p>
              ) : (
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                  {t("ui.game.campaignWiki.knowledgeClaimUnavailable")}
                </p>
              )}
              <CampaignWikiEvidence chatId={chatId} evidence={item.learnedFrom} />
            </div>
          );
        })}
      </WikiSection>
      <WikiSection title={t("ui.game.campaignWiki.currentState")} page={currentState}>
        <div className="space-y-2">
          {currentState.items.map((item) => (
            <div key={item.stateId} className="rounded-md border border-[var(--border)] p-2 text-xs">
              <strong>{item.property}</strong>: <WikiValue value={item.value} />
              <p className="mt-1 text-[0.625rem] text-[var(--muted-foreground)]">
                {t("ui.game.campaignWiki.validAtCaptureOrder", { order: item.validAtOrder })}
                {sourceChecks[item.stateId] && <SourceFreshnessBadge state={sourceChecks[item.stateId].state} />}
              </p>
              {(() => {
                const sourceEvent = referencedEventById.get(item.sourceEventId);
                return sourceEvent ? (
                  <div className="mt-2 rounded border border-[var(--border)] p-2 text-[0.625rem]">
                    <p className="font-medium">{t("ui.game.campaignWiki.stateCause")}</p>
                    <p className="mt-1 whitespace-pre-wrap break-words text-[var(--muted-foreground)]">
                      {sourceEvent.transitions.join(" · ") || t("ui.game.campaignWiki.eventRecorded")}
                      {sourceChecks[sourceEvent.eventId] && (
                        <SourceFreshnessBadge state={sourceChecks[sourceEvent.eventId].state} />
                      )}
                    </p>
                    <CampaignWikiEvidence chatId={chatId} evidence={sourceEvent.evidence} />
                  </div>
                ) : (
                  <p className="mt-2 text-[0.625rem] text-[var(--destructive)]">
                    {t("ui.game.campaignWiki.stateCauseUnavailable")}
                  </p>
                );
              })()}
            </div>
          ))}
        </div>
      </WikiSection>
      <WikiSection title={t("ui.game.campaignWiki.events")} page={events}>
        <div className="space-y-2">
          {events.items.map((item) => (
            <div key={item.eventId} className="rounded-md border border-[var(--border)] p-2 text-xs">
              <p>{item.transitions.join(" · ") || t("ui.game.campaignWiki.eventRecorded")}</p>
              <p className="mt-1 text-[0.625rem] text-[var(--muted-foreground)]">
                {item.campaignTime && (
                  <span>{t("ui.game.campaignWiki.campaignTime", { time: item.campaignTime })}</span>
                )}
                <span className={item.campaignTime ? "ml-2" : ""}>
                  {t("ui.game.campaignWiki.recordedAtCaptureOrder", { order: item.occurrenceOrder })}
                </span>
                {sourceChecks[item.eventId] && <SourceFreshnessBadge state={sourceChecks[item.eventId].state} />}
              </p>
              <CampaignWikiEvidence chatId={chatId} evidence={item.evidence} />
            </div>
          ))}
        </div>
      </WikiSection>
      <CampaignWikiTimeline
        chatId={chatId}
        entityId={entity.kind === "location" ? undefined : entity.entityId}
        locationId={entity.kind === "location" ? entity.entityId : undefined}
        heading={t("ui.game.campaignWiki.timeline")}
        onSelect={onSelect}
      />
      <CampaignWikiCommitments chatId={chatId} entityId={entity.entityId} onNavigate={onSelect} />
      <WikiSection title={t("ui.game.campaignWiki.relationships")} page={relationships}>
        <div className="space-y-1">
          {relationships.items.map((item) => {
            const targetId = item.direction === "outgoing" ? item.targetEntityId : item.sourceEntityId;
            const target = related.get(targetId);
            return (
              <div key={item.relationshipId} className="rounded-md border border-[var(--border)] p-2">
                <button
                  type="button"
                  onClick={() => onSelect(targetId)}
                  className="flex min-h-10 w-full items-center justify-between text-left text-sm hover:bg-[var(--secondary)]"
                >
                  <span>
                    {item.label} · {target?.aliases[0] || targetId}
                    <small className="mt-1 block text-xs text-[var(--muted-foreground)]">
                      {item.type} · {enumLabel(t, "relationshipStatus", item.status)}
                      {item.effectiveFrom &&
                        t("ui.game.campaignWiki.relationshipEffectiveFrom", { order: item.effectiveFrom })}
                      {item.effectiveTo &&
                        t("ui.game.campaignWiki.relationshipEffectiveTo", { order: item.effectiveTo })}
                      {sourceChecks[item.relationshipId] && (
                        <SourceFreshnessBadge state={sourceChecks[item.relationshipId].state} />
                      )}
                    </small>
                  </span>
                  <ChevronRight size={13} />
                </button>
                <CampaignWikiEvidence chatId={chatId} evidence={item.evidence} />
              </div>
            );
          })}
        </div>
      </WikiSection>
      <details className="rounded-md border border-[var(--border)] px-2 py-1.5">
        <summary className="cursor-pointer text-[0.625rem] text-[var(--muted-foreground)]">
          {t("ui.game.campaignWiki.provenance")}
        </summary>
        <p className="mt-2 text-[0.625rem] text-[var(--muted-foreground)]">
          {entity.provenance.source} · {entity.provenance.sourceRevision} · {entity.provenance.actor}
        </p>
      </details>
      {detailTotal > detailLimit && (
        <div className="flex items-center justify-between gap-2 border-t border-[var(--border)] pt-3">
          <p className="text-xs text-[var(--muted-foreground)]">
            {t("ui.game.campaignWiki.detailTotal", {
              shown: Math.min(
                detailOffset +
                  Math.max(
                    facts.items.length,
                    knowledge.items.length,
                    events.items.length,
                    currentState.items.length,
                    relationships.items.length,
                  ),
                detailTotal,
              ),
              total: detailTotal,
            })}
          </p>
          <div className="flex gap-1">
            <button
              type="button"
              disabled={detailOffset === 0}
              onClick={() => onPageChange(Math.max(0, detailOffset - detailLimit))}
              className="min-h-9 rounded-md border border-[var(--border)] px-2 text-xs disabled:opacity-40"
            >
              {t("ui.game.campaignWiki.previous")}
            </button>
            <button
              type="button"
              disabled={detailOffset + detailLimit >= detailTotal}
              onClick={() => onPageChange(detailOffset + detailLimit)}
              className="min-h-9 rounded-md border border-[var(--border)] px-2 text-xs disabled:opacity-40"
            >
              {t("ui.game.campaignWiki.next")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function CampaignWikiTimeline({
  chatId,
  entityId,
  locationId,
  heading,
  onSelect,
}: {
  chatId: string;
  entityId?: string;
  locationId?: string;
  heading: string;
  onSelect: (id: string) => void;
}) {
  const { t } = useUiTranslation();
  // Cursor history: the last entry is the current page; Previous pops, Next pushes nextCursor.
  const [cursors, setCursors] = useState<string[]>([]);
  const timeline = useCampaignMemoryTimeline(chatId, { entityId, locationId, cursor: cursors[cursors.length - 1] });
  const page = timeline.data;
  const nextCursor = page?.nextCursor ?? null;
  return (
    <section className="space-y-2" aria-label={heading}>
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold text-[var(--foreground)]">{heading}</h4>
        {cursors.length > 0 && (
          <p className="text-[0.625rem] text-[var(--muted-foreground)]">
            {t("ui.game.campaignWiki.timelinePage", { page: cursors.length + 1 })}
          </p>
        )}
      </div>
      {timeline.isLoading && (
        <div className="flex items-center gap-2 py-3 text-xs text-[var(--muted-foreground)]">
          <Loader2 size={14} className="animate-spin" />
          {t("ui.game.campaignWiki.timelineLoading")}
        </div>
      )}
      {timeline.isError && <ErrorState onRetry={() => void timeline.refetch()} />}
      {page && page.items.length === 0 && (
        <p className="text-xs text-[var(--muted-foreground)]">{t("ui.game.campaignWiki.timelineEmpty")}</p>
      )}
      {page && page.items.length > 0 && (
        <ol className="space-y-2">
          {page.items.map((item) => {
            const location = item.location;
            return (
              <li key={item.eventId} className="rounded-md border border-[var(--border)] p-2 text-xs">
                <p className="break-words">{item.summary || t("ui.game.campaignWiki.eventRecorded")}</p>
                <p className="mt-1 text-[0.625rem] text-[var(--muted-foreground)]">
                  <span>
                    {item.campaignTime
                      ? t("ui.game.campaignWiki.campaignTime", { time: item.campaignTime })
                      : t("ui.game.campaignWiki.timelineUnknownTime")}
                  </span>
                  <span className="ml-2">
                    {t("ui.game.campaignWiki.recordedAtCaptureOrder", { order: item.occurrenceOrder })}
                  </span>
                </p>
                {(location || item.participants.length > 0) && (
                  <p className="mt-1 flex flex-wrap items-center gap-1 text-[0.625rem] text-[var(--muted-foreground)]">
                    {location && (
                      <button
                        type="button"
                        onClick={() => onSelect(location.entityId)}
                        className="min-h-8 rounded border border-[var(--border)] px-2 hover:bg-[var(--secondary)]"
                      >
                        {t("ui.game.campaignWiki.timelineLocation", { name: location.alias || location.entityId })}
                      </button>
                    )}
                    {item.participants.length > 0 && <span>{t("ui.game.campaignWiki.timelineParticipants")}</span>}
                    {item.participants.map((participant) => (
                      <button
                        type="button"
                        key={participant.entityId}
                        onClick={() => onSelect(participant.entityId)}
                        className="min-h-8 rounded border border-[var(--border)] px-2 hover:bg-[var(--secondary)]"
                      >
                        {participant.alias || participant.entityId}
                      </button>
                    ))}
                  </p>
                )}
                {item.stateChanges.length > 0 && (
                  <div className="mt-1 text-[0.625rem] text-[var(--muted-foreground)]">
                    <p>{t("ui.game.campaignWiki.timelineStateChanges")}</p>
                    <ul className="list-disc pl-4">
                      {item.stateChanges.map((change, index) => (
                        <li key={`${change.entityId}-${change.key}-${index}`} className="break-words">
                          {change.entityId} · {change.key}: <WikiValue value={change.value} />
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {item.sourceMessageId && (
                  <p className="mt-1 break-all text-[0.625rem] text-[var(--muted-foreground)]">
                    {t("ui.game.campaignWiki.timelineSourceMessage", { id: item.sourceMessageId })}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {page && (cursors.length > 0 || nextCursor) && (
        <div className="flex justify-end gap-1">
          <button
            type="button"
            disabled={cursors.length === 0}
            onClick={() => setCursors((current) => current.slice(0, -1))}
            className="min-h-9 rounded-md border border-[var(--border)] px-2 text-xs disabled:opacity-40"
          >
            {t("ui.game.campaignWiki.previous")}
          </button>
          <button
            type="button"
            disabled={!nextCursor}
            onClick={() => nextCursor && setCursors((current) => [...current, nextCursor])}
            className="min-h-9 rounded-md border border-[var(--border)] px-2 text-xs disabled:opacity-40"
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

function WikiSection({
  title,
  page,
  children,
}: {
  title: string;
  page: CampaignMemoryPage<unknown>;
  children: ReactNode;
}) {
  const { t } = useUiTranslation();
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold text-[var(--foreground)]">{title}</h4>
        <PageTotal page={page} label={title} />
      </div>
      {page.items.length ? (
        children
      ) : (
        <p className="text-xs text-[var(--muted-foreground)]">{t("ui.game.campaignWiki.noRecords")}</p>
      )}
    </section>
  );
}

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
  const entities = useCampaignMemoryEntities(chatId, { query, kind, offset: entityOffset });
  const detail = useCampaignMemoryEntity(chatId, selectedId, { offset: detailOffset });
  const selected = useMemo(
    () => entities.data?.items.find((entity) => entity.entityId === selectedId),
    [entities.data, selectedId],
  );
  const listError = entities.isError;
  const listGroups = useMemo(() => groupByMatchTier(entities.data?.items ?? [], query), [entities.data, query]);
  const overviewGroups = useMemo(() => {
    const groups = new Map<CampaignMemoryEntityKind, CampaignMemoryEntityListItem[]>();
    for (const entity of entities.data?.items ?? []) {
      const items = groups.get(entity.kind) ?? [];
      items.push(entity);
      groups.set(entity.kind, items);
    }
    return KINDS.filter((kind): kind is CampaignMemoryEntityKind => kind !== "all" && groups.has(kind)).map((kind) => ({
      kind,
      items: groups.get(kind) ?? [],
    }));
  }, [entities.data]);
  const reading = Boolean(selectedId) || campaignTimeline;
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
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden text-[var(--foreground)]">
      <CampaignMemoryBranchNotice chat={chat} />
      <div className="flex min-h-0 flex-1 flex-col gap-3 md:flex-row">
        <section
          className={cn(
            "flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto md:w-[22rem] md:shrink-0 md:flex-none md:pr-2",
            reading && "hidden md:flex",
            navCollapsed && "md:hidden",
          )}
          aria-label={t("ui.game.campaignWiki.entities")}
        >
          <div className="mb-2 flex items-center gap-2">
            <Database size={14} className="text-[var(--primary)]" />
            <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{t("ui.game.campaignWiki.entities")}</h3>
            <button
              type="button"
              onClick={() => {
                if (!closeReading()) return;
                setCampaignTimeline(true);
              }}
              aria-pressed={campaignTimeline}
              title={t("ui.game.campaignWiki.campaignTimeline")}
              className={cn(
                "inline-flex min-h-9 items-center gap-1 rounded-md border px-2 text-xs",
                campaignTimeline
                  ? "border-[var(--primary)] bg-[var(--secondary)]"
                  : "border-[var(--border)] hover:bg-[var(--secondary)]",
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
              className="hidden min-h-9 items-center rounded-md border border-[var(--border)] px-2 text-[var(--muted-foreground)] hover:bg-[var(--secondary)] md:inline-flex"
            >
              <PanelLeftClose size={14} />
            </button>
          </div>
          <label className="relative block">
            <Search size={13} className="absolute left-2.5 top-2.5 text-[var(--muted-foreground)]" />
            <input
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              placeholder={t("ui.game.campaignWiki.searchPlaceholder")}
              aria-label={t("ui.game.campaignWiki.searchPlaceholder")}
              className="min-h-10 w-full rounded-md border border-[var(--border)] bg-[var(--background)] py-2 pl-8 pr-2 text-sm outline-none focus:border-[var(--primary)]"
            />
          </label>
          <div
            className="mt-2 flex flex-wrap gap-1 pb-1"
            role="group"
            aria-label={t("ui.game.campaignWiki.filterByKind")}
          >
            {KINDS.map((item) => (
              <button
                type="button"
                key={item}
                onClick={() => {
                  setKind(item);
                  setEntityOffset(0);
                }}
                aria-pressed={kind === item}
                className={cn(
                  "min-h-9 shrink-0 rounded-md px-3 py-1 text-xs",
                  kind === item
                    ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                    : "bg-[var(--secondary)] text-[var(--muted-foreground)]",
                )}
              >
                {enumLabel(t, "kind", item)}
              </button>
            ))}
          </div>
          {entities.isLoading && (
            <div className="flex items-center gap-2 py-5 text-xs text-[var(--muted-foreground)]">
              <Loader2 size={14} className="animate-spin" />
              {t("ui.game.campaignWiki.loading")}
            </div>
          )}
          {listError && <ErrorState onRetry={() => void entities.refetch()} />}
          {!entities.isLoading && !listError && entities.data && (
            <div className="space-y-3 py-5 text-xs text-[var(--muted-foreground)]">
              {entities.data.items.length === 0 && <p>{t("ui.game.campaignWiki.empty")}</p>}
              <button
                type="button"
                onClick={previewImport}
                disabled={importPreviewMutation.isPending || importApplyMutation.isPending}
                className="min-h-10 rounded-md border border-[var(--primary)] px-3 text-[var(--foreground)] disabled:opacity-50"
              >
                {importPreviewMutation.isPending
                  ? t("ui.game.campaignWiki.importPreviewing")
                  : t("ui.game.campaignWiki.importExisting")}
              </button>
              {importError && (
                <p className="text-[var(--destructive)]">
                  {importError === "sourceChanged"
                    ? t("ui.game.campaignWiki.importSourceChanged")
                    : t("ui.game.campaignWiki.importError")}
                </p>
              )}
              {importPreview && (
                <div className="space-y-2 rounded-md border border-[var(--border)] p-3">
                  <p>
                    {t("ui.game.campaignWiki.importSummary", { count: importPreview.manifest.counts.planned ?? 0 })}
                  </p>
                  <button
                    type="button"
                    onClick={applyImport}
                    disabled={importApplyMutation.isPending}
                    className="min-h-10 rounded-md bg-[var(--primary)] px-3 text-[var(--primary-foreground)] disabled:opacity-50"
                  >
                    {importApplyMutation.isPending
                      ? t("ui.game.campaignWiki.importApplying")
                      : t("ui.game.campaignWiki.importApply")}
                  </button>
                </div>
              )}
            </div>
          )}
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1" data-campaign-wiki-entity-list>
            {listGroups.map((group) => (
              <div key={group.tier ?? "all"} className="space-y-1">
                {group.tier && (
                  <p className="px-1 pt-2 text-[0.625rem] uppercase tracking-wide text-[var(--muted-foreground)]">
                    {t(`ui.game.campaignWiki.matchTier.${group.tier}`)}
                  </p>
                )}
                {group.items.map((entity) => (
                  <button
                    type="button"
                    key={entity.entityId}
                    onClick={() => selectEntity(entity.entityId)}
                    className={cn(
                      "flex min-h-10 w-full items-center justify-between rounded-md px-3 py-2 text-left transition-colors",
                      selectedId === entity.entityId
                        ? "bg-[var(--secondary)] text-[var(--primary)]"
                        : "hover:bg-[var(--secondary)]",
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{displayEntityName(t, entity)}</span>
                      <span className="block text-xs text-[var(--muted-foreground)]">
                        {enumLabel(t, "kind", entity.kind)} · {enumLabel(t, "recordStatus", entity.status)}
                      </span>
                    </span>
                    <ChevronRight size={15} className="shrink-0 text-[var(--muted-foreground)]" />
                  </button>
                ))}
              </div>
            ))}
          </div>
          {entities.data && entities.data.total > entities.data.items.length && (
            <div className="mt-2 flex items-center justify-between gap-2">
              <p className="text-xs text-[var(--muted-foreground)]">
                {t("ui.game.campaignWiki.listTotal", {
                  shown: Math.min(entityOffset + entities.data.items.length, entities.data.total),
                  total: entities.data.total,
                })}
              </p>
              <div className="flex gap-1">
                <button
                  type="button"
                  disabled={entityOffset === 0}
                  onClick={() => setEntityOffset(Math.max(0, entityOffset - (entities.data?.limit ?? 20)))}
                  className="min-h-9 rounded-md border border-[var(--border)] px-2 text-xs disabled:opacity-40"
                >
                  {t("ui.game.campaignWiki.previous")}
                </button>
                <button
                  type="button"
                  disabled={entityOffset + entities.data.items.length >= entities.data.total}
                  onClick={() => setEntityOffset(entityOffset + (entities.data?.limit ?? 20))}
                  className="min-h-9 rounded-md border border-[var(--border)] px-2 text-xs disabled:opacity-40"
                >
                  {t("ui.game.campaignWiki.next")}
                </button>
              </div>
            </div>
          )}
        </section>
        <section
          className={cn("flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden", !reading && "hidden md:flex")}
          aria-live="polite"
        >
          {reading && (
            <button
              type="button"
              onClick={closeReading}
              className="mb-3 inline-flex min-h-10 items-center gap-1 rounded-md px-2 text-xs text-[var(--muted-foreground)] hover:bg-[var(--secondary)] md:hidden"
            >
              <ArrowLeft size={14} />
              {t("ui.game.campaignWiki.backToEntities")}
            </button>
          )}
          {navCollapsed && (
            <button
              type="button"
              onClick={() => setNavCollapsed(false)}
              className="mb-3 hidden min-h-10 items-center gap-1 rounded-md border border-[var(--border)] px-2 text-xs text-[var(--muted-foreground)] hover:bg-[var(--secondary)] md:inline-flex"
            >
              <PanelLeftOpen size={14} />
              {t("ui.game.campaignWiki.navExpand")}
            </button>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto px-2 md:px-6 lg:px-10" data-campaign-wiki-scroll="reader">
            {campaignTimeline && !selectedId && (
              <CampaignWikiTimeline
                chatId={chatId}
                heading={t("ui.game.campaignWiki.campaignTimeline")}
                onSelect={selectEntity}
              />
            )}
            {campaignTimeline && !selectedId && <CampaignWikiCommitments chatId={chatId} onNavigate={selectEntity} />}
            {detail.isLoading && (
              <div className="flex items-center gap-2 py-5 text-xs text-[var(--muted-foreground)]">
                <Loader2 size={14} className="animate-spin" />
                {t("ui.game.campaignWiki.loadingDetail")}
              </div>
            )}
            {detail.isError && <ErrorState onRetry={() => void detail.refetch()} />}
            {!reading && !selectedId && !detail.isLoading && (
              <div data-campaign-wiki-overview className="mx-auto max-w-5xl space-y-6 py-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--primary)]">
                    {t("ui.game.campaignWiki.overviewEyebrow")}
                  </p>
                  <h2 className="mt-1 text-2xl font-semibold tracking-tight">{t("ui.game.campaignWiki.title")}</h2>
                  <p className="mt-2 text-sm leading-6 text-[var(--muted-foreground)]">
                    {t("ui.game.campaignWiki.overviewDescription")}
                  </p>
                </div>
                {entities.data && (
                  <div
                    className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--muted-foreground)]"
                    aria-label={t("ui.game.campaignWiki.overviewCounts")}
                  >
                    <span>
                      {t("ui.game.campaignWiki.overviewLoadedLabel")}: {entities.data.items.length}
                    </span>
                    <span>
                      {t("ui.game.campaignWiki.overviewIndexedLabel")}: {entities.data.total}
                    </span>
                  </div>
                )}
                <p className="text-sm text-[var(--muted-foreground)]">{t("ui.game.campaignWiki.selectEntity")}</p>
                {overviewGroups.length > 0 && (
                  <div className="grid gap-5 lg:grid-cols-2" data-campaign-wiki-overview-index>
                    {overviewGroups.map((group) => (
                      <section key={group.kind} className="min-w-0">
                        <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
                          {enumLabel(t, "kind", group.kind)}
                        </h3>
                        <div className="divide-y divide-[var(--border)] rounded-md border border-[var(--border)]">
                          {group.items.map((entity) => (
                            <button
                              type="button"
                              key={entity.entityId}
                              onClick={() => selectEntity(entity.entityId)}
                              className="flex min-h-10 w-full items-start justify-between gap-3 px-3 py-2 text-left first:rounded-t-md last:rounded-b-md hover:bg-[var(--secondary)]"
                            >
                              <span className="min-w-0">
                                <span className="block truncate text-sm font-medium">
                                  {displayEntityName(t, entity)}
                                </span>
                                {entity.summary && (
                                  <span className="mt-0.5 block truncate text-xs text-[var(--muted-foreground)]">
                                    {entity.summary}
                                  </span>
                                )}
                              </span>
                              <ChevronRight size={14} className="mt-0.5 shrink-0 text-[var(--muted-foreground)]" />
                            </button>
                          ))}
                        </div>
                      </section>
                    ))}
                  </div>
                )}
              </div>
            )}
            {detail.data &&
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
                />
              ))}
            {selected && !detail.data && !detail.isLoading && !detail.isError && (
              <p className="text-xs text-[var(--muted-foreground)]">{selected.summary}</p>
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
    return (
      <p className="text-[0.625rem] text-[var(--muted-foreground)]">{t("ui.game.campaignWiki.branchStatusLoading")}</p>
    );
  }
  if (chat.isError && !branch) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border border-[var(--border)] px-3 py-2 text-xs text-[var(--muted-foreground)]">
        <span>{t("ui.game.campaignWiki.branchStatusError")}</span>
        <button
          type="button"
          onClick={() => void chat.refetch()}
          className="min-h-8 rounded border border-[var(--border)] px-2 hover:bg-[var(--secondary)]"
        >
          {t("ui.game.campaignWiki.retry")}
        </button>
      </div>
    );
  }
  if (!branch?.held.length) return null;
  return (
    <aside className="rounded-md border border-[var(--destructive)]/50 bg-[var(--destructive)]/5 px-3 py-2 text-xs">
      {chat.isError && (
        <div className="mb-2 flex items-center justify-between gap-2 text-[var(--destructive)]">
          <span>{t("ui.game.campaignWiki.branchStatusError")}</span>
          <button
            type="button"
            onClick={() => void chat.refetch()}
            className="min-h-8 rounded border border-[var(--border)] px-2 text-[var(--muted-foreground)] hover:bg-[var(--secondary)]"
          >
            {t("ui.game.campaignWiki.retry")}
          </button>
        </div>
      )}
      <p className="font-medium">{t("ui.game.campaignWiki.branchHeldWarning")}</p>
      <p className="mt-1 text-[var(--muted-foreground)]">{t("ui.game.campaignWiki.branchHeldSummary")}</p>
      <details
        className="mt-2"
        open={diagnosticsOpen}
        onToggle={(event) => setDiagnosticsOpen(event.currentTarget.open)}
      >
        <summary className="cursor-pointer text-[var(--muted-foreground)]">
          {t("ui.game.campaignWiki.branchHeldRecords", { count: branch.held.length })}
        </summary>
        <ul className="mt-2 space-y-2">
          {branch.held.map((record, index) => (
            <li
              key={`${record.recordType}-${record.recordId}-${index}`}
              className="rounded border border-[var(--border)] p-2"
            >
              <strong>
                {t(
                  `ui.game.campaignWiki.branchRecordType.${record.recordType === "current-state" ? "currentState" : record.recordType}`,
                  {
                    defaultValue: branchRecordTypeLabels[record.recordType],
                  },
                )}
              </strong>
              <p className="mt-1 text-[var(--muted-foreground)]">{record.reason}</p>
              <details className="mt-1 text-[0.625rem] text-[var(--muted-foreground)]">
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
    <div className="flex items-center justify-between gap-2 py-5 text-xs text-[var(--destructive)]">
      <span>{t("ui.game.campaignWiki.error")}</span>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-[var(--muted-foreground)] hover:bg-[var(--secondary)]"
      >
        <RotateCw size={12} />
        {t("ui.game.campaignWiki.retry")}
      </button>
    </div>
  );
}
