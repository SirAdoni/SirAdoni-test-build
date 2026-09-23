// ──────────────────────────────────────────────
// Random tables and the yes/no oracle (pure half)
//
// A GM's random table is a list of rows rolled either on dice ("2d6", each row
// owning a range of totals) or by weight (no dice: a row with weight 3 is three
// times as likely as a row with weight 1). A row may name another table as
// [[Other Table]] and that table is rolled in its place, recursively, up to a
// depth limit so a table that names itself cannot spin forever. [[2d6]] in a
// row rolls those dice inline when no table has that name.
//
// Every roll takes its randomness from an injected `rng`, so the same seed
// always gives the same result; the server passes Math.random, the tests a
// seeded generator.
// ──────────────────────────────────────────────

import { parseDiceNotation } from "./dice-notation.js";

export type RandomTableRng = () => number;

export interface RandomTableRow {
  /** What the row says. May contain [[Table Name]] or [[2d6]] references. */
  text: string;
  /** Inclusive range of totals, for a dice table. Omitted rows follow on from the row before. */
  min?: number | null;
  max?: number | null;
  /** Relative weight, for a table without dice (and the span of a dice row without a range). Default 1. */
  weight?: number | null;
}

export interface RandomTableDefinition {
  name: string;
  /** Dice notation such as "d20" or "2d6"; null or empty rolls rows by weight. */
  dice?: string | null;
  rows: RandomTableRow[];
}

export interface ResolvedTableRow {
  index: number;
  text: string;
  min: number;
  max: number;
}

export interface ResolvedTable {
  /** The dice actually thrown: the table's own, or d<total weight> for a weighted table. */
  notation: string;
  count: number;
  sides: number;
  rows: ResolvedTableRow[];
  /** Totals no row covers, e.g. a d20 table whose rows stop at 18. */
  gaps: number[];
}

export interface TableRollResult {
  tableName: string;
  notation: string;
  /** Every die thrown for this table, in order. */
  rolls: number[];
  total: number;
  /** Index into the table's rows, or -1 when the total fell in a gap. */
  rowIndex: number;
  /** The row's text as written. */
  rowText: string;
  /** The row's text with every reference rolled out. */
  text: string;
  /** The rolls made for references inside this row, in the order they appear. */
  nested: TableRollResult[];
  /** Set when a reference was left unrolled: depth limit, unknown table or a loop guard. */
  unresolved: string[];
}

export const RANDOM_TABLE_MAX_DEPTH = 5;
export const RANDOM_TABLE_MAX_ROWS = 1000;
export const RANDOM_TABLE_MAX_NAME = 120;
export const RANDOM_TABLE_MAX_ROW_TEXT = 2000;
/** Most tables one import reads (a scope holds no more); anything past it is ignored unread. */
export const RANDOM_TABLE_MAX_IMPORT = 2000;
/** Most references one top-level roll may expand, across every level. */
const MAX_TOTAL_EXPANSIONS = 100;

const REFERENCE_PATTERN = /\[\[([^\[\]]{1,160})\]\]/g;

// ── Randomness ──

function hashSeed(seed: string): number {
  // FNV-1a, enough to spread short seeds across the 32-bit space.
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** A small deterministic generator (mulberry32) returning values in [0, 1). */
export function createSeededRng(seed: string | number): RandomTableRng {
  let state = typeof seed === "number" ? seed >>> 0 : hashSeed(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rollDie(sides: number, rng: RandomTableRng): number {
  const value = rng();
  const safe = Number.isFinite(value) && value >= 0 && value < 1 ? value : 0;
  return Math.floor(safe * sides) + 1;
}

// ── Table shape ──

export function normalizeTableName(name: string): string {
  return name.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : null;
}

function integerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

/** Dice a table may be rolled on: plain NdM, no modifier, at most 10 dice of at most 1000 faces. */
export function parseTableDice(
  dice: string | null | undefined,
): { notation: string; count: number; sides: number } | null {
  const trimmed = typeof dice === "string" ? dice.trim() : "";
  if (!trimmed) return null;
  const parsed = parseDiceNotation(trimmed);
  if (!parsed || parsed.modifier !== 0 || parsed.count > 10 || parsed.sides > 1000) return null;
  return { notation: parsed.dice, count: parsed.count, sides: parsed.sides };
}

/**
 * Give every row a concrete range of totals. A dice table uses each row's own
 * min/max; a row without one starts right after the previous row and spans its
 * weight. A weighted table becomes d<total weight> with consecutive ranges, so
 * both kinds roll through the same code.
 */
export function resolveTableRanges(table: RandomTableDefinition): ResolvedTable {
  const dice = parseTableDice(table.dice);
  const rows = table.rows.filter((row) => typeof row.text === "string" && row.text.trim().length > 0);
  const resolved: ResolvedTableRow[] = [];
  let next = dice ? dice.count : 1;
  rows.forEach((row, index) => {
    const span = positiveInteger(row.weight) ?? 1;
    const ownMin = dice ? integerOrNull(row.min) : null;
    const ownMax = dice ? integerOrNull(row.max) : null;
    let min: number;
    let max: number;
    if (ownMin === null && ownMax === null) {
      min = next;
      max = next + span - 1;
    } else {
      min = ownMin ?? ownMax!;
      max = ownMax ?? ownMin!;
      if (max < min) [min, max] = [max, min];
    }
    resolved.push({ index, text: row.text.trim(), min, max });
    next = max + 1;
  });

  if (dice) {
    const lowest = dice.count;
    const highest = dice.count * dice.sides;
    const gaps: number[] = [];
    // Only small ranges are walked for gaps; a d1000 table is not worth listing.
    if (highest - lowest <= 1000) {
      for (let total = lowest; total <= highest; total += 1) {
        if (!resolved.some((row) => total >= row.min && total <= row.max)) gaps.push(total);
      }
    }
    return { notation: dice.notation, count: dice.count, sides: dice.sides, rows: resolved, gaps };
  }

  const sides = Math.max(1, next - 1);
  return { notation: `d${sides}`, count: 1, sides, rows: resolved, gaps: resolved.length === 0 ? [1] : [] };
}

// ── Rolling ──

export type RandomTableLookup = (name: string) => RandomTableDefinition | null | undefined;

interface RollState {
  rng: RandomTableRng;
  lookup: RandomTableLookup;
  maxDepth: number;
  expansions: number;
}

function expandReferences(text: string, depth: number, stack: string[], state: RollState) {
  const nested: TableRollResult[] = [];
  const unresolved: string[] = [];
  const expanded = text.replace(REFERENCE_PATTERN, (whole, rawName: string) => {
    const name = rawName.trim();
    const table = state.lookup(name);
    if (table) {
      const key = normalizeTableName(table.name);
      if (depth >= state.maxDepth || state.expansions >= MAX_TOTAL_EXPANSIONS || stack.includes(key)) {
        unresolved.push(name);
        return name;
      }
      state.expansions += 1;
      const result = rollTableAt(table, depth + 1, [...stack, key], state);
      nested.push(result);
      return result.text;
    }
    const dice = parseDiceNotation(name);
    if (dice && dice.count <= 100 && dice.sides <= 1000) {
      let sum = dice.modifier;
      for (let index = 0; index < dice.count; index += 1) sum += rollDie(dice.sides, state.rng);
      return String(sum);
    }
    unresolved.push(name);
    return whole;
  });
  return { expanded, nested, unresolved };
}

function rollTableAt(table: RandomTableDefinition, depth: number, stack: string[], state: RollState): TableRollResult {
  const resolved = resolveTableRanges(table);
  const rolls: number[] = [];
  for (let index = 0; index < resolved.count; index += 1) rolls.push(rollDie(resolved.sides, state.rng));
  const total = rolls.reduce((sum, roll) => sum + roll, 0);
  const row = resolved.rows.find((candidate) => total >= candidate.min && total <= candidate.max) ?? null;
  if (!row) {
    return {
      tableName: table.name,
      notation: resolved.notation,
      rolls,
      total,
      rowIndex: -1,
      rowText: "",
      text: "",
      nested: [],
      unresolved: [],
    };
  }
  const { expanded, nested, unresolved } = expandReferences(row.text, depth, stack, state);
  return {
    tableName: table.name,
    notation: resolved.notation,
    rolls,
    total,
    rowIndex: row.index,
    rowText: row.text,
    text: expanded,
    nested,
    unresolved,
  };
}

/** Roll a table, rolling any [[references]] in the chosen row through `lookup`. */
export function rollRandomTable(
  table: RandomTableDefinition,
  options: { rng: RandomTableRng; lookup?: RandomTableLookup; maxDepth?: number },
): TableRollResult {
  const state: RollState = {
    rng: options.rng,
    lookup: options.lookup ?? (() => null),
    maxDepth: Math.max(0, Math.min(options.maxDepth ?? RANDOM_TABLE_MAX_DEPTH, RANDOM_TABLE_MAX_DEPTH)),
    expansions: 0,
  };
  return rollTableAt(table, 0, [normalizeTableName(table.name)], state);
}

/** A case- and space-insensitive lookup over a set of tables; the first of a duplicated name wins. */
export function createTableLookup(tables: readonly RandomTableDefinition[]): RandomTableLookup {
  const byName = new Map<string, RandomTableDefinition>();
  for (const table of tables) {
    const key = normalizeTableName(table.name);
    if (key && !byName.has(key)) byName.set(key, table);
  }
  return (name) => byName.get(normalizeTableName(name)) ?? null;
}

/** The table names a table's rows refer to, for showing links and spotting missing tables. */
export function listTableReferences(table: RandomTableDefinition): string[] {
  const names = new Set<string>();
  for (const row of table.rows) {
    for (const match of row.text.matchAll(REFERENCE_PATTERN)) {
      const name = match[1]!.trim();
      if (!parseDiceNotation(name)) names.add(name);
    }
  }
  return [...names];
}

/** One line for a chat note: "Encounters (2d6: 7): Bandits on the road". */
export function formatTableRollLine(result: TableRollResult): string {
  const text = result.rowIndex < 0 ? "(no row for this total)" : result.text;
  return `${result.tableName} (${result.notation}: ${result.total}): ${text}`;
}

// ── Plain-list paste ──

const LIST_LINE_PATTERN = /^(\d{1,4})(?:\s*(?:-|–|—|to)\s*(\d{1,4}))?\s*(?:[:.)|]\s*|\s+)(.+)$/i;
const BULLET_PATTERN = /^\s*(?:[-*•]\s+)/;
// Matched on a trimmed line. The lookbehind keeps this linear: a leading `\s+` would
// rescan every whitespace run from each of its positions, and the editor parses on
// every keystroke.
const WEIGHT_SUFFIX_PATTERN = /(?<=\s)\((?:x|w|weight\s*)(\d{1,4})\)$/i;

/**
 * Turn pasted text into rows, one per non-empty line. A line may start with a
 * total or a range ("1-3: Bandits", "4. Wolves", "05-10 Rain") and may end in
 * a weight "(x3)". When every line has a range the dice are inferred from the
 * covered span (1-20 is d20, 2-12 is 2d6); otherwise the rows roll by weight.
 */
export function parsePlainTableList(text: string): { rows: RandomTableRow[]; dice: string | null } {
  const parsed: Array<{ line: string; text: string; weight: number | null; min: number | null; max: number | null }> =
    [];
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.replace(BULLET_PATTERN, "").trim();
    if (!line) continue;
    let weight: number | null = null;
    const weightMatch = line.match(WEIGHT_SUFFIX_PATTERN);
    if (weightMatch) {
      weight = positiveInteger(Number(weightMatch[1]));
      line = line.slice(0, weightMatch.index).trim();
    }
    const match = line.match(LIST_LINE_PATTERN);
    if (match && match[3]!.trim()) {
      const first = Number(match[1]);
      const second = match[2] ? Number(match[2]) : first;
      parsed.push({ line, text: match[3]!.trim(), weight, min: Math.min(first, second), max: Math.max(first, second) });
    } else {
      parsed.push({ line, text: line, weight, min: null, max: null });
    }
    if (parsed.length >= RANDOM_TABLE_MAX_ROWS) break;
  }

  const clip = (value: string) => value.slice(0, RANDOM_TABLE_MAX_ROW_TEXT);
  if (parsed.length === 0 || parsed.some((row) => row.min === null)) {
    // Unranged or mixed: roll by weight. A leading number on a mixed list is part of the
    // text ("3 goblins"), so those lines keep what was written.
    return {
      rows: parsed.map((row) => ({
        text: clip(row.line),
        ...(row.weight && row.weight !== 1 ? { weight: row.weight } : {}),
      })),
      dice: null,
    };
  }
  const lowest = Math.min(...parsed.map((row) => row.min!));
  const highest = Math.max(...parsed.map((row) => row.max!));
  const dice = inferDiceForSpan(lowest, highest);
  return {
    // Each row keeps its range for the dice, and its span as a weight, so ranges that fit
    // no plain dice (5-10) still roll in proportion without them.
    rows: parsed.map((row) => {
      const span = row.max! - row.min! + 1;
      return { text: clip(row.text), min: row.min, max: row.max, ...(span !== 1 ? { weight: span } : {}) };
    }),
    dice,
  };
}

/** The editor's text form of a table's rows, which parsePlainTableList reads back. */
export function formatPlainTableList(rows: readonly RandomTableRow[]): string {
  return rows
    .map((row) => {
      const min = integerOrNull(row.min);
      const max = integerOrNull(row.max);
      if (min !== null) return `${max !== null && max !== min ? `${min}-${max}` : min}: ${row.text}`;
      const weight = positiveInteger(row.weight);
      return weight && weight !== 1 ? `${row.text} (x${weight})` : row.text;
    })
    .join("\n");
}

/** The plain NdM whose totals run exactly lowest..highest, if any (1-20 → d20, 2-12 → 2d6, 3-18 → 3d6). */
export function inferDiceForSpan(lowest: number, highest: number): string | null {
  if (lowest < 1 || highest < lowest || lowest > 10) return null;
  const count = lowest;
  if (highest % count !== 0) return null;
  const sides = highest / count;
  if (sides < 2 || sides > 1000) return null;
  return count === 1 ? `d${sides}` : `${count}d${sides}`;
}

// ── Import / export ──

export interface RandomTableExport {
  format: "marinara-random-tables";
  version: 1;
  tables: Array<{ name: string; dice: string | null; description?: string; rows: RandomTableRow[] }>;
}

function cleanRow(value: unknown): RandomTableRow | null {
  if (typeof value === "string") {
    const text = value.trim().slice(0, RANDOM_TABLE_MAX_ROW_TEXT);
    return text ? { text } : null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const raw = typeof record.text === "string" ? record.text : typeof record.result === "string" ? record.result : "";
  const text = raw.trim().slice(0, RANDOM_TABLE_MAX_ROW_TEXT);
  if (!text) return null;
  const row: RandomTableRow = { text };
  const min = integerOrNull(record.min);
  const max = integerOrNull(record.max);
  const weight = positiveInteger(record.weight);
  if (min !== null) row.min = min;
  if (max !== null) row.max = max;
  if (weight !== null && weight !== 1) row.weight = Math.min(weight, 10_000);
  return row;
}

/** Validate and trim one table from untrusted JSON. Returns null when there is nothing usable. */
export function sanitizeRandomTable(
  value: unknown,
): { name: string; dice: string | null; description: string; rows: RandomTableRow[] } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const name =
    typeof record.name === "string" ? record.name.replace(/\s+/g, " ").trim().slice(0, RANDOM_TABLE_MAX_NAME) : "";
  if (!name) return null;
  const rawRows = Array.isArray(record.rows) ? record.rows : Array.isArray(record.entries) ? record.entries : [];
  const rows = rawRows
    .slice(0, RANDOM_TABLE_MAX_ROWS)
    .map(cleanRow)
    .filter((row): row is RandomTableRow => row !== null);
  const dice = parseTableDice(typeof record.dice === "string" ? record.dice : null)?.notation ?? null;
  const description = typeof record.description === "string" ? record.description.trim().slice(0, 1000) : "";
  return { name, dice, description, rows };
}

/** Read an export file, a bare array of tables or a single table. */
export function parseRandomTableImport(json: unknown) {
  const list = Array.isArray(json)
    ? json
    : json && typeof json === "object" && Array.isArray((json as { tables?: unknown }).tables)
      ? (json as { tables: unknown[] }).tables
      : [json];
  return list
    .slice(0, RANDOM_TABLE_MAX_IMPORT)
    .map(sanitizeRandomTable)
    .filter((table): table is NonNullable<typeof table> => table !== null);
}

export function buildRandomTableExport(
  tables: ReadonlyArray<{ name: string; dice: string | null; description?: string; rows: RandomTableRow[] }>,
): RandomTableExport {
  return {
    format: "marinara-random-tables",
    version: 1,
    tables: tables.map((table) => ({
      name: table.name,
      dice: table.dice,
      ...(table.description ? { description: table.description } : {}),
      rows: table.rows,
    })),
  };
}

// ── Lorebook source ──

export interface LorebookTableSourceEntry {
  name: string;
  folderId: string | null;
  tag: string;
  enabled: boolean;
}

/**
 * Rows for a table built from lorebook entries: every entry in the chosen folders
 * (the caller expands subfolders) and/or with the chosen tag, one row per
 * distinct entry name, sorted by name so a rebuild gives the same table.
 */
export function buildLorebookTableRows(
  entries: readonly LorebookTableSourceEntry[],
  filter: { folderIds?: readonly string[] | null; tag?: string | null; includeDisabled?: boolean },
): RandomTableRow[] {
  const folderIds = filter.folderIds ? new Set(filter.folderIds) : null;
  const tag = filter.tag?.trim().toLocaleLowerCase() || null;
  const names = new Map<string, string>();
  for (const entry of entries) {
    if (!filter.includeDisabled && !entry.enabled) continue;
    if (folderIds && !folderIds.has(entry.folderId ?? "")) continue;
    if (tag && entry.tag.trim().toLocaleLowerCase() !== tag) continue;
    const name = entry.name.replace(/\s+/g, " ").trim().slice(0, RANDOM_TABLE_MAX_ROW_TEXT);
    if (!name) continue;
    const key = name.toLocaleLowerCase();
    if (!names.has(key)) names.set(key, name);
  }
  return [...names.values()]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, RANDOM_TABLE_MAX_ROWS)
    .map((text) => ({ text }));
}

// ── Oracle ──

export type OracleLikelihood = "certain" | "likely" | "even" | "unlikely" | "impossible";
export type OracleOutcome = "yes_and" | "yes" | "yes_but" | "no_but" | "no" | "no_and";

export const ORACLE_LIKELIHOODS: readonly OracleLikelihood[] = ["certain", "likely", "even", "unlikely", "impossible"];

/** Chance of a yes on d100 for each likelihood, a simplified Mythic fate chart. */
export const ORACLE_YES_CHANCE: Record<OracleLikelihood, number> = {
  certain: 90,
  likely: 75,
  even: 50,
  unlikely: 25,
  impossible: 10,
};

/** Rolls this close to the line on either side come with a twist ("yes, but", "no, but"). */
const ORACLE_TWIST_BAND = 5;

export interface OracleResult {
  likelihood: OracleLikelihood;
  chance: number;
  roll: number;
  outcome: OracleOutcome;
  answer: "yes" | "no";
  exceptional: boolean;
}

/** Where each outcome starts and ends on d100 for a likelihood. */
export function oracleBands(likelihood: OracleLikelihood) {
  const chance = ORACLE_YES_CHANCE[likelihood];
  // The top and bottom fifth of each side are exceptional, at least one face each.
  const exceptionalYes = Math.max(1, Math.round(chance / 5));
  const exceptionalNo = 100 - Math.max(1, Math.round((100 - chance) / 5)) + 1;
  return { chance, exceptionalYes, exceptionalNo };
}

export function resolveOracleRoll(likelihood: OracleLikelihood, roll: number): OracleResult {
  const { chance, exceptionalYes, exceptionalNo } = oracleBands(likelihood);
  let outcome: OracleOutcome;
  if (roll <= exceptionalYes) outcome = "yes_and";
  else if (roll <= chance) outcome = roll > chance - ORACLE_TWIST_BAND ? "yes_but" : "yes";
  else if (roll >= exceptionalNo) outcome = "no_and";
  else outcome = roll <= chance + ORACLE_TWIST_BAND ? "no_but" : "no";
  return {
    likelihood,
    chance,
    roll,
    outcome,
    answer: roll <= chance ? "yes" : "no",
    exceptional: outcome === "yes_and" || outcome === "no_and",
  };
}

export function rollOracle(likelihood: OracleLikelihood, rng: RandomTableRng): OracleResult {
  return resolveOracleRoll(likelihood, rollDie(100, rng));
}

export const ORACLE_OUTCOME_TEXT: Record<OracleOutcome, string> = {
  yes_and: "Yes, and",
  yes: "Yes",
  yes_but: "Yes, but",
  no_but: "No, but",
  no: "No",
  no_and: "No, and",
};

export function formatOracleLine(result: OracleResult, question?: string | null): string {
  const asked = question?.replace(/\s+/g, " ").trim();
  const prefix = asked ? `${asked} ` : "";
  return `${prefix}Oracle (${result.likelihood}, d100: ${result.roll}): ${ORACLE_OUTCOME_TEXT[result.outcome]}`;
}
