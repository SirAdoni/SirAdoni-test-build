import { useMemo, type ReactNode } from "react";
import { Clock3, RotateCw } from "lucide-react";
import type { CampaignMemoryEntity, CampaignMemoryEntityKind, CampaignMemoryJson } from "@marinara-engine/shared";
import { useTranslation as useUiTranslation } from "react-i18next";
import { wikiValueRecord, wikiValueSummary } from "../../lib/campaign-wiki-value";
import { useCampaignMemoryEntity, type CampaignMemoryEntityListItem } from "../../hooks/use-campaign-memory";
import { useCharacters } from "../../hooks/use-characters";
import {
  EntityAvatar,
  WikiChip,
  formatCaptureOrder,
  humanizeKey,
  recordOrigin,
  type WikiTone,
} from "./campaign-wiki-ui";

/**
 * Small reader pieces shared by the Campaign Wiki page (CampaignWiki.tsx) and its article parts (facts, infobox).
 * Everything here is display-only; no writes.
 */

export type TFn = (key: string, options?: Record<string, unknown>) => string;

export function enumLabel(t: TFn, group: string, value: string) {
  return t(`ui.game.campaignWiki.${group}.${value}`, { defaultValue: humanizeKey(value) });
}

export function kindLabel(t: TFn, kind: CampaignMemoryEntityKind | "all") {
  return enumLabel(t, "kind", kind);
}

export const RAW_ID = /^(cme_|cmf_|cmk_|cmev_|cmt_|legacy-|gcb_|gch_|gcr_)[\w-]+$/iu;
/** A stored value that is itself a wiki page id (current state often records a location this way). */
export const ENTITY_ID = /^(cme_|legacy-)[0-9a-f]{16,}$/iu;

export function displayEntityName(t: TFn, entity: Pick<CampaignMemoryEntityListItem, "aliases" | "entityId" | "kind">) {
  const alias = entity.aliases.find((value) => value.trim() && !RAW_ID.test(value.trim()));
  return alias || t("ui.game.campaignWiki.untitledEntity", { kind: kindLabel(t, entity.kind) });
}

/** Name of a page that is not in the loaded detail; shows a neutral label until it arrives. */
export function EntityRefName({ chatId, entityId }: { chatId: string; entityId: string }) {
  const { t } = useUiTranslation();
  const detail = useCampaignMemoryEntity(chatId, entityId, { limit: 1 });
  if (detail.data?.entity) return <>{displayEntityName(t, detail.data.entity)}</>;
  return <>{detail.isError ? t("ui.game.campaignWiki.reader.unknownPage", { defaultValue: "Unknown page" }) : "…"}</>;
}

/** The wiki page a stored state value points at, when the value is a page reference. */
export function stateTargetId(value: CampaignMemoryJson | undefined): string | undefined {
  const record = wikiValueRecord(value);
  if (record && typeof record.entityId === "string") return record.entityId;
  return typeof value === "string" && ENTITY_ID.test(value.trim()) ? value.trim() : undefined;
}

/** Readable text for any stored value, never raw JSON. */
export function readableValue(value: CampaignMemoryJson | undefined): string {
  return wikiValueSummary(value);
}

/** Reader vocabulary (plan): verified | pending | disputed | stale | legacy. Plain supersession keeps its own label. */
export type FactLabel = "verified" | "pending" | "disputed" | "stale" | "legacy" | "superseded";

const FACT_LABEL_TONE: Record<FactLabel, WikiTone> = {
  verified: "success",
  pending: "warning",
  disputed: "danger",
  stale: "danger",
  legacy: "neutral",
  superseded: "neutral",
};

export function FactLabelBadge({ label }: { label: FactLabel }) {
  const { t } = useUiTranslation();
  return (
    <WikiChip tone={FACT_LABEL_TONE[label]} title={t(`ui.game.campaignWiki.factLabelHint.${label}`)}>
      {t(`ui.game.campaignWiki.factLabel.${label}`)}
    </WikiChip>
  );
}

export function SessionChip({ record }: { record: unknown }) {
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

export function WhenChip({ order }: { order: string | null | undefined }) {
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
export function useCharacterPortraits(): Map<string, string> {
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

export function portraitFor(
  entity: Pick<CampaignMemoryEntity, "owner">,
  portraits: Map<string, string>,
): string | null {
  if (entity.owner.type === "existing" && entity.owner.store === "characters") {
    return portraits.get(entity.owner.recordId) ?? null;
  }
  return null;
}

export function EntityChipButton({
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

export function Pager({
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

export function WikiErrorState({ onRetry }: { onRetry: () => void }) {
  const { t } = useUiTranslation();
  return (
    <div className="flex items-center justify-between gap-2 rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-3 text-xs text-destructive">
      <span>{t("ui.game.campaignWiki.error")}</span>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-border px-2.5 text-muted-foreground hover:bg-secondary"
      >
        <RotateCw size={12} />
        {t("ui.game.campaignWiki.retry")}
      </button>
    </div>
  );
}
