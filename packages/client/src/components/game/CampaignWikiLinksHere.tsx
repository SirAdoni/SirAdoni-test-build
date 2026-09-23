import { useMemo } from "react";
import { ChevronRight, Link2 } from "lucide-react";
import type {
  CampaignMemoryBacklink,
  CampaignMemoryEntity,
  CampaignMemoryEntityDetail,
  CampaignMemoryEntityKind,
} from "@marinara-engine/shared";
import { useTranslation as useUiTranslation } from "react-i18next";
import { useCampaignMemoryReferences } from "../../hooks/use-campaign-memory";
import { KIND_ORDER } from "./CampaignWikiRail";
import { displayEntityName, enumLabel, kindSectionLabel, portraitFor, type TFn } from "./CampaignWikiReaderParts";
import { EntityAvatar, WikiSectionHeader, humanizeKey } from "./campaign-wiki-ui";

/**
 * "What links here" at the end of an article: the pages that name this one through a connection or a shared event,
 * grouped by kind, with the campaign-wide reference counts from GET /memory/entities/:id/references. The page list
 * comes from the loaded article (first page of connections and events); an older server without the references
 * route still gets the list, only without the counts.
 */

interface LinkingPage {
  entity: CampaignMemoryEntity;
  name: string;
  labels: string[];
  events: number;
}

export function CampaignWikiLinksHere({
  chatId,
  detail,
  onSelect,
  portraits,
}: {
  chatId: string;
  detail: CampaignMemoryEntityDetail;
  onSelect: (id: string) => void;
  portraits: Map<string, string>;
}) {
  const { t } = useUiTranslation();
  const { entity } = detail;
  const references = useCampaignMemoryReferences(chatId, entity.entityId);
  const groups = useMemo(() => {
    const related = new Map(detail.relatedEntities.map((item) => [item.entityId, item]));
    const pages = new Map<string, LinkingPage>();
    const pageFor = (id: string) => {
      if (id === entity.entityId) return null;
      const found = related.get(id);
      if (!found) return null;
      let page = pages.get(id);
      if (!page) {
        page = { entity: found, name: displayEntityName(t as TFn, found), labels: [], events: 0 };
        pages.set(id, page);
      }
      return page;
    };
    for (const item of detail.relationships.items as CampaignMemoryBacklink[]) {
      const page = pageFor(item.direction === "outgoing" ? item.targetEntityId : item.sourceEntityId);
      if (!page) continue;
      const base = item.label || humanizeKey(item.type);
      const label =
        item.status !== "active"
          ? `${base} (${enumLabel(t as TFn, "relationshipStatus", item.status).toLocaleLowerCase()})`
          : base;
      if (!page.labels.some((existing) => existing.toLocaleLowerCase() === label.toLocaleLowerCase()))
        page.labels.push(label);
    }
    for (const event of detail.events.items) {
      const ids = new Set([
        ...(event.participantEntityIds ?? []),
        ...(event.locationEntityId ? [event.locationEntityId] : []),
      ]);
      for (const id of ids) {
        const page = pageFor(id);
        if (page) page.events += 1;
      }
    }
    const byKind = new Map<CampaignMemoryEntityKind, LinkingPage[]>();
    for (const page of pages.values()) {
      if (!page.name) continue;
      byKind.set(page.entity.kind, [...(byKind.get(page.entity.kind) ?? []), page]);
    }
    return KIND_ORDER.filter((kind) => byKind.has(kind)).map((kind) => ({
      kind,
      pages: byKind
        .get(kind)!
        .sort(
          (left, right) =>
            right.labels.length + right.events - (left.labels.length + left.events) ||
            left.name.localeCompare(right.name),
        ),
    }));
  }, [detail, entity.entityId, t]);
  const counts = references.data;
  const summary = counts
    ? [
        counts.events > 0 &&
          t("ui.game.campaignWiki.linksHere.events", {
            defaultValue: "{{formattedCount}} events",
            count: counts.events,
            formattedCount: counts.events.toLocaleString(),
          }),
        counts.relationships > 0 &&
          t("ui.game.campaignWiki.linksHere.connections", {
            defaultValue: "{{formattedCount}} connections",
            count: counts.relationships,
            formattedCount: counts.relationships.toLocaleString(),
          }),
        counts.knowledge > 0 &&
          t("ui.game.campaignWiki.linksHere.knowledge", {
            defaultValue: "{{formattedCount}} secrets",
            count: counts.knowledge,
            formattedCount: counts.knowledge.toLocaleString(),
          }),
      ].filter((part): part is string => Boolean(part))
    : [];
  if (groups.length === 0 && summary.length === 0) return null;

  return (
    <section
      data-campaign-wiki-links-here
      aria-label={t("ui.game.campaignWiki.linksHere.title", { defaultValue: "What links here" })}
      className="border-t border-border pt-5"
    >
      <WikiSectionHeader
        title={
          <span className="inline-flex items-center gap-1.5">
            <Link2 size={14} className="text-muted-foreground" aria-hidden="true" />
            {t("ui.game.campaignWiki.linksHere.title", { defaultValue: "What links here" })}
          </span>
        }
        hint={
          summary.length > 0
            ? t("ui.game.campaignWiki.linksHere.summary", {
                defaultValue: "Named in {{parts}} across the campaign.",
                parts: summary.join(", "),
              })
            : undefined
        }
      />
      {groups.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("ui.game.campaignWiki.linksHere.none", { defaultValue: "No other page links here yet." })}
        </p>
      ) : (
        <div className="space-y-3">
          {groups.map(({ kind, pages }) => (
            <div key={kind} data-campaign-wiki-links-kind={kind}>
              <h5 className="mb-1 text-[0.6875rem] font-bold uppercase tracking-wide text-muted-foreground">
                {kindSectionLabel(t as TFn, kind)}
              </h5>
              <ul className="grid gap-x-3 gap-y-0.5 @xl:grid-cols-2">
                {pages.map((page) => {
                  const reasons = [
                    ...page.labels,
                    page.events > 0 &&
                      t("ui.game.campaignWiki.linksHere.sharedEvents", {
                        defaultValue: "{{count}} shared events",
                        count: page.events,
                      }),
                  ].filter(Boolean);
                  return (
                    <li key={page.entity.entityId} className="min-w-0">
                      <button
                        type="button"
                        onClick={() => onSelect(page.entity.entityId)}
                        className="-mx-1.5 flex min-h-11 w-[calc(100%+0.75rem)] items-center gap-2.5 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                      >
                        <EntityAvatar
                          name={page.name}
                          kind={page.entity.kind}
                          size={30}
                          imageUrl={portraitFor(page.entity, portraits)}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold leading-5 text-foreground">
                            {page.name}
                          </span>
                          <span className="block truncate text-[0.6875rem] leading-4 text-muted-foreground">
                            {reasons.join(" · ")}
                          </span>
                        </span>
                        <ChevronRight size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
