// ──────────────────────────────────────────────
// Game calendar: today's in-world date, a month view, upcoming events and the setup editor
//
// Today is always the game clock's day (gameTime.day) seen through the calendar;
// advancing or picking a date moves that clock on the server.
// ──────────────────────────────────────────────
import { useMemo, useState } from "react";
import { CalendarDays, Check, ChevronLeft, ChevronRight, Loader2, Plus, Settings2, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  addCalendarDays,
  calendarDateForClockDay,
  calendarDateToDays,
  calendarWeekday,
  daysInMonth,
  eventsOnDate,
  formatCalendarYear,
  monthsToText,
  moonStates,
  newMoonDayFor,
  parseMonthsText,
  parseWeekdaysText,
  readGameClock,
  sanitizeGameCalendarConfig,
  sanitizeGameCalendarDate,
  upcomingCalendarEvents,
  weekdayOffsetFor,
  type GameCalendarConfig,
  type GameCalendarDate,
  type GameCalendarEvent,
  type GameCalendarEventKind,
  type GameCalendarState,
  type MoonPhase,
} from "@marinara-engine/shared";
import {
  useAdvanceGameCalendar,
  useGameCalendar,
  useSaveGameCalendar,
  useSetGameCalendarDate,
} from "../../hooks/use-game-calendar";
import { useChat } from "../../hooks/use-chats";
import { parseChatMetadata } from "../../lib/chat-display";
import { cn } from "../../lib/utils";

const FIELD_CLASS =
  "h-8 min-w-0 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/40";
const AREA_CLASS =
  "min-h-[4.5rem] w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/40";
const ICON_BUTTON_CLASS =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent";
const SMALL_BUTTON_CLASS =
  "flex h-7 items-center justify-center gap-1.5 rounded-md border border-border px-2.5 text-[0.6875rem] font-medium text-foreground transition-colors hover:bg-secondary disabled:opacity-60";
const LABEL_CLASS = "text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground";

function newEventId() {
  return `ev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function signed(value: number) {
  return value > 0 ? `+${value}` : String(value);
}

function toInt(value: string, fallback: number) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** "Name | cycle days | age today" per line. */
function parseMoonLines(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.split("|").map((part) => part.trim()))
    .filter((parts) => parts[0])
    .slice(0, 8)
    .map(([name, cycle, age]) => ({ name: name!, cycleDays: Number(cycle) || 28, age: toInt(age ?? "", 0) }));
}

function useMoonPhaseLabel() {
  const { t } = useTranslation();
  return (phase: MoonPhase) => {
    switch (phase) {
      case "new":
        return t("ui.gameCalendar.phaseNew");
      case "waxingCrescent":
        return t("ui.gameCalendar.phaseWaxingCrescent");
      case "firstQuarter":
        return t("ui.gameCalendar.phaseFirstQuarter");
      case "waxingGibbous":
        return t("ui.gameCalendar.phaseWaxingGibbous");
      case "full":
        return t("ui.gameCalendar.phaseFull");
      case "waningGibbous":
        return t("ui.gameCalendar.phaseWaningGibbous");
      case "lastQuarter":
        return t("ui.gameCalendar.phaseLastQuarter");
      default:
        return t("ui.gameCalendar.phaseWaningCrescent");
    }
  };
}

/** Year, month and day inputs for one date of a calendar. */
function DateFields({
  config,
  value,
  onChange,
}: {
  config: GameCalendarConfig;
  value: GameCalendarDate;
  onChange: (date: GameCalendarDate) => void;
}) {
  const { t } = useTranslation();
  const set = (patch: Partial<GameCalendarDate>) => {
    const next = { ...value, ...patch };
    onChange(sanitizeGameCalendarDate(config, next) ?? value);
  };
  return (
    <div className="flex min-w-0 flex-1 gap-1">
      <input
        type="number"
        min={1}
        value={value.day}
        onChange={(event) => set({ day: toInt(event.target.value, value.day) })}
        className={cn(FIELD_CLASS, "w-14 shrink-0")}
        aria-label={t("ui.gameCalendar.day")}
      />
      <select
        value={value.month}
        onChange={(event) => set({ month: toInt(event.target.value, value.month) })}
        className={cn(FIELD_CLASS, "min-w-0 flex-1")}
        aria-label={t("ui.gameCalendar.month")}
      >
        {config.months.map((month, index) => (
          <option key={index} value={index}>
            {month.name}
          </option>
        ))}
      </select>
      <input
        type="number"
        value={value.year}
        onChange={(event) => set({ year: toInt(event.target.value, value.year) })}
        className={cn(FIELD_CLASS, "w-20 shrink-0")}
        aria-label={t("ui.gameCalendar.year")}
      />
    </div>
  );
}

export function GameCalendarTool({ chatId }: { chatId: string }) {
  const { t } = useTranslation();
  const { data, isLoading, isError } = useGameCalendar(chatId);
  const { data: chat } = useChat(chatId);
  const [editing, setEditing] = useState(false);
  // Read the clock from the chat itself so a Day editor change or a time advance shows here at once.
  const metaClock = useMemo(
    () => readGameClock(parseChatMetadata((chat as { metadata?: unknown } | undefined)?.metadata).gameTime),
    [chat],
  );
  const clockDay = metaClock?.day ?? data?.clock?.day ?? 1;

  if (isLoading) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 size={12} className="animate-spin" />
        {t("ui.gameCalendar.loading")}
      </p>
    );
  }
  if (isError || !data) return <p className="text-xs text-muted-foreground">{t("ui.gameCalendar.loadFailed")}</p>;

  if (editing) {
    return (
      <CalendarSetup chatId={chatId} calendar={data.calendar} clockDay={clockDay} onDone={() => setEditing(false)} />
    );
  }
  if (!data.calendar.enabled) {
    return (
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">{t("ui.gameCalendar.intro")}</p>
        <button type="button" onClick={() => setEditing(true)} className={cn(SMALL_BUTTON_CLASS, "w-full")}>
          <Settings2 size={12} />
          {t("ui.gameCalendar.setUp")}
        </button>
      </div>
    );
  }
  return <CalendarView chatId={chatId} calendar={data.calendar} clockDay={clockDay} onEdit={() => setEditing(true)} />;
}

function CalendarView({
  chatId,
  calendar,
  clockDay,
  onEdit,
}: {
  chatId: string;
  calendar: GameCalendarState;
  clockDay: number;
  onEdit: () => void;
}) {
  const { t } = useTranslation();
  const phaseLabel = useMoonPhaseLabel();
  const { config, events } = calendar;
  const today = useMemo(() => calendarDateForClockDay(config, clockDay), [config, clockDay]);
  const [view, setView] = useState<{ year: number; month: number } | null>(null);
  const [selected, setSelected] = useState<GameCalendarDate | null>(null);
  const [advanceBy, setAdvanceBy] = useState("1");
  const [draft, setDraft] = useState({ title: "", kind: "event" as GameCalendarEventKind, yearly: false });
  const advance = useAdvanceGameCalendar(chatId);
  const setDate = useSetGameCalendarDate(chatId);
  const save = useSaveGameCalendar(chatId);
  const busy = advance.isPending || setDate.isPending;

  const shown = view ?? { year: today.year, month: today.month };
  const focus = selected ?? today;
  const weekdayCount = config.weekdays.length;
  const aligned = weekdayCount <= 10;
  const columns = aligned ? weekdayCount : 7;
  const monthLength = daysInMonth(config, shown.year, shown.month);
  const lead = aligned ? calendarWeekday(config, { ...shown, day: 1 }) : 0;
  const todayKey = calendarDateToDays(config, today);
  const focusKey = calendarDateToDays(config, focus);
  const upcoming = useMemo(
    () => upcomingCalendarEvents(config, events, today, { horizonDays: 400, limit: 12 }),
    [config, events, today],
  );
  const dayEvents = useMemo(() => eventsOnDate(config, events, focus), [config, events, focus]);
  const eventDays = useMemo(() => {
    const days = new Set<number>();
    for (let day = 1; day <= monthLength; day++) {
      if (eventsOnDate(config, events, { ...shown, day }).length > 0) days.add(day);
    }
    return days;
  }, [config, events, monthLength, shown]);

  const shortDate = (date: GameCalendarDate) =>
    `${date.day} ${config.months[date.month]?.name ?? ""} ${formatCalendarYear(config, date.year)}`;
  const stepMonth = (delta: number) => {
    const index = shown.month + delta;
    if (index < 0) setView({ year: shown.year - 1, month: config.months.length - 1 });
    else if (index >= config.months.length) setView({ year: shown.year + 1, month: 0 });
    else setView({ year: shown.year, month: index });
  };
  const fail = (error: unknown) =>
    toast.error(error instanceof Error ? error.message : t("ui.gameCalendar.saveFailed"));
  const runAdvance = (days: number) => {
    if (!Number.isFinite(days) || days === 0) return;
    advance.mutate(days, {
      onSuccess: () => {
        setView(null);
        setSelected(null);
      },
      onError: fail,
    });
  };
  // Each save sends the whole event list, so a second edit before the first lands would drop it.
  const saveEvents = (next: GameCalendarEvent[]) => {
    if (save.isPending) return;
    save.mutate({ ...calendar, events: next }, { onError: fail });
  };
  const addEvent = () => {
    const title = draft.title.trim();
    if (!title) return;
    saveEvents([
      ...events,
      { id: newEventId(), title, kind: draft.kind, date: focus, yearly: draft.yearly, notes: "", done: false },
    ]);
    setDraft({ ...draft, title: "" });
  };
  const inDaysLabel = (inDays: number, overdue: boolean) =>
    overdue
      ? t("ui.gameCalendar.overdue", { count: -inDays })
      : inDays === 0
        ? t("ui.gameCalendar.today")
        : inDays === 1
          ? t("ui.gameCalendar.tomorrow")
          : t("ui.gameCalendar.inDays", { count: inDays });
  const moons = moonStates(config, today);
  const monthTitle = [config.months[shown.month]?.name ?? "", formatCalendarYear(config, shown.year)].join(" ");
  const focusLabel = [shortDate(focus), signed(focusKey - todayKey)].join(" · ");
  const eventDateLabel = (date: GameCalendarDate, yearly: boolean) =>
    yearly ? [shortDate(date), t("ui.gameCalendar.yearly")].join(" · ") : shortDate(date);

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border bg-secondary/40 px-2.5 py-2" aria-live="polite">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className={LABEL_CLASS}>{config.weekdays[calendarWeekday(config, today)]}</p>
            <p className="text-sm font-semibold text-foreground [overflow-wrap:anywhere]">{shortDate(today)}</p>
          </div>
          <span className="shrink-0 rounded-md bg-background px-1.5 py-0.5 text-[0.625rem] tabular-nums text-muted-foreground">
            {t("ui.gameCalendar.clockDay", { day: clockDay })}
          </span>
        </div>
        {moons.length > 0 && (
          <p className="mt-1 text-[0.6875rem] text-muted-foreground">
            {moons.map((moon) => `${moon.name}: ${phaseLabel(moon.phase)}`).join(" · ")}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1" role="group" aria-label={t("ui.gameCalendar.advance")}>
        {[-1, 1, 7].map((days) => (
          <button
            key={days}
            type="button"
            disabled={busy}
            onClick={() => runAdvance(days)}
            className={cn(SMALL_BUTTON_CLASS, "tabular-nums")}
            title={t("ui.gameCalendar.moveDays", { count: days })}
            aria-label={t("ui.gameCalendar.moveDays", { count: days })}
          >
            {t("ui.gameCalendar.daysShort", { value: signed(days) })}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-1">
          <input
            type="number"
            value={advanceBy}
            onChange={(event) => setAdvanceBy(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") runAdvance(toInt(advanceBy, 0));
            }}
            className={cn(FIELD_CLASS, "h-7 w-16")}
            aria-label={t("ui.gameCalendar.daysToAdvance")}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => runAdvance(toInt(advanceBy, 0))}
            className={SMALL_BUTTON_CLASS}
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <ChevronRight size={12} />}
            {t("ui.gameCalendar.advance")}
          </button>
        </div>
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between gap-1">
          <button
            type="button"
            onClick={() => stepMonth(-1)}
            className={ICON_BUTTON_CLASS}
            aria-label={t("ui.gameCalendar.previousMonth")}
          >
            <ChevronLeft size={14} />
          </button>
          <button
            type="button"
            onClick={() => {
              setView(null);
              setSelected(null);
            }}
            className="min-w-0 truncate rounded-md px-1.5 text-xs font-semibold text-foreground hover:bg-secondary"
            title={t("ui.gameCalendar.backToToday")}
          >
            {monthTitle}
          </button>
          <button
            type="button"
            onClick={() => stepMonth(1)}
            className={ICON_BUTTON_CLASS}
            aria-label={t("ui.gameCalendar.nextMonth")}
          >
            <ChevronRight size={14} />
          </button>
        </div>
        <div className="grid gap-[2px]" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
          {aligned &&
            config.weekdays.map((name, index) => (
              <div
                key={index}
                className="truncate text-center text-[0.5625rem] font-medium text-muted-foreground"
                title={name}
              >
                {name.slice(0, 2)}
              </div>
            ))}
          {Array.from({ length: lead }, (_, index) => (
            <div key={`lead-${index}`} />
          ))}
          {Array.from({ length: monthLength }, (_, index) => {
            const day = index + 1;
            const key = calendarDateToDays(config, { ...shown, day });
            const isToday = key === todayKey;
            const isFocus = key === focusKey;
            return (
              <button
                key={day}
                type="button"
                onClick={() => setSelected({ ...shown, day })}
                aria-pressed={isFocus}
                aria-label={shortDate({ ...shown, day })}
                className={cn(
                  "relative flex h-7 items-center justify-center rounded-md text-[0.6875rem] tabular-nums transition-colors",
                  isToday
                    ? "bg-primary font-bold text-primary-foreground"
                    : key < todayKey
                      ? "text-muted-foreground/70 hover:bg-secondary"
                      : "text-foreground hover:bg-secondary",
                  isFocus && !isToday && "ring-1 ring-primary",
                )}
              >
                {day}
                {eventDays.has(day) && (
                  <span
                    className={cn(
                      "absolute bottom-0.5 h-1 w-1 rounded-full",
                      isToday ? "bg-primary-foreground" : "bg-primary",
                    )}
                  />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {selected && focusKey !== todayKey && (
        <div className="flex flex-wrap items-center justify-between gap-1.5 rounded-lg border border-border px-2 py-1.5">
          <span className="min-w-0 text-xs text-foreground [overflow-wrap:anywhere]">{focusLabel}</span>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              setDate.mutate(focus, {
                onSuccess: () => setSelected(null),
                onError: fail,
              })
            }
            className={SMALL_BUTTON_CLASS}
          >
            <CalendarDays size={12} />
            {t("ui.gameCalendar.makeToday")}
          </button>
        </div>
      )}
      {selected && dayEvents.length > 0 && (
        <ul className="space-y-0.5">
          {dayEvents.map((event) => (
            <li key={event.id} className="truncate text-xs text-foreground">
              {event.title}
            </li>
          ))}
        </ul>
      )}

      <div>
        <p className={cn(LABEL_CLASS, "mb-1")}>{t("ui.gameCalendar.upcoming")}</p>
        {upcoming.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("ui.gameCalendar.noUpcoming")}</p>
        ) : (
          <ul className="space-y-1">
            {upcoming.map(({ event, date, inDays, overdue }) => (
              <li key={event.id} className="flex items-center gap-1.5 rounded-md px-1 py-0.5 hover:bg-secondary/50">
                {event.kind === "deadline" ? (
                  <button
                    type="button"
                    disabled={save.isPending}
                    onClick={() =>
                      saveEvents(events.map((item) => (item.id === event.id ? { ...item, done: !item.done } : item)))
                    }
                    className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-border text-foreground hover:bg-secondary"
                    aria-label={t("ui.gameCalendar.markDone", { title: event.title })}
                    title={t("ui.gameCalendar.markDone", { title: event.title })}
                  >
                    {event.done && <Check size={10} />}
                  </button>
                ) : (
                  <CalendarDays size={12} className="shrink-0 text-muted-foreground" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs text-foreground" title={event.title}>
                    {event.title}
                  </p>
                  <p className="truncate text-[0.625rem] text-muted-foreground">{eventDateLabel(date, event.yearly)}</p>
                </div>
                <span
                  className={cn(
                    "shrink-0 text-[0.625rem] tabular-nums",
                    overdue ? "font-semibold text-destructive" : "text-muted-foreground",
                  )}
                >
                  {inDaysLabel(inDays, overdue)}
                </span>
                <button
                  type="button"
                  disabled={save.isPending}
                  onClick={() => saveEvents(events.filter((item) => item.id !== event.id))}
                  className={cn(ICON_BUTTON_CLASS, "h-6 w-6")}
                  aria-label={t("ui.gameCalendar.removeEvent", { title: event.title })}
                  title={t("ui.gameCalendar.removeEvent", { title: event.title })}
                >
                  <Trash2 size={11} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-1.5 rounded-lg border border-border p-2">
        <p className={LABEL_CLASS}>{t("ui.gameCalendar.addEventOn", { date: shortDate(focus) })}</p>
        <input
          value={draft.title}
          onChange={(event) => setDraft({ ...draft, title: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Enter") addEvent();
          }}
          placeholder={t("ui.gameCalendar.eventTitle")}
          aria-label={t("ui.gameCalendar.eventTitle")}
          maxLength={200}
          className={cn(FIELD_CLASS, "w-full")}
        />
        <div className="flex flex-wrap items-center gap-1.5">
          <select
            value={draft.kind}
            onChange={(event) => setDraft({ ...draft, kind: event.target.value as GameCalendarEventKind })}
            className={cn(FIELD_CLASS, "h-7")}
            aria-label={t("ui.gameCalendar.kind")}
          >
            <option value="event">{t("ui.gameCalendar.kindEvent")}</option>
            <option value="deadline">{t("ui.gameCalendar.kindDeadline")}</option>
          </select>
          <label className="flex items-center gap-1 text-[0.6875rem] text-foreground">
            <input
              type="checkbox"
              checked={draft.yearly}
              onChange={(event) => setDraft({ ...draft, yearly: event.target.checked })}
            />
            {t("ui.gameCalendar.yearly")}
          </label>
          <button
            type="button"
            disabled={!draft.title.trim() || save.isPending}
            onClick={addEvent}
            className={cn(SMALL_BUTTON_CLASS, "ml-auto")}
          >
            <Plus size={12} />
            {t("ui.gameCalendar.addEvent")}
          </button>
        </div>
      </div>

      <button type="button" onClick={onEdit} className={cn(SMALL_BUTTON_CLASS, "w-full")}>
        <Settings2 size={12} />
        {t("ui.gameCalendar.editCalendar")}
      </button>
    </div>
  );
}

function CalendarSetup({
  chatId,
  calendar,
  clockDay,
  onDone,
}: {
  chatId: string;
  calendar: GameCalendarState;
  clockDay: number;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const save = useSaveGameCalendar(chatId);
  const { config } = calendar;
  const initialToday = calendarDateForClockDay(config, clockDay);
  const [enabled, setEnabled] = useState(true);
  const [monthsText, setMonthsText] = useState(() => monthsToText(config));
  const [weekdaysText, setWeekdaysText] = useState(() => config.weekdays.join(", "));
  const [era, setEra] = useState(config.era);
  const [today, setToday] = useState<GameCalendarDate>(initialToday);
  const [weekday, setWeekday] = useState(() => calendarWeekday(config, initialToday));
  const [leap, setLeap] = useState(() => ({
    every: String(config.leap?.every ?? ""),
    except: String(config.leap?.except ?? ""),
    unless: String(config.leap?.unless ?? ""),
    monthIndex: config.leap?.monthIndex ?? 0,
    extraDays: String(config.leap?.extraDays ?? 1),
  }));
  const [moonsText, setMoonsText] = useState(() =>
    moonStates(config, initialToday)
      .map((moon, index) => `${moon.name} | ${config.moons[index]!.cycleDays} | ${moon.age}`)
      .join("\n"),
  );

  // The calendar as currently typed, without the moons and anchors, to drive the date and weekday pickers.
  const shape = useMemo(
    () =>
      sanitizeGameCalendarConfig({
        months: parseMonthsText(monthsText),
        weekdays: parseWeekdaysText(weekdaysText),
        era,
        leap: leap.every
          ? {
              every: toInt(leap.every, 0),
              except: toInt(leap.except, 0),
              unless: toInt(leap.unless, 0),
              monthIndex: leap.monthIndex,
              extraDays: toInt(leap.extraDays, 1),
            }
          : null,
        startDate: today,
      }),
    [monthsText, weekdaysText, era, leap, today],
  );
  const safeToday = sanitizeGameCalendarDate(shape, today) ?? shape.startDate;

  const submit = () => {
    const withWeekday = {
      ...shape,
      weekdayOffset: weekdayOffsetFor(shape, safeToday, Math.min(weekday, shape.weekdays.length - 1)),
    };
    const next: GameCalendarConfig = {
      ...withWeekday,
      // Clock Day 1 is as many days before today as the clock has run.
      startDate: addCalendarDays(withWeekday, safeToday, -(clockDay - 1)),
      moons: parseMoonLines(moonsText).map((moon) => ({
        name: moon.name,
        cycleDays: moon.cycleDays,
        newMoonDay: newMoonDayFor(withWeekday, safeToday, moon.age),
      })),
    };
    save.mutate(
      { enabled, config: next, events: calendar.events },
      {
        onSuccess: () => {
          toast.success(t("ui.gameCalendar.saved"));
          onDone();
        },
        onError: (error) => toast.error(error instanceof Error ? error.message : t("ui.gameCalendar.saveFailed")),
      },
    );
  };

  return (
    <div className="space-y-2.5">
      <p className="text-xs text-muted-foreground">{t("ui.gameCalendar.setupHelp")}</p>
      <label className="flex items-center gap-1.5 text-xs text-foreground">
        <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        {t("ui.gameCalendar.enabled")}
      </label>

      <label className="block space-y-1">
        <span className={LABEL_CLASS}>{t("ui.gameCalendar.months")}</span>
        <textarea
          value={monthsText}
          onChange={(event) => setMonthsText(event.target.value)}
          rows={5}
          className={AREA_CLASS}
          placeholder={t("ui.gameCalendar.monthsPlaceholder")}
        />
      </label>
      <label className="block space-y-1">
        <span className={LABEL_CLASS}>{t("ui.gameCalendar.weekdays")}</span>
        <input
          value={weekdaysText}
          onChange={(event) => setWeekdaysText(event.target.value)}
          className={cn(FIELD_CLASS, "w-full")}
          placeholder={t("ui.gameCalendar.weekdaysPlaceholder")}
        />
      </label>
      <label className="block space-y-1">
        <span className={LABEL_CLASS}>{t("ui.gameCalendar.era")}</span>
        <input
          value={era}
          onChange={(event) => setEra(event.target.value)}
          maxLength={40}
          className={cn(FIELD_CLASS, "w-full")}
          placeholder={t("ui.gameCalendar.eraPlaceholder")}
        />
      </label>

      <div className="space-y-1">
        <span className={LABEL_CLASS}>{t("ui.gameCalendar.todayIs", { day: clockDay })}</span>
        <DateFields config={shape} value={safeToday} onChange={setToday} />
        <select
          value={Math.min(weekday, shape.weekdays.length - 1)}
          onChange={(event) => setWeekday(toInt(event.target.value, 0))}
          className={cn(FIELD_CLASS, "w-full")}
          aria-label={t("ui.gameCalendar.todayWeekday")}
        >
          {shape.weekdays.map((name, index) => (
            <option key={index} value={index}>
              {name}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1">
        <span className={LABEL_CLASS}>{t("ui.gameCalendar.leapRule")}</span>
        <div className="grid grid-cols-3 gap-1">
          <input
            type="number"
            min={0}
            value={leap.every}
            onChange={(event) => setLeap({ ...leap, every: event.target.value })}
            className={FIELD_CLASS}
            placeholder={t("ui.gameCalendar.leapEvery")}
            aria-label={t("ui.gameCalendar.leapEvery")}
            title={t("ui.gameCalendar.leapEvery")}
          />
          <input
            type="number"
            min={0}
            value={leap.except}
            onChange={(event) => setLeap({ ...leap, except: event.target.value })}
            className={FIELD_CLASS}
            placeholder={t("ui.gameCalendar.leapExcept")}
            aria-label={t("ui.gameCalendar.leapExcept")}
            title={t("ui.gameCalendar.leapExcept")}
          />
          <input
            type="number"
            min={0}
            value={leap.unless}
            onChange={(event) => setLeap({ ...leap, unless: event.target.value })}
            className={FIELD_CLASS}
            placeholder={t("ui.gameCalendar.leapUnless")}
            aria-label={t("ui.gameCalendar.leapUnless")}
            title={t("ui.gameCalendar.leapUnless")}
          />
        </div>
        <div className="flex gap-1">
          <select
            value={Math.min(leap.monthIndex, shape.months.length - 1)}
            onChange={(event) => setLeap({ ...leap, monthIndex: toInt(event.target.value, 0) })}
            className={cn(FIELD_CLASS, "min-w-0 flex-1")}
            aria-label={t("ui.gameCalendar.leapMonth")}
          >
            {shape.months.map((month, index) => (
              <option key={index} value={index}>
                {month.name}
              </option>
            ))}
          </select>
          <input
            type="number"
            min={1}
            value={leap.extraDays}
            onChange={(event) => setLeap({ ...leap, extraDays: event.target.value })}
            className={cn(FIELD_CLASS, "w-20")}
            aria-label={t("ui.gameCalendar.leapExtraDays")}
            title={t("ui.gameCalendar.leapExtraDays")}
          />
        </div>
        <p className="text-[0.625rem] text-muted-foreground">{t("ui.gameCalendar.leapHelp")}</p>
      </div>

      <label className="block space-y-1">
        <span className={LABEL_CLASS}>{t("ui.gameCalendar.moons")}</span>
        <textarea
          value={moonsText}
          onChange={(event) => setMoonsText(event.target.value)}
          rows={2}
          className={AREA_CLASS}
          placeholder={t("ui.gameCalendar.moonsPlaceholder")}
        />
      </label>

      <div className="flex gap-1.5">
        <button type="button" onClick={onDone} className={cn(SMALL_BUTTON_CLASS, "flex-1")}>
          {t("ui.gameCalendar.cancel")}
        </button>
        <button type="button" disabled={save.isPending} onClick={submit} className={cn(SMALL_BUTTON_CLASS, "flex-1")}>
          {save.isPending ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          {t("ui.gameCalendar.save")}
        </button>
      </div>
    </div>
  );
}
