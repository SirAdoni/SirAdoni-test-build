// ──────────────────────────────────────────────
// Game calendar: pure in-world calendar math
//
// A game's own calendar: named months of any length, named weekdays, an era
// suffix for the year, an optional leap rule that lengthens one month, and
// optional moons with their own cycles. Dates are { year, month, day } with a
// 0-based month and a 1-based day. Arithmetic runs on an absolute day number
// counted from the first day of year 0, so any date, including years before 0,
// converts both ways without drift.
//
// The calendar never stores a "today" of its own. Game Mode already keeps the
// in-world clock in chat metadata (`gameTime.day`, starting at Day 1), which the
// Day editor, /game/time/advance and the scene analyzer all move. The calendar
// only adds `startDate`, the calendar date of clock Day 1, so clock day N is
// startDate + (N - 1) days, and moving the date means moving that same clock.
// ──────────────────────────────────────────────

/** Chat metadata key the calendar lives under. It travels to new sessions with the rest of the game metadata. */
export const GAME_CALENDAR_METADATA_KEY = "gameCalendar";

export interface GameCalendarMonth {
  name: string;
  days: number;
}

/** Leap years: every `every` years, except multiples of `except`, unless also multiples of `unless`. */
export interface GameCalendarLeapRule {
  every: number;
  except: number | null;
  unless: number | null;
  /** The month that gains the extra days in a leap year. */
  monthIndex: number;
  extraDays: number;
}

export interface GameCalendarMoon {
  name: string;
  /** Days from one new moon to the next. May be fractional. */
  cycleDays: number;
  /** Absolute day number of a new moon. */
  newMoonDay: number;
}

export interface GameCalendarDate {
  year: number;
  /** 0-based month index. */
  month: number;
  /** 1-based day of the month. */
  day: number;
}

export interface GameCalendarConfig {
  months: GameCalendarMonth[];
  weekdays: string[];
  /** Written after the year, such as "AR". Empty for none. */
  era: string;
  /** Weekday index of absolute day 0. */
  weekdayOffset: number;
  leap: GameCalendarLeapRule | null;
  moons: GameCalendarMoon[];
  /** The calendar date of the game clock's Day 1. */
  startDate: GameCalendarDate;
}

export type GameCalendarEventKind = "event" | "deadline";

export interface GameCalendarEvent {
  id: string;
  title: string;
  kind: GameCalendarEventKind;
  date: GameCalendarDate;
  /** A festival that returns every year on the same month and day. */
  yearly: boolean;
  notes: string;
  /** A finished deadline stops counting as overdue. */
  done: boolean;
}

/** What the `gameCalendar` metadata key holds. */
export interface GameCalendarState {
  enabled: boolean;
  config: GameCalendarConfig;
  events: GameCalendarEvent[];
}

export interface GameClockTime {
  day: number;
  hour: number;
  minute: number;
}

export const GAME_CALENDAR_LIMITS = {
  months: 60,
  weekdays: 30,
  moons: 8,
  monthDays: 1000,
  name: 80,
  era: 40,
  eventTitle: 200,
  eventNotes: 2000,
  events: 500,
  /** Years beyond this in either direction are clamped: far enough for any campaign. */
  year: 1_000_000,
  advanceDays: 100_000,
} as const;

/** The moon phase names the client localizes, in order from new moon. */
export const MOON_PHASES = [
  "new",
  "waxingCrescent",
  "firstQuarter",
  "waxingGibbous",
  "full",
  "waningGibbous",
  "lastQuarter",
  "waningCrescent",
] as const;
export type MoonPhase = (typeof MOON_PHASES)[number];

/** A ready-made twelve-month calendar with a 4/100/400 leap rule, to start from and rename. */
export function defaultGameCalendarConfig(): GameCalendarConfig {
  const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const names = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  return {
    months: names.map((name, index) => ({ name, days: lengths[index]! })),
    weekdays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
    era: "",
    weekdayOffset: 0,
    leap: { every: 4, except: 100, unless: 400, monthIndex: 1, extraDays: 1 },
    moons: [],
    startDate: { year: 1, month: 0, day: 1 },
  };
}

export function defaultGameCalendarState(): GameCalendarState {
  return { enabled: false, config: defaultGameCalendarConfig(), events: [] };
}

// ── Sanitizing ──

/** Longest leap cycle (in years) a calendar may have; sanitizing drops rule parts past it. */
const MAX_LEAP_CYCLE = 100_000;

function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function cleanInt(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function mod(value: number, by: number): number {
  return ((value % by) + by) % by;
}

/** Make any stored or posted calendar safe to compute with. Always returns a usable calendar. */
export function sanitizeGameCalendarConfig(input: unknown): GameCalendarConfig {
  const fallback = defaultGameCalendarConfig();
  if (!input || typeof input !== "object") return fallback;
  const raw = input as Record<string, unknown>;

  const months = (Array.isArray(raw.months) ? raw.months : [])
    .slice(0, GAME_CALENDAR_LIMITS.months)
    .map((month, index) => {
      const item = (month && typeof month === "object" ? month : {}) as Record<string, unknown>;
      return {
        name: cleanText(item.name, GAME_CALENDAR_LIMITS.name) || `Month ${index + 1}`,
        days: cleanInt(item.days, 1, GAME_CALENDAR_LIMITS.monthDays, 30),
      };
    });
  const weekdays = (Array.isArray(raw.weekdays) ? raw.weekdays : [])
    .slice(0, GAME_CALENDAR_LIMITS.weekdays)
    .map((name, index) => cleanText(name, GAME_CALENDAR_LIMITS.name) || `Day ${index + 1}`);
  const safeMonths = months.length > 0 ? months : fallback.months;
  const safeWeekdays = weekdays.length > 0 ? weekdays : fallback.weekdays;

  let leap: GameCalendarLeapRule | null = null;
  if (raw.leap && typeof raw.leap === "object") {
    const rule = raw.leap as Record<string, unknown>;
    const every = cleanInt(rule.every, 0, 10_000, 0);
    if (every > 0) {
      const except = cleanInt(rule.except, 0, 10_000, 0);
      const unless = cleanInt(rule.unless, 0, 10_000, 0);
      leap = {
        every,
        except: except > 0 ? except : null,
        unless: except > 0 && unless > 0 ? unless : null,
        monthIndex: cleanInt(rule.monthIndex, 0, safeMonths.length - 1, 0),
        extraDays: cleanInt(rule.extraDays, 1, GAME_CALENDAR_LIMITS.monthDays, 1),
      };
      // The date math precomputes one full leap cycle; keep that cycle small.
      if (leapCycleYears(leap) > MAX_LEAP_CYCLE) leap.unless = null;
      if (leapCycleYears(leap) > MAX_LEAP_CYCLE) leap.except = null;
    }
  }

  const moons = (Array.isArray(raw.moons) ? raw.moons : []).slice(0, GAME_CALENDAR_LIMITS.moons).flatMap((moon) => {
    if (!moon || typeof moon !== "object") return [];
    const item = moon as Record<string, unknown>;
    const cycle = typeof item.cycleDays === "number" ? item.cycleDays : Number(item.cycleDays);
    if (!Number.isFinite(cycle) || cycle < 1) return [];
    return [
      {
        name: cleanText(item.name, GAME_CALENDAR_LIMITS.name) || "Moon",
        cycleDays: Math.min(10_000, Math.round(cycle * 1000) / 1000),
        newMoonDay: cleanInt(item.newMoonDay, -1e12, 1e12, 0),
      },
    ];
  });

  const base: GameCalendarConfig = {
    months: safeMonths,
    weekdays: safeWeekdays,
    era: cleanText(raw.era, GAME_CALENDAR_LIMITS.era),
    weekdayOffset: mod(cleanInt(raw.weekdayOffset, -1e6, 1e6, 0), safeWeekdays.length),
    leap,
    moons,
    startDate: { year: 1, month: 0, day: 1 },
  };
  base.startDate = sanitizeGameCalendarDate(base, raw.startDate) ?? { year: 1, month: 0, day: 1 };
  return base;
}

/** A date clamped into the calendar: the month into range and the day into that month. Null when unreadable. */
export function sanitizeGameCalendarDate(config: GameCalendarConfig, input: unknown): GameCalendarDate | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const year = cleanInt(raw.year, -GAME_CALENDAR_LIMITS.year, GAME_CALENDAR_LIMITS.year, NaN);
  if (Number.isNaN(year)) return null;
  const month = cleanInt(raw.month, 0, config.months.length - 1, 0);
  const day = cleanInt(raw.day, 1, daysInMonth(config, year, month), 1);
  return { year, month, day };
}

export function sanitizeGameCalendarEvent(
  config: GameCalendarConfig,
  input: unknown,
  fallbackId: string,
): GameCalendarEvent | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const title = cleanText(raw.title, GAME_CALENDAR_LIMITS.eventTitle);
  const date = sanitizeGameCalendarDate(config, raw.date);
  if (!title || !date) return null;
  return {
    id: cleanText(raw.id, 80) || fallbackId,
    title,
    kind: raw.kind === "deadline" ? "deadline" : "event",
    date,
    yearly: raw.yearly === true,
    notes: typeof raw.notes === "string" ? raw.notes.trim().slice(0, GAME_CALENDAR_LIMITS.eventNotes) : "",
    done: raw.done === true,
  };
}

/** The whole `gameCalendar` metadata value, safe to use. Events with duplicate ids get fresh ones. */
export function sanitizeGameCalendarState(input: unknown): GameCalendarState {
  if (!input || typeof input !== "object") return defaultGameCalendarState();
  const raw = input as Record<string, unknown>;
  const config = sanitizeGameCalendarConfig(raw.config);
  const seen = new Set<string>();
  const events: GameCalendarEvent[] = [];
  for (const [index, item] of (Array.isArray(raw.events) ? raw.events : []).entries()) {
    if (events.length >= GAME_CALENDAR_LIMITS.events) break;
    const event = sanitizeGameCalendarEvent(config, item, `event-${index + 1}`);
    if (!event) continue;
    let id = event.id;
    for (let n = 2; seen.has(id); n++) id = `${event.id}-${n}`;
    seen.add(id);
    events.push({ ...event, id });
  }
  return { enabled: raw.enabled === true, config, events };
}

/** The calendar a game uses, or null when it has none switched on. */
export function readGameCalendar(metadata: Record<string, unknown> | null | undefined): GameCalendarState | null {
  const value = metadata?.[GAME_CALENDAR_METADATA_KEY];
  if (!value || typeof value !== "object") return null;
  const state = sanitizeGameCalendarState(value);
  return state.enabled ? state : null;
}

// ── Years and months ──

export function isLeapYear(config: Pick<GameCalendarConfig, "leap">, year: number): boolean {
  const rule = config.leap;
  if (!rule) return false;
  if (mod(year, rule.every) !== 0) return false;
  if (rule.except && mod(year, rule.except) === 0) {
    return Boolean(rule.unless && mod(year, rule.unless) === 0);
  }
  return true;
}

export function daysInMonth(config: GameCalendarConfig, year: number, month: number): number {
  const base = config.months[month]?.days ?? 0;
  const leap = config.leap;
  return leap && leap.monthIndex === month && isLeapYear(config, year) ? base + leap.extraDays : base;
}

export function daysInYear(config: GameCalendarConfig, year: number): number {
  const common = config.months.reduce((sum, month) => sum + month.days, 0);
  return isLeapYear(config, year) ? common + (config.leap?.extraDays ?? 0) : common;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** Years after which the leap pattern repeats. */
function leapCycleYears(rule: GameCalendarLeapRule | null): number {
  if (!rule) return 1;
  let cycle = rule.every;
  for (const step of [rule.except, rule.unless]) {
    if (step) cycle = (cycle / gcd(cycle, step)) * step;
  }
  return cycle;
}

interface YearTable {
  cycle: number;
  cycleDays: number;
  /** prefix[i] = days in years 0..i-1 of a cycle. */
  prefix: number[];
}

const yearTables = new WeakMap<GameCalendarConfig, YearTable>();

function yearTable(config: GameCalendarConfig): YearTable {
  const cached = yearTables.get(config);
  if (cached) return cached;
  const cycle = Math.min(leapCycleYears(config.leap), MAX_LEAP_CYCLE);
  const prefix = [0];
  for (let year = 0; year < cycle; year++) prefix.push(prefix[year]! + daysInYear(config, year));
  const table = { cycle, cycleDays: prefix[cycle]!, prefix };
  yearTables.set(config, table);
  return table;
}

/** Days from the first day of year 0 to the first day of `year` (negative before year 0). */
function daysBeforeYear(config: GameCalendarConfig, year: number): number {
  const { cycle, cycleDays, prefix } = yearTable(config);
  const cycles = Math.floor(year / cycle);
  return cycles * cycleDays + prefix[year - cycles * cycle]!;
}

// ── Conversions ──

/** Absolute day number of a date. Day 0 is the first day of year 0. Out-of-range days overflow into later months. */
export function calendarDateToDays(config: GameCalendarConfig, date: GameCalendarDate): number {
  let days = daysBeforeYear(config, Math.trunc(date.year));
  const month = Math.min(Math.max(0, Math.trunc(date.month)), config.months.length - 1);
  for (let index = 0; index < month; index++) days += daysInMonth(config, date.year, index);
  return days + Math.trunc(date.day) - 1;
}

export function daysToCalendarDate(config: GameCalendarConfig, absoluteDay: number): GameCalendarDate {
  const target = Math.trunc(absoluteDay);
  const { cycle, cycleDays, prefix } = yearTable(config);
  const cycles = Math.floor(target / cycleDays);
  let rest = target - cycles * cycleDays;
  // Binary search the year inside the cycle.
  let low = 0;
  let high = cycle - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (prefix[middle]! <= rest) low = middle;
    else high = middle - 1;
  }
  rest -= prefix[low]!;
  const year = cycles * cycle + low;
  let month = 0;
  while (month < config.months.length - 1 && rest >= daysInMonth(config, year, month)) {
    rest -= daysInMonth(config, year, month);
    month++;
  }
  return { year, month, day: rest + 1 };
}

/** Move a date by whole days (negative moves back), carrying across months and years. */
export function addCalendarDays(config: GameCalendarConfig, date: GameCalendarDate, days: number): GameCalendarDate {
  return daysToCalendarDate(config, calendarDateToDays(config, date) + Math.trunc(days));
}

export function compareCalendarDates(config: GameCalendarConfig, a: GameCalendarDate, b: GameCalendarDate): number {
  return calendarDateToDays(config, a) - calendarDateToDays(config, b);
}

/** 0-based index into `config.weekdays`. */
export function calendarWeekday(config: GameCalendarConfig, date: GameCalendarDate): number {
  return mod(calendarDateToDays(config, date) + config.weekdayOffset, config.weekdays.length);
}

/** The weekday offset that makes `date` fall on `weekday`. */
export function weekdayOffsetFor(config: GameCalendarConfig, date: GameCalendarDate, weekday: number): number {
  return mod(weekday - calendarDateToDays(config, date), config.weekdays.length);
}

export interface MoonState {
  name: string;
  phase: MoonPhase;
  /** Whole days since the last new moon. */
  age: number;
  /** 0 new, 0.5 full, towards 1 at the next new moon. */
  fraction: number;
}

export function moonStates(config: GameCalendarConfig, date: GameCalendarDate): MoonState[] {
  const today = calendarDateToDays(config, date);
  return config.moons.map((moon) => {
    const age = mod(today - moon.newMoonDay, moon.cycleDays);
    const fraction = age / moon.cycleDays;
    const phase = MOON_PHASES[Math.floor(fraction * 8 + 0.5) % 8]!;
    return { name: moon.name, phase, age: Math.floor(age), fraction };
  });
}

/** The newMoonDay that makes `date` be `age` days into a moon's cycle. */
export function newMoonDayFor(config: GameCalendarConfig, date: GameCalendarDate, age: number): number {
  return calendarDateToDays(config, date) - Math.trunc(age);
}

// ── The game clock ──

/** Read the Game Mode clock (`gameTime`) from chat metadata; null when the game has no clock yet. */
export function readGameClock(value: unknown): GameClockTime | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const day = Number(raw.day);
  if (!Number.isFinite(day)) return null;
  const hour = Number(raw.hour);
  const minute = Number(raw.minute);
  return {
    day: Math.max(1, Math.trunc(day)),
    hour: Number.isFinite(hour) ? Math.min(23, Math.max(0, Math.trunc(hour))) : 8,
    minute: Number.isFinite(minute) ? Math.min(59, Math.max(0, Math.trunc(minute))) : 0,
  };
}

/** Largest clock day the calendar maps; beyond it years would leave exact integer range. */
const MAX_CLOCK_DAY = 1_000_000_000;

function formatGameClock(clock: GameClockTime): string {
  const day = Math.min(MAX_CLOCK_DAY, clock.day);
  const timeOfDay =
    clock.hour >= 5 && clock.hour < 7
      ? "dawn"
      : clock.hour >= 7 && clock.hour < 12
        ? "morning"
        : clock.hour >= 12 && clock.hour < 17
          ? "afternoon"
          : clock.hour >= 17 && clock.hour < 20
            ? "evening"
            : clock.hour >= 20
              ? "night"
              : "midnight";
  return `Day ${day}, ${clock.hour.toString().padStart(2, "0")}:${clock.minute
    .toString()
    .padStart(2, "0")} (${timeOfDay})`;
}

/** The calendar date of a Game Mode clock day: clock Day 1 is `startDate`. */
export function calendarDateForClockDay(config: GameCalendarConfig, clockDay: number): GameCalendarDate {
  // The clock day comes from stored metadata; keep absurd values inside exact integer range.
  const day = Math.min(MAX_CLOCK_DAY, Math.max(-MAX_CLOCK_DAY, Math.trunc(clockDay) || 1));
  return addCalendarDays(config, config.startDate, day - 1);
}

/** The clock day a calendar date falls on. Below 1 when the date is before the game's Day 1. */
export function clockDayForCalendarDate(config: GameCalendarConfig, date: GameCalendarDate): number {
  return calendarDateToDays(config, date) - calendarDateToDays(config, config.startDate) + 1;
}

/**
 * Move the clock by whole days. The clock never goes below Day 1, so a negative advance past the
 * start stops there. Hour and minute are kept.
 */
export function advanceClockDays(clock: GameClockTime, days: number): GameClockTime {
  const step = Math.max(
    -GAME_CALENDAR_LIMITS.advanceDays,
    Math.min(GAME_CALENDAR_LIMITS.advanceDays, Math.trunc(days)),
  );
  return { ...clock, day: Math.max(1, clock.day + step) };
}

/**
 * Set "today" to a calendar date by moving the clock. A date before clock Day 1 cannot be a clock
 * day, so the calendar's start moves back to that date and the clock goes to Day 1.
 */
export function setClockToCalendarDate(
  config: GameCalendarConfig,
  clock: GameClockTime,
  date: GameCalendarDate,
): { config: GameCalendarConfig; clock: GameClockTime } {
  const day = clockDayForCalendarDate(config, date);
  if (day >= 1) return { config, clock: { ...clock, day } };
  return { config: { ...config, startDate: date }, clock: { ...clock, day: 1 } };
}

// ── Formatting ──

export function formatCalendarYear(config: GameCalendarConfig, year: number): string {
  return config.era ? `${year} ${config.era}` : String(year);
}

/** Plain form for prompts and exports, such as "Firstday, 3 Rainmoon 88 AR". */
export function formatCalendarDate(config: GameCalendarConfig, date: GameCalendarDate, withWeekday = true): string {
  const month = config.months[date.month]?.name ?? "";
  const body = `${date.day} ${month} ${formatCalendarYear(config, date.year)}`;
  return withWeekday ? `${config.weekdays[calendarWeekday(config, date)]}, ${body}` : body;
}

// ── Events ──

/** The date a yearly event falls on in `year`: a day past the month's end (a leap day) moves to its last day. */
export function yearlyOccurrence(config: GameCalendarConfig, event: GameCalendarEvent, year: number): GameCalendarDate {
  const month = Math.min(event.date.month, config.months.length - 1);
  return { year, month, day: Math.min(event.date.day, daysInMonth(config, year, month)) };
}

export interface UpcomingCalendarEvent {
  event: GameCalendarEvent;
  /** The occurrence being listed (this year's or next year's for a yearly event). */
  date: GameCalendarDate;
  /** Days from today; negative for an overdue deadline, 0 for today. */
  inDays: number;
  overdue: boolean;
}

/** The next occurrence of an event on or after today, or its own date when it is one-off. */
export function nextOccurrence(
  config: GameCalendarConfig,
  event: GameCalendarEvent,
  today: GameCalendarDate,
): GameCalendarDate {
  if (!event.yearly) return event.date;
  const todayDays = calendarDateToDays(config, today);
  const startYear = Math.max(today.year, event.date.year);
  for (const year of [startYear, startYear + 1]) {
    const occurrence = yearlyOccurrence(config, event, year);
    if (calendarDateToDays(config, occurrence) >= todayDays) return occurrence;
  }
  return yearlyOccurrence(config, event, startYear + 1);
}

/**
 * Overdue deadlines first (oldest first), then what is coming, soonest first, within `horizonDays`.
 * Finished deadlines and past one-off events drop out.
 */
export function upcomingCalendarEvents(
  config: GameCalendarConfig,
  events: GameCalendarEvent[],
  today: GameCalendarDate,
  options: { horizonDays?: number; limit?: number } = {},
): UpcomingCalendarEvent[] {
  const horizon = options.horizonDays ?? Number.POSITIVE_INFINITY;
  const todayDays = calendarDateToDays(config, today);
  const listed: UpcomingCalendarEvent[] = [];
  for (const event of events) {
    if (event.kind === "deadline" && event.done) continue;
    const date = nextOccurrence(config, event, today);
    const inDays = calendarDateToDays(config, date) - todayDays;
    const overdue = inDays < 0 && event.kind === "deadline";
    if (inDays < 0 && !overdue) continue;
    if (inDays > horizon) continue;
    listed.push({ event, date, inDays, overdue });
  }
  listed.sort((a, b) => a.inDays - b.inDays || a.event.title.localeCompare(b.event.title));
  return options.limit === undefined ? listed : listed.slice(0, options.limit);
}

/** The events that fall on one date (yearly events by month and day, from their first year on). */
export function eventsOnDate(
  config: GameCalendarConfig,
  events: GameCalendarEvent[],
  date: GameCalendarDate,
): GameCalendarEvent[] {
  const target = calendarDateToDays(config, date);
  return events.filter((event) => {
    const occurrence = event.yearly ? yearlyOccurrence(config, event, date.year) : event.date;
    return calendarDateToDays(config, occurrence) === target && (!event.yearly || date.year >= event.date.year);
  });
}

/**
 * Upcoming events as calendar HUD widget entries ("Day 21" + title), on the same clock-day numbers the
 * widget counts in, so a GM-made calendar widget can list them beside its own entries.
 */
export function calendarWidgetEntries(
  state: GameCalendarState,
  clockDay: number,
  options: { horizonDays?: number; limit?: number } = {},
): Array<{ when: string; text: string }> {
  const today = calendarDateForClockDay(state.config, clockDay);
  // Overdue deadlines sort first; drop them before the limit so they never crowd out what is coming.
  return upcomingCalendarEvents(state.config, state.events, today, { horizonDays: options.horizonDays ?? 60 })
    .filter((item) => !item.overdue)
    .slice(0, options.limit ?? 8)
    .map((item) => ({ when: `Day ${clockDay + item.inDays}`, text: item.event.title }));
}

/**
 * The date line the GM sees for a game with a calendar: today's date, then any event or deadline in
 * the next `horizonDays`, such as "Firstday, 3 Rainmoon 88 AR (upcoming: Lantern Fair tomorrow;
 * deadline Toll owed in 4 days)".
 */
export function describeCalendarForPrompt(
  state: GameCalendarState,
  clockDay: number,
  options: { horizonDays?: number; limit?: number } = {},
): string {
  const today = calendarDateForClockDay(state.config, clockDay);
  const label = formatCalendarDate(state.config, today);
  const upcoming = upcomingCalendarEvents(state.config, state.events, today, {
    horizonDays: options.horizonDays ?? 14,
    limit: options.limit ?? 4,
  });
  if (upcoming.length === 0) return label;
  const parts = upcoming.map(({ event, inDays, overdue }) => {
    const name = event.kind === "deadline" ? `deadline ${event.title}` : event.title;
    if (overdue) return `${name} overdue by ${-inDays} day${inDays === -1 ? "" : "s"}`;
    if (inDays === 0) return `${name} today`;
    if (inDays === 1) return `${name} tomorrow`;
    return `${name} in ${inDays} days`;
  });
  return `${label} (upcoming: ${parts.join("; ")})`;
}

// ── Plain-text lists for the setup editor ──

/** "Name | 30" per line. */
export function monthsToText(config: GameCalendarConfig): string {
  return config.months.map((month) => `${month.name} | ${month.days}`).join("\n");
}

/** Lines of "Name | days" (or "Name 30"); a line without a number gets 30 days. Blank lines are skipped. */
export function parseMonthsText(text: string): GameCalendarMonth[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, GAME_CALENDAR_LIMITS.months)
    .map((line) => {
      const match = /^(.*?)\s*(?:\|\s*|\s)(\d{1,4})$/.exec(line);
      const name = cleanText(match ? match[1] : line.replace(/\|/g, " "), GAME_CALENDAR_LIMITS.name);
      const days = match ? cleanInt(match[2], 1, GAME_CALENDAR_LIMITS.monthDays, 30) : 30;
      return { name: name || "Month", days };
    });
}

/** Weekday names, one per line or comma separated. */
export function parseWeekdaysText(text: string): string[] {
  return text
    .split(/[\r\n,]+/)
    .map((name) => cleanText(name, GAME_CALENDAR_LIMITS.name))
    .filter(Boolean)
    .slice(0, GAME_CALENDAR_LIMITS.weekdays);
}

/**
 * The GM prompt's "Time" value. A valid Game Mode clock in metadata is authoritative; snapshots are
 * retained as a legacy fallback when no clock exists. With a calendar enabled, its date line comes
 * from the metadata clock day while the clock supplies the time portion.
 */
export function composeGameTimeLine(
  snapshot: { date?: string | null; time?: string | null } | null | undefined,
  metadata: Record<string, unknown> | null | undefined,
): string | undefined {
  const clock = readGameClock(metadata?.gameTime);
  let calendar: GameCalendarState | null = null;
  try {
    calendar = readGameCalendar(metadata);
  } catch {
    calendar = null;
  }
  if (!calendar) {
    if (clock) return formatGameClock(clock);
    if (!snapshot || !(snapshot.time || snapshot.date)) return undefined;
    return [snapshot.date, snapshot.time].filter(Boolean).join(", ");
  }
  const day = clock?.day ?? 1;
  let line: string;
  try {
    line = describeCalendarForPrompt(calendar, day);
  } catch {
    // A calendar that cannot be read never costs the GM its time line: fall back to the plain one.
    if (clock) return formatGameClock(clock);
    return composeGameTimeLine(snapshot, null);
  }
  return [line, clock ? formatGameClock(clock) : snapshot?.time].filter(Boolean).join(", ");
}
