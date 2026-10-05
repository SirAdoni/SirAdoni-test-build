import assert from "node:assert/strict";
import {
  addCalendarDays,
  advanceClockDays,
  calendarDateForClockDay,
  calendarDateToDays,
  calendarWeekday,
  clockDayForCalendarDate,
  composeGameTimeLine,
  daysInMonth,
  daysInYear,
  daysToCalendarDate,
  defaultGameCalendarConfig,
  describeCalendarForPrompt,
  eventsOnDate,
  formatCalendarDate,
  isLeapYear,
  monthsToText,
  moonStates,
  newMoonDayFor,
  parseMonthsText,
  parseWeekdaysText,
  readGameCalendar,
  readGameClock,
  sanitizeGameCalendarConfig,
  sanitizeGameCalendarState,
  setClockToCalendarDate,
  upcomingCalendarEvents,
  weekdayOffsetFor,
  type GameCalendarConfig,
  type GameCalendarEvent,
  type GameCalendarState,
} from "../../packages/shared/src/index.js";

const date = (year: number, month: number, day: number) => ({ year, month, day });

// ── Default (Gregorian-shaped) calendar: leap rule, overflow and weekdays against the real calendar ──
const greg = defaultGameCalendarConfig();
assert.equal(isLeapYear(greg, 2024), true);
assert.equal(isLeapYear(greg, 2023), false);
assert.equal(isLeapYear(greg, 1900), false, "century years skip the leap day");
assert.equal(isLeapYear(greg, 2000), true, "every fourth century keeps it");
assert.equal(isLeapYear(greg, -4), true, "leap years work before year 0");
assert.equal(daysInYear(greg, 2024), 366);
assert.equal(daysInYear(greg, 2023), 365);
assert.equal(daysInMonth(greg, 2024, 1), 29);
assert.equal(daysInMonth(greg, 2023, 1), 28);

// Month overflow, year overflow and negative moves.
assert.deepEqual(addCalendarDays(greg, date(2023, 0, 31), 1), date(2023, 1, 1));
assert.deepEqual(addCalendarDays(greg, date(2023, 1, 28), 1), date(2023, 2, 1));
assert.deepEqual(addCalendarDays(greg, date(2024, 1, 28), 1), date(2024, 1, 29));
assert.deepEqual(addCalendarDays(greg, date(2023, 11, 31), 1), date(2024, 0, 1));
assert.deepEqual(addCalendarDays(greg, date(2024, 0, 1), -1), date(2023, 11, 31));
assert.deepEqual(addCalendarDays(greg, date(2024, 2, 1), -1), date(2024, 1, 29));
assert.deepEqual(addCalendarDays(greg, date(1, 0, 1), -1), date(0, 11, 31));
assert.deepEqual(addCalendarDays(greg, date(1, 0, 1), -366), date(0, 0, 1), "year 0 is a leap year");
assert.deepEqual(addCalendarDays(greg, date(0, 0, 1), -365), date(-1, 0, 1), "year -1 is not");
assert.deepEqual(addCalendarDays(greg, date(2023, 5, 15), 365 * 3 + 1), date(2026, 5, 15));
assert.deepEqual(addCalendarDays(greg, date(2026, 5, 15), -(365 * 3 + 1)), date(2023, 5, 15));
// A day past the month's end overflows into the next month.
assert.equal(calendarDateToDays(greg, date(2023, 0, 32)), calendarDateToDays(greg, date(2023, 1, 1)));

// Same day counts as the proleptic Gregorian calendar: 0001-01-01 to 2001-01-01 is 730485 days.
assert.equal(calendarDateToDays(greg, date(2001, 0, 1)) - calendarDateToDays(greg, date(1, 0, 1)), 730485);
// 0001-01-01 was a Monday; with that anchored, 2026-09-23 is a Wednesday and 2000-02-29 a Tuesday.
const anchored: GameCalendarConfig = { ...greg, weekdayOffset: weekdayOffsetFor(greg, date(1, 0, 1), 0) };
assert.equal(anchored.weekdays[calendarWeekday(anchored, date(2026, 8, 23))], "Wednesday");
assert.equal(anchored.weekdays[calendarWeekday(anchored, date(2000, 1, 29))], "Tuesday");
assert.equal(anchored.weekdays[calendarWeekday(anchored, date(-1, 11, 31))], "Friday");

// Round trip and continuity over a wide span, including negative years.
for (let day = -800_000; day <= 800_000; day += 997) {
  const back = calendarDateToDays(greg, daysToCalendarDate(greg, day));
  assert.equal(back, day, `round trip for absolute day ${day}`);
  const next = daysToCalendarDate(greg, day + 1);
  assert.equal(calendarDateToDays(greg, next), day + 1);
}

// ── A custom calendar: 5 months of uneven length, a 6-day week, an era and its own leap rule ──
const custom = sanitizeGameCalendarConfig({
  months: [
    { name: "Thawing", days: 40 },
    { name: "Greening", days: 35 },
    { name: "Highsun", days: 45 },
    { name: "Fading", days: 35 },
    { name: "Deepfrost", days: 30 },
  ],
  weekdays: ["Oneday", "Twoday", "Threeday", "Fourday", "Fiveday", "Restday"],
  era: "AR",
  leap: { every: 3, except: 30, unless: 0, monthIndex: 4, extraDays: 2 },
  startDate: { year: 88, month: 2, day: 44 },
});
assert.equal(daysInYear(custom, 88), 185);
assert.equal(isLeapYear(custom, 87), true);
assert.equal(isLeapYear(custom, 90), false, "except rule without unless");
assert.equal(daysInYear(custom, 87), 187);
assert.equal(daysInMonth(custom, 87, 4), 32);
assert.deepEqual(addCalendarDays(custom, date(88, 2, 44), 2), date(88, 3, 1));
assert.deepEqual(
  addCalendarDays(custom, date(87, 4, 30), 2),
  date(87, 4, 32),
  "leap days sit at the end of the leap month",
);
assert.deepEqual(addCalendarDays(custom, date(87, 4, 30), 3), date(88, 0, 1));
assert.deepEqual(addCalendarDays(custom, date(88, 0, 1), -1), date(87, 4, 32));
assert.deepEqual(addCalendarDays(custom, date(88, 0, 1), -(187 + 1)), date(86, 4, 30));
// Weekdays cycle through six names and step back correctly.
const w0 = calendarWeekday(custom, date(88, 0, 1));
assert.equal(calendarWeekday(custom, date(88, 0, 7)), w0);
assert.equal(calendarWeekday(custom, date(87, 4, 32)), (w0 + 5) % 6);
assert.equal(formatCalendarDate(custom, date(88, 2, 3), false), "3 Highsun 88 AR");
assert.match(formatCalendarDate(custom, date(88, 2, 3)), /^[A-Za-z]+day, 3 Highsun 88 AR$/);
for (let day = -50_000; day <= 50_000; day += 37) {
  assert.equal(calendarDateToDays(custom, daysToCalendarDate(custom, day)), day);
}

// ── Sanitizing: junk becomes a usable calendar and clamped dates ──
const junk = sanitizeGameCalendarConfig({ months: [{ name: "", days: -3 }, "x"], weekdays: [], leap: { every: 0 } });
assert.deepEqual(junk.months, [
  { name: "Month 1", days: 1 },
  { name: "Month 2", days: 30 },
]);
assert.equal(junk.weekdays.length, 7);
assert.equal(junk.leap, null);
assert.deepEqual(sanitizeGameCalendarConfig(null).months.length, 12);
assert.deepEqual(sanitizeGameCalendarConfig({ startDate: { year: 5, month: 99, day: 99 } }).startDate, date(5, 11, 31));
const hugeCycle = sanitizeGameCalendarConfig({ leap: { every: 9973, except: 9967, unless: 9949 } });
assert.equal(hugeCycle.leap?.unless, null, "leap cycles past the cap drop their outer exception");
assert.equal(hugeCycle.leap?.except, null);

// ── The game clock: the calendar is a view of gameTime.day, never a second date ──
assert.deepEqual(calendarDateForClockDay(custom, 1), date(88, 2, 44));
assert.deepEqual(calendarDateForClockDay(custom, 4), date(88, 3, 2));
assert.equal(clockDayForCalendarDate(custom, date(88, 3, 2)), 4);
assert.equal(clockDayForCalendarDate(custom, date(88, 2, 40)), -3);
assert.deepEqual(readGameClock({ day: 7, hour: 14, minute: 30 }), { day: 7, hour: 14, minute: 30 });
assert.deepEqual(readGameClock({ day: "3" }), { day: 3, hour: 8, minute: 0 });
assert.equal(readGameClock(undefined), null);
assert.deepEqual(advanceClockDays({ day: 5, hour: 9, minute: 15 }, 3), { day: 8, hour: 9, minute: 15 });
assert.deepEqual(advanceClockDays({ day: 5, hour: 9, minute: 15 }, -2), { day: 3, hour: 9, minute: 15 });
assert.deepEqual(advanceClockDays({ day: 5, hour: 9, minute: 15 }, -20), { day: 1, hour: 9, minute: 15 });
const moved = setClockToCalendarDate(custom, { day: 2, hour: 8, minute: 0 }, date(88, 3, 10));
assert.equal(moved.clock.day, 12);
assert.equal(moved.config, custom, "a date on or after Day 1 moves only the clock");
const rewound = setClockToCalendarDate(custom, { day: 2, hour: 8, minute: 0 }, date(88, 1, 1));
assert.deepEqual(rewound.clock, { day: 1, hour: 8, minute: 0 });
assert.deepEqual(rewound.config.startDate, date(88, 1, 1));

// ── Events: yearly festivals, deadlines, horizon and the day view ──
const leapGreg = { ...anchored, startDate: date(2023, 11, 30) };
const event = (id: string, extra: Partial<GameCalendarEvent>): GameCalendarEvent => ({
  id,
  title: id,
  kind: "event",
  date: date(2023, 0, 1),
  yearly: false,
  notes: "",
  done: false,
  ...extra,
});
const events = [
  event("Lantern Fair", { date: date(2020, 0, 2), yearly: true }),
  event("Toll owed", { kind: "deadline", date: date(2023, 11, 28) }),
  event("Paid toll", { kind: "deadline", date: date(2023, 11, 20), done: true }),
  event("Old parade", { date: date(2023, 5, 1) }),
  event("Leap feast", { date: date(2020, 1, 29), yearly: true }),
  event("Far voyage", { date: date(2025, 0, 1) }),
];
const today = date(2023, 11, 30);
const upcoming = upcomingCalendarEvents(leapGreg, events, today, { horizonDays: 90 });
assert.deepEqual(
  upcoming.map((item) => [item.event.id, item.inDays, item.overdue]),
  [
    ["Toll owed", -2, true],
    ["Lantern Fair", 3, false],
    ["Leap feast", 61, false],
  ],
);
assert.deepEqual(upcoming[2]!.date, date(2024, 1, 29), "a leap-day festival lands on the leap day in leap years");
assert.deepEqual(
  upcomingCalendarEvents(leapGreg, events, date(2024, 2, 1)).find((item) => item.event.id === "Leap feast")?.date,
  date(2025, 1, 28),
  "and on the month's last day otherwise",
);
assert.equal(upcomingCalendarEvents(leapGreg, events, today, { limit: 1 }).length, 1);
assert.deepEqual(
  eventsOnDate(leapGreg, events, date(2031, 0, 2)).map((item) => item.id),
  ["Lantern Fair"],
);
assert.deepEqual(eventsOnDate(leapGreg, events, date(2019, 0, 2)), [], "yearly events start in their own year");

// ── Moons ──
const moonCal = {
  ...custom,
  moons: [{ name: "Pale", cycleDays: 28, newMoonDay: newMoonDayFor(custom, date(88, 0, 1), 0) }],
};
assert.equal(moonStates(moonCal, date(88, 0, 1))[0]!.phase, "new");
assert.equal(moonStates(moonCal, date(88, 0, 15))[0]!.phase, "full");
assert.equal(moonStates(moonCal, date(88, 0, 8))[0]!.phase, "firstQuarter");
assert.equal(moonStates(moonCal, addCalendarDays(moonCal, date(88, 0, 1), -7))[0]!.phase, "lastQuarter");

// ── Stored state, the prompt line and the HUD widget bridge ──
const stored = sanitizeGameCalendarState({
  enabled: true,
  config: leapGreg,
  events: [
    ...events,
    { id: "Toll owed", title: "Second toll", date: date(2024, 0, 5), kind: "deadline" },
    { title: "" },
  ],
});
assert.equal(stored.events.length, events.length + 1);
assert.equal(new Set(stored.events.map((item) => item.id)).size, stored.events.length, "duplicate ids are renamed");
assert.equal(readGameCalendar({ gameCalendar: { ...stored, enabled: false } }), null);
assert.equal(readGameCalendar({}), null);
assert.ok(readGameCalendar({ gameCalendar: stored }));

const state: GameCalendarState = stored;
assert.equal(
  describeCalendarForPrompt(state, 1),
  "Saturday, 30 December 2023 (upcoming: deadline Toll owed overdue by 2 days; Lantern Fair in 3 days; deadline Second toll in 6 days)",
);
assert.equal(describeCalendarForPrompt({ ...state, events: [] }, 3), "Monday, 1 January 2024");

// ── The GM prompt's Time value: unchanged without a calendar, calendar date line with one ──
const snap = { date: "the third day of the thaw", time: "Day 3, 14:00 (afternoon)" };
assert.equal(composeGameTimeLine(snap, {}), "the third day of the thaw, Day 3, 14:00 (afternoon)");
assert.equal(composeGameTimeLine({ date: null, time: "Day 3, 14:00 (afternoon)" }, {}), "Day 3, 14:00 (afternoon)");
assert.equal(composeGameTimeLine({ date: null, time: null }, {}), undefined);
assert.equal(
  composeGameTimeLine({ date: null, time: "Day 5, 08:00 (morning)" }, { gameTime: { day: 3, hour: 14, minute: 0 } }),
  "Day 3, 14:00 (afternoon)",
  "a valid metadata clock overrides a stale snapshot clock",
);
assert.equal(
  composeGameTimeLine(null, { gameTime: { day: 3, hour: 14, minute: 0 } }),
  "Day 3, 14:00 (afternoon)",
  "a valid metadata clock is sufficient without a snapshot",
);
assert.equal(
  composeGameTimeLine(snap, { gameTime: { day: "invalid" } }),
  "the third day of the thaw, Day 3, 14:00 (afternoon)",
  "an invalid metadata clock falls back to the legacy snapshot",
);
assert.equal(
  composeGameTimeLine(snap, { gameTime: { day: 4, hour: 0, minute: 7 } }),
  "Day 4, 00:07 (midnight)",
  "midnight uses the metadata clock",
);
assert.equal(
  composeGameTimeLine(snap, { gameCalendar: { ...state, enabled: false }, gameTime: { day: 3 } }),
  "Day 3, 08:00 (morning)",
  "a valid metadata clock remains authoritative when the calendar is switched off",
);
assert.equal(
  composeGameTimeLine(snap, { gameCalendar: { ...state, events: [] }, gameTime: { day: 3, hour: 14, minute: 0 } }),
  "Monday, 1 January 2024, Day 3, 14:00 (afternoon)",
);
assert.equal(
  composeGameTimeLine(
    { date: null, time: "Day 5, 08:00 (morning)" },
    { gameCalendar: { ...state, events: [] }, gameTime: { day: 3, hour: 14, minute: 0 } },
  ),
  "Monday, 1 January 2024, Day 3, 14:00 (afternoon)",
  "calendar date and clock both come from metadata when the clock is valid",
);
assert.equal(composeGameTimeLine(null, { gameCalendar: { ...state, events: [] } }), "Saturday, 30 December 2023");

// ── Setup editor text lists ──
assert.deepEqual(parseMonthsText("Seedfall | 30\n\n  Emberwane 28 \nLong Night\nYear | End | 5"), [
  { name: "Seedfall", days: 30 },
  { name: "Emberwane", days: 28 },
  { name: "Long Night", days: 30 },
  { name: "Year | End", days: 5 },
]);
assert.equal(monthsToText(custom).split("\n")[0], "Thawing | 40");
assert.deepEqual(parseMonthsText(monthsToText(custom)), custom.months, "months round trip through text");
assert.deepEqual(parseWeekdaysText("Oneday, Twoday\nRestday\n ,"), ["Oneday", "Twoday", "Restday"]);

// ── Review fixes: huge clock days, hostile metadata, overdue deadlines in widget entries ──
{
  const tiny = sanitizeGameCalendarState({
    enabled: true,
    config: { months: [{ name: "Only", days: 1 }], weekdays: ["Oneday"] },
    events: [{ id: "fest", title: "Fest", date: { year: 1, month: 0, day: 1 }, yearly: true }],
  });
  // A 1-day year makes the year equal the clock day; a clock day past 2^53 used to spin nextOccurrence forever.
  const line = composeGameTimeLine(null, { gameCalendar: tiny, gameTime: { day: 1e300 } });
  assert.equal(typeof line, "string");
  assert.equal(
    line,
    "Oneday, 1 Only 1000000000 (upcoming: Fest today), Day 1000000000, 08:00 (morning)",
    "the clock day is clamped, not looped on",
  );
  const hostile = {
    get gameCalendar(): unknown {
      throw new Error("bad metadata");
    },
  };
  assert.equal(composeGameTimeLine(snap, hostile), "the third day of the thaw, Day 3, 14:00 (afternoon)");
}

console.log("game calendar math regression passed");
