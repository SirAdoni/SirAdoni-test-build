// ──────────────────────────────────────────────
// Game: extended HUD widget renderers
//
// checklist, schedule, note, clock, pips, countdown, tug_of_war, tier_track, stages, tags, ledger, log,
// rumor_board, obligations, turn_order, scoreboard, bars, charges, calendar.
// State rules live in @marinara-engine/shared (hud-widget-extended); these only draw.
// JSX output never uses template literals: localization:ui-check flags them, even numeric ones.
// ──────────────────────────────────────────────
import type { ReactNode } from "react";
import {
  calendarUpcoming,
  isExtendedHudWidgetType,
  normalizeExtendedWidgetConfig,
  scheduleDayOf,
  type HudWidget,
} from "@marinara-engine/shared";
import { useTranslation as useUiTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import { CharacterLinkedContent } from "../characters/CharacterReferences";

const MUTED = "text-[var(--marinara-chat-chrome-panel-muted)]";
const TEXT = "text-[var(--marinara-chat-chrome-panel-text)]";
const TRACK = "bg-[var(--marinara-chat-chrome-panel-divider)]";
const ROW = "text-[0.5625rem] leading-snug";
const GAIN = "#22c55e";
const LOSS = "#ef4444";

const DEFAULT_ACCENT: Record<string, string> = {
  checklist: "#84cc16",
  schedule: "#f472b6",
  note: "#eab308",
  clock: "#f97316",
  pips: "#a78bfa",
  countdown: "#ef4444",
  tug_of_war: "#38bdf8",
  tier_track: "#f59e0b",
  stages: "#14b8a6",
  tags: "#94a3b8",
  ledger: "#eab308",
  log: "#94a3b8",
  rumor_board: "#c084fc",
  obligations: "#fb7185",
  turn_order: "#38bdf8",
  scoreboard: "#f59e0b",
  bars: "#22c55e",
  charges: "#818cf8",
  calendar: "#60a5fa",
};

/** "+3" / "-2" / "0" for amounts and day offsets. */
const signed = (n: number) => (n > 0 ? "+" + n : String(n));

const Linked = ({ children }: { children: string }) => (
  <CharacterLinkedContent currentNames>{children}</CharacterLinkedContent>
);

function Empty() {
  const { t: localizeUi } = useUiTranslation();
  return (
    <p className={cn("text-[0.5625rem] italic", MUTED)}>
      {localizeUi("ui.characters.characterversionhistorypanel.empty")}
    </p>
  );
}

function Rows({ children, empty }: { children: ReactNode; empty: boolean }) {
  return empty ? <Empty /> : <div className="space-y-0.5">{children}</div>;
}

/** A row of filled/empty dots. */
function Pips({ value, max, accent, size = 7 }: { value: number; max: number; accent: string; size?: number }) {
  return (
    <span className="inline-flex flex-wrap gap-[3px]" aria-hidden>
      {Array.from({ length: max }, (_, i) => (
        <span
          key={i}
          className="inline-block rounded-full border"
          style={{
            width: size,
            height: size,
            borderColor: accent,
            background: i < value ? accent : "transparent",
            opacity: i < value ? 1 : 0.45,
          }}
        />
      ))}
    </span>
  );
}

function Bar({ ratio, accent }: { ratio: number; accent: string }) {
  return (
    <div className={cn("h-1 w-full overflow-hidden rounded-full", TRACK)}>
      <div
        className="h-full rounded-full transition-all"
        style={{ width: Math.max(0, Math.min(1, ratio)) * 100 + "%", background: accent }}
      />
    </div>
  );
}

/** Blades-style progress clock: a circle cut into segments. */
function ClockFace({ value, max, accent }: { value: number; max: number; accent: string }) {
  const r = 15;
  const point = (angle: number) => `${16 + r * Math.cos(angle)} ${16 + r * Math.sin(angle)}`;
  const wedge = (i: number) => {
    const a0 = (i / max) * 2 * Math.PI - Math.PI / 2;
    const a1 = ((i + 1) / max) * 2 * Math.PI - Math.PI / 2;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    return `M16 16 L${point(a0)} A${r} ${r} 0 ${large} 1 ${point(a1)} Z`;
  };
  return (
    <svg viewBox="0 0 32 32" className="h-9 w-9 shrink-0" aria-hidden>
      {Array.from({ length: max }, (_, i) => (
        <path
          key={i}
          d={wedge(i)}
          fill={i < value ? accent : "transparent"}
          fillOpacity={i < value ? 0.85 : 0}
          stroke="var(--marinara-chat-chrome-panel-muted)"
          strokeWidth={0.8}
        />
      ))}
    </svg>
  );
}

function ExtendedWidgetView({ widget }: { widget: HudWidget }) {
  const { t: localizeUi } = useUiTranslation();
  if (!isExtendedHudWidgetType(widget.type)) return null;
  const type = widget.type;
  const c = normalizeExtendedWidgetConfig(type, widget.config ?? {});
  const accent = widget.accent ?? DEFAULT_ACCENT[type] ?? "var(--marinara-chat-chrome-accent)";
  const value = c.value ?? 0;
  const max = c.max ?? 0;

  switch (type) {
    case "checklist":
    case "obligations": {
      const tasks = c.tasks ?? [];
      return (
        <Rows empty={!tasks.length}>
          {tasks.map((task, i) => {
            const [text = "", terms = ""] =
              type === "obligations" ? task.text.split("|").map((s) => s.trim()) : [task.text];
            return (
              <div key={i} className={cn("flex items-start gap-1.5", ROW)}>
                <span
                  aria-hidden
                  className="mt-px shrink-0 leading-none"
                  style={{ color: task.done ? accent : undefined }}
                >
                  {task.done ? "☑" : "☐"}
                </span>
                <span className={cn("min-w-0 flex-1", task.done ? cn(MUTED, "line-through") : TEXT)}>
                  <Linked>{text}</Linked>
                </span>
                {terms && <span className={cn("shrink-0 tabular-nums", MUTED)}>{terms}</span>}
              </div>
            );
          })}
        </Rows>
      );
    }

    case "schedule": {
      const entries = c.entries ?? [];
      return (
        <div className="space-y-1">
          {!entries.length && <Empty />}
          {entries.map((entry, i) => (
            <div key={i} className={ROW}>
              {entry.when && (
                <div className="text-[0.5rem] font-semibold uppercase tracking-wide" style={{ color: accent }}>
                  {entry.when}
                </div>
              )}
              <div className={TEXT}>
                <Linked>{entry.text}</Linked>
              </div>
            </div>
          ))}
        </div>
      );
    }

    case "note":
      return c.text ? (
        <p className={cn("whitespace-pre-wrap", ROW, TEXT)}>
          <Linked>{c.text}</Linked>
        </p>
      ) : (
        <Empty />
      );

    case "clock":
      return (
        <div className="flex items-center gap-2">
          <ClockFace value={value} max={max} accent={accent} />
          <span className={cn("text-[0.6875rem] font-semibold tabular-nums", TEXT)}>
            {value}
            <span className={MUTED}>
              {" / "}
              {max}
            </span>
          </span>
        </div>
      );

    case "pips":
      return (
        <div className="flex items-center gap-2">
          <Pips value={value} max={max} accent={accent} size={9} />
          <span className={cn("text-[0.5625rem] tabular-nums", MUTED)}>
            {value}
            {"/"}
            {max}
          </span>
        </div>
      );

    case "countdown": {
      const urgent = value <= 1 || (max > 0 && value / max <= 0.2);
      return (
        <div className="space-y-1">
          <div className="flex items-baseline gap-1.5">
            <span className="text-base font-bold tabular-nums leading-none" style={{ color: urgent ? LOSS : accent }}>
              {value}
            </span>
            {c.text && <span className={cn("text-[0.5625rem]", MUTED)}>{c.text}</span>}
          </div>
          {max > 0 && <Bar ratio={value / max} accent={urgent ? LOSS : accent} />}
        </div>
      );
    }

    case "tug_of_war": {
      const [left = "", right = ""] = (c.text ?? "").split("|").map((s) => s.trim());
      const half = max > 0 ? Math.abs(value) / max / 2 : 0;
      return (
        <div className="space-y-1">
          <div className={cn("relative h-1.5 w-full rounded-full", TRACK)}>
            <div
              className="absolute top-0 h-full rounded-full transition-all"
              style={{
                background: accent,
                width: half * 100 + "%",
                left: value >= 0 ? "50%" : (0.5 - half) * 100 + "%",
              }}
            />
            <div className="absolute left-1/2 top-[-2px] h-[10px] w-px bg-[var(--marinara-chat-chrome-panel-muted)]" />
          </div>
          <div className={cn("flex justify-between gap-2 text-[0.5rem]", MUTED)}>
            <span className={cn(value < 0 && "font-semibold text-[var(--marinara-chat-chrome-panel-text)]")}>
              {left}
            </span>
            <span className="tabular-nums">{signed(value)}</span>
            <span className={cn(value > 0 && "font-semibold text-[var(--marinara-chat-chrome-panel-text)]")}>
              {right}
            </span>
          </div>
        </div>
      );
    }

    case "tier_track": {
      const levels = c.levels ?? [];
      const current = c.current ?? 0;
      return (
        <Rows empty={!levels.length}>
          <div className="mb-1 flex gap-[2px]">
            {levels.map((_, i) => (
              <div
                key={i}
                className={cn("h-1.5 flex-1 rounded-sm", i > current && TRACK)}
                style={
                  i <= current ? { background: accent, opacity: 0.4 + (0.6 * (i + 1)) / levels.length } : undefined
                }
              />
            ))}
          </div>
          <div className="text-[0.6875rem] font-semibold" style={{ color: accent }}>
            {levels[current]}
          </div>
          {current < levels.length - 1 && (
            <div className={cn("text-[0.5rem]", MUTED)}>
              {"→ "}
              {levels[current + 1]}
            </div>
          )}
        </Rows>
      );
    }

    case "stages":
    case "turn_order": {
      const items = (type === "stages" ? c.levels : c.items) ?? [];
      const current = c.current ?? 0;
      return (
        <Rows empty={!items.length}>
          {items.map((item, i) => {
            const past = type === "stages" && i < current;
            const now = i === current;
            return (
              <div key={i} className={cn("flex items-center gap-1.5", ROW)}>
                <span
                  aria-hidden
                  className="w-2.5 shrink-0 text-center leading-none"
                  style={{ color: now || past ? accent : undefined }}
                >
                  {past ? "✓" : now ? (type === "stages" ? "●" : "▶") : type === "stages" ? "○" : i + 1}
                </span>
                <span className={cn(now && "font-semibold", now ? TEXT : MUTED)}>
                  <Linked>{item}</Linked>
                </span>
              </div>
            );
          })}
        </Rows>
      );
    }

    case "tags": {
      const tags = c.tags ?? [];
      return tags.length ? (
        <div className="flex flex-wrap gap-1">
          {tags.map((tag, i) => (
            <span
              key={i}
              className={cn("rounded-full border px-1.5 py-px text-[0.5rem]", TEXT)}
              style={{ borderColor: accent, background: "color-mix(in srgb, " + accent + " 14%, transparent)" }}
            >
              {tag}
            </span>
          ))}
        </div>
      ) : (
        <Empty />
      );
    }

    case "ledger": {
      const transactions = [...(c.transactions ?? [])].reverse();
      return (
        <div className="space-y-1">
          <div className="flex items-baseline gap-1">
            <span className="text-sm font-bold tabular-nums leading-none" style={{ color: accent }}>
              {value.toLocaleString()}
            </span>
            {c.text && <span className={cn("text-[0.5625rem]", MUTED)}>{c.text}</span>}
          </div>
          {transactions.map((entry, i) => (
            <div key={i} className={cn("flex gap-1.5", ROW)}>
              <span className="w-9 shrink-0 text-right tabular-nums" style={{ color: entry.amount >= 0 ? GAIN : LOSS }}>
                {signed(entry.amount)}
              </span>
              <span className={cn("min-w-0", MUTED)}>
                <Linked>{entry.text}</Linked>
              </span>
            </div>
          ))}
        </div>
      );
    }

    case "log": {
      const items = c.items ?? [];
      return (
        <Rows empty={!items.length}>
          {items.map((item, i) => (
            <div key={i} className={cn(ROW, i === 0 ? TEXT : MUTED)} style={{ opacity: 1 - i * 0.1 }}>
              <Linked>{item}</Linked>
            </div>
          ))}
        </Rows>
      );
    }

    case "rumor_board": {
      const rumors = c.rumors ?? [];
      return (
        <Rows empty={!rumors.length}>
          {rumors.map((rumor, i) => (
            <div key={i} className={cn("flex items-start gap-1.5", ROW)}>
              <span
                aria-hidden
                className="w-2.5 shrink-0 text-center font-bold leading-none"
                style={{ color: rumor.status === "confirmed" ? GAIN : rumor.status === "false" ? LOSS : accent }}
              >
                {rumor.status === "confirmed" ? "✓" : rumor.status === "false" ? "✗" : "?"}
              </span>
              <span className={cn(rumor.status === "false" ? cn(MUTED, "line-through") : TEXT)}>
                <Linked>{rumor.text}</Linked>
              </span>
            </div>
          ))}
        </Rows>
      );
    }

    case "scoreboard": {
      const stats = [...((c.stats ?? []) as Array<{ name: string; value: number }>)].sort((a, b) => b.value - a.value);
      const top = Math.max(1, ...stats.map((stat) => Math.abs(stat.value)));
      return (
        <Rows empty={!stats.length}>
          {stats.map((stat, i) => (
            <div key={i + ":" + stat.name} className="space-y-px">
              <div className={cn("flex justify-between gap-2", ROW)}>
                <span className={cn(i === 0 && "font-semibold", TEXT)}>
                  <Linked>{stat.name}</Linked>
                </span>
                <span className="tabular-nums" style={{ color: i === 0 ? accent : undefined }}>
                  {stat.value}
                </span>
              </div>
              <Bar ratio={Math.abs(stat.value) / top} accent={accent} />
            </div>
          ))}
        </Rows>
      );
    }

    case "bars":
    case "charges": {
      const meters = c.meters ?? [];
      return (
        <Rows empty={!meters.length}>
          {meters.map((meter, i) =>
            type === "bars" ? (
              <div key={i + ":" + meter.name} className="space-y-px">
                <div className={cn("flex justify-between gap-2", ROW)}>
                  <span className={TEXT}>{meter.name}</span>
                  <span className={cn("tabular-nums", MUTED)}>
                    {meter.value}
                    {"/"}
                    {meter.max}
                  </span>
                </div>
                <Bar ratio={meter.value / meter.max} accent={accent} />
              </div>
            ) : (
              <div key={i + ":" + meter.name} className={cn("flex items-center justify-between gap-2", ROW)}>
                <span className={cn("min-w-0", TEXT)}>{meter.name}</span>
                {meter.max <= 12 ? (
                  <Pips value={meter.value} max={meter.max} accent={accent} />
                ) : (
                  <span className={cn("tabular-nums", MUTED)}>
                    {meter.value}
                    {"/"}
                    {meter.max}
                  </span>
                )}
              </div>
            ),
          )}
        </Rows>
      );
    }

    case "calendar": {
      const week = max || 7;
      const today = value || 1;
      const start = Math.floor((today - 1) / week) * week + 1;
      const eventDays = new Set((c.entries ?? []).map((entry) => scheduleDayOf(entry.when)));
      const upcoming = calendarUpcoming(c).slice(0, 3);
      return (
        <div className="space-y-1.5">
          <div className="text-[0.625rem] font-semibold" style={{ color: accent }}>
            {c.text || localizeUi("ui.game.extendedwidgets.dayValue", { value: today })}
          </div>
          <div className="grid gap-[2px]" style={{ gridTemplateColumns: "repeat(" + week + ", minmax(0, 1fr))" }}>
            {Array.from({ length: week * 3 }, (_, i) => start + i).map((day) => {
              const isToday = day === today;
              return (
                <div
                  key={day}
                  className={cn(
                    "relative flex h-4 items-center justify-center rounded-sm text-[0.5rem] tabular-nums",
                    isToday ? "font-bold" : day < today ? MUTED : TEXT,
                  )}
                  style={isToday ? { background: accent, color: "#fff" } : { opacity: day < today ? 0.5 : 1 }}
                >
                  {day}
                  {eventDays.has(day) && (
                    <span
                      className="absolute bottom-px h-[3px] w-[3px] rounded-full"
                      style={{ background: isToday ? "#fff" : accent }}
                    />
                  )}
                </div>
              );
            })}
          </div>
          {upcoming.map((entry, i) => (
            <div key={i} className={cn("flex gap-1.5", ROW)}>
              <span className="w-5 shrink-0 text-right tabular-nums" style={{ color: accent }}>
                {entry.inDays === null ? "•" : entry.inDays === 0 ? "●" : signed(entry.inDays)}
              </span>
              <span className={TEXT}>
                <Linked>{entry.text}</Linked>
              </span>
            </div>
          ))}
        </div>
      );
    }
  }
}

export { ExtendedWidgetView, DEFAULT_ACCENT as EXTENDED_WIDGET_ACCENTS };
