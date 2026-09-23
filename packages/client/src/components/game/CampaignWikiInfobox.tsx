import { useState, type ReactNode } from "react";
import { ChevronRight, MapPin, MessageSquareQuote } from "lucide-react";
import type {
  CampaignMemoryBacklink,
  CampaignMemoryCurrentState,
  CampaignMemoryEntityDetail,
} from "@marinara-engine/shared";
import { useTranslation as useUiTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import { useCampaignMemoryCommitments } from "../../hooks/use-campaign-memory";
import { CampaignWikiEvidence } from "./CampaignWikiEvidence";
import {
  EntityRefName,
  FactLabelBadge,
  displayEntityName,
  enumLabel,
  portraitFor,
  readableValue,
  stateTargetId,
  type FactLabel,
  type TFn,
} from "./CampaignWikiReaderParts";
import { EntityAvatar, humanizeKey, recordOrigin } from "./campaign-wiki-ui";

export type CampaignWikiView =
  | "facts"
  | "knowledge"
  | "events"
  | "connections"
  | "timeline"
  | "commitments"
  | "details";

const OPEN_COMMITMENT_STATES = new Set(["proposed", "accepted", "active", "unresolved"]);
const INFOBOX_CONNECTIONS = 5;
const INFOBOX_PROMISES = 3;
const STALE_LABEL: FactLabel = "stale";

function InfoboxSection({
  title,
  action,
  children,
  label,
}: {
  title: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  label?: string;
}) {
  return (
    <section aria-label={label} className="border-t border-border/70 px-3.5 py-3 first:border-t-0">
      <div className="mb-1.5 flex min-h-6 items-center justify-between gap-2">
        <h4 className="text-[0.6875rem] font-bold uppercase tracking-wide text-muted-foreground">{title}</h4>
        {action}
      </div>
      {children}
    </section>
  );
}

function SeeAll({ onClick, label }: { onClick: () => void; label: string }) {
  const { t } = useUiTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="-my-1 inline-flex min-h-8 items-center gap-0.5 rounded-md px-1.5 text-[0.6875rem] font-semibold text-primary hover:bg-secondary"
    >
      {t("ui.game.campaignWiki.reader.seeAll", { defaultValue: "See all" })}
      <ChevronRight size={12} aria-hidden="true" />
    </button>
  );
}

/**
 * Fact box of a wiki page (right column on wide screens, under the lead on narrow ones): the current state, the
 * closest connections, open promises and the page's other sections. Each section link opens that view in the main
 * column. Lives inside the article's `@container`, so its layout follows the reader width, not the window.
 */
export function CampaignWikiInfobox({
  chatId,
  detail,
  view,
  onView,
  onSelect,
  portraits,
  factTotal,
}: {
  chatId: string;
  detail: CampaignMemoryEntityDetail;
  view: CampaignWikiView;
  onView: (view: CampaignWikiView) => void;
  onSelect: (id: string) => void;
  portraits: Map<string, string>;
  factTotal: number;
}) {
  const { t } = useUiTranslation();
  const { entity, currentState, relationships, relatedEntities, knowledge, events } = detail;
  const related = new Map(relatedEntities.map((item) => [item.entityId, item]));
  const referencedEventById = new Map((detail.referencedEvents ?? []).map((item) => [item.eventId, item]));
  const sourceChecks = detail.sourceChecks ?? {};
  const nameOf = (id: string) => {
    const found = related.get(id) ?? (id === entity.entityId ? entity : undefined);
    return found ? displayEntityName(t as TFn, found) : null;
  };
  // Same query as the full promises list (first page), so both share one request and one error state.
  const commitments = useCampaignMemoryCommitments(chatId, { entityId: entity.entityId });
  const openPromises = (commitments.data?.items ?? []).filter(
    (item) => !item.historical && OPEN_COMMITMENT_STATES.has(item.state),
  );
  // One row per connected page: several relationships to the same person read as one line of labels.
  const connections: Array<{
    targetId: string;
    target: NonNullable<ReturnType<typeof related.get>>;
    name: string;
    labels: string[];
  }> = [];
  for (const item of relationships.items as CampaignMemoryBacklink[]) {
    const targetId = item.direction === "outgoing" ? item.targetEntityId : item.sourceEntityId;
    const target = related.get(targetId);
    if (!target) continue;
    let row = connections.find((existing) => existing.targetId === targetId);
    if (!row) {
      row = { targetId, target, name: displayEntityName(t as TFn, target), labels: [] };
      connections.push(row);
    }
    const base = item.label || humanizeKey(item.type);
    const label =
      item.status !== "active"
        ? `${base} (${enumLabel(t as TFn, "relationshipStatus", item.status).toLocaleLowerCase()})`
        : base;
    if (!row.labels.some((existing) => existing.toLocaleLowerCase() === label.toLocaleLowerCase()))
      row.labels.push(label);
  }
  const person = entity.kind === "character" || entity.kind === "persona";
  const contents: Array<{ id: CampaignWikiView; label: string; count?: number }> = [
    { id: "facts", label: t("ui.game.campaignWiki.facts"), count: factTotal },
    {
      id: "knowledge",
      label: person
        ? t("ui.game.campaignWiki.reader.tabKnows", { defaultValue: "What they know" })
        : t("ui.game.campaignWiki.reader.tabKnowledge", { defaultValue: "Who knows" }),
      count: knowledge.total,
    },
    {
      id: "events",
      label: t("ui.game.campaignWiki.reader.tabEvents", { defaultValue: "Events" }),
      count: events.total,
    },
    {
      id: "connections",
      label: t("ui.game.campaignWiki.reader.tabConnections", { defaultValue: "Connections" }),
      count: relationships.total,
    },
    { id: "timeline", label: t("ui.game.campaignWiki.timeline") },
    {
      id: "commitments",
      label: t("ui.game.campaignWiki.reader.tabCommitments", { defaultValue: "Promises & quests" }),
    },
    { id: "details", label: t("ui.game.campaignWiki.reader.tabDetails", { defaultValue: "Details" }) },
  ];

  return (
    <aside
      aria-label={t("ui.game.campaignWiki.infobox.label", { defaultValue: "At a glance" })}
      data-component="campaign-wiki-infobox"
      className="min-w-0 overflow-hidden rounded-xl border border-border bg-[color-mix(in_srgb,var(--background)_82%,var(--secondary))]"
    >
      {currentState.items.length > 0 && (
        <InfoboxSection
          title={t("ui.game.campaignWiki.reader.rightNow", { defaultValue: "Right now" })}
          label={t("ui.game.campaignWiki.currentState")}
        >
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 @3xl:grid-cols-1">
            {currentState.items.map((item) => (
              <StateRow
                key={item.stateId}
                chatId={chatId}
                item={item}
                stale={sourceChecks[item.stateId]?.state === "stale"}
                sourceEvent={referencedEventById.get(item.sourceEventId)}
                nameOf={nameOf}
                onSelect={onSelect}
              />
            ))}
          </dl>
        </InfoboxSection>
      )}

      {connections.length > 0 && (
        <InfoboxSection
          title={t("ui.game.campaignWiki.reader.tabConnections", { defaultValue: "Connections" })}
          action={
            relationships.total > relationships.items.length || connections.length > INFOBOX_CONNECTIONS ? (
              <SeeAll
                onClick={() => onView("connections")}
                label={t("ui.game.campaignWiki.infobox.seeAllConnections", { defaultValue: "See all connections" })}
              />
            ) : undefined
          }
        >
          <ul className="space-y-0.5">
            {connections.slice(0, INFOBOX_CONNECTIONS).map(({ targetId, target, name, labels }) => (
              <li key={targetId}>
                <button
                  type="button"
                  onClick={() => onSelect(targetId)}
                  className="-mx-1.5 flex min-h-10 w-[calc(100%+0.75rem)] items-center gap-2.5 rounded-lg px-1.5 py-1 text-left hover:bg-secondary/70"
                >
                  <EntityAvatar name={name} kind={target.kind} size={30} imageUrl={portraitFor(target, portraits)} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-foreground">{name}</span>
                    <span className="block truncate text-[0.6875rem] text-muted-foreground" title={labels.join(", ")}>
                      {labels.join(", ")}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </InfoboxSection>
      )}

      {openPromises.length > 0 && (
        <InfoboxSection
          title={t("ui.game.campaignWiki.infobox.openPromises", { defaultValue: "Open promises" })}
          action={
            <SeeAll
              onClick={() => onView("commitments")}
              label={t("ui.game.campaignWiki.infobox.seeAllPromises", { defaultValue: "See all promises and quests" })}
            />
          }
        >
          <ul className="space-y-1.5">
            {openPromises.slice(0, INFOBOX_PROMISES).map((item) => (
              <li key={item.commitmentId} className="flex items-start gap-2 text-sm leading-5 text-foreground">
                <span className="mt-[0.4rem] h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  {item.title}
                  <span className="ml-1.5 text-[0.6875rem] text-muted-foreground">
                    {enumLabel(t as TFn, "commitments.state", item.state)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </InfoboxSection>
      )}

      <InfoboxSection title={t("ui.game.campaignWiki.infobox.onThisPage", { defaultValue: "On this page" })}>
        <nav aria-label={t("ui.game.campaignWiki.reader.sections", { defaultValue: "Sections" })}>
          <ul className="flex flex-wrap gap-1.5 @3xl:-mx-1.5 @3xl:block">
            {contents.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => onView(item.id)}
                  aria-current={view === item.id ? "page" : undefined}
                  className={cn(
                    "flex min-h-9 items-center gap-2 rounded-full border px-3 text-left text-xs transition-colors @3xl:w-full @3xl:rounded-lg @3xl:border-0 @3xl:px-1.5 @3xl:text-sm",
                    view === item.id
                      ? "border-primary/50 bg-primary/15 font-semibold text-foreground"
                      : "border-border text-foreground/90 hover:bg-secondary/70",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {typeof item.count === "number" && (
                    <span className="text-xs tabular-nums text-muted-foreground">{item.count.toLocaleString()}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      </InfoboxSection>
    </aside>
  );
}

function StateRow({
  chatId,
  item,
  stale,
  sourceEvent,
  nameOf,
  onSelect,
}: {
  chatId: string;
  item: CampaignMemoryCurrentState;
  stale: boolean;
  sourceEvent: NonNullable<CampaignMemoryEntityDetail["referencedEvents"]>[number] | undefined;
  nameOf: (id: string) => string | null;
  onSelect: (id: string) => void;
}) {
  const { t } = useUiTranslation();
  const [showSource, setShowSource] = useState(false);
  const target = stateTargetId(item.value);
  const targetName = target ? nameOf(target) : null;
  return (
    <div className="min-w-0">
      <dt className="flex min-h-7 items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">{humanizeKey(item.property)}</span>
        {stale && <FactLabelBadge label={STALE_LABEL} />}
        {sourceEvent && sourceEvent.evidence.length > 0 && (
          <button
            type="button"
            onClick={() => setShowSource((current) => !current)}
            aria-expanded={showSource}
            aria-label={t("ui.game.campaignWiki.evidence.fromStory", { defaultValue: "From the story" })}
            title={t("ui.game.campaignWiki.evidence.fromStory", { defaultValue: "From the story" })}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-secondary hover:text-foreground"
          >
            <MessageSquareQuote size={12} aria-hidden="true" />
          </button>
        )}
      </dt>
      <dd className="text-sm font-semibold leading-5 text-foreground">
        {target ? (
          <button
            type="button"
            onClick={() => onSelect(target)}
            className="inline-flex items-center gap-1 text-left hover:text-primary"
          >
            <MapPin size={12} className="shrink-0" aria-hidden="true" />
            {targetName ?? <EntityRefName chatId={chatId} entityId={target} />}
          </button>
        ) : (
          readableValue(item.value)
        )}
      </dd>
      {showSource && sourceEvent && (
        <CampaignWikiEvidence
          chatId={chatId}
          sourceChatId={recordOrigin(sourceEvent).chatId ?? chatId}
          evidence={sourceEvent.evidence}
          defaultOpen
          className="mt-1"
        />
      )}
    </div>
  );
}
