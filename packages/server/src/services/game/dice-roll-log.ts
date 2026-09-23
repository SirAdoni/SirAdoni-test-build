// ──────────────────────────────────────────────
// Game: dice roll history (pure half)
//
// Turns the Engine's roll results into log entries and summarizes a set of
// logged rolls for the Dice Log panel. No storage here, so the arithmetic is
// testable on its own; game-dice-rolls.storage.ts does the reading and writing.
// ──────────────────────────────────────────────

import { parseDiceNotation, type DiceRollResult, type SkillCheckResult } from "@marinara-engine/shared";

/**
 * "table" is a roll on a random table or the oracle, made from the Tools tab;
 * "initiative" is a roll from the Tools tab's initiative tracker.
 */
export type DiceRollLogSource = "player" | "gm" | "skill_check" | "table" | "initiative";

export interface DiceRollLogEntry {
  source: DiceRollLogSource;
  actor: string | null;
  label: string | null;
  notation: string;
  rolls: number[];
  modifier: number;
  total: number;
  critical: boolean;
  fumble: boolean;
}

export interface DiceRollLogRecord extends DiceRollLogEntry {
  id: string;
  chatId: string;
  gameId: string;
  messageId: string | null;
  createdAt: string;
}

export interface DiceFaceStats {
  sides: number;
  /** Dice of this size thrown across every logged roll. */
  dice: number;
  /** Mean face shown, and the fair-die expectation (sides + 1) / 2. */
  average: number;
  expected: number;
  /** counts[i] is how often face i + 1 came up. */
  counts: number[];
}

export interface DiceRollStats {
  rolls: number;
  dice: number;
  /** Mean total against the mean of what each roll's notation expected. Null when no roll could be priced. */
  averageTotal: number | null;
  expectedTotal: number | null;
  natural20s: number;
  natural1s: number;
  criticals: number;
  fumbles: number;
  /** One entry per die size seen, most thrown first. */
  bySides: DiceFaceStats[];
}

const MAX_TRACKED_SIDES = 100;
const MAX_LABEL = 200;

function finiteInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed.slice(0, MAX_LABEL) : null;
}

/** Faces per die for a notation, or null when it is not plain NdM. */
export function diceSidesForNotation(notation: string): number | null {
  const parsed = parseDiceNotation(notation);
  return parsed ? parsed.sides : null;
}

/** A single d20 is the only throw where a natural 20 or 1 means anything by itself. */
function singleD20Flags(notation: string, rolls: readonly number[]) {
  const parsed = parseDiceNotation(notation);
  if (!parsed || parsed.sides !== 20 || rolls.length !== 1) return { critical: false, fumble: false };
  return { critical: rolls[0] === 20, fumble: rolls[0] === 1 };
}

/** A tray or GM roll as a log entry. Returns null for anything that is not a real result. */
export function diceResultLogEntry(
  result: DiceRollResult,
  source: Exclude<DiceRollLogSource, "skill_check">,
  label?: string | null,
): DiceRollLogEntry | null {
  const notation = cleanText(result?.notation);
  const total = finiteInteger(result?.total);
  if (!notation || total === null || !Array.isArray(result.rolls)) return null;
  const rolls = result.rolls.map(finiteInteger).filter((roll): roll is number => roll !== null);
  if (rolls.length === 0) return null;
  return {
    source,
    actor: null,
    label: cleanText(label),
    notation,
    rolls,
    modifier: finiteInteger(result.modifier) ?? 0,
    total,
    ...singleD20Flags(notation, rolls),
  };
}

/** A skill check as a log entry: the check's own crit flags win over the single-d20 rule. */
export function skillCheckLogEntry(result: SkillCheckResult): DiceRollLogEntry | null {
  const total = finiteInteger(result?.total);
  if (total === null || !Array.isArray(result.rolls)) return null;
  const rolls = result.rolls.map(finiteInteger).filter((roll): roll is number => roll !== null);
  if (rolls.length === 0) return null;
  const skill = cleanText(result.skill);
  const dc = finiteInteger(result.dc);
  return {
    source: "skill_check",
    actor: cleanText(result.who),
    label: skill ? (dc !== null ? `${skill} (DC ${dc})` : skill) : null,
    notation: cleanText(result.dice) ?? "1d20",
    rolls,
    modifier: finiteInteger(result.modifier) ?? 0,
    total,
    critical: result.criticalSuccess === true,
    fumble: result.criticalFailure === true,
  };
}

/**
 * The log entries for one Game Master turn: every roll the turn saved, plus its checks.
 * A check that adopted one of the turn's own roll results (a declared check citing a
 * roll_dice call) shares that result's rolls array, so the roll is logged once, as the
 * check, rather than twice. Never throws: the turn it belongs to is already decided.
 */
export function gmTurnDiceLogEntries(
  diceRolls: readonly DiceRollResult[],
  checks: readonly SkillCheckResult[],
): DiceRollLogEntry[] {
  try {
    const adopted = new Set<unknown>(checks.map((check) => check?.rolls));
    return [
      ...diceRolls.filter((roll) => !adopted.has(roll?.rolls)).map((roll) => diceResultLogEntry(roll, "gm")),
      ...checks.map(skillCheckLogEntry),
    ].filter((entry): entry is DiceRollLogEntry => entry !== null);
  } catch {
    return [];
  }
}

function expectedTotalFor(record: Pick<DiceRollLogEntry, "notation" | "modifier" | "source">): number | null {
  // A skill check's total is the kept die plus modifiers, or a success count, so a
  // notation sum would price it wrongly. Only plain sums are compared.
  if (record.source === "skill_check") return null;
  const parsed = parseDiceNotation(record.notation);
  if (!parsed) return null;
  return (parsed.count * (parsed.sides + 1)) / 2 + record.modifier;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Aggregate a set of logged rolls for the Dice Log panel. */
export function summarizeDiceRolls(records: readonly DiceRollLogEntry[]): DiceRollStats {
  const faces = new Map<number, number[]>();
  let dice = 0;
  let natural20s = 0;
  let natural1s = 0;
  let criticals = 0;
  let fumbles = 0;
  let pricedCount = 0;
  let pricedTotal = 0;
  let pricedExpected = 0;

  for (const record of records) {
    if (record.critical) criticals += 1;
    if (record.fumble) fumbles += 1;
    const expected = expectedTotalFor(record);
    if (expected !== null) {
      pricedCount += 1;
      pricedTotal += record.total;
      pricedExpected += expected;
    }
    const sides = diceSidesForNotation(record.notation);
    for (const roll of record.rolls) {
      dice += 1;
      if (sides === null || sides < 2 || sides > MAX_TRACKED_SIDES || roll < 1 || roll > sides) continue;
      let counts = faces.get(sides);
      if (!counts) {
        counts = new Array<number>(sides).fill(0);
        faces.set(sides, counts);
      }
      counts[roll - 1]! += 1;
      if (sides === 20) {
        if (roll === 20) natural20s += 1;
        if (roll === 1) natural1s += 1;
      }
    }
  }

  const bySides = [...faces.entries()]
    .map(([sides, counts]): DiceFaceStats => {
      const thrown = counts.reduce((sum, count) => sum + count, 0);
      const sum = counts.reduce((acc, count, index) => acc + count * (index + 1), 0);
      return {
        sides,
        dice: thrown,
        average: thrown ? round(sum / thrown) : 0,
        expected: round((sides + 1) / 2),
        counts,
      };
    })
    .sort((left, right) => right.dice - left.dice || left.sides - right.sides);

  return {
    rolls: records.length,
    dice,
    averageTotal: pricedCount ? round(pricedTotal / pricedCount) : null,
    expectedTotal: pricedCount ? round(pricedExpected / pricedCount) : null,
    natural20s,
    natural1s,
    criticals,
    fumbles,
    bySides,
  };
}
