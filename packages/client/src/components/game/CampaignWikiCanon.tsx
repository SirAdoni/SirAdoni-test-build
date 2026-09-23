import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Pin, PinOff, Search, ServerCog, X } from "lucide-react";
import type { CampaignMemoryJson } from "@marinara-engine/shared";
import { useTranslation as useUiTranslation } from "react-i18next";
import {
  useCampaignMemoryPinnedFacts,
  useUpdateCampaignMemoryFact,
  type CampaignMemoryListedFact,
} from "../../hooks/use-campaign-memory";
import { CampaignWikiSubjectLink } from "./CampaignWikiReview";
import { SessionChip, WhenChip, WikiErrorState as ErrorState, type TFn } from "./CampaignWikiReaderParts";
import {
  WikiEmpty,
  WikiSkeleton,
  crossSessionReferenceDetail,
  crossSessionReferenceText,
  factDisplay,
  isWikiRevisionConflict,
  recordWriteChatId,
} from "./campaign-wiki-ui";

/**
 * The Canon page: every fact the player pinned across the campaign, grouped by the page it is about, with Unpin.
 * Reads GET /memory/facts?pinned=true; an older server without that route gets a "needs a server update" state
 * instead of a walk over every page.
 */

const SEARCH_DEBOUNCE_MS = 300;

function operationId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `campaign-wiki-canon-${Date.now()}`;
}

export function CampaignWikiCanon({
  chatId,
  onSelect,
  portraits,
}: {
  chatId: string;
  onSelect: (id: string) => void;
  portraits: Map<string, string>;
}) {
  const { t } = useUiTranslation();
  const [searchText, setSearchText] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(searchText.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchText]);
  const pinned = useCampaignMemoryPinnedFacts(chatId, { query });
  const groups = useMemo(() => {
    const bySubject = new Map<string, { entityId: string; alias: string; facts: CampaignMemoryListedFact[] }>();
    for (const fact of pinned.facts) {
      const entityId = fact.subject?.entityId ?? fact.subjectEntityId;
      const group = bySubject.get(entityId) ?? { entityId, alias: fact.subject?.alias ?? "", facts: [] };
      group.facts.push(fact);
      bySubject.set(entityId, group);
    }
    return [...bySubject.values()].sort((left, right) => left.alias.localeCompare(right.alias));
  }, [pinned.facts]);
  const loaded = pinned.data !== undefined;

  return (
    <div className="@container mx-auto w-full min-w-0 max-w-[60rem] space-y-4 pb-10 pt-1" data-campaign-wiki-canon>
      <header className="space-y-1.5 border-b border-border pb-4">
        <h2 className="flex flex-wrap items-center gap-2 text-2xl font-bold leading-tight">
          <Pin size={20} className="text-primary" aria-hidden="true" />
          {t("ui.game.campaignWiki.canon.title", { defaultValue: "Canon" })}
          {loaded && !pinned.unsupported && (
            <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-semibold tabular-nums text-muted-foreground">
              {pinned.total.toLocaleString()}
            </span>
          )}
        </h2>
        <p className="max-w-[65ch] text-sm leading-6 text-muted-foreground">
          {t("ui.game.campaignWiki.canon.intro", {
            defaultValue:
              "Facts you pinned as canon. The memory always keeps them and never changes them automatically.",
          })}
        </p>
      </header>

      {!pinned.unsupported && (pinned.total > 0 || query || searchText) && (
        <label className="flex min-h-10 items-center gap-2 rounded-lg border border-border bg-background/40 px-3 focus-within:border-primary/60">
          <Search size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="sr-only">{t("ui.game.campaignWiki.canon.search", { defaultValue: "Search canon" })}</span>
          <input
            type="search"
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            placeholder={t("ui.game.campaignWiki.canon.search", { defaultValue: "Search canon" })}
            className="min-h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          {searchText && (
            <button
              type="button"
              onClick={() => setSearchText("")}
              aria-label={t("ui.game.campaignWiki.canon.clearSearch", { defaultValue: "Clear search" })}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              <X size={14} aria-hidden="true" />
            </button>
          )}
        </label>
      )}

      {pinned.isLoading && <WikiSkeleton rows={4} />}
      {pinned.isError && <ErrorState onRetry={() => void pinned.refetch()} />}
      {pinned.unsupported && (
        <WikiEmpty
          icon={<ServerCog size={24} />}
          title={t("ui.game.campaignWiki.canon.unsupportedTitle", { defaultValue: "Canon needs a server update" })}
          hint={t("ui.game.campaignWiki.canon.unsupportedHint", {
            defaultValue:
              "This server cannot list pinned facts across the campaign yet. Update Marinara, or open a page to see the facts pinned there.",
          })}
        />
      )}
      {loaded && !pinned.unsupported && !pinned.isLoading && groups.length === 0 && (
        <WikiEmpty
          icon={<Pin size={24} />}
          title={
            query
              ? t("ui.game.campaignWiki.canon.noMatches", { defaultValue: "No pinned facts match" })
              : t("ui.game.campaignWiki.canon.emptyTitle", { defaultValue: "Nothing pinned yet" })
          }
          hint={
            query
              ? undefined
              : t("ui.game.campaignWiki.canon.emptyHint", {
                  defaultValue:
                    "Open a page, expand a fact and choose Pin as canon. Pinned facts are always kept as written.",
                })
          }
        />
      )}

      {groups.length > 0 && (
        <div className="space-y-5">
          {groups.map((group) => (
            <section
              key={group.entityId}
              data-campaign-wiki-canon-group={group.entityId}
              className="rounded-xl border border-border bg-[color-mix(in_srgb,var(--background)_82%,var(--secondary))]"
            >
              <header className="flex items-center gap-2 border-b border-border/70 px-3.5 py-2">
                <div className="min-w-0 flex-1">
                  <CampaignWikiSubjectLink
                    chatId={chatId}
                    entityId={group.entityId}
                    fallbackName={group.alias}
                    onSelect={onSelect}
                    portraits={portraits}
                    meta={t("ui.game.campaignWiki.canon.pinnedCount", {
                      defaultValue: "{{count}} pinned",
                      count: group.facts.length,
                    })}
                  />
                </div>
              </header>
              <ul className="divide-y divide-border/60 px-1.5 py-1">
                {group.facts.map((fact) => (
                  <CanonRow key={`${fact.originChatId ?? chatId}:${fact.factId}`} chatId={chatId} fact={fact} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {pinned.hasNextPage && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => void pinned.fetchNextPage()}
            disabled={pinned.isFetchingNextPage}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-semibold hover:bg-secondary disabled:opacity-50"
          >
            {pinned.isFetchingNextPage && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
            {t("ui.game.campaignWiki.canon.loadMore", {
              defaultValue: "Load more ({{shown}} of {{total}})",
              shown: pinned.facts.length.toLocaleString(),
              total: pinned.total.toLocaleString(),
            })}
          </button>
        </div>
      )}
    </div>
  );
}

function CanonRow({ chatId, fact }: { chatId: string; fact: CampaignMemoryListedFact }) {
  const { t } = useUiTranslation();
  const queryClient = useQueryClient();
  const update = useUpdateCampaignMemoryFact(recordWriteChatId(fact, chatId));
  const [error, setError] = useState<"conflict" | "generic" | "crossSession" | null>(null);
  const [crossSessionDetail, setCrossSessionDetail] = useState("");
  const display = factDisplay(fact);
  const valueObject =
    fact.value && typeof fact.value === "object" && !Array.isArray(fact.value)
      ? (fact.value as Record<string, CampaignMemoryJson>)
      : null;
  const unpin = () => {
    if (!valueObject) return;
    setError(null);
    // Same as the article's Unpin: an earlier hand lock stays, a lock added by pinning goes.
    const { lockedBeforePin, ...rest } = valueObject;
    update.mutate(
      {
        fact,
        changes: { value: { ...rest, pinned: false }, manualLock: lockedBeforePin === true },
        reason: "Unpinned in the Campaign Wiki",
        operationId: operationId(),
      },
      {
        onError: (failure) => {
          const detail = crossSessionReferenceDetail(failure);
          setCrossSessionDetail(detail ?? "");
          setError(detail !== null ? "crossSession" : isWikiRevisionConflict(failure) ? "conflict" : "generic");
        },
      },
    );
  };
  return (
    <li className="px-2 py-2.5" data-campaign-wiki-canon-fact={fact.factId}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1.5">
        <Pin size={13} className="mt-1.5 shrink-0 text-primary" aria-hidden="true" />
        <p className="min-w-0 flex-1 basis-56 text-sm leading-6 text-foreground">
          {display.label && (
            <>
              <span className="font-semibold">{display.label}</span>
              <span className="text-muted-foreground">: </span>
            </>
          )}
          {display.text}
        </p>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <SessionChip record={fact} />
          <WhenChip order={fact.validFromOrder} />
          {valueObject && (
            <button
              type="button"
              onClick={unpin}
              disabled={update.isPending}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border bg-background/40 px-2.5 text-xs font-semibold text-foreground transition-colors hover:border-primary/50 hover:bg-secondary disabled:opacity-50"
            >
              {update.isPending ? (
                <Loader2 size={13} className="animate-spin" aria-hidden="true" />
              ) : (
                <PinOff size={13} aria-hidden="true" />
              )}
              {t("ui.game.campaignWiki.facts.unpin", { defaultValue: "Unpin" })}
            </button>
          )}
        </div>
      </div>
      {error && (
        <div role="alert" className="mt-1.5 flex flex-wrap items-center gap-2 pl-6 text-xs text-destructive">
          <span className="min-w-0 flex-1 basis-48">
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
    </li>
  );
}
