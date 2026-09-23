import type { HudWidget, HudWidgetConfig, HudWidgetType, WidgetUpdate } from "../types/game.js";

/**
 * Extended HUD widgets (checklist, schedule, note, clock, pips, countdown, tug_of_war, tier_track, stages, tags,
 * ledger, log, rumor_board, obligations, turn_order, scoreboard, bars, charges, calendar).
 *
 * One pure implementation shared by live playback (client store), branch restoration (server), the GM prompt summary
 * and the manual editors, so a command means the same thing everywhere. Every type reuses the existing [widget:]
 * keys (add, remove, check, uncheck, text, value, max, stat), so the tag syntax did not grow.
 */

export const EXTENDED_HUD_WIDGET_TYPES = [
  "checklist",
  "schedule",
  "note",
  "clock",
  "pips",
  "countdown",
  "tug_of_war",
  "tier_track",
  "stages",
  "tags",
  "ledger",
  "log",
  "rumor_board",
  "obligations",
  "turn_order",
  "scoreboard",
  "bars",
  "charges",
  "calendar",
] as const satisfies readonly HudWidgetType[];
export type ExtendedHudWidgetType = (typeof EXTENDED_HUD_WIDGET_TYPES)[number];

export const CHECKLIST_MAX_TASKS = 12;
export const SCHEDULE_MAX_ENTRIES = 10;
export const NOTE_MAX_CHARS = 600;
const ITEM_MAX_CHARS = 200;
const NAME_MAX_CHARS = 60;
const LEVELS_MAX = 10;
const TAGS_MAX = 10;
const LOG_MAX = 6;
const LEDGER_MAX = 6;
const RUMORS_MAX = 8;
const TURN_ORDER_MAX = 12;
const ROWS_MAX = 8;

type RumorStatus = "unverified" | "confirmed" | "false";
type Meter = { name: string; value: number; max: number };
type DatedEntry = { when: string; text: string };

export function isExtendedHudWidgetType(type: unknown): type is ExtendedHudWidgetType {
  return (EXTENDED_HUD_WIDGET_TYPES as readonly unknown[]).includes(type);
}

const clip = (value: string, max: number) => (value.length > max ? value.slice(0, max).trimEnd() : value);
const clean = (value: unknown, max: number) => clip(String(value ?? "").trim(), max);
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Number from a number or a wholly numeric string ("3", "-2", "+1.5"); otherwise null. */
function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !/^\s*[+-]?\d+(?:\.\d+)?\s*$/.test(value)) return null;
  return Number(value);
}

const intOr = (value: unknown, fallback: number) => Math.round(num(value) ?? fallback);

/** Leading number of a value ("120 gold" -> 120, 3 -> 3); null when it does not start with one. */
export function leadingWidgetNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * How a raw [widget: id, value: ...] string becomes WidgetUpdate.value. Shared by the live tag parser and branch
 * restoration so both see the same input: a wholly numeric value becomes a number, anything else ("3rd Legion",
 * "next", "120 gold") stays text. Numeric widgets read a leading number from text themselves (leadingWidgetNumber).
 */
export function coerceWidgetValue(raw: string): number | string {
  const text = raw.trim();
  return num(text) ?? text;
}

/** Matching key: case, accents, punctuation and spacing do not matter. */
export function normalizeWidgetText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Index of the entry whose text equals `target` after normalization. Symbol-only text normalizes to nothing, so it
 * is compared raw. This is the duplicate check: "Goblin" and "Goblin Archer" are different entries.
 */
function findExact<T>(entries: readonly T[], target: string, textOf: (entry: T) => string): number {
  const key = normalizeWidgetText(target);
  if (key) return entries.findIndex((entry) => normalizeWidgetText(textOf(entry)) === key);
  const raw = target.trim();
  return raw ? entries.findIndex((entry) => textOf(entry).trim() === raw) : -1;
}

/**
 * Target lookup for remove / check / uncheck / stat / cursor moves: an exact match, else the single entry that
 * starts with `target` ("rusk" finds "Rusk sold the keys"). Never used to decide whether something is a duplicate,
 * and a longer target never resolves to a shorter entry.
 */
function findEntry<T>(entries: readonly T[], target: string, textOf: (entry: T) => string): number {
  const exact = findExact(entries, target, textOf);
  const key = normalizeWidgetText(target);
  if (exact >= 0 || !key) return exact;
  const prefixed = entries
    .map((entry, index) => ({ index, text: normalizeWidgetText(textOf(entry)) }))
    .filter((entry) => entry.text.startsWith(key));
  return prefixed.length === 1 ? prefixed[0]!.index : -1;
}

/** Unique, trimmed strings; over the cap keep the first entries (ordered lists) or the last (rolling sets). */
function uniqueStrings(values: unknown, max: number, cap: number, keep: "first" | "last" = "last"): string[] {
  const out: string[] = [];
  for (const raw of Array.isArray(values) ? values : []) {
    const value = clean(raw, max);
    if (value && findExact(out, value, (entry) => entry) < 0) out.push(value);
  }
  return keep === "first" ? out.slice(0, cap) : out.slice(-cap);
}

/**
 * Ordered list with a cursor (tier_track, stages, turn_order). The cursor follows the entry it pointed at when
 * duplicates are dropped or the list is capped, instead of staying on the same position.
 */
function normalizeCursorList(source: unknown, current: unknown, cap: number) {
  const raw = Array.isArray(source) ? source : [];
  const index = intOr(current, 0);
  const items = uniqueStrings(raw, NAME_MAX_CHARS, cap, "first");
  const marked = index >= 0 && index < raw.length ? clean(raw[index], NAME_MAX_CHARS) : "";
  const found = marked ? findExact(items, marked, (item) => item) : -1;
  return { items, current: found >= 0 ? found : clamp(index, 0, Math.max(0, items.length - 1)) };
}

/** "Day 21", "day 3 dusk", "D21" -> 21; otherwise null. */
export function scheduleDayOf(when: string): number | null {
  const match = /\bd(?:ay)?\s*(\d{1,5})\b/i.exec(when);
  return match ? Number(match[1]) : null;
}

/** Split "when | what"; without a separator the whole text is the entry. */
export function parseScheduleEntry(raw: string): DatedEntry | null {
  const value = raw.trim();
  if (!value) return null;
  const pipe = value.indexOf("|");
  if (pipe >= 0) {
    const when = value.slice(0, pipe).trim();
    const text = value.slice(pipe + 1).trim();
    return text ? { when: clip(when, 60), text: clip(text, ITEM_MAX_CHARS) } : null;
  }
  return { when: "", text: clip(value, ITEM_MAX_CHARS) };
}

function sortSchedule(entries: DatedEntry[]) {
  // Stable: entries without a day keep their place after all dated entries.
  return entries
    .map((entry, index) => ({ entry, index, day: scheduleDayOf(entry.when) }))
    .sort((a, b) => {
      if (a.day !== null && b.day !== null && a.day !== b.day) return a.day - b.day;
      if (a.day === null && b.day !== null) return 1;
      if (a.day !== null && b.day === null) return -1;
      return a.index - b.index;
    })
    .map((item) => item.entry);
}

function normalizeDatedEntries(c: HudWidgetConfig): DatedEntry[] {
  const entries = Array.isArray(c.entries)
    ? c.entries
        .map((entry) => ({ when: clean(entry?.when, 60), text: clean(entry?.text, ITEM_MAX_CHARS) }))
        .filter((entry) => entry.text)
    : Array.isArray(c.items)
      ? c.items.map((item) => parseScheduleEntry(String(item))).filter((e): e is DatedEntry => !!e)
      : [];
  return sortSchedule(entries).slice(-SCHEDULE_MAX_ENTRIES);
}

/** "+50 | Sold the ring", "-20 gold | Bribe", "+1,000 | Reward" -> { amount, text }; null without a leading number. */
function parseLedgerEntry(raw: string): { amount: number; text: string } | null {
  const [head = "", ...rest] = raw.split("|");
  // "1,000" and "1,000,000" are thousands; "1,5" is a decimal comma.
  const match = /^\s*([+-]?\s*\d{1,3}(?:,\d{3})+(?:\.\d+)?|[+-]?\s*\d+(?:[.,]\d+)?)/.exec(head);
  if (!match) return null;
  const token = match[1]!.replace(/\s/g, "");
  const amount = Number(/,\d{3}(?:\D|$)/.test(token) ? token.replace(/,/g, "") : token.replace(",", "."));
  if (!Number.isFinite(amount)) return null;
  const text = clean(rest.length ? rest.join("|") : head.slice(match[0].length), ITEM_MAX_CHARS);
  return { amount: Math.round(amount * 100) / 100, text };
}

/** "Name | 3 / 10", "Name | 10", "Name" -> meter (value defaults to max for charges, 0 for bars). */
function parseMeter(raw: string, fullByDefault: boolean): Meter | null {
  const [head = "", tail = ""] = raw.split("|");
  const name = clean(head, NAME_MAX_CHARS);
  if (!name) return null;
  const numbers = tail.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  const max = clamp(Math.round(numbers.length >= 2 ? numbers[1]! : (numbers[0] ?? 10)), 1, 999);
  const value = numbers.length >= 2 ? numbers[0]! : fullByDefault ? max : 0;
  return { name, value: clamp(value, 0, max), max };
}

function normalizeTasks(config: HudWidgetConfig) {
  const tasks = Array.isArray(config.tasks)
    ? config.tasks.map((task) => ({ text: clean(task?.text, ITEM_MAX_CHARS), done: task?.done === true }))
    : Array.isArray(config.items)
      ? config.items.map((item) => ({ text: clean(item, ITEM_MAX_CHARS), done: false }))
      : [];
  return tasks.filter((task) => task.text).slice(-CHECKLIST_MAX_TASKS);
}

function normalizeMeters(config: HudWidgetConfig): Meter[] {
  const source = Array.isArray(config.meters)
    ? config.meters
    : Array.isArray(config.stats)
      ? config.stats.map((stat) => ({ name: stat?.name, value: num(stat?.value) ?? 0, max: 10 }))
      : [];
  const meters: Meter[] = [];
  for (const raw of source) {
    const name = clean(raw?.name, NAME_MAX_CHARS);
    if (!name || findExact(meters, name, (m) => m.name) >= 0) continue;
    const max = clamp(intOr(raw?.max, 10), 1, 999);
    meters.push({ name, max, value: clamp(num(raw?.value) ?? 0, 0, max) });
  }
  return meters.slice(0, ROWS_MAX);
}

/** Coerce a stored or imported config into a valid one for the type. Missing fields get defaults. */
export function normalizeExtendedWidgetConfig(type: ExtendedHudWidgetType, config: HudWidgetConfig): HudWidgetConfig {
  const c = config ?? {};
  switch (type) {
    case "checklist":
    case "obligations":
      return { ...c, tasks: normalizeTasks(c) };
    case "schedule":
      return { ...c, entries: normalizeDatedEntries(c) };
    case "note":
      return { ...c, text: clean(c.text, NOTE_MAX_CHARS) };
    case "clock": {
      const max = clamp(intOr(c.max, 6), 2, 12);
      return { ...c, max, value: clamp(intOr(c.value, 0), 0, max) };
    }
    case "pips": {
      const max = clamp(intOr(c.max, 5), 1, 20);
      return { ...c, max, value: clamp(intOr(c.value, 0), 0, max) };
    }
    case "countdown": {
      const value = Math.max(0, intOr(c.value, 0));
      const max = num(c.max);
      return { ...c, value, max: max !== null && max >= 1 ? Math.round(max) : undefined, text: clean(c.text, 80) };
    }
    case "tug_of_war": {
      const max = clamp(intOr(c.max, 5), 1, 20);
      return { ...c, max, value: clamp(intOr(c.value, 0), -max, max), text: clean(c.text, 80) };
    }
    case "tier_track":
    case "stages": {
      const { items, current } = normalizeCursorList(c.levels ?? c.items, c.current, LEVELS_MAX);
      return { ...c, levels: items, current };
    }
    case "tags":
      return { ...c, tags: uniqueStrings(c.tags ?? c.items, 40, TAGS_MAX) };
    case "ledger": {
      const transactions = (Array.isArray(c.transactions) ? c.transactions : [])
        .map((entry) => ({ amount: num(entry?.amount) ?? 0, text: clean(entry?.text, ITEM_MAX_CHARS) }))
        .filter((entry) => entry.amount !== 0 || entry.text)
        .slice(-LEDGER_MAX);
      return { ...c, value: Math.round((num(c.value) ?? 0) * 100) / 100, text: clean(c.text, 20), transactions };
    }
    case "log":
      return {
        ...c,
        items: (Array.isArray(c.items) ? c.items : [])
          .map((i) => clean(i, ITEM_MAX_CHARS))
          .filter(Boolean)
          .slice(0, LOG_MAX),
      };
    case "rumor_board": {
      const source = Array.isArray(c.rumors)
        ? c.rumors
        : Array.isArray(c.items)
          ? c.items.map((text) => ({ text, status: "unverified" as const }))
          : [];
      const rumors = source
        .map((rumor) => ({
          text: clean(rumor?.text, ITEM_MAX_CHARS),
          status: (["confirmed", "false"].includes(rumor?.status as string)
            ? rumor.status
            : "unverified") as RumorStatus,
        }))
        .filter((rumor) => rumor.text)
        .slice(-RUMORS_MAX);
      return { ...c, rumors };
    }
    case "turn_order": {
      const { items, current } = normalizeCursorList(c.items, c.current, TURN_ORDER_MAX);
      return { ...c, items, current };
    }
    case "scoreboard": {
      const stats: Array<{ name: string; value: number }> = [];
      for (const stat of Array.isArray(c.stats) ? c.stats : []) {
        const name = clean(stat?.name, NAME_MAX_CHARS);
        if (name && findExact(stats, name, (s) => s.name) < 0) stats.push({ name, value: num(stat?.value) ?? 0 });
      }
      return { ...c, stats: stats.slice(0, ROWS_MAX) };
    }
    case "bars":
    case "charges":
      return { ...c, meters: normalizeMeters(c) };
    case "calendar":
      return {
        ...c,
        value: Math.max(1, intOr(c.value, 1)),
        max: clamp(intOr(c.max, 7), 3, 12),
        text: clean(c.text, 60),
        entries: normalizeDatedEntries(c),
      };
  }
}

/** Upcoming calendar events: dated entries from today on (by day number), then undated ones. */
export function calendarUpcoming(config: HudWidgetConfig): Array<DatedEntry & { inDays: number | null }> {
  const today = Math.max(1, intOr(config.value, 1));
  return (config.entries ?? [])
    .map((entry) => {
      const day = scheduleDayOf(entry.when);
      return { ...entry, inDays: day === null ? null : day - today };
    })
    .filter((entry) => entry.inDays === null || entry.inDays >= 0);
}

/** Initial config for a newly created extended widget. */
export function defaultExtendedWidgetConfig(type: ExtendedHudWidgetType): HudWidgetConfig {
  return normalizeExtendedWidgetConfig(type, {});
}

/** Move an index by a word ("next"/"up" +1, "back"/"previous"/"down" -1); null when the word is not a step. */
function stepOf(word: string): number | null {
  const key = normalizeWidgetText(word);
  if (["next", "up", "advance", "forward", "raise"].includes(key)) return 1;
  if (["back", "previous", "prev", "down", "lower"].includes(key)) return -1;
  return null;
}

function applyTaskUpdate(tasks: Array<{ text: string; done: boolean }>, changes: WidgetUpdate["changes"]) {
  const next = [...tasks];
  if (changes.remove) {
    const index = findEntry(next, changes.remove, (task) => task.text);
    if (index >= 0) next.splice(index, 1);
  }
  if (changes.add) {
    const text = clean(changes.add, ITEM_MAX_CHARS);
    if (text && findExact(next, text, (task) => task.text) < 0) next.push({ text, done: false });
  }
  for (const [target, done] of [
    [changes.check, true],
    [changes.uncheck, false],
  ] as const) {
    if (!target) continue;
    const index = findEntry(next, target, (task) => task.text);
    if (index >= 0) next[index] = { ...next[index]!, done };
    else if (done) next.push({ text: clean(target, ITEM_MAX_CHARS), done: true });
  }
  // Over the cap, finished tasks leave first, then the oldest.
  while (next.length > CHECKLIST_MAX_TASKS) {
    const finished = next.findIndex((task) => task.done);
    next.splice(finished >= 0 ? finished : 0, 1);
  }
  return next;
}

/** Remove a named entry from an ordered list and keep `current` pointing at the same entry. */
function removeWithCursor(items: string[], current: number, target: string) {
  const index = findEntry(items, target, (item) => item);
  if (index < 0) return { items, current };
  const next = items.filter((_, i) => i !== index);
  return { items: next, current: clamp(index < current ? current - 1 : current, 0, Math.max(0, next.length - 1)) };
}

/** Point `current` at a level/name, a 1-based number, or a step word; unknown names are appended (up to `cap`). */
function moveCursor(items: string[], current: number, value: number | string | undefined, wrap: boolean, cap: number) {
  if (value === undefined || value === "") return { items, current };
  const n = num(value);
  if (n !== null) return { items, current: clamp(Math.round(n) - 1, 0, Math.max(0, items.length - 1)) };
  const text = String(value);
  const step = stepOf(text);
  if (step !== null) {
    if (!items.length) return { items, current };
    const moved = current + step;
    return { items, current: wrap ? (moved + items.length) % items.length : clamp(moved, 0, items.length - 1) };
  }
  const index = findEntry(items, text, (item) => item);
  if (index >= 0) return { items, current: index };
  const name = clean(text, NAME_MAX_CHARS);
  if (!name || items.length >= cap) return { items, current };
  const next = [...items, name];
  return { items: next, current: next.length - 1 };
}

/** Apply one non-lifecycle [widget:] update to an extended widget. Other widgets pass through. */
export function applyExtendedWidgetUpdate(widget: HudWidget, changes: WidgetUpdate["changes"]): HudWidget {
  if (!isExtendedHudWidgetType(widget.type)) return widget;
  const type = widget.type;
  const config = normalizeExtendedWidgetConfig(type, widget.config ?? {});
  const value = changes.value;
  const n = num(value);
  const amount = leadingWidgetNumber(value);
  const done = (next: HudWidgetConfig) => ({ ...widget, config: normalizeExtendedWidgetConfig(type, next) });

  switch (type) {
    case "checklist":
    case "obligations":
      return done({ ...config, tasks: applyTaskUpdate(config.tasks ?? [], changes) });

    case "calendar":
    case "schedule": {
      const entries = [...(config.entries ?? [])];
      if (changes.remove) {
        const index = findEntry(entries, changes.remove, (entry) => entry.text);
        const byFull =
          index >= 0 ? index : findEntry(entries, changes.remove, (entry) => `${entry.when} ${entry.text}`);
        if (byFull >= 0) entries.splice(byFull, 1);
      }
      let added: DatedEntry | null = null;
      if (changes.add) {
        added = parseScheduleEntry(changes.add);
        if (added) {
          const existing = findExact(entries, added.text, (item) => item.text);
          if (existing >= 0) entries[existing] = added;
          else entries.push(added);
        }
      }
      // Over the cap the earliest entry leaves first (for a calendar, most likely past), but never the one just added.
      const sorted = sortSchedule(entries);
      while (sorted.length > SCHEDULE_MAX_ENTRIES)
        sorted.splice(
          sorted.findIndex((entry) => entry !== added),
          1,
        );
      const next: HudWidgetConfig = { ...config, entries: sorted };
      if (type === "calendar") {
        // Today: a day number or next/back.
        const step = typeof value === "string" ? stepOf(value) : null;
        if (n !== null) next.value = n;
        else if (step !== null) next.value = (config.value ?? 1) + step;
        if (typeof changes.max === "number" && Number.isFinite(changes.max)) next.max = changes.max;
        if (typeof changes.text === "string") next.text = changes.text;
      }
      return done(next);
    }

    case "note":
      return typeof changes.text === "string" ? done({ ...config, text: changes.text }) : { ...widget, config };

    case "clock":
    case "pips":
    case "countdown":
    case "tug_of_war": {
      const next = { ...config };
      if (typeof changes.max === "number" && Number.isFinite(changes.max)) next.max = changes.max;
      if (amount !== null) next.value = amount;
      if (typeof changes.text === "string" && (type === "countdown" || type === "tug_of_war")) next.text = changes.text;
      return done(next);
    }

    case "tier_track":
    case "stages": {
      let items = [...(config.levels ?? [])];
      let current = config.current ?? 0;
      if (changes.remove) ({ items, current } = removeWithCursor(items, current, changes.remove));
      if (changes.add) {
        const level = clean(changes.add, NAME_MAX_CHARS);
        if (level && items.length < LEVELS_MAX && findExact(items, level, (item) => item) < 0) items.push(level);
      }
      ({ items, current } = moveCursor(items, current, value, false, LEVELS_MAX));
      return done({ ...config, levels: items, current });
    }

    case "tags": {
      let tags = [...(config.tags ?? [])];
      if (changes.remove) {
        const index = findEntry(tags, changes.remove, (tag) => tag);
        if (index >= 0) tags.splice(index, 1);
      }
      if (changes.add) {
        const tag = clean(changes.add, 40);
        if (tag && findExact(tags, tag, (item) => item) < 0) tags = [...tags, tag].slice(-TAGS_MAX);
      }
      return done({ ...config, tags });
    }

    case "ledger": {
      const transactions = [...(config.transactions ?? [])];
      let balance = config.value ?? 0;
      const next = { ...config };
      if (typeof changes.text === "string") next.text = changes.text;
      if (amount !== null) balance = amount;
      if (changes.remove) {
        const index = findEntry(transactions, changes.remove, (entry) => entry.text);
        if (index >= 0) balance -= transactions.splice(index, 1)[0]!.amount;
      }
      if (changes.add) {
        const entry = parseLedgerEntry(changes.add);
        if (entry) {
          balance += entry.amount;
          transactions.push(entry);
        }
      }
      return done({ ...next, value: balance, transactions: transactions.slice(-LEDGER_MAX) });
    }

    case "log": {
      let items = [...(config.items ?? [])];
      if (changes.remove) {
        const index = findEntry(items, changes.remove, (item) => item);
        if (index >= 0) items.splice(index, 1);
      }
      if (changes.add) {
        const text = clean(changes.add, ITEM_MAX_CHARS);
        const existing = findExact(items, text, (item) => item);
        if (text) items = [text, ...items.filter((_, i) => i !== existing)].slice(0, LOG_MAX);
      }
      return done({ ...config, items });
    }

    case "rumor_board": {
      const rumors = [...(config.rumors ?? [])];
      if (changes.remove) {
        const index = findEntry(rumors, changes.remove, (rumor) => rumor.text);
        if (index >= 0) rumors.splice(index, 1);
      }
      const upsert = (raw: string | undefined, status: RumorStatus, overwrite: boolean) => {
        if (!raw) return;
        // add asks "is this rumor already here" (exact); check/uncheck target an existing rumor (prefix allowed).
        const index = overwrite
          ? findEntry(rumors, raw, (rumor) => rumor.text)
          : findExact(rumors, raw, (rumor) => rumor.text);
        if (index >= 0) {
          if (overwrite) rumors[index] = { ...rumors[index]!, status };
        } else {
          const text = clean(raw, ITEM_MAX_CHARS);
          if (text) rumors.push({ text, status });
        }
      };
      upsert(changes.add, "unverified", false);
      upsert(changes.check, "confirmed", true);
      upsert(changes.uncheck, "false", true);
      // Over the cap, settled rumors leave first, then the oldest.
      while (rumors.length > RUMORS_MAX) {
        const settled = rumors.findIndex((rumor) => rumor.status !== "unverified");
        rumors.splice(settled >= 0 ? settled : 0, 1);
      }
      return done({ ...config, rumors });
    }

    case "turn_order": {
      let items = [...(config.items ?? [])];
      let current = config.current ?? 0;
      if (changes.remove) ({ items, current } = removeWithCursor(items, current, changes.remove));
      if (changes.add) {
        const name = clean(changes.add, NAME_MAX_CHARS);
        if (name && items.length < TURN_ORDER_MAX && findExact(items, name, (item) => item) < 0) items.push(name);
      }
      ({ items, current } = moveCursor(items, current, value, true, TURN_ORDER_MAX));
      return done({ ...config, items, current });
    }

    case "scoreboard": {
      const stats = [...((config.stats ?? []) as Array<{ name: string; value: number }>)];
      if (changes.remove) {
        const index = findEntry(stats, changes.remove, (stat) => stat.name);
        if (index >= 0) stats.splice(index, 1);
      }
      const name = changes.statName ?? changes.add;
      if (name) {
        const index = changes.statName
          ? findEntry(stats, name, (stat) => stat.name)
          : findExact(stats, name, (stat) => stat.name);
        if (index >= 0) {
          if (amount !== null) stats[index] = { ...stats[index]!, value: amount };
        } else if (stats.length < ROWS_MAX) {
          stats.push({ name: clean(name, NAME_MAX_CHARS), value: amount ?? 0 });
        }
      }
      return done({ ...config, stats });
    }

    case "bars":
    case "charges": {
      const meters = [...(config.meters ?? [])];
      if (changes.remove) {
        const index = findEntry(meters, changes.remove, (meter) => meter.name);
        if (index >= 0) meters.splice(index, 1);
      }
      if (changes.add) {
        const meter = parseMeter(changes.add, type === "charges");
        if (meter) {
          const index = findExact(meters, meter.name, (m) => m.name);
          if (index >= 0) meters[index] = { ...meters[index]!, max: meter.max, value: meter.value };
          else if (meters.length < ROWS_MAX) meters.push(meter);
        }
      }
      if (changes.statName) {
        const index = findEntry(meters, changes.statName, (meter) => meter.name);
        const max = typeof changes.max === "number" && Number.isFinite(changes.max) ? changes.max : undefined;
        if (index >= 0) {
          meters[index] = {
            ...meters[index]!,
            ...(max !== undefined ? { max } : {}),
            ...(amount !== null ? { value: amount } : {}),
          };
        } else if (amount !== null && meters.length < ROWS_MAX) {
          meters.push({
            name: clean(changes.statName, NAME_MAX_CHARS),
            value: amount,
            max: max ?? Math.max(1, amount),
          });
        }
      }
      return done({ ...config, meters });
    }
  }
}

/** Create-time fields (value, max, text) applied on top of the defaults. */
export function createExtendedWidgetConfig(
  type: ExtendedHudWidgetType,
  changes: WidgetUpdate["changes"],
): HudWidgetConfig {
  const stub: HudWidget = {
    id: "_",
    type,
    label: "_",
    position: "hud_left",
    config: defaultExtendedWidgetConfig(type),
  };
  const numeric = ["clock", "pips", "countdown", "tug_of_war", "ledger", "calendar"].includes(type);
  return applyExtendedWidgetUpdate(stub, {
    ...(numeric && changes.max !== undefined ? { max: changes.max } : {}),
    ...(numeric && changes.value !== undefined ? { value: changes.value } : {}),
    ...(typeof changes.text === "string" ? { text: changes.text } : {}),
  }).config;
}

const signed = (amount: number) => (amount > 0 ? `+${amount}` : String(amount));
const sides = (text: string | undefined) => {
  const [left = "", right = ""] = (text ?? "").split("|").map((part) => part.trim());
  return { left, right };
};
const datedLine = (entry: DatedEntry) => (entry.when ? `${entry.when} | ${entry.text}` : entry.text);
// Editor lines keep the separator when undated text itself contains "|", so it reads back unchanged.
const datedEditorLine = (entry: DatedEntry) =>
  entry.when || entry.text.includes("|") ? `${entry.when} | ${entry.text}` : entry.text;

/** One-line summary for the GM prompt. */
export function describeExtendedWidgetForPrompt(widget: HudWidget): string | null {
  if (!isExtendedHudWidgetType(widget.type)) return null;
  const c = normalizeExtendedWidgetConfig(widget.type, widget.config ?? {});
  const list = (parts: string[]) => (parts.length ? parts.join("; ") : "(empty)");
  switch (widget.type) {
    case "checklist":
    case "obligations":
      return list((c.tasks ?? []).map((task) => `[${task.done ? "x" : " "}] ${task.text}`));
    case "schedule":
      return list((c.entries ?? []).map(datedLine));
    case "note":
      return c.text ? `"${c.text}"` : "(empty)";
    case "clock":
      return `${c.value}/${c.max} segments filled`;
    case "pips":
      return `${c.value}/${c.max}`;
    case "countdown":
      return `${c.value}${c.max ? `/${c.max}` : ""}${c.text ? ` ${c.text}` : ""} remaining`;
    case "tug_of_war": {
      const { left, right } = sides(c.text);
      return `${signed(c.value ?? 0)} on -${c.max}..+${c.max}${left || right ? ` (- ${left || "left"}, + ${right || "right"})` : ""}`;
    }
    case "tier_track":
    case "stages":
    case "turn_order": {
      const items = (widget.type === "turn_order" ? c.items : c.levels) ?? [];
      return list(items.map((item, i) => (i === c.current ? `[${item}]` : item)));
    }
    case "tags":
      return list(c.tags ?? []);
    case "ledger": {
      const recent = (c.transactions ?? []).map(
        (entry) => `${signed(entry.amount)}${entry.text ? ` ${entry.text}` : ""}`,
      );
      return `balance ${c.value}${c.text ? ` ${c.text}` : ""}${recent.length ? `; recent: ${recent.join(", ")}` : ""}`;
    }
    case "log":
      return list(c.items ?? []);
    case "rumor_board":
      return list((c.rumors ?? []).map((rumor) => `[${rumor.status}] ${rumor.text}`));
    case "scoreboard":
      return list((c.stats ?? []).map((stat) => `${stat.name}=${stat.value}`));
    case "bars":
    case "charges":
      return list((c.meters ?? []).map((meter) => `${meter.name} ${meter.value}/${meter.max}`));
    case "calendar": {
      const events = (c.entries ?? []).map(datedLine);
      return `today Day ${c.value}${c.text ? ` (${c.text})` : ""}, ${c.max}-day weeks${events.length ? `; events: ${events.join("; ")}` : ""}`;
    }
  }
}

/** Format shown under each manual editor (syntax, not prose). */
export const EXTENDED_WIDGET_TEXT_FORMAT: Record<ExtendedHudWidgetType, string> = {
  checklist: "[x] Done task / [ ] Open task",
  schedule: "Day 21, dusk | Event",
  note: "",
  clock: "3 / 6",
  pips: "2 / 5",
  countdown: "3 / 10 | days left",
  tug_of_war: "-2 / 5 | Left side | Right side",
  tier_track: "Level (one per line; > marks the current one)",
  stages: "Stage (one per line; > marks the current one)",
  tags: "Tag (one per line)",
  ledger: "120 gold (first line), then +50 | Reason",
  log: "Event (one per line, newest first)",
  rumor_board: "[?] Unverified / [x] Confirmed / [-] False",
  obligations: "[ ] Party owes Rusk | 200 gold / [x] Settled",
  turn_order: "Name (one per line; > marks the current one)",
  scoreboard: "Side | 3",
  bars: "Name | 3 / 10",
  charges: "Name | 2 / 4",
  calendar: "18 / 7 | Date label (today / days per week), then Day 21 | Event",
};

const CURSOR_MARK = /^>\s*/;

/** Text codec for the manual editors: one line per entry; numeric widgets use a single "value / max" line. */
export function extendedWidgetConfigToText(type: ExtendedHudWidgetType, config: HudWidgetConfig): string {
  const c = normalizeExtendedWidgetConfig(type, config);
  const lines = (parts: string[]) => parts.join("\n");
  switch (type) {
    case "checklist":
    case "obligations":
      return lines((c.tasks ?? []).map((task) => `${task.done ? "[x]" : "[ ]"} ${task.text}`));
    case "schedule":
      return lines((c.entries ?? []).map(datedEditorLine));
    case "note":
      return c.text ?? "";
    case "clock":
    case "pips":
      return `${c.value} / ${c.max}`;
    case "countdown":
      return `${c.value}${c.max ? ` / ${c.max}` : ""}${c.text ? ` | ${c.text}` : ""}`;
    case "tug_of_war":
      return `${c.value} / ${c.max}${c.text ? ` | ${c.text}` : ""}`;
    case "tier_track":
    case "stages":
    case "turn_order": {
      const items = (type === "turn_order" ? c.items : c.levels) ?? [];
      return lines(items.map((item, i) => (i === c.current ? `> ${item}` : item)));
    }
    case "tags":
      return lines(c.tags ?? []);
    case "ledger":
      return lines([
        `${c.value}${c.text ? ` ${c.text}` : ""}`,
        ...(c.transactions ?? []).map((entry) => `${signed(entry.amount)}${entry.text ? ` | ${entry.text}` : ""}`),
      ]);
    case "log":
      return lines(c.items ?? []);
    case "rumor_board":
      return lines(
        (c.rumors ?? []).map(
          (rumor) => `${rumor.status === "confirmed" ? "[x]" : rumor.status === "false" ? "[-]" : "[?]"} ${rumor.text}`,
        ),
      );
    case "scoreboard":
      return lines((c.stats ?? []).map((stat) => `${stat.name} | ${stat.value}`));
    case "bars":
    case "charges":
      return lines((c.meters ?? []).map((meter) => `${meter.name} | ${meter.value} / ${meter.max}`));
    case "calendar":
      return lines([`${c.value} / ${c.max}${c.text ? ` | ${c.text}` : ""}`, ...(c.entries ?? []).map(datedEditorLine)]);
  }
}

export function extendedWidgetConfigFromText(
  type: ExtendedHudWidgetType,
  text: string,
  base: HudWidgetConfig = {},
): HudWidgetConfig {
  if (type === "note") return normalizeExtendedWidgetConfig(type, { ...base, text });
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const numbers = (line: string) => line.match(/[+-]?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  const afterPipe = (line: string) => line.split("|").slice(1).join("|").trim();
  const cursorList = () => {
    const current = Math.max(
      0,
      lines.findIndex((line) => CURSOR_MARK.test(line)),
    );
    return { items: lines.map((line) => line.replace(CURSOR_MARK, "")), current };
  };
  const normalize = (next: HudWidgetConfig) => normalizeExtendedWidgetConfig(type, { ...base, ...next });
  const dated = (source: string[]) =>
    source.map((line) => parseScheduleEntry(line)).filter((e): e is DatedEntry => !!e);

  switch (type) {
    case "checklist":
    case "obligations":
      return normalize({
        tasks: lines.map((line) => {
          const match = /^\[( |x|X)\]\s*(.*)$/.exec(line);
          return match ? { text: match[2]!.trim(), done: match[1] !== " " } : { text: line, done: false };
        }),
      });
    case "schedule":
      return normalize({ entries: dated(lines) });
    case "clock":
    case "pips":
    case "countdown":
    case "tug_of_war": {
      const first = lines[0] ?? "";
      const [value, max] = numbers(first.split("|")[0] ?? "");
      // A bare "4" keeps the current size; only a countdown may drop its maximum by leaving it out.
      return normalize({ value, max: max ?? (type === "countdown" ? undefined : base.max), text: afterPipe(first) });
    }
    case "tier_track":
    case "stages": {
      const { items, current } = cursorList();
      return normalize({ levels: items, current });
    }
    case "turn_order":
      return normalize(cursorList());
    case "tags":
      return normalize({ tags: lines });
    case "log":
      return normalize({ items: lines });
    case "ledger": {
      const [head = "", ...rest] = lines;
      // Same number reader as transactions, so "1,500 gold" is 1500 gold, not 1 with ",500 gold" as the unit.
      const headEntry = parseLedgerEntry(head);
      const balance = headEntry?.amount ?? 0;
      const unit = headEntry ? headEntry.text : head.trim();
      const transactions = rest
        .map((line) => parseLedgerEntry(line))
        .filter((e): e is { amount: number; text: string } => !!e);
      return normalize({ value: balance, text: unit, transactions });
    }
    case "rumor_board":
      return normalize({
        rumors: lines.map((line) => {
          const match = /^\[(\?|x|X|-)\]\s*(.*)$/.exec(line);
          const status: RumorStatus = !match
            ? "unverified"
            : match[1] === "-"
              ? "false"
              : match[1] === "?"
                ? "unverified"
                : "confirmed";
          return { text: match ? match[2]!.trim() : line, status };
        }),
      });
    case "scoreboard":
      return normalize({
        stats: lines.map((line) => ({ name: line.split("|")[0]!.trim(), value: numbers(afterPipe(line))[0] ?? 0 })),
      });
    case "bars":
    case "charges":
      return normalize({
        meters: lines.map((line) => parseMeter(line, type === "charges")).filter((m): m is Meter => !!m),
      });
    case "calendar": {
      const [head = "", ...rest] = lines;
      const [value, max] = numbers(head.split("|")[0] ?? "");
      return normalize({ value, max: max ?? base.max, text: afterPipe(head), entries: dated(rest) });
    }
  }
}
