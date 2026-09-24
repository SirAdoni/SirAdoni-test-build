import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Check, ChevronDown, Loader2, Minus, Plus, X } from "lucide-react";
import type {
  CampaignMemoryAuthoringRequest,
  CampaignMemoryAuthoringPreview,
  CampaignMemoryEntity,
  CampaignMemoryEntityDetail,
  CampaignMemoryEntityKind,
  CampaignMemoryFact,
  CampaignMemoryKnowledge,
  CampaignMemoryPage,
  CampaignMemoryRelationshipStatus,
} from "@marinara-engine/shared";
import { useTranslation as useUiTranslation } from "react-i18next";
import { api } from "../../lib/api-client";
import { cn } from "../../lib/utils";
import { wikiValueSummary } from "../../lib/campaign-wiki-value";
import {
  useApplyCampaignMemoryMutation,
  useCampaignMemoryEntities,
  usePreviewCampaignMemoryMutation,
} from "../../hooks/use-campaign-memory";
import {
  WikiCard,
  WikiChip,
  crossSessionReferenceDetail,
  crossSessionReferenceText,
  factDisplay,
  humanizeKey,
  isWikiRevisionConflict,
  recordOrigin,
  recordWriteChatId,
} from "./campaign-wiki-ui";
import type { TFn } from "./CampaignWikiReaderParts";

type RecordKind = "fact" | "knowledge" | "relationship" | "entity";

const CREATABLE_ENTITY_KINDS = ["organization", "item", "quest", "lore", "note"] as const;
type CreatableEntityKind = (typeof CREATABLE_ENTITY_KINDS)[number];

/** Owner stores accepted by the server for existing owners (mirrors CAMPAIGN_MEMORY_OWNER_STORES); registry kinds own themselves. */
const EXISTING_OWNER_STORES: Partial<Record<CampaignMemoryEntityKind, string>> = {
  lore: "lorebook-entries",
  quest: "game-state",
  item: "game-state",
};

type Translate = ReturnType<typeof useUiTranslation>["t"];

function newOperationId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `campaign-memory-create-${Date.now()}`;
}

function lines(value: string) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function shorten(value: string, max = 70) {
  const clean = value.replace(/\s+/gu, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/* ------------------------------------------------------------------------------------------------------------------
 * Shared editor building blocks (also used by CampaignWikiEditor). Every string arrives already translated.
 * ---------------------------------------------------------------------------------------------------------------- */

const INPUT_CLASS =
  "mt-1.5 block w-full rounded-lg border bg-background/70 px-3 py-2 text-sm leading-6 text-foreground placeholder:text-muted-foreground/70 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-60";

export const editorButton = {
  primary:
    "inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-sm transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50",
  secondary:
    "inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg border border-border bg-secondary/50 px-4 text-sm font-semibold text-foreground transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-50",
  ghost:
    "inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-secondary/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-50",
};

export function EditorField({
  label,
  value,
  onChange,
  disabled = false,
  hint,
  error,
  required = false,
  requiredLabel,
  multiline = true,
  rows = 1,
  maxLength,
  counter,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  /** Visible "Required" marker; kept outside the label so the accessible name stays the plain label. */
  requiredLabel?: string;
  multiline?: boolean;
  rows?: number;
  maxLength?: number;
  counter?: string;
  placeholder?: string;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  const className = cn(
    INPUT_CLASS,
    error ? "border-destructive/70" : "border-border",
    multiline && "resize-y [field-sizing:content]",
  );
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <label htmlFor={id} className="text-[0.8125rem] font-semibold text-foreground">
          {label}
        </label>
        {required && requiredLabel && (
          <span aria-hidden="true" className="text-[0.6875rem] font-medium text-muted-foreground">
            {requiredLabel}
          </span>
        )}
      </div>
      {multiline ? (
        <textarea
          id={id}
          required={required}
          value={value}
          rows={rows}
          disabled={disabled}
          maxLength={maxLength}
          placeholder={placeholder}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
          className={className}
          style={{ minHeight: `${Math.max(rows, 1) * 1.5 + 1.1}rem` }}
        />
      ) : (
        <input
          id={id}
          type="text"
          required={required}
          value={value}
          disabled={disabled}
          maxLength={maxLength}
          placeholder={placeholder}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
          className={cn(className, "min-h-10")}
        />
      )}
      {(hint || counter) && !error && (
        <div className="mt-1 flex items-start justify-between gap-3 text-xs leading-5 text-muted-foreground">
          {hint ? <p id={hintId}>{hint}</p> : <span />}
          {counter && <span className="shrink-0 tabular-nums">{counter}</span>}
        </div>
      )}
      {error && (
        <p id={errorId} className="mt-1 flex items-start gap-1 text-xs leading-5 text-destructive">
          <AlertTriangle size={12} className="mt-1 shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}

export function EditorSelect({
  label,
  value,
  onChange,
  disabled = false,
  hint,
  error,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="text-[0.8125rem] font-semibold text-foreground">
        {label}
      </label>
      <div className="relative">
        <select
          id={id}
          value={value}
          disabled={disabled}
          aria-describedby={hint ? hintId : undefined}
          aria-invalid={error ? true : undefined}
          onChange={(event) => onChange(event.target.value)}
          className={cn(
            INPUT_CLASS,
            "min-h-10 appearance-none pr-9",
            error ? "border-destructive/70" : "border-border",
          )}
        >
          {children}
        </select>
        <ChevronDown
          size={15}
          aria-hidden="true"
          className="pointer-events-none absolute right-3 top-1/2 mt-[3px] -translate-y-1/2 text-muted-foreground"
        />
      </div>
      {hint && !error && (
        <p id={hintId} className="mt-1 text-xs leading-5 text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p className="mt-1 flex items-start gap-1 text-xs leading-5 text-destructive">
          <AlertTriangle size={12} className="mt-1 shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}

/** Checkbox row: the label stays the plain title so tests and screen readers get a stable name. */
export function EditorToggle({
  label,
  description,
  checked,
  onChange,
  disabled = false,
  tone = "neutral",
}: {
  label: string;
  description?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  tone?: "neutral" | "danger";
}) {
  const id = useId();
  return (
    <div
      className={cn(
        "flex min-h-11 items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors",
        checked
          ? tone === "danger"
            ? "border-destructive/50 bg-destructive/10"
            : "border-primary/45 bg-primary/10"
          : "border-border bg-secondary/30",
      )}
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-describedby={description ? `${id}-description` : undefined}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-5 w-5 shrink-0 cursor-pointer accent-[var(--primary)] disabled:cursor-not-allowed"
      />
      <div className="min-w-0">
        <label htmlFor={id} className="cursor-pointer text-sm font-semibold text-foreground">
          {label}
        </label>
        {description && (
          <p id={`${id}-description`} className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {description}
          </p>
        )}
      </div>
    </div>
  );
}

/** One titled group of fields. A solid reading card; never place another card inside it. */
export function EditorSection({
  title,
  description,
  icon,
  children,
  label,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  children: ReactNode;
  label?: string;
  className?: string;
}) {
  return (
    <WikiCard as="section" className={cn("space-y-3.5 p-4", className)}>
      <header aria-label={label}>
        <h4 className="flex items-center gap-2 text-sm font-bold text-foreground">
          {icon && <span className="text-muted-foreground">{icon}</span>}
          {title}
        </h4>
        {description && <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{description}</p>}
      </header>
      {children}
    </WikiCard>
  );
}

export function EditorAlert({
  tone = "danger",
  children,
  action,
}: {
  tone?: "danger" | "warning" | "info";
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cn(
        "flex flex-wrap items-start gap-2 rounded-lg border px-3 py-2.5 text-sm leading-5",
        tone === "danger" && "border-destructive/50 bg-destructive/10 text-destructive",
        tone === "warning" && "border-amber-400/40 bg-amber-400/10 text-amber-100",
        tone === "info" && "border-sky-400/35 bg-sky-400/10 text-sky-100",
      )}
    >
      <AlertTriangle size={15} className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </div>
  );
}

/** Edit -> Review -> Save progress. */
export function EditorStepper({ step, labels }: { step: 1 | 2 | 3; labels: [string, string, string] }) {
  return (
    <ol className="flex items-center gap-1.5 text-xs font-semibold">
      {labels.map((label, index) => {
        const number = (index + 1) as 1 | 2 | 3;
        const done = number < step;
        const active = number === step;
        return (
          <li key={label} className="flex min-w-0 items-center gap-1.5" aria-current={active ? "step" : undefined}>
            {index > 0 && (
              <span
                aria-hidden="true"
                className={cn("h-px w-4 shrink-0 sm:w-8", done || active ? "bg-primary/60" : "bg-border")}
              />
            )}
            <span
              aria-hidden="true"
              className={cn(
                "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[0.6875rem] tabular-nums",
                active && "border-primary bg-primary text-primary-foreground",
                done && "border-primary/50 bg-primary/15 text-foreground",
                !active && !done && "border-border text-muted-foreground",
              )}
            >
              {done ? <Check size={12} /> : number}
            </span>
            <span className={cn("truncate", active ? "text-foreground" : "text-muted-foreground")}>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** Save/cancel bar that stays in reach at the bottom of long forms. */
export function EditorFooter({ status, children }: { status?: ReactNode; children: ReactNode }) {
  return (
    <div className="sticky bottom-0 z-10 -mx-1 border-t border-border bg-background px-1 pb-[max(0.75rem,var(--mari-safe-area-inset-bottom,env(safe-area-inset-bottom)))] pt-3">
      {status && <div className="mb-2 text-xs leading-5 text-muted-foreground">{status}</div>}
      <div className="flex flex-wrap items-center justify-end gap-2 [&>*]:flex-1 sm:[&>*]:flex-none">{children}</div>
    </div>
  );
}

/* ---------------------------------------------- Readable change review ---------------------------------------------- */

const FIELD_NAMES: Record<string, string> = {
  aliases: "Names",
  tags: "Tags",
  summary: "Description",
  body: "Notes",
  manualLock: "Protection",
  status: "Status",
  predicate: "Topic",
  value: "Details",
  conditions: "When it applies",
  kind: "Kind",
  epistemicState: "How they know it",
  type: "Relationship",
  inverseLabel: "The other way round",
  validFromOrder: "Applies from",
  targetEntityId: "Connected page",
  sourceEntityId: "From page",
  subjectEntityId: "About",
  holderEntityId: "Who knows it",
  factId: "Fact",
};

/** Fields that are identifiers or plumbing; shown only inside the collapsed technical details. */
const TECHNICAL_FIELDS = new Set([
  "entityId",
  "factId",
  "knowledgeId",
  "relationshipId",
  "subjectEntityId",
  "holderEntityId",
  "sourceEntityId",
  "supersedesFactId",
  "owner",
  "evidence",
  "attributes",
  "learnedFrom",
  "revision",
  "createdAt",
  "updatedAt",
  "provenance",
  "chatId",
  "operationId",
  "payloadHash",
  "originChatId",
  "originSessionNumber",
  "validFromOrder",
]);

function fieldName(t: Translate, field: string) {
  return t(`ui.game.campaignWiki.editor.fieldName.${field}`, {
    defaultValue: FIELD_NAMES[field] ?? humanizeKey(field),
  });
}

function isEmptyValue(value: unknown) {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && !value.trim()) ||
    (Array.isArray(value) && value.length === 0)
  );
}

function readableItems(field: string, value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (field === "conditions") {
    return value.map((item) => {
      const record = (item ?? {}) as { kind?: unknown; value?: unknown };
      const text = wikiValueSummary(record.value);
      return typeof record.kind === "string" && record.kind !== "condition"
        ? `${humanizeKey(record.kind)}: ${text}`
        : text;
    });
  }
  return value.map((item) => wikiValueSummary(item));
}

function readableValue(t: Translate, field: string, value: unknown, resolveName?: (id: string) => string | undefined) {
  if (isEmptyValue(value)) return t("ui.game.campaignWiki.editor.review.empty", { defaultValue: "Empty" });
  if (field === "manualLock" && typeof value === "boolean") {
    return value
      ? t("ui.game.campaignWiki.editor.review.protected", { defaultValue: "Protected from automatic changes" })
      : t("ui.game.campaignWiki.editor.review.unprotected", { defaultValue: "Can be updated automatically" });
  }
  if (field === "status" && typeof value === "string") {
    return t(`ui.game.campaignWiki.editor.status.${value}`, { defaultValue: humanizeKey(value) });
  }
  if (field === "epistemicState" && typeof value === "string") {
    return t(`ui.game.campaignWiki.epistemicState.${value}`, { defaultValue: humanizeKey(value) });
  }
  if (field === "kind" && typeof value === "string") {
    return t(`ui.game.campaignWiki.kind.${value}`, { defaultValue: humanizeKey(value) });
  }
  if (field.endsWith("EntityId") && typeof value === "string") return resolveName?.(value) ?? value;
  if (typeof value === "boolean") {
    return value
      ? t("ui.game.campaignWiki.editor.review.yes", { defaultValue: "Yes" })
      : t("ui.game.campaignWiki.editor.review.no", { defaultValue: "No" });
  }
  return wikiValueSummary(value);
}

function ListDiff({ t, field, before, after }: { t: Translate; field: string; before: unknown; after: unknown }) {
  const oldItems = readableItems(field, before) ?? [];
  const newItems = readableItems(field, after) ?? [];
  const removed = oldItems.filter((item) => !newItems.includes(item));
  const added = newItems.filter((item) => !oldItems.includes(item));
  const kept = newItems.filter((item) => oldItems.includes(item));
  return (
    <div className="flex flex-wrap gap-1.5">
      {removed.map((item) => (
        <WikiChip
          key={`removed-${item}`}
          tone="danger"
          icon={<Minus size={11} />}
          title={t("ui.game.campaignWiki.editor.review.removedItem", { defaultValue: "Removed: {{item}}", item })}
          className="line-through decoration-destructive/60"
        >
          {item}
        </WikiChip>
      ))}
      {added.map((item) => (
        <WikiChip
          key={`added-${item}`}
          tone="success"
          icon={<Plus size={11} />}
          title={t("ui.game.campaignWiki.editor.review.addedItem", { defaultValue: "Added: {{item}}", item })}
        >
          {item}
        </WikiChip>
      ))}
      {kept.map((item) => (
        <WikiChip key={`kept-${item}`}>{item}</WikiChip>
      ))}
      {removed.length + added.length + kept.length === 0 && (
        <span className="text-xs text-muted-foreground">
          {t("ui.game.campaignWiki.editor.review.empty", { defaultValue: "Empty" })}
        </span>
      )}
    </div>
  );
}

/**
 * Human-readable preview of a validated change: before and after side by side for updates, a plain list of what will
 * be added for creations. Identifiers and plumbing go into one collapsed "Technical details" disclosure.
 */
export function ChangeReview({
  preview,
  resolveName,
  footnote,
}: {
  preview: CampaignMemoryAuthoringPreview;
  resolveName?: (id: string) => string | undefined;
  footnote?: ReactNode;
}) {
  const { t } = useUiTranslation();
  const before = (preview.before ?? undefined) as Record<string, unknown> | undefined;
  const after = (preview.after ?? undefined) as Record<string, unknown> | undefined;
  const creating = preview.action === "create" || !before;
  const fields = Object.keys(preview.diff);
  const friendly = fields.filter((field) => {
    if (!TECHNICAL_FIELDS.has(field)) return true;
    // Links to another page read naturally once the page name is known.
    return (
      field.endsWith("EntityId") &&
      field !== "subjectEntityId" &&
      typeof preview.diff[field] === "string" &&
      Boolean(resolveName?.(preview.diff[field] as string))
    );
  });
  const technical = fields.filter((field) => !friendly.includes(field));
  const shown = creating ? friendly.filter((field) => !isEmptyValue(after?.[field] ?? preview.diff[field])) : friendly;
  return (
    <WikiCard as="section" className="space-y-3 p-4">
      <header>
        <h4 className="flex items-center gap-2 text-sm font-bold text-foreground">
          <Check size={15} className="text-primary" />
          {t("ui.game.campaignWiki.editor.changedFields")}
        </h4>
        <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
          {creating
            ? t("ui.game.campaignWiki.editor.review.createHint", {
                defaultValue: "This is what will be added. Nothing is saved until you confirm.",
              })
            : t("ui.game.campaignWiki.editor.review.updateHint", {
                defaultValue: "Compare the old and new versions. Nothing is saved until you confirm.",
              })}
        </p>
      </header>
      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("ui.game.campaignWiki.editor.noChangedFields")}</p>
      ) : (
        <ul className="divide-y divide-border/70">
          {shown.map((field) => {
            const oldValue = before?.[field];
            const newValue = after && field in after ? after[field] : preview.diff[field];
            const list = Array.isArray(oldValue) || Array.isArray(newValue);
            return (
              <li key={field} className="space-y-1.5 py-2.5 first:pt-0 last:pb-0">
                <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
                  {fieldName(t, field)}
                </p>
                {list && !creating ? (
                  <ListDiff t={t} field={field} before={oldValue} after={newValue} />
                ) : list ? (
                  <ul className="list-disc space-y-0.5 pl-5 text-sm leading-6 text-foreground">
                    {(readableItems(field, newValue) ?? []).map((item, index) => (
                      <li key={`${item}-${index}`} className="break-words">
                        {item}
                      </li>
                    ))}
                  </ul>
                ) : creating ? (
                  <p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">
                    {readableValue(t, field, newValue, resolveName)}
                  </p>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-[1fr_auto_1fr] sm:items-stretch">
                    <div className="min-w-0 rounded-lg bg-secondary/40 px-3 py-2">
                      <p className="text-[0.625rem] pointer-coarse:text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
                        {t("ui.game.campaignWiki.editor.review.before", { defaultValue: "Before" })}
                      </p>
                      <p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-6 text-muted-foreground">
                        {readableValue(t, field, oldValue, resolveName)}
                      </p>
                    </div>
                    <ArrowRight
                      size={15}
                      aria-hidden="true"
                      className="mx-auto hidden self-center text-muted-foreground sm:block"
                    />
                    <div className="min-w-0 rounded-lg border border-primary/35 bg-primary/10 px-3 py-2">
                      <p className="text-[0.625rem] pointer-coarse:text-[0.6875rem] font-semibold uppercase tracking-wide text-foreground/80">
                        {t("ui.game.campaignWiki.editor.review.after", { defaultValue: "After" })}
                      </p>
                      <p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-6 text-foreground">
                        {readableValue(t, field, newValue, resolveName)}
                      </p>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {footnote && <p className="text-xs leading-5 text-muted-foreground">{footnote}</p>}
      {technical.length > 0 && (
        <details className="group rounded-lg border border-border/70 px-3 py-2 text-xs">
          <summary className="flex min-h-8 pointer-coarse:min-h-9 cursor-pointer list-none items-center gap-1.5 font-medium text-muted-foreground">
            <ChevronDown size={13} className="transition-transform group-open:rotate-180" />
            {t("ui.game.campaignWiki.editor.review.technical", { defaultValue: "Technical details" })}
          </summary>
          <dl className="mt-2 space-y-1.5">
            {technical.map((field) => (
              <div key={field} className="grid gap-0.5 sm:grid-cols-[10rem_1fr]">
                <dt className="font-mono text-muted-foreground">{field}</dt>
                <dd className="break-all font-mono text-foreground/80">
                  {(() => {
                    const value = after && field in after ? after[field] : preview.diff[field];
                    try {
                      return typeof value === "string" ? value : JSON.stringify(value);
                    } catch {
                      return String(value);
                    }
                  })()}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </WikiCard>
  );
}

/* ------------------------------------------------ Create record ------------------------------------------------ */

type CreateError =
  | "validation"
  | "preview"
  | "apply"
  | "conflict"
  | "crossSession"
  | "ownerLinked"
  | "ownerChecking"
  | null;

export function CampaignWikiCreateRecord({
  chatId,
  detail,
  onCancel,
  onApplied,
  onDirtyChange,
}: {
  chatId: string;
  detail: CampaignMemoryEntityDetail;
  onCancel: () => void;
  onApplied: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { t } = useUiTranslation();
  const { entity, facts, referencedFacts } = detail;
  const entityName =
    entity.aliases.find((alias) => alias.trim()) ??
    t("ui.game.campaignWiki.create.thisPage", { defaultValue: "this page" });
  const [kind, setKind] = useState<RecordKind>("fact");
  const [predicate, setPredicate] = useState("");
  const [factValue, setFactValue] = useState("");
  const [conditions, setConditions] = useState("");
  const [factStatus, setFactStatus] = useState<CampaignMemoryFact["status"]>("proposed");
  const [holderState, setHolderState] = useState<CampaignMemoryKnowledge["epistemicState"]>("knows");
  const [factId, setFactId] = useState("");
  const [targetQuery, setTargetQuery] = useState("");
  const [targetId, setTargetId] = useState("");
  const [relationshipType, setRelationshipType] = useState("");
  const [inverseLabel, setInverseLabel] = useState("");
  const [relationshipStatus, setRelationshipStatus] = useState<CampaignMemoryRelationshipStatus>("proposed");
  const [entityKind, setEntityKind] = useState<CreatableEntityKind>("organization");
  const [newEntityName, setNewEntityName] = useState("");
  const [entityAliases, setEntityAliases] = useState("");
  const [entityTags, setEntityTags] = useState("");
  const [entitySummary, setEntitySummary] = useState("");
  const [ownerRecordId, setOwnerRecordId] = useState("");
  const [ownerLookup, setOwnerLookup] = useState("");
  const [reason, setReason] = useState("");
  const [request, setRequest] = useState<CampaignMemoryAuthoringRequest | null>(null);
  const [preview, setPreview] = useState<CampaignMemoryAuthoringPreview | null>(null);
  const [error, setError] = useState<CreateError>(null);
  // Server reason for CAMPAIGN_MEMORY_CROSS_SESSION_REFERENCE (who or what the write session lacks).
  const [crossSessionDetail, setCrossSessionDetail] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [dirty, setDirty] = useState(false);
  const version = useRef(0);
  const mounted = useRef(true);
  const reviewRef = useRef<HTMLDivElement | null>(null);
  // Records about this page belong to the page's own session; a brand new page belongs to the session being viewed.
  const writeChatId = kind === "entity" ? chatId : recordWriteChatId(entity, chatId);
  const previewMutation = usePreviewCampaignMemoryMutation(writeChatId);
  const applyMutation = useApplyCampaignMemoryMutation(writeChatId);
  const targets = useCampaignMemoryEntities(chatId, {
    query: targetQuery,
    kind: "all",
    offset: 0,
    limit: 20,
    enabled: kind === "relationship",
  });
  const ownerStore = EXISTING_OWNER_STORES[entityKind];
  const ownerRef = ownerStore && ownerLookup ? `${ownerStore}:${ownerLookup}` : "";
  // Contract item 2: entities already owned by the chosen existing owner record.
  const ownerEntities = useQuery({
    queryKey: ["campaign-memory", "owner", chatId, ownerRef],
    queryFn: () =>
      api.get<CampaignMemoryPage<CampaignMemoryEntity>>(
        `/game/${chatId}/memory/entities?owner=${encodeURIComponent(ownerRef)}&offset=0&limit=5`,
      ),
    enabled: kind === "entity" && Boolean(ownerRef),
    staleTime: 0,
  });
  const ownerId = ownerRecordId.trim();
  // The lookup is debounced: its result only counts when it covers the exact ID being sent and is not refetching.
  const ownerCheckPending = Boolean(ownerStore) && (ownerLookup !== ownerId || ownerEntities.isFetching);
  const ownerCheckCurrent = Boolean(ownerStore && ownerId) && !ownerCheckPending;
  const ownerLinked = ownerCheckCurrent ? ownerEntities.data?.items[0] : undefined;

  // Knowledge must cite a fact of the write session: a fact that exists only in another session is refused with
  // CAMPAIGN_MEMORY_CROSS_SESSION_REFERENCE unless this session has its own copy. Same-session facts come first; the
  // others stay choosable (the server maps a copy when one exists) but are labelled with their session.
  const verifiedFacts = useMemo(() => {
    const byId = new Map<string, CampaignMemoryFact>();
    [...facts.items, ...referencedFacts].forEach((fact) => {
      if (fact.status === "verified" && detail.sourceChecks?.[fact.factId]?.state !== "stale")
        byId.set(fact.factId, fact);
    });
    const sameSession: CampaignMemoryFact[] = [];
    const otherSessions: CampaignMemoryFact[] = [];
    for (const fact of byId.values()) {
      if ((recordOrigin(fact).chatId ?? writeChatId) === writeChatId) sameSession.push(fact);
      else otherSessions.push(fact);
    }
    otherSessions.sort(
      (left, right) =>
        (recordOrigin(right).sessionNumber ?? -1) - (recordOrigin(left).sessionNumber ?? -1) ||
        left.predicate.localeCompare(right.predicate),
    );
    return { sameSession, otherSessions, all: [...sameSession, ...otherSessions] };
  }, [detail.sourceChecks, facts.items, referencedFacts, writeChatId]);
  const chosenOtherSessionFact = verifiedFacts.otherSessions.find((fact) => fact.factId === factId);

  const targetNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const candidate of [...detail.relatedEntities, ...(targets.data?.items ?? [])]) {
      const name = candidate.aliases.find((alias) => alias.trim());
      if (name) names.set(candidate.entityId, name);
    }
    return names;
  }, [detail.relatedEntities, targets.data?.items]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  useEffect(() => {
    const timer = window.setTimeout(() => setOwnerLookup(ownerRecordId.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [ownerRecordId]);

  useEffect(() => {
    // The "still checking" notice clears itself once the owner check has caught up.
    if (!ownerCheckPending) setError((current) => (current === "ownerChecking" ? null : current));
  }, [ownerCheckPending]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  useEffect(() => {
    if (preview) reviewRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [preview]);

  const busy = previewMutation.isPending || applyMutation.isPending;
  const invalidate = () => {
    version.current += 1;
    setRequest(null);
    setPreview(null);
    setError(null);
  };
  const edit =
    <T,>(setter: (value: T) => void) =>
    (value: T) => {
      setter(value);
      invalidate();
      setDirty(true);
    };
  const changeKind = (value: RecordKind) => {
    setKind(value);
    setTargetId("");
    setAttempted(false);
    invalidate();
    setDirty(true);
  };
  const close = () => {
    if (
      dirty &&
      !window.confirm(t("ui.game.campaignWiki.editor.unsavedConfirm", { defaultValue: "Discard unsaved record?" }))
    )
      return;
    onCancel();
  };
  const entityAliasList = () => {
    const first = newEntityName.trim();
    return [...(first ? [first] : []), ...lines(entityAliases).filter((alias) => alias !== first)];
  };
  const buildRequest = (): CampaignMemoryAuthoringRequest | null => {
    if (!reason.trim()) return null;
    const operationId = newOperationId();
    if (kind === "fact") {
      if (!predicate.trim() || !factValue.trim()) return null;
      const parsedConditions = lines(conditions).map((line) => ({ kind: "condition", value: line }));
      return {
        operationId,
        action: "create",
        recordType: "fact",
        reason: reason.trim(),
        input: {
          subjectEntityId: entity.entityId,
          predicate: predicate.trim(),
          value: factValue.trim(),
          conditions: parsedConditions,
          status: factStatus,
          evidence: [],
          manualLock: false,
        },
      };
    }
    if (kind === "knowledge") {
      if (!factId) return null;
      return {
        operationId,
        action: "create",
        recordType: "knowledge",
        reason: reason.trim(),
        input: {
          holderEntityId: entity.entityId,
          factId,
          epistemicState: holderState,
          learnedFrom: [],
          manualLock: false,
        },
      };
    }
    if (kind === "entity") {
      const aliases = entityAliasList();
      if (aliases.length === 0) return null;
      const recordId = ownerRecordId.trim();
      if (ownerStore && !recordId) return null;
      // Registry owners must point at their own entity ID, so the ID is fixed before the request is previewed.
      const entityId = ownerStore ? undefined : operationId;
      return {
        operationId,
        action: "create",
        recordType: "entity",
        reason: reason.trim(),
        input: {
          ...(entityId ? { entityId } : {}),
          kind: entityKind,
          owner: ownerStore
            ? { type: "existing", store: ownerStore, recordId }
            : { type: "registry", store: "campaign-memory", recordId: entityId },
          aliases,
          tags: entityTags
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
          ...(entitySummary.trim() ? { summary: entitySummary.trim() } : {}),
          attributes: {},
          status: "active",
          manualLock: false,
        },
      };
    }
    if (!targetId || !relationshipType.trim() || !inverseLabel.trim()) return null;
    return {
      operationId,
      action: "create",
      recordType: "relationship",
      reason: reason.trim(),
      input: {
        sourceEntityId: entity.entityId,
        targetEntityId: targetId,
        type: relationshipType.trim(),
        inverseLabel: inverseLabel.trim(),
        status: relationshipStatus,
        evidence: [],
        manualLock: false,
      },
    };
  };
  const previewDraft = () => {
    setAttempted(true);
    if (kind === "entity" && ownerStore && ownerId) {
      if (ownerCheckPending) {
        setError("ownerChecking");
        return;
      }
      if (ownerLinked || !ownerEntities.data) {
        setError(ownerLinked ? "ownerLinked" : "validation");
        return;
      }
    }
    const next = buildRequest();
    if (!next) {
      setError("validation");
      return;
    }
    setError(null);
    const requestVersion = version.current;
    setRequest(next);
    void previewMutation
      .mutateAsync(next)
      .then((result) => {
        if (mounted.current && requestVersion === version.current) setPreview(result);
      })
      .catch((failure: unknown) => {
        if (mounted.current && requestVersion === version.current) {
          const detail = crossSessionReferenceDetail(failure);
          setPreview(null);
          setCrossSessionDetail(detail ?? "");
          setError(detail !== null ? "crossSession" : "preview");
        }
      });
  };
  const apply = () => {
    if (!request || !preview) return;
    // A check that finished after the preview still blocks a second page for the same owner.
    if (kind === "entity" && ownerStore && (ownerCheckPending || ownerLinked)) {
      setError(ownerLinked ? "ownerLinked" : "ownerChecking");
      return;
    }
    setError(null);
    void applyMutation
      .mutateAsync(request)
      .then(() => {
        setDirty(false);
        setRequest(null);
        setPreview(null);
        onApplied();
      })
      .catch((reasonValue: unknown) => {
        const detail = crossSessionReferenceDetail(reasonValue);
        setCrossSessionDetail(detail ?? "");
        setError(detail !== null ? "crossSession" : isWikiRevisionConflict(reasonValue) ? "conflict" : "apply");
      });
  };

  const required = t("ui.game.campaignWiki.editor.required", { defaultValue: "Required" });
  const requiredError = t("ui.game.campaignWiki.editor.requiredError", { defaultValue: "Fill this in to continue." });
  const need = (empty: boolean) => (attempted && empty ? requiredError : null);
  const step: 1 | 2 | 3 = applyMutation.isPending ? 3 : preview ? 2 : 1;
  const typeHint: Record<RecordKind, string> = {
    fact: t("ui.game.campaignWiki.create.typeHint.fact", {
      defaultValue: "Something true about {{name}}, like a trait, a possession or a promise.",
      name: entityName,
    }),
    knowledge: t("ui.game.campaignWiki.create.typeHint.knowledge", {
      defaultValue: "Something {{name}} knows, believes or has heard as a rumour.",
      name: entityName,
    }),
    relationship: t("ui.game.campaignWiki.create.typeHint.relationship", {
      defaultValue: "How {{name}} is connected to another page.",
      name: entityName,
    }),
    entity: t("ui.game.campaignWiki.create.typeHint.entity", {
      defaultValue: "A brand new page for an organization, item, quest, lore entry or note.",
    }),
  };
  const ownerStoreName = ownerStore
    ? t(
        `ui.game.campaignWiki.create.ownerStoreName.${ownerStore.replace(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase())}`,
        { defaultValue: humanizeKey(ownerStore) },
      )
    : "";
  const factOption = (fact: CampaignMemoryFact) => {
    const text = factDisplay(fact).text;
    const label =
      text && text !== "—" && text !== fact.predicate
        ? t("ui.game.campaignWiki.create.factOption", {
            defaultValue: "{{topic}}: {{text}}",
            topic: fact.predicate,
            text: shorten(text),
          })
        : fact.predicate;
    const origin = recordOrigin(fact);
    const otherSession = (origin.chatId ?? writeChatId) !== writeChatId;
    return (
      <option key={fact.factId} value={fact.factId} data-other-session={otherSession ? "true" : undefined}>
        {!otherSession
          ? label
          : origin.sessionNumber !== null
            ? t("ui.game.campaignWiki.create.factOptionFromSession", {
                defaultValue: "{{option}} (from Session {{number}})",
                option: label,
                number: origin.sessionNumber,
              })
            : t("ui.game.campaignWiki.create.factOptionFromOtherSession", {
                defaultValue: "{{option}} (from another session)",
                option: label,
              })}
      </option>
    );
  };
  const errorText =
    error === "validation"
      ? t("ui.game.campaignWiki.create.validation", { defaultValue: "Complete the required fields and reason." })
      : error === "ownerChecking"
        ? t("ui.game.campaignWiki.create.ownerStillChecking", {
            defaultValue: "Still checking whether this owner already has a page. Try again in a moment.",
          })
        : error === "ownerLinked"
          ? t("ui.game.campaignWiki.create.ownerLinked", {
              name: ownerLinked?.aliases[0] || ownerLinked?.entityId || "",
            })
          : error === "crossSession"
            ? crossSessionReferenceText(t as TFn, crossSessionDetail)
            : error === "conflict"
              ? t("ui.game.campaignWiki.editor.conflict")
              : error === "preview"
                ? t("ui.game.campaignWiki.editor.previewError")
                : error === "apply"
                  ? t("ui.game.campaignWiki.editor.applyError")
                  : null;

  return (
    <div className="space-y-4" aria-label={t("ui.game.campaignWiki.create.title", { defaultValue: "Add record" })}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-2">
          <div>
            <h4 className="text-lg font-bold leading-tight text-foreground">
              {t("ui.game.campaignWiki.create.title", { defaultValue: "Add record" })}
            </h4>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("ui.game.campaignWiki.create.subtitle", {
                defaultValue: "Add something new to {{name}}. You will see a preview before anything is saved.",
                name: entityName,
              })}
            </p>
          </div>
          <EditorStepper
            step={step}
            labels={[
              t("ui.game.campaignWiki.editor.step.edit", { defaultValue: "Write" }),
              t("ui.game.campaignWiki.editor.step.review", { defaultValue: "Review" }),
              t("ui.game.campaignWiki.editor.step.save", { defaultValue: "Save" }),
            ]}
          />
        </div>
        <button
          type="button"
          onClick={close}
          disabled={busy}
          className={editorButton.ghost}
          aria-label={t("ui.game.campaignWiki.create.close", { defaultValue: "Close without adding" })}
        >
          <X size={16} />
        </button>
      </div>

      <EditorSection
        title={t("ui.game.campaignWiki.create.whatToAdd", { defaultValue: "What would you like to add?" })}
      >
        <EditorSelect
          label={t("ui.game.campaignWiki.create.type", { defaultValue: "Record type" })}
          value={kind}
          onChange={(value) => changeKind(value as RecordKind)}
          disabled={busy}
          hint={typeHint[kind]}
        >
          <option value="fact">{t("ui.game.campaignWiki.create.fact", { defaultValue: "Fact" })}</option>
          {(entity.kind === "character" || entity.kind === "persona") && (
            <option value="knowledge">
              {t("ui.game.campaignWiki.create.knowledge", { defaultValue: "Knowledge" })}
            </option>
          )}
          <option value="relationship">
            {t("ui.game.campaignWiki.create.relationship", { defaultValue: "Relationship" })}
          </option>
          <option value="entity">{t("ui.game.campaignWiki.create.entity")}</option>
        </EditorSelect>
      </EditorSection>

      {kind === "fact" && (
        <EditorSection
          title={t("ui.game.campaignWiki.create.factSection", { defaultValue: "The fact" })}
          description={t("ui.game.campaignWiki.create.factSectionHint", {
            defaultValue: "Write it the way you would tell another player.",
          })}
        >
          <EditorField
            label={t("ui.game.campaignWiki.create.topic", { defaultValue: "Topic" })}
            hint={t("ui.game.campaignWiki.create.topicHint", {
              defaultValue: "A short label, like occupation, owes money to, or favourite drink.",
            })}
            value={predicate}
            onChange={edit(setPredicate)}
            disabled={busy}
            required
            requiredLabel={required}
            error={need(!predicate.trim())}
          />
          <EditorField
            label={t("ui.game.campaignWiki.create.details", { defaultValue: "What is true" })}
            hint={t("ui.game.campaignWiki.create.detailsHint", {
              defaultValue: "The fact itself, in plain words.",
            })}
            value={factValue}
            onChange={edit(setFactValue)}
            disabled={busy}
            rows={3}
            required
            requiredLabel={required}
            error={need(!factValue.trim())}
          />
          <EditorField
            label={t("ui.game.campaignWiki.create.conditions")}
            hint={t("ui.game.campaignWiki.create.conditionsHint", {
              defaultValue: "Optional. When or where this is true, for example: while in the capital.",
            })}
            value={conditions}
            onChange={edit(setConditions)}
            disabled={busy}
            rows={2}
          />
          <EditorSelect
            label={t("ui.game.campaignWiki.editor.status")}
            hint={t("ui.game.campaignWiki.create.statusHint", {
              defaultValue: "Verified facts are treated as settled canon. Proposed ones can still be reviewed.",
            })}
            value={factStatus}
            onChange={(value) => edit(setFactStatus)(value as CampaignMemoryFact["status"])}
            disabled={busy}
          >
            {["proposed", "verified", "superseded", "held", "retracted"].map((status) => (
              <option key={status} value={status}>
                {t(`ui.game.campaignWiki.editor.status.${status}`, { defaultValue: humanizeKey(status) })}
              </option>
            ))}
          </EditorSelect>
        </EditorSection>
      )}

      {kind === "knowledge" && (
        <EditorSection
          title={t("ui.game.campaignWiki.create.knowledgeSection", {
            defaultValue: "What {{name}} knows",
            name: entityName,
          })}
          description={t("ui.game.campaignWiki.create.manualKnowledge", {
            defaultValue: "Knowledge is manual and has no inferred source.",
          })}
        >
          <EditorSelect
            label={t("ui.game.campaignWiki.create.verifiedFact", { defaultValue: "Existing verified fact" })}
            hint={
              verifiedFacts.all.length === 0
                ? t("ui.game.campaignWiki.create.noVerifiedFacts", {
                    defaultValue: "There are no verified facts to choose from yet. Verify a fact first.",
                  })
                : chosenOtherSessionFact
                  ? t("ui.game.campaignWiki.create.otherSessionFactHint", {
                      defaultValue:
                        "This fact was recorded in another session. It can only be saved here if this session has its own copy of it; facts from this session are safest.",
                    })
                  : undefined
            }
            value={factId}
            onChange={edit(setFactId)}
            disabled={busy}
            error={need(!factId)}
          >
            <option value="">
              {t("ui.game.campaignWiki.create.chooseFact", { defaultValue: "Choose a verified fact" })}
            </option>
            {verifiedFacts.otherSessions.length === 0 ? (
              verifiedFacts.sameSession.map(factOption)
            ) : (
              <>
                {verifiedFacts.sameSession.length > 0 && (
                  <optgroup
                    label={t("ui.game.campaignWiki.create.factsThisSession", { defaultValue: "From this session" })}
                  >
                    {verifiedFacts.sameSession.map(factOption)}
                  </optgroup>
                )}
                <optgroup
                  label={t("ui.game.campaignWiki.create.factsOtherSessions", {
                    defaultValue: "From other sessions (saved only if this session has a copy)",
                  })}
                >
                  {verifiedFacts.otherSessions.map(factOption)}
                </optgroup>
              </>
            )}
          </EditorSelect>
          <EditorSelect
            label={t("ui.game.campaignWiki.create.howKnown", { defaultValue: "How sure are they?" })}
            value={holderState}
            onChange={(value) => edit(setHolderState)(value as CampaignMemoryKnowledge["epistemicState"])}
            disabled={busy}
          >
            {(["knows", "believes", "rumor"] as const).map((state) => (
              <option key={state} value={state}>
                {t(`ui.game.campaignWiki.epistemicState.${state}`, { defaultValue: humanizeKey(state) })}
              </option>
            ))}
          </EditorSelect>
        </EditorSection>
      )}

      {kind === "relationship" && (
        <EditorSection
          title={t("ui.game.campaignWiki.create.relationshipSection", { defaultValue: "The connection" })}
          description={t("ui.game.campaignWiki.create.relationshipSectionHint", {
            defaultValue: "Find the other page, then describe the connection in both directions.",
          })}
        >
          <EditorField
            label={t("ui.game.campaignWiki.create.targetSearch", { defaultValue: "Search existing target" })}
            placeholder={t("ui.game.campaignWiki.create.targetPlaceholder", { defaultValue: "Type a name" })}
            value={targetQuery}
            onChange={(value) => {
              setTargetQuery(value);
              setTargetId("");
              invalidate();
              setDirty(true);
            }}
            disabled={busy}
          />
          <EditorSelect
            label={t("ui.game.campaignWiki.create.target", { defaultValue: "Target entity" })}
            value={targetId}
            onChange={edit(setTargetId)}
            disabled={busy}
            error={need(!targetId)}
            hint={
              targets.isLoading ? (
                <span className="inline-flex items-center gap-1">
                  <Loader2 size={12} className="animate-spin" />
                  {t("ui.game.campaignWiki.create.searching", { defaultValue: "Searching…" })}
                </span>
              ) : undefined
            }
          >
            <option value="">
              {t("ui.game.campaignWiki.create.chooseTarget", { defaultValue: "Choose a target" })}
            </option>
            {(targets.data?.items ?? [])
              .filter((candidate) => candidate.entityId !== entity.entityId)
              .map((candidate: CampaignMemoryEntity) => (
                <option key={candidate.entityId} value={candidate.entityId}>
                  {t("ui.game.campaignWiki.create.targetOption", {
                    defaultValue: "{{name}} · {{kind}}",
                    name:
                      candidate.aliases.find((alias) => alias.trim()) ||
                      t("ui.game.campaignWiki.create.untitled", { defaultValue: "Untitled" }),
                    kind: t(`ui.game.campaignWiki.kind.${candidate.kind}`, {
                      defaultValue: humanizeKey(candidate.kind),
                    }),
                  })}
                </option>
              ))}
          </EditorSelect>
          <EditorField
            label={t("ui.game.campaignWiki.create.relationshipLabel", { defaultValue: "Relationship label" })}
            hint={t("ui.game.campaignWiki.create.relationshipLabelHint", {
              defaultValue: "How {{name}} relates to them, for example: mentor of, sister of, owes a debt to.",
              name: entityName,
            })}
            value={relationshipType}
            onChange={edit(setRelationshipType)}
            disabled={busy}
            required
            requiredLabel={required}
            error={need(!relationshipType.trim())}
          />
          <EditorField
            label={t("ui.game.campaignWiki.create.inverseLabel", { defaultValue: "Inverse label" })}
            hint={t("ui.game.campaignWiki.create.inverseLabelHint", {
              defaultValue: "The same connection seen from the other side, for example: student of.",
            })}
            value={inverseLabel}
            onChange={edit(setInverseLabel)}
            disabled={busy}
            required
            requiredLabel={required}
            error={need(!inverseLabel.trim())}
          />
          <EditorSelect
            label={t("ui.game.campaignWiki.editor.status")}
            value={relationshipStatus}
            onChange={(value) => edit(setRelationshipStatus)(value as CampaignMemoryRelationshipStatus)}
            disabled={busy}
          >
            {["proposed", "active", "ended", "held"].map((status) => (
              <option key={status} value={status}>
                {t(`ui.game.campaignWiki.relationshipStatus.${status}`, { defaultValue: humanizeKey(status) })}
              </option>
            ))}
          </EditorSelect>
        </EditorSection>
      )}

      {kind === "entity" && (
        <>
          <EditorSection title={t("ui.game.campaignWiki.create.entitySection", { defaultValue: "The new page" })}>
            <EditorSelect
              label={t("ui.game.campaignWiki.create.entityKind")}
              value={entityKind}
              onChange={(value) => {
                edit(setEntityKind)(value as CreatableEntityKind);
                setOwnerRecordId("");
              }}
              disabled={busy}
            >
              {CREATABLE_ENTITY_KINDS.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {t(`ui.game.campaignWiki.kind.${candidate}`, { defaultValue: candidate })}
                </option>
              ))}
            </EditorSelect>
            <EditorField
              multiline={false}
              label={t("ui.game.campaignWiki.create.entityName", { defaultValue: "Name" })}
              hint={t("ui.game.campaignWiki.create.entityNameHint", {
                defaultValue: "The title shown at the top of the page.",
              })}
              value={newEntityName}
              onChange={edit(setNewEntityName)}
              disabled={busy}
              required
              requiredLabel={required}
              error={need(entityAliasList().length === 0)}
            />
            <EditorField
              label={t("ui.game.campaignWiki.create.entityOtherNames", { defaultValue: "Other names" })}
              hint={t("ui.game.campaignWiki.create.entityOtherNamesHint", {
                defaultValue:
                  "Optional. Nicknames, titles or spellings, one per line. They help the story find this page.",
              })}
              value={entityAliases}
              onChange={edit(setEntityAliases)}
              disabled={busy}
              rows={2}
            />
            <EditorField
              label={t("ui.game.campaignWiki.editor.tags")}
              hint={t("ui.game.campaignWiki.editor.tagsHint", {
                defaultValue: "Optional. Short labels for grouping, separated by commas.",
              })}
              value={entityTags}
              onChange={edit(setEntityTags)}
              disabled={busy}
            />
            <EditorField
              label={t("ui.game.campaignWiki.editor.summary")}
              hint={t("ui.game.campaignWiki.editor.summaryHint", {
                defaultValue: "One or two sentences shown at the top of the page.",
              })}
              value={entitySummary}
              onChange={edit(setEntitySummary)}
              disabled={busy}
              rows={3}
            />
          </EditorSection>
          <EditorSection
            label={t("ui.game.campaignWiki.create.owner")}
            title={t("ui.game.campaignWiki.create.owner")}
            description={
              ownerStore
                ? t("ui.game.campaignWiki.create.ownerExistingHint", {
                    defaultValue: "This kind of page describes a record that already exists as a {{store}}.",
                    store: ownerStoreName,
                  })
                : t("ui.game.campaignWiki.create.ownerRegistry")
            }
          >
            {ownerStore ? (
              <>
                {/* ponytail: owner selection is by stable record ID; a candidate list from the owner stores is the upgrade path. */}
                <EditorField
                  multiline={false}
                  label={t("ui.game.campaignWiki.create.ownerRecordId")}
                  hint={t("ui.game.campaignWiki.create.ownerRecordIdHint", {
                    defaultValue: "Paste the ID of the {{store}} this page is about.",
                    store: ownerStoreName,
                  })}
                  value={ownerRecordId}
                  onChange={edit(setOwnerRecordId)}
                  disabled={busy}
                  required
                  requiredLabel={required}
                  error={need(!ownerRecordId.trim())}
                />
                {ownerId && ownerCheckPending && (
                  <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Loader2 size={12} className="animate-spin" />
                    {t("ui.game.campaignWiki.create.ownerChecking")}
                  </p>
                )}
                {ownerCheckCurrent && ownerEntities.isError && (
                  <EditorAlert>{t("ui.game.campaignWiki.create.ownerCheckError")}</EditorAlert>
                )}
                {ownerCheckCurrent && ownerEntities.data && (
                  <div className="flex items-center gap-2 text-sm">
                    {ownerLinked ? (
                      <EditorAlert tone="warning">
                        {t("ui.game.campaignWiki.create.ownerLinked", {
                          name: ownerLinked.aliases[0] || ownerLinked.entityId,
                        })}
                      </EditorAlert>
                    ) : (
                      <WikiChip tone="success" icon={<Check size={11} />}>
                        {t("ui.game.campaignWiki.create.ownerFree")}
                      </WikiChip>
                    )}
                  </div>
                )}
              </>
            ) : (
              <WikiChip tone="info">
                {t("ui.game.campaignWiki.create.ownerRegistryShort", { defaultValue: "Stands on its own" })}
              </WikiChip>
            )}
          </EditorSection>
        </>
      )}

      <EditorSection title={t("ui.game.campaignWiki.editor.whySection", { defaultValue: "Why are you adding this?" })}>
        <EditorField
          label={t("ui.game.campaignWiki.editor.reason")}
          hint={t("ui.game.campaignWiki.editor.reasonHint", {
            defaultValue: "A short note for the change history, for example: fixed after session 12.",
          })}
          value={reason}
          onChange={edit(setReason)}
          disabled={busy}
          required
          requiredLabel={required}
          error={need(!reason.trim())}
        />
      </EditorSection>

      {errorText && <EditorAlert>{errorText}</EditorAlert>}

      {preview && (
        <div ref={reviewRef}>
          <ChangeReview
            preview={preview}
            resolveName={(id) => (id === entity.entityId ? entityName : targetNames.get(id))}
          />
        </div>
      )}

      <EditorFooter
        status={
          preview
            ? t("ui.game.campaignWiki.editor.footer.reviewed", {
                defaultValue: "Looks right? Save it to the wiki. Editing any field will ask for a fresh preview.",
              })
            : t("ui.game.campaignWiki.editor.footer.draft", {
                defaultValue: "Nothing is saved until you review the preview and confirm.",
              })
        }
      >
        <button type="button" onClick={close} disabled={busy} className={editorButton.ghost}>
          {t("ui.game.campaignWiki.editor.cancel", { defaultValue: "Cancel" })}
        </button>
        <button
          type="button"
          onClick={previewDraft}
          disabled={busy}
          className={preview ? editorButton.secondary : editorButton.primary}
        >
          {previewMutation.isPending && <Loader2 size={14} className="animate-spin" />}
          {previewMutation.isPending
            ? t("ui.game.campaignWiki.editor.previewing")
            : t("ui.game.campaignWiki.editor.preview")}
        </button>
        {preview && (
          <button type="button" onClick={apply} disabled={busy} className={editorButton.primary}>
            {applyMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
            {applyMutation.isPending ? t("ui.game.campaignWiki.editor.saving") : t("ui.game.campaignWiki.editor.apply")}
          </button>
        )}
      </EditorFooter>
    </div>
  );
}
