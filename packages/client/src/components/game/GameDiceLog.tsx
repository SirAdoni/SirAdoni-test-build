// ──────────────────────────────────────────────
// Game: Dice Log (roll history and luck stats)
// ──────────────────────────────────────────────
import { useEffect, useMemo, useState } from "react";
import { Dices, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import {
  useDiceLog,
  type DiceFaceStats,
  type DiceLogRecord,
  type DiceLogScope,
  type DiceLogSource,
} from "../../hooks/use-game-tools";

const SOURCE_KEYS: Record<DiceLogSource, string> = {
  player: "ui.game.diceLog.sourcePlayer",
  gm: "ui.game.diceLog.sourceGm",
  skill_check: "ui.game.diceLog.sourceCheck",
  table: "ui.game.diceLog.sourceTable",
  initiative: "ui.game.diceLog.sourceInitiative",
};

function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return "-";
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-secondary/40 px-2.5 py-2">
      <p className="truncate text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">{value}</p>
      {hint && <p className="truncate text-[0.625rem] text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Face-frequency bars for one die size, with the fair-die expectation as a dashed guide. */
function DistributionChart({ stats }: { stats: DiceFaceStats }) {
  const { t } = useTranslation();
  const expectedPerFace = stats.dice / stats.sides;
  const max = Math.max(1, expectedPerFace, ...stats.counts);
  const labelEvery = stats.sides <= 12 ? 1 : stats.sides <= 20 ? 5 : 10;
  return (
    <figure className="space-y-1">
      <div
        role="img"
        aria-label={t("ui.game.diceLog.chartLabel", { sides: stats.sides, dice: stats.dice })}
        className="relative flex h-24 items-end gap-[2px] border-b border-border"
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 border-t border-dashed border-muted-foreground/60"
          style={{ bottom: `${(expectedPerFace / max) * 100}%` }}
        />
        {stats.counts.map((count, index) => {
          const face = index + 1;
          const tone =
            stats.sides === 20 && face === 20
              ? "bg-emerald-500/80"
              : stats.sides === 20 && face === 1
                ? "bg-rose-500/80"
                : "bg-primary/70";
          return (
            <div
              key={face}
              className="group relative flex h-full min-w-0 flex-1 items-end"
              title={t("ui.game.diceLog.barTooltip", { face, count })}
            >
              <div
                className={cn("w-full rounded-t-[4px] transition-opacity group-hover:opacity-100", tone, "opacity-90")}
                style={{ height: count > 0 ? `max(2px, ${(count / max) * 100}%)` : "0" }}
              />
            </div>
          );
        })}
      </div>
      <div className="flex gap-[2px]" aria-hidden>
        {stats.counts.map((_, index) => {
          const face = index + 1;
          const show = face === 1 || face === stats.sides || face % labelEvery === 0;
          return (
            <span key={face} className="min-w-0 flex-1 text-center text-[0.5625rem] tabular-nums text-muted-foreground">
              {show ? face : ""}
            </span>
          );
        })}
      </div>
      <figcaption className="text-[0.625rem] text-muted-foreground">
        {t("ui.game.diceLog.chartCaption", {
          average: formatNumber(stats.average),
          expected: formatNumber(stats.expected),
        })}
      </figcaption>
    </figure>
  );
}

function RollRow({ record }: { record: DiceLogRecord }) {
  const { t } = useTranslation();
  const who = [record.actor, record.label].filter(Boolean).join(" · ");
  const modifier = record.modifier ? ` ${record.modifier > 0 ? "+" : "-"} ${Math.abs(record.modifier)}` : "";
  const breakdown = `[${record.rolls.join(", ")}]${modifier}`;
  return (
    <li className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-secondary/50">
      <span className="mt-0.5 w-12 shrink-0 whitespace-nowrap text-[0.625rem] tabular-nums text-muted-foreground">
        {formatTime(record.createdAt)}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-foreground">
          <span className="min-w-0 break-all font-medium">{record.notation}</span>
          <span className="text-muted-foreground">{t(SOURCE_KEYS[record.source] ?? SOURCE_KEYS.gm)}</span>
          {record.critical && (
            <span className="rounded bg-emerald-500/15 px-1 text-[0.625rem] font-semibold text-emerald-600 dark:text-emerald-400">
              {t("ui.game.diceLog.critical")}
            </span>
          )}
          {record.fumble && (
            <span className="rounded bg-rose-500/15 px-1 text-[0.625rem] font-semibold text-rose-600 dark:text-rose-400">
              {t("ui.game.diceLog.fumble")}
            </span>
          )}
        </p>
        {who && <p className="truncate text-[0.6875rem] text-muted-foreground">{who}</p>}
        <p className="truncate text-[0.6875rem] tabular-nums text-muted-foreground">{breakdown}</p>
      </div>
      <span className="shrink-0 text-sm font-semibold tabular-nums text-foreground">{record.total}</span>
    </li>
  );
}

export function GameDiceLog({ chatId }: { chatId: string }) {
  const { t } = useTranslation();
  const [scope, setScope] = useState<DiceLogScope>("session");
  const [sides, setSides] = useState<number | null>(null);
  const { data, isLoading, isError, refetch } = useDiceLog(chatId, scope);
  const stats = data?.stats;

  const chartStats = useMemo(() => {
    if (!stats?.bySides.length) return null;
    return (
      stats.bySides.find((entry) => entry.sides === sides) ??
      stats.bySides.find((entry) => entry.sides === 20) ??
      stats.bySides[0]!
    );
  }, [sides, stats]);

  useEffect(() => setSides(null), [scope, chatId]);

  const hasD20 = Boolean(stats?.bySides.some((entry) => entry.sides === 20));

  // Summary strip: the most thrown die against a fair one, and the d20 extremes as rates.
  const summary = useMemo(() => {
    const top = stats?.bySides[0];
    if (!top || top.dice === 0) return null;
    const d20 = stats.bySides.find((entry) => entry.sides === 20);
    const rate = (count: number) => (d20 && d20.dice > 0 ? formatNumber((count / d20.dice) * 100) : null);
    return {
      top,
      high: rate(stats.natural20s),
      low: rate(stats.natural1s),
    };
  }, [stats]);

  return (
    <section className="space-y-3" aria-label={t("ui.game.diceLog.title")}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <Dices size={14} className="text-muted-foreground" />
          {t("ui.game.diceLog.title")}
        </h3>
        <div
          className="flex rounded-md border border-border p-0.5"
          role="group"
          aria-label={t("ui.game.diceLog.scope")}
        >
          {(["session", "game"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={scope === value}
              onClick={() => setScope(value)}
              className={cn(
                "rounded px-2 py-0.5 text-[0.6875rem] font-medium transition-colors",
                scope === value
                  ? "bg-primary/15 text-foreground"
                  : "text-muted-foreground hover:bg-secondary hover:text-foreground",
              )}
            >
              {t(value === "session" ? "ui.game.diceLog.scopeSession" : "ui.game.diceLog.scopeGame")}
            </button>
          ))}
        </div>
      </div>

      {isLoading && (
        <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 size={12} className="animate-spin" />
          {t("ui.game.diceLog.loading")}
        </p>
      )}
      {isError && (
        <div className="flex items-center gap-2 text-xs text-destructive">
          <span>{t("ui.game.diceLog.loadFailed")}</span>
          <button
            type="button"
            className="rounded-md border border-border bg-secondary/50 px-2 py-0.5 text-foreground transition-colors hover:bg-secondary"
            onClick={() => void refetch()}
          >
            {t("ui.game.diceLog.retry")}
          </button>
        </div>
      )}
      {stats && stats.rolls === 0 && <p className="text-xs text-muted-foreground">{t("ui.game.diceLog.empty")}</p>}

      {stats && stats.rolls > 0 && (
        <>
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            <Stat label={t("ui.game.diceLog.rolls")} value={String(stats.rolls)} />
            <Stat
              label={t("ui.game.diceLog.average")}
              value={formatNumber(stats.averageTotal)}
              hint={
                stats.expectedTotal !== null
                  ? t("ui.game.diceLog.expected", { value: formatNumber(stats.expectedTotal) })
                  : undefined
              }
            />
            <Stat
              label={t("ui.game.diceLog.natural20s")}
              value={hasD20 ? String(stats.natural20s) : "-"}
              hint={t("ui.game.diceLog.criticalCount", { count: stats.criticals })}
            />
            <Stat
              label={t("ui.game.diceLog.natural1s")}
              value={hasD20 ? String(stats.natural1s) : "-"}
              hint={t("ui.game.diceLog.fumbleCount", { count: stats.fumbles })}
            />
          </div>

          {summary && (
            <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-[0.6875rem] tabular-nums text-muted-foreground">
              <span>
                {t("ui.game.gamedicelog.mostRolled", {
                  sides: summary.top.sides,
                  count: summary.top.dice,
                  average: formatNumber(summary.top.average),
                  expected: formatNumber(summary.top.expected),
                })}
              </span>
              {summary.high !== null && summary.low !== null && (
                <span>{t("ui.game.gamedicelog.d20Rates", { high: summary.high, low: summary.low })}</span>
              )}
            </p>
          )}

          {chartStats && (
            <div className="space-y-2 rounded-lg border border-border p-2.5">
              {stats.bySides.length > 1 && (
                <div className="flex flex-wrap gap-1" role="group" aria-label={t("ui.game.diceLog.dieSize")}>
                  {stats.bySides.map((entry) => (
                    <button
                      key={entry.sides}
                      type="button"
                      aria-pressed={entry.sides === chartStats.sides}
                      onClick={() => setSides(entry.sides)}
                      className={cn(
                        "rounded-full border px-2 py-0.5 text-[0.625rem] font-medium tabular-nums transition-colors",
                        entry.sides === chartStats.sides
                          ? "border-primary/60 bg-primary/15 text-foreground"
                          : "border-border text-muted-foreground hover:bg-secondary",
                      )}
                    >
                      {t("ui.dice.diceglyph.dValue1", { value1: entry.sides })}
                    </button>
                  ))}
                </div>
              )}
              <DistributionChart stats={chartStats} />
            </div>
          )}

          <div>
            <p className="mb-1 text-[0.6875rem] font-medium text-muted-foreground">
              {t("ui.game.diceLog.recent", { shown: data?.recent.length ?? 0, total: data?.total ?? 0 })}
            </p>
            <ul className="space-y-0.5">
              {data?.recent.map((record) => (
                <RollRow key={record.id} record={record} />
              ))}
            </ul>
          </div>
        </>
      )}
    </section>
  );
}
