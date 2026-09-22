import type { ReactNode } from "react";
import {
  BookOpen,
  Gem,
  Landmark,
  MapPin,
  NotebookPen,
  ScrollText,
  User,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import type { CampaignMemoryEntityKind, CampaignMemoryFact, CampaignMemoryJson } from "@marinara-engine/shared";
import { cn } from "../../lib/utils";
import { wikiValueRecord, wikiValueSummary } from "../../lib/campaign-wiki-value";
import { useTranslation as useUiTranslation } from "react-i18next";

/**
 * Shared building blocks for the Campaign Wiki and continuity surfaces.
 *
 * Calm reading surfaces on the Marinara violet shell: tokenized borders and tints, the user's accent for selection,
 * solid (not glass) backgrounds behind long text, and no side stripes or nested cards. Every component takes already
 * translated text; nothing in here renders a hard-coded English string.
 */

export type WikiTone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

const TONE_CLASS: Record<WikiTone, string> = {
  neutral: "border-border bg-secondary/60 text-muted-foreground",
  accent: "border-primary/40 bg-primary/12 text-foreground",
  success: "border-emerald-400/35 bg-emerald-400/10 text-emerald-200",
  warning: "border-amber-400/35 bg-amber-400/10 text-amber-200",
  danger: "border-destructive/50 bg-destructive/12 text-destructive",
  info: "border-sky-400/35 bg-sky-400/10 text-sky-200",
};

export function WikiChip({
  tone = "neutral",
  icon,
  title,
  className,
  children,
}: {
  tone?: WikiTone;
  icon?: ReactNode;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex max-w-full items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[0.6875rem] font-medium leading-4",
        TONE_CLASS[tone],
        className,
      )}
    >
      {icon}
      <span className="truncate">{children}</span>
    </span>
  );
}

/** Solid reading card. Never nest one inside another. */
export function WikiCard({
  className,
  children,
  as: Tag = "div",
}: {
  className?: string;
  children: ReactNode;
  as?: "div" | "article" | "section" | "li";
}) {
  return (
    <Tag
      className={cn(
        "rounded-xl border border-border bg-[color-mix(in_srgb,var(--background)_82%,var(--secondary))] p-3.5",
        className,
      )}
    >
      {children}
    </Tag>
  );
}

export function WikiSectionHeader({
  title,
  count,
  hint,
  action,
  className,
}: {
  title: ReactNode;
  count?: number;
  hint?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-2 flex flex-wrap items-end justify-between gap-2", className)}>
      <div className="min-w-0">
        <h4 className="flex items-center gap-2 text-sm font-bold text-foreground">
          {title}
          {typeof count === "number" && (
            <span className="rounded-full bg-secondary px-1.5 py-px text-[0.6875rem] font-semibold text-muted-foreground">
              {count.toLocaleString()}
            </span>
          )}
        </h4>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

export function WikiEmpty({
  icon,
  title,
  hint,
  action,
}: {
  icon?: ReactNode;
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border px-4 py-8 text-center">
      {icon && <div className="text-muted-foreground">{icon}</div>}
      <p className="text-sm font-semibold text-foreground">{title}</p>
      {hint && <p className="max-w-[46ch] text-xs leading-5 text-muted-foreground">{hint}</p>}
      {action}
    </div>
  );
}

export function WikiStat({
  label,
  value,
  icon,
  onClick,
}: {
  label: ReactNode;
  value: ReactNode;
  icon?: ReactNode;
  onClick?: () => void;
}) {
  const body = (
    <>
      <span className="flex items-center gap-1.5 text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
      </span>
      <span className="mt-1 block text-xl font-bold tabular-nums text-foreground">{value}</span>
    </>
  );
  const className = "min-w-0 rounded-xl border border-border bg-secondary/40 px-3 py-2.5 text-left";
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        className,
        "transition-colors hover:border-primary/50 hover:bg-secondary/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
      )}
    >
      {body}
    </button>
  ) : (
    <div className={className}>{body}</div>
  );
}

export interface WikiTab<T extends string> {
  id: T;
  label: string;
  count?: number;
  icon?: ReactNode;
}

/** Segmented tabs. Tabs with a count of 0 are hidden unless they are the active tab. */
export function WikiTabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  className,
}: {
  tabs: WikiTab<T>[];
  value: T;
  onChange: (next: T) => void;
  label: string;
  className?: string;
}) {
  const { t: localizeUi } = useUiTranslation();
  const visible = tabs.filter((tab) => tab.count === undefined || tab.count > 0 || tab.id === value);
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn("flex gap-1 overflow-x-auto pb-1 [scrollbar-width:thin]", className)}
    >
      {visible.map((tab) => {
        const active = tab.id === value;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab.id)}
            className={cn(
              "inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
              active
                ? "border-primary/50 bg-primary/15 text-foreground"
                : "border-transparent text-muted-foreground hover:bg-secondary/70 hover:text-foreground",
            )}
          >
            {tab.icon}
            {tab.label}
            {typeof tab.count === "number" && (
              <span
                className={cn(
                  "rounded-full px-1.5 text-[0.625rem] tabular-nums",
                  active ? "bg-primary/25" : "bg-secondary",
                )}
              >
                {tab.count > 999
                  ? localizeUi("ui.game.wikitabs.value1K", { value1: Math.floor(tab.count / 1000) })
                  : tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export const ENTITY_KIND_ICONS: Record<CampaignMemoryEntityKind, LucideIcon> = {
  character: User,
  persona: UserRound,
  location: MapPin,
  organization: Landmark,
  item: Gem,
  quest: ScrollText,
  lore: BookOpen,
  note: NotebookPen,
};

function hueOf(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  return hash % 360;
}

export function initialsOf(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/\s+/u)
    .filter(
      (word) =>
        word &&
        !/^(lady|lord|sir|dame|the|of|countess|count|princess|prince|warmagus|keeper|sister|captain|first|alderwoman|mistress|master)$/iu.test(
          word,
        ),
    );
  const picked = (words.length ? words : name.split(/\s+/u)).filter(Boolean);
  const letters =
    picked.length > 1 ? `${picked[0]![0]}${picked[picked.length - 1]![0]}` : (picked[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

/** Initials in a softly tinted circle; the hue is stable per name. Characters are round, everything else rounded. */
export function EntityAvatar({
  name,
  kind,
  size = 36,
  imageUrl,
  className,
}: {
  name: string;
  kind: CampaignMemoryEntityKind;
  size?: number;
  imageUrl?: string | null;
  className?: string;
}) {
  const Icon = ENTITY_KIND_ICONS[kind] ?? BookOpen;
  const person = kind === "character" || kind === "persona";
  const hue = hueOf(name.toLowerCase());
  const style = {
    width: size,
    height: size,
    background: `color-mix(in srgb, hsl(${hue} 60% 55%) 22%, var(--secondary))`,
    color: `color-mix(in srgb, hsl(${hue} 80% 78%) 85%, var(--foreground))`,
    borderColor: `color-mix(in srgb, hsl(${hue} 60% 60%) 35%, transparent)`,
  };
  return (
    <span
      aria-hidden="true"
      style={style}
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center overflow-hidden border font-bold",
        person ? "rounded-full" : "rounded-lg",
        className,
      )}
    >
      {imageUrl ? (
        <img src={imageUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
      ) : person ? (
        <span style={{ fontSize: Math.max(10, size * 0.36) }}>{initialsOf(name)}</span>
      ) : (
        <Icon size={Math.max(12, size * 0.45)} />
      )}
    </span>
  );
}

/** "current_location" / "currentLocation" -> "Current location". */
export function humanizeKey(value: string): string {
  const spaced = value
    .replace(/[._-]+/gu, " ")
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .trim()
    .toLowerCase();
  return spaced ? spaced[0]!.toUpperCase() + spaced.slice(1) : value;
}

/** Parse an `m1|<iso>|<messageId>` capture order. */
export function parseCaptureOrder(order: string | null | undefined): { date: Date; messageId: string } | null {
  if (!order || !order.startsWith("m1|")) return null;
  const iso = order.slice(3, 27);
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  return { date, messageId: order.slice(28) };
}

/** Short local date for a capture order (the real-world time the turn was played). */
export function formatCaptureOrder(order: string | null | undefined, locale?: string): string | null {
  const parsed = parseCaptureOrder(order);
  if (!parsed) return null;
  return parsed.date.toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" });
}

/** The session a projected record came from, when the server reports it. */
export function recordOrigin(record: unknown): { chatId: string | null; sessionNumber: number | null } {
  const value = (record ?? {}) as { originChatId?: unknown; originSessionNumber?: unknown; chatId?: unknown };
  return {
    chatId:
      typeof value.originChatId === "string"
        ? value.originChatId
        : typeof value.chatId === "string"
          ? value.chatId
          : null,
    sessionNumber: typeof value.originSessionNumber === "number" ? value.originSessionNumber : null,
  };
}

/** Which chat owns a record for writes: its origin session when the server projected it, else the page chat. */
export function recordWriteChatId(record: unknown, fallbackChatId: string): string {
  const value = (record ?? {}) as { originChatId?: unknown };
  return typeof value.originChatId === "string" && value.originChatId ? value.originChatId : fallbackChatId;
}

export function entitySessionNumbers(entity: unknown): number[] {
  const value = (entity ?? {}) as { sessionNumbers?: unknown; originSessionNumber?: unknown };
  if (Array.isArray(value.sessionNumbers)) {
    return [...new Set(value.sessionNumbers.filter((item): item is number => typeof item === "number"))].sort(
      (a, b) => a - b,
    );
  }
  return typeof value.originSessionNumber === "number" ? [value.originSessionNumber] : [];
}

/** Compress [1,2,3,5,7,8] into "1–3, 5, 7–8". */
export function formatSessionRanges(sessions: readonly number[]): string {
  const sorted = [...new Set(sessions)].sort((a, b) => a - b);
  const parts: string[] = [];
  let start: number | null = null;
  let previous: number | null = null;
  for (const value of sorted) {
    if (start === null) {
      start = value;
    } else if (previous !== null && value !== previous + 1) {
      parts.push(start === previous ? `${start}` : `${start}–${previous}`);
      start = value;
    }
    previous = value;
  }
  if (start !== null && previous !== null) parts.push(start === previous ? `${start}` : `${start}–${previous}`);
  return parts.join(", ");
}

export interface FactDisplay {
  text: string;
  /** Readable predicate for facts without prose. */
  label: string | null;
  kind: string | null;
  claimStatus: string | null;
  conditions: string[];
  keys: string[];
  historical: boolean;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

/** Readable parts of a fact: the prose, its kind, its claim status and its conditions (deduplicated). */
export function factDisplay(fact: Pick<CampaignMemoryFact, "predicate" | "value" | "conditions">): FactDisplay {
  const record = wikiValueRecord(fact.value);
  const text = wikiValueSummary(record && typeof record.text === "string" ? record.text : fact.value);
  const conditionTexts = new Set<string>();
  for (const item of stringList(record?.conditions)) conditionTexts.add(item.trim());
  for (const condition of fact.conditions ?? []) {
    const value = wikiValueSummary(condition.value as CampaignMemoryJson).trim();
    if (value && value !== "—") conditionTexts.add(value);
  }
  const continuityRecord = Boolean(record && typeof record.text === "string");
  const kind = record && typeof record.kind === "string" ? record.kind : null;
  // Hand-written facts have no prose: the predicate names what the value is ("Age: 207").
  const label = !continuityRecord && fact.predicate && fact.predicate !== "other" ? humanizeKey(fact.predicate) : null;
  return {
    text,
    label,
    kind: kind || null,
    claimStatus: record && typeof record.status === "string" ? record.status : null,
    conditions: [...conditionTexts],
    keys: stringList(record?.keys),
    historical: record?.historical === true,
  };
}

/** Tone for a continuity record kind. */
export function factKindTone(kind: string | null): WikiTone {
  switch (kind) {
    case "decision":
    case "commitment":
    case "promise":
    case "agreement":
      return "accent";
    case "offer":
    case "invitation":
    case "proposal":
    case "request":
      return "info";
    case "condition":
    case "restriction":
    case "rule":
      return "warning";
    case "correction":
    case "conflict":
      return "danger";
    case "learning":
    case "outcome":
    case "reaction":
      return "success";
    default:
      return "neutral";
  }
}

/** Visually quiet loading placeholder rows. */
export function WikiSkeleton({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("space-y-2", className)} aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="h-14 animate-pulse rounded-xl bg-secondary/50" />
      ))}
    </div>
  );
}
