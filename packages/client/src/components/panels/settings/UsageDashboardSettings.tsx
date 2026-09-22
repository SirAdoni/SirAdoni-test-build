import { useMemo, useState, type ReactNode } from "react";
import { Check, CircleDollarSign, Loader2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_USAGE_DASHBOARD_SETTINGS,
  type UsageConnectionBucket,
  type UsageDashboardSettings,
  type UsageDayBucket,
  type UsageTotals,
} from "@marinara-engine/shared";
import {
  useSaveUsageDashboardSettings,
  useUsageDashboardSettings,
  useUsageSummary,
} from "../../../hooks/use-usage-dashboard";
import {
  estimateUsageCost,
  formatTokenCount,
  formatUsageCost,
  parsePriceDraft,
  presetUsageRange,
  USAGE_RANGE_PRESET_DAYS,
  type UsageRangePreset,
} from "../../../lib/usage-dashboard";
import { cn } from "../../../lib/utils";

type RangeChoice = UsageRangePreset | "custom";

const CHAT_ROWS_COLLAPSED = 8;

const RANGE_LABEL_KEYS: Record<RangeChoice, string> = {
  "7d": "usage.range.last7Days",
  "30d": "usage.range.last30Days",
  "90d": "usage.range.last90Days",
  custom: "usage.range.custom",
};

const FIELD_CLASS =
  "min-w-0 rounded-lg bg-[var(--secondary)] px-2 py-1.5 text-xs outline-none ring-1 ring-[var(--border)] focus:ring-[var(--ring)]";

function totalTokens(totals: Pick<UsageTotals, "inputTokens" | "outputTokens">) {
  return totals.inputTokens + totals.outputTokens;
}

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-[var(--background)]/55 px-2.5 py-2 ring-1 ring-[var(--border)]">
      <div className="truncate text-[0.625rem] text-[var(--muted-foreground)]">{label}</div>
      <div className="truncate text-sm font-semibold tabular-nums text-[var(--foreground)]" title={hint}>
        {value}
      </div>
    </div>
  );
}

function DailyBars({ days }: { days: UsageDayBucket[] }) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState<UsageDayBucket | null>(null);
  const max = Math.max(1, ...days.map(totalTokens));
  const readout = hovered ?? null;

  return (
    <div className="space-y-1.5">
      <div className="flex min-h-4 items-baseline justify-between gap-2 text-[0.625rem] text-[var(--muted-foreground)]">
        <span className="font-medium">{t("usage.byDay")}</span>
        {readout && (
          <span className="truncate tabular-nums">
            {t("usage.dayReadout", {
              day: readout.day,
              input: formatTokenCount(readout.inputTokens),
              output: formatTokenCount(readout.outputTokens),
              requests: readout.requests,
            })}
          </span>
        )}
      </div>
      <div
        role="img"
        aria-label={t("usage.byDayChartLabel")}
        className={cn(
          "flex h-24 items-end border-b border-[var(--border)]/70",
          days.length > 45 ? "gap-px" : "gap-[2px]",
        )}
        onPointerLeave={() => setHovered(null)}
      >
        {days.map((day) => {
          const value = totalTokens(day);
          const height = value > 0 ? Math.max(3, (value / max) * 100) : 0;
          return (
            <div
              key={day.day}
              className="flex h-full min-w-0 flex-1 items-end"
              onPointerEnter={() => setHovered(day)}
              title={t("usage.dayReadout", {
                day: day.day,
                input: formatTokenCount(day.inputTokens),
                output: formatTokenCount(day.outputTokens),
                requests: day.requests,
              })}
            >
              <div
                className={cn(
                  "w-full rounded-t-[4px] bg-[var(--primary)] transition-opacity",
                  hovered && hovered.day !== day.day ? "opacity-45" : "opacity-90",
                )}
                style={{ height: `${height}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="flex justify-between text-[0.5625rem] tabular-nums text-[var(--muted-foreground)]">
        <span>{days[0]?.day}</span>
        <span>{days[days.length - 1]?.day}</span>
      </div>
    </div>
  );
}

function ShareRow({
  title,
  subtitle,
  totals,
  max,
  cost,
  action,
}: {
  title: string;
  subtitle?: string;
  totals: UsageTotals;
  max: number;
  cost: string | null;
  action?: ReactNode;
}) {
  const { t } = useTranslation();
  const share = max > 0 ? (totalTokens(totals) / max) * 100 : 0;
  return (
    <div className="space-y-1 rounded-lg px-1.5 py-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-[var(--foreground)]">{title}</div>
          {subtitle && <div className="truncate text-[0.625rem] text-[var(--muted-foreground)]">{subtitle}</div>}
        </div>
        <div className="shrink-0 text-right text-[0.625rem] tabular-nums text-[var(--muted-foreground)]">
          <div>
            {t("usage.inOut", {
              input: formatTokenCount(totals.inputTokens),
              output: formatTokenCount(totals.outputTokens),
            })}
          </div>
          <div>{cost ?? t("usage.requests", { count: totals.requests })}</div>
        </div>
        {action}
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-[var(--secondary)]">
        <div className="h-full rounded-full bg-[var(--primary)]/80" style={{ width: `${share}%` }} />
      </div>
    </div>
  );
}

function PriceEditor({
  bucket,
  settings,
  onDone,
}: {
  bucket: UsageConnectionBucket;
  settings: UsageDashboardSettings;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const save = useSaveUsageDashboardSettings();
  const current = bucket.connectionId ? settings.prices[bucket.connectionId] : undefined;
  const [input, setInput] = useState(current?.input != null ? String(current.input) : "");
  const [output, setOutput] = useState(current?.output != null ? String(current.output) : "");
  const [currency, setCurrency] = useState(settings.currency);
  const parsedInput = parsePriceDraft(input);
  const parsedOutput = parsePriceDraft(output);
  const invalid = parsedInput === undefined || parsedOutput === undefined;

  const submit = async () => {
    if (invalid || !bucket.connectionId) return;
    const prices = { ...settings.prices };
    if (parsedInput == null && parsedOutput == null) delete prices[bucket.connectionId];
    else prices[bucket.connectionId] = { input: parsedInput ?? null, output: parsedOutput ?? null };
    try {
      await save.mutateAsync({ ...settings, currency: currency.trim().slice(0, 8), prices });
      onDone();
    } catch {
      /* the mutation already reported the failure */
    }
  };

  return (
    <div className="space-y-2 rounded-lg bg-[var(--background)]/55 p-2.5 ring-1 ring-[var(--border)]">
      <div className="grid grid-cols-[1fr_1fr_4rem] gap-2">
        <label className="min-w-0 space-y-1">
          <span className="block truncate text-[0.625rem] text-[var(--muted-foreground)]">
            {t("usage.pricing.input")}
          </span>
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            inputMode="decimal"
            className={cn(FIELD_CLASS, "w-full")}
          />
        </label>
        <label className="min-w-0 space-y-1">
          <span className="block truncate text-[0.625rem] text-[var(--muted-foreground)]">
            {t("usage.pricing.output")}
          </span>
          <input
            value={output}
            onChange={(event) => setOutput(event.target.value)}
            inputMode="decimal"
            className={cn(FIELD_CLASS, "w-full")}
          />
        </label>
        <label className="min-w-0 space-y-1">
          <span className="block truncate text-[0.625rem] text-[var(--muted-foreground)]">
            {t("usage.pricing.currency")}
          </span>
          <input
            value={currency}
            onChange={(event) => setCurrency(event.target.value)}
            maxLength={8}
            className={cn(FIELD_CLASS, "w-full")}
          />
        </label>
      </div>
      {invalid && <p className="text-[0.625rem] text-amber-500">{t("usage.pricing.invalid")}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onDone} className="mari-chrome-control mari-chrome-control--compact px-3">
          <X size="0.75rem" />
          {t("chat.delete.dialog.cancel")}
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={invalid || save.isPending}
          className="mari-chrome-control mari-chrome-control--compact mari-chrome-control--selected px-3"
        >
          <Check size="0.75rem" />
          {t("usage.pricing.save")}
        </button>
      </div>
    </div>
  );
}

export function UsageDashboardSettings() {
  const { t } = useTranslation();
  const [choice, setChoice] = useState<RangeChoice>("30d");
  const [custom, setCustom] = useState(() => presetUsageRange(30));
  const [editingPriceFor, setEditingPriceFor] = useState<string | null>(null);
  const [showAllChats, setShowAllChats] = useState(false);
  const range = useMemo(
    () => (choice === "custom" ? custom : presetUsageRange(USAGE_RANGE_PRESET_DAYS[choice])),
    [choice, custom],
  );
  const validRange = !!range.from && !!range.to;
  const summary = useUsageSummary(range, validRange);
  const { data: settings = DEFAULT_USAGE_DASHBOARD_SETTINGS } = useUsageDashboardSettings();
  const data = summary.data;

  const connectionCost = (bucket: UsageConnectionBucket) =>
    estimateUsageCost(bucket, bucket.connectionId ? settings.prices[bucket.connectionId] : null);
  const totalCost = data?.byConnection.reduce<number | null>((sum, bucket) => {
    const cost = connectionCost(bucket);
    return cost == null ? sum : (sum ?? 0) + cost;
  }, null);
  const connectionMax = Math.max(0, ...(data?.byConnection ?? []).map(totalTokens));
  const chatMax = Math.max(0, ...(data?.byChat ?? []).map(totalTokens));
  const chats = data ? (showAllChats ? data.byChat : data.byChat.slice(0, CHAT_ROWS_COLLAPSED)) : [];

  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">{t("usage.description")}</p>

      <div className="flex flex-wrap items-center gap-1.5">
        {(["7d", "30d", "90d", "custom"] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={choice === option}
            onClick={() => {
              if (option === "custom" && choice !== "custom") setCustom(range);
              setChoice(option);
            }}
            className={cn(
              "mari-chrome-tag min-h-8 px-2.5 py-1 text-[0.6875rem] font-medium transition-colors",
              choice === option
                ? "bg-[var(--primary)]/15 text-[var(--primary)] ring-1 ring-[var(--primary)]/30"
                : "bg-[var(--secondary)] text-[var(--muted-foreground)] ring-1 ring-[var(--border)] hover:bg-[var(--accent)]",
            )}
          >
            {t(RANGE_LABEL_KEYS[option])}
          </button>
        ))}
        {summary.isFetching && (
          <Loader2 size="0.75rem" className="animate-spin text-[var(--muted-foreground)]" aria-hidden="true" />
        )}
      </div>
      {choice === "custom" && (
        <div className="grid grid-cols-2 gap-2">
          <label className="min-w-0 space-y-1">
            <span className="block text-[0.625rem] text-[var(--muted-foreground)]">{t("usage.range.from")}</span>
            <input
              type="date"
              value={custom.from}
              max={custom.to || undefined}
              onChange={(event) => setCustom((current) => ({ ...current, from: event.target.value }))}
              className={cn(FIELD_CLASS, "w-full")}
            />
          </label>
          <label className="min-w-0 space-y-1">
            <span className="block text-[0.625rem] text-[var(--muted-foreground)]">{t("usage.range.to")}</span>
            <input
              type="date"
              value={custom.to}
              min={custom.from || undefined}
              onChange={(event) => setCustom((current) => ({ ...current, to: event.target.value }))}
              className={cn(FIELD_CLASS, "w-full")}
            />
          </label>
        </div>
      )}

      {summary.isError ? (
        <p className="text-xs text-[var(--destructive)]">{t("usage.loadFailed")}</p>
      ) : !data ? (
        <p className="text-xs text-[var(--muted-foreground)]">{t("usage.loading")}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <StatTile label={t("usage.totals.requests")} value={data.totals.requests.toLocaleString()} />
            <StatTile
              label={t("usage.totals.cost")}
              value={totalCost != null ? formatUsageCost(totalCost, settings.currency) : t("usage.totals.noPrices")}
            />
            <StatTile
              label={t("usage.totals.input")}
              value={formatTokenCount(data.totals.inputTokens)}
              hint={data.totals.inputTokens.toLocaleString()}
            />
            <StatTile
              label={t("usage.totals.output")}
              value={formatTokenCount(data.totals.outputTokens)}
              hint={data.totals.outputTokens.toLocaleString()}
            />
          </div>

          {data.totals.requests === 0 ? (
            <div className="rounded-lg border border-dashed border-[var(--border)] px-3 py-4 text-center text-xs text-[var(--muted-foreground)]">
              {t("usage.empty")}
            </div>
          ) : (
            <>
              <DailyBars days={data.byDay} />

              <div className="space-y-1">
                <div className="text-[0.625rem] font-medium text-[var(--muted-foreground)]">
                  {t("usage.byConnection")}
                </div>
                {data.byConnection.map((bucket) => {
                  const key = bucket.connectionId ?? `provider:${bucket.provider ?? ""}`;
                  const cost = connectionCost(bucket);
                  return (
                    <div key={key} className="space-y-1">
                      <ShareRow
                        title={bucket.name ?? (bucket.connectionId ? t("usage.deletedConnection") : t("usage.unknown"))}
                        subtitle={[bucket.provider, bucket.models.join(", ")].filter(Boolean).join(" · ")}
                        totals={bucket}
                        max={connectionMax}
                        cost={cost != null ? formatUsageCost(cost, settings.currency) : null}
                        action={
                          bucket.connectionId ? (
                            <button
                              type="button"
                              onClick={() => setEditingPriceFor((current) => (current === key ? null : key))}
                              aria-pressed={editingPriceFor === key}
                              className="mari-chrome-control mari-chrome-control--compact h-7 w-7 shrink-0 p-0"
                              title={t("usage.pricing.edit")}
                              aria-label={t("usage.pricing.editNamed", { name: bucket.name ?? bucket.provider ?? "" })}
                            >
                              <CircleDollarSign size="0.75rem" />
                            </button>
                          ) : null
                        }
                      />
                      {editingPriceFor === key && (
                        <PriceEditor bucket={bucket} settings={settings} onDone={() => setEditingPriceFor(null)} />
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="space-y-1">
                <div className="text-[0.625rem] font-medium text-[var(--muted-foreground)]">{t("usage.byChat")}</div>
                {chats.map((bucket) => (
                  <ShareRow
                    key={bucket.chatId ?? "none"}
                    title={bucket.name ?? (bucket.chatId ? t("usage.deletedChat") : t("usage.unknown"))}
                    totals={bucket}
                    max={chatMax}
                    cost={null}
                  />
                ))}
                {data.byChat.length > CHAT_ROWS_COLLAPSED && (
                  <button
                    type="button"
                    onClick={() => setShowAllChats((value) => !value)}
                    className="w-full rounded-lg py-1.5 text-[0.6875rem] text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)]/60 hover:text-[var(--foreground)]"
                  >
                    {showAllChats ? t("usage.showFewer") : t("usage.showAll", { count: data.byChat.length })}
                  </button>
                )}
              </div>
            </>
          )}
          <p className="text-[0.625rem] leading-relaxed text-[var(--muted-foreground)]">{t("usage.footnote")}</p>
        </>
      )}
    </div>
  );
}
