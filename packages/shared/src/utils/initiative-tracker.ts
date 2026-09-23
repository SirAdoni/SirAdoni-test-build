// ──────────────────────────────────────────────
// Game: initiative and encounter tracker (pure half)
//
// Turn order for the Tools tab's initiative tracker: who acts, in what order,
// in which round. Nothing here rolls dice or touches storage; the server rolls
// and logs, the client renders, and every state change goes through these
// functions so the order rules are testable on their own. Every function
// returns a new state and never mutates its input.
// ──────────────────────────────────────────────

import { parseDiceNotation } from "./dice-notation.js";

export type InitiativeCombatantSource = "character" | "lorebook" | "custom";

export interface InitiativeCombatant {
  id: string;
  name: string;
  source: InitiativeCombatantSource;
  /** Character or lorebook entry id when the combatant came from one. */
  sourceId: string | null;
  /** Initiative dice, such as "d20+2". */
  dice: string;
  /** Rolled or typed initiative; null until one is set. */
  initiative: number | null;
  /** Free text such as "12/20". */
  hp: string;
  /** Conditions and notes, free text. */
  notes: string;
}

export interface InitiativeEncounterState {
  /** 1-based round counter. */
  round: number;
  /** Index into `combatants` of whoever acts now. */
  turn: number;
  combatants: InitiativeCombatant[];
}

export const MAX_INITIATIVE_COMBATANTS = 100;
export const MAX_INITIATIVE_NAME = 120;
export const MAX_INITIATIVE_FIELD = 500;
export const DEFAULT_INITIATIVE_DICE = "d20";

const SOURCES: readonly InitiativeCombatantSource[] = ["character", "lorebook", "custom"];

export function createInitiativeState(): InitiativeEncounterState {
  return { round: 1, turn: 0, combatants: [] };
}

/**
 * Read what a user typed as initiative dice. Empty means a plain d20, a bare
 * modifier ("+3", "-1", "2") means d20 plus that, and anything else must be NdM
 * notation. Returns null for text that is none of those.
 */
export function normalizeInitiativeDice(value: string | null | undefined): string | null {
  const text = (value ?? "").replace(/\s+/g, "").toLowerCase();
  if (!text) return DEFAULT_INITIATIVE_DICE;
  const bare = text.match(/^([+-]?)(\d{1,4})$/);
  if (bare) {
    const amount = Number.parseInt(bare[2]!, 10);
    if (amount === 0) return DEFAULT_INITIATIVE_DICE;
    return `${DEFAULT_INITIATIVE_DICE}${bare[1] === "-" ? "-" : "+"}${amount}`;
  }
  return parseDiceNotation(text) ? text : null;
}

/** The flat modifier of a combatant's dice, used to break initiative ties. */
function diceModifier(dice: string): number {
  return parseDiceNotation(dice)?.modifier ?? 0;
}

function clampTurn(state: InitiativeEncounterState): InitiativeEncounterState {
  const count = state.combatants.length;
  const turn = count === 0 ? 0 : Math.min(Math.max(0, Math.trunc(state.turn)), count - 1);
  return turn === state.turn ? state : { ...state, turn };
}

/** The combatant whose turn it is, or null for an empty encounter. */
export function currentCombatant(state: InitiativeEncounterState): InitiativeCombatant | null {
  return state.combatants[state.turn] ?? null;
}

/** The combatant who acts after the current one, wrapping into the next round. */
export function nextCombatant(state: InitiativeEncounterState): InitiativeCombatant | null {
  if (state.combatants.length < 2) return null;
  return state.combatants[(state.turn + 1) % state.combatants.length] ?? null;
}

/** Keep the current-turn marker on the same combatant after the list was rearranged. */
function followCurrent(
  previous: InitiativeEncounterState,
  combatants: InitiativeCombatant[],
): InitiativeEncounterState {
  const currentId = currentCombatant(previous)?.id;
  const index = currentId ? combatants.findIndex((combatant) => combatant.id === currentId) : -1;
  return clampTurn({ ...previous, combatants, turn: index >= 0 ? index : previous.turn });
}

/**
 * Highest initiative first. Ties go to the higher dice modifier; after that the
 * existing order stands (the sort is stable). Combatants without initiative go last.
 */
export function sortCombatantsByInitiative(combatants: readonly InitiativeCombatant[]): InitiativeCombatant[] {
  return combatants
    .map((combatant, index) => ({ combatant, index }))
    .sort((left, right) => {
      const a = left.combatant.initiative;
      const b = right.combatant.initiative;
      if (a === null && b === null) return left.index - right.index;
      if (a === null) return 1;
      if (b === null) return -1;
      return (
        b - a || diceModifier(right.combatant.dice) - diceModifier(left.combatant.dice) || left.index - right.index
      );
    })
    .map((entry) => entry.combatant);
}

/**
 * Apply rolled or typed initiative totals and sort. `restart` begins the fight
 * over at round 1 with the top of the order; without it the current combatant
 * keeps the turn (a late arrival rolling in mid-fight).
 */
export function applyInitiatives(
  state: InitiativeEncounterState,
  totals: Readonly<Record<string, number>>,
  options: { restart?: boolean } = {},
): InitiativeEncounterState {
  const combatants = sortCombatantsByInitiative(
    state.combatants.map((combatant) => {
      const total = totals[combatant.id];
      return typeof total === "number" && Number.isFinite(total)
        ? { ...combatant, initiative: Math.trunc(total) }
        : combatant;
    }),
  );
  if (options.restart) return { round: 1, turn: 0, combatants };
  return followCurrent(state, combatants);
}

/** Next turn; past the last combatant the round counter goes up and the order starts over. */
export function advanceTurn(state: InitiativeEncounterState): InitiativeEncounterState {
  const count = state.combatants.length;
  if (count === 0) return state;
  const turn = state.turn + 1;
  if (turn >= count) return { ...state, turn: 0, round: state.round + 1 };
  return { ...state, turn };
}

/** Step back one turn, into the previous round when needed. Round 1's first turn is the floor. */
export function previousTurn(state: InitiativeEncounterState): InitiativeEncounterState {
  const count = state.combatants.length;
  if (count === 0) return state;
  if (state.turn > 0) return { ...state, turn: state.turn - 1 };
  if (state.round <= 1) return state;
  return { ...state, turn: count - 1, round: state.round - 1 };
}

/** Make a name unique in the encounter: a second "Goblin" becomes "Goblin 2". */
export function uniqueCombatantName(combatants: readonly InitiativeCombatant[], name: string): string {
  const base = cleanText(name, MAX_INITIATIVE_NAME) || "?";
  const taken = new Set(combatants.map((combatant) => combatant.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base} ${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return base;
}

/**
 * Add a combatant. One with initiative goes into its place in the order (after
 * anyone it ties with); one without goes to the end. The current turn stays put.
 */
export function addCombatant(
  state: InitiativeEncounterState,
  combatant: InitiativeCombatant,
): InitiativeEncounterState {
  if (state.combatants.length >= MAX_INITIATIVE_COMBATANTS) return state;
  const added = { ...combatant, name: uniqueCombatantName(state.combatants, combatant.name) };
  const combatants = [...state.combatants];
  let index = combatants.length;
  if (added.initiative !== null) {
    const before = combatants.findIndex(
      (other) => other.initiative === null || other.initiative < (added.initiative as number),
    );
    if (before >= 0) index = before;
  }
  combatants.splice(index, 0, added);
  return followCurrent(state, combatants);
}

/** Change a combatant's details. Initiative edits do not re-sort; use applyInitiatives for that. */
export function updateCombatant(
  state: InitiativeEncounterState,
  id: string,
  patch: Partial<Omit<InitiativeCombatant, "id">>,
): InitiativeEncounterState {
  let changed = false;
  const combatants = state.combatants.map((combatant) => {
    if (combatant.id !== id) return combatant;
    changed = true;
    return { ...combatant, ...patch, id };
  });
  return changed ? { ...state, combatants } : state;
}

/**
 * Remove a combatant. Removing whoever acts now hands the turn to the next one;
 * removing the last in the order on their turn ends the round.
 */
export function removeCombatant(state: InitiativeEncounterState, id: string): InitiativeEncounterState {
  const index = state.combatants.findIndex((combatant) => combatant.id === id);
  if (index < 0) return state;
  const combatants = state.combatants.filter((combatant) => combatant.id !== id);
  if (combatants.length === 0) return { ...state, turn: 0, combatants };
  if (index < state.turn) return { ...state, combatants, turn: state.turn - 1 };
  if (index === state.turn && state.turn >= combatants.length) {
    return { ...state, combatants, turn: 0, round: state.round + 1 };
  }
  return { ...state, combatants };
}

/** Move a combatant up (-1) or down (+1) one place. The turn marker stays with whoever had it. */
export function moveCombatant(state: InitiativeEncounterState, id: string, delta: -1 | 1): InitiativeEncounterState {
  const index = state.combatants.findIndex((combatant) => combatant.id === id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= state.combatants.length) return state;
  const combatants = [...state.combatants];
  [combatants[index], combatants[target]] = [combatants[target]!, combatants[index]!];
  return followCurrent(state, combatants);
}

/**
 * Delay: the combatant gives up their place and acts right after the next one
 * in the order. When it is their turn, the next combatant acts now. The last in
 * the order has no one after them this round, so a delay there does nothing.
 */
export function delayCombatant(state: InitiativeEncounterState, id: string): InitiativeEncounterState {
  const index = state.combatants.findIndex((combatant) => combatant.id === id);
  if (index < 0 || index >= state.combatants.length - 1) return state;
  const combatants = [...state.combatants];
  [combatants[index], combatants[index + 1]] = [combatants[index + 1]!, combatants[index]!];
  if (index === state.turn) return { ...state, combatants };
  return followCurrent(state, combatants);
}

function combatantDetail(combatant: InitiativeCombatant): string {
  const parts: string[] = [];
  if (combatant.hp.trim()) parts.push(`HP ${combatant.hp.trim()}`);
  if (combatant.notes.trim()) parts.push(combatant.notes.trim());
  return parts.length > 0 ? ` (${parts.join("; ")})` : "";
}

/**
 * A one-line turn summary for the chat input, such as
 * "Round 2: Tamsin's turn (HP 12/20; poisoned). Next: Goblin." Empty when no one is in the fight.
 */
export function formatInitiativeTurnSummary(state: InitiativeEncounterState): string {
  const current = currentCombatant(state);
  if (!current) return "";
  const next = nextCombatant(state);
  const line = `Round ${state.round}: ${current.name}'s turn${combatantDetail(current)}.`;
  return next ? `${line} Next: ${next.name}.` : line;
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function cleanCombatant(raw: unknown, seen: Set<string>): InitiativeCombatant | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const id = cleanText(value.id, 100);
  const name = cleanText(value.name, MAX_INITIATIVE_NAME);
  if (!id || !name || seen.has(id)) return null;
  seen.add(id);
  const source = SOURCES.includes(value.source as InitiativeCombatantSource)
    ? (value.source as InitiativeCombatantSource)
    : "custom";
  const initiative =
    typeof value.initiative === "number" && Number.isFinite(value.initiative) ? Math.trunc(value.initiative) : null;
  return {
    id,
    name,
    source,
    sourceId: cleanText(value.sourceId, 200) || null,
    dice: normalizeInitiativeDice(typeof value.dice === "string" ? value.dice : "") ?? DEFAULT_INITIATIVE_DICE,
    initiative,
    hp: cleanText(value.hp, 60),
    notes: cleanText(value.notes, MAX_INITIATIVE_FIELD),
  };
}

/** Whether two encounter states hold the same fight once both are cleaned the way storage cleans them. */
export function sameInitiativeState(left: unknown, right: unknown): boolean {
  return JSON.stringify(sanitizeInitiativeState(left)) === JSON.stringify(sanitizeInitiativeState(right));
}

/** Read a stored or posted encounter state, dropping anything malformed. Never throws. */
export function sanitizeInitiativeState(raw: unknown): InitiativeEncounterState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return createInitiativeState();
  const value = raw as Record<string, unknown>;
  const seen = new Set<string>();
  const combatants = (Array.isArray(value.combatants) ? value.combatants : [])
    .slice(0, MAX_INITIATIVE_COMBATANTS)
    .map((combatant) => cleanCombatant(combatant, seen))
    .filter((combatant): combatant is InitiativeCombatant => combatant !== null);
  const round =
    typeof value.round === "number" && Number.isFinite(value.round)
      ? Math.min(Math.max(1, Math.trunc(value.round)), 99999)
      : 1;
  const turn = typeof value.turn === "number" && Number.isFinite(value.turn) ? Math.trunc(value.turn) : 0;
  return clampTurn({ round, turn, combatants });
}
