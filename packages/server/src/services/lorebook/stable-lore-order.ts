// ──────────────────────────────────────────────
// Lorebook: stable lore order
// Keeps selectively activated entries (keyword and semantic scans) in the same
// order from turn to turn so providers that cache by prompt prefix can reuse
// the part of the lore block that did not change.
// ──────────────────────────────────────────────
// Settings > Features "Cache-friendly prompt layout" (cacheFriendlyPromptLayout). On:
//   1. The first order is a stable key: lorebook id, then entry order, then position, then entry id.
//      Activation score and scan order never decide the order.
//   2. Every later turn keeps the entries it sent last turn in the order it sent them, removes the
//      ones that are no longer active and appends newly activated ones at the END, sorted by the
//      stable key. The block only grows at its tail, so the prefix before the first new entry is
//      byte-identical to the previous request.
//   3. An entry that a keyword, semantic or recursive match activated and that stops matching may
//      linger for a few turns (chat metadata `stableLoreLingerTurns`, default 2, 0 turns it off)
//      while it still passes every non-keyword gate (filters, game-state conditions, schedule) and
//      the lore budgets have room, so a keyword that flickers does not rewrite the block every turn.
//      Entries activated by the current location, constants, decisions or timing never linger.
//   4. An entry whose linger turns ran out is removed only on a turn whose order changes anyway.
//      Removing it from an otherwise unchanged block would make the provider re-read everything
//      after it (the whole history), so it is held instead, for at most MAX_STABLE_LORE_HELD_TURNS
//      turns and only while it still passes the same gates and budgets.
// The state is small (entry ids, linger counters, ids that may not linger), lives in chat metadata
// under `stableLoreOrder`, is keyed by the turn it was built for (regenerate and swipe of the same
// turn start from the same previous order and so send the same order) and is dropped on branch.
// Off: entries are ordered by entry order with scan order as the tie breaker, as upstream.
import type { LorebookActivationSource, LorebookEntry } from "@marinara-engine/shared";
import { isFeatureEnabled } from "../features/feature-settings.js";
import type { ActivatedEntry } from "./keyword-scanner.js";

export const STABLE_LORE_ORDER_METADATA_KEY = "stableLoreOrder";
export const STABLE_LORE_LINGER_METADATA_KEY = "stableLoreLingerTurns";
export const DEFAULT_STABLE_LORE_LINGER_TURNS = 2;
const MAX_STABLE_LORE_LINGER_TURNS = 8;
/**
 * Turns an entry whose linger ran out may still be held while the rest of the order stays the same. A held entry is
 * stored with a linger counter of -1 after its first held turn, down to -MAX_STABLE_LORE_HELD_TURNS after its last.
 */
export const MAX_STABLE_LORE_HELD_TURNS = 4;
/** Distinct scan scopes (for example one per group-chat responder) remembered per chat. */
const MAX_STABLE_LORE_SCOPES = 8;
/** Upper bound on remembered ids per scope; far above any real activation count. */
const MAX_STABLE_LORE_IDS = 1024;
/** Turn key used when the chat has no message yet. */
export const STABLE_LORE_FIRST_TURN_KEY = "start";
/** Stored state version; state written by another version reads as none. */
const STABLE_LORE_STATE_VERSION = 2;

/** The order one request sent: entry ids in order, plus linger turns left for entries kept without a match. */
export interface StableLoreOrderSnapshot {
  o: string[];
  /**
   * id -> further turns the entry may still linger after the request that wrote this. 0 or less: the linger ran
   * out and the entry is only held while the order does not change otherwise (see MAX_STABLE_LORE_HELD_TURNS).
   */
  l?: Record<string, number>;
  /** Ids in `o` that must not linger once inactive (not activated by a keyword, semantic or recursive match). */
  x?: string[];
}

export interface StableLoreOrderScopeState extends StableLoreOrderSnapshot {
  /** The turn this order was built for (id of the newest message before the reply). */
  t: string;
  /** The order this turn started from, reused by a regenerate or swipe of the same turn. */
  b: StableLoreOrderSnapshot;
  /** Write sequence, used to drop the least recently used scope. */
  n: number;
}

export interface StableLoreOrderMetadata {
  v: 2;
  n: number;
  scopes: Record<string, StableLoreOrderScopeState>;
}

/** What a caller hands processLorebooks to get a sticky order. */
export interface StableLoreOrderRequest {
  /** The raw chat metadata value under STABLE_LORE_ORDER_METADATA_KEY. */
  state: unknown;
  /** The turn this request answers; see stableLoreTurnKey. */
  turnKey: string;
  /** Which scan this is; different character scopes in one chat keep separate orders. */
  scopeKey: string;
  lingerTurns: number;
}

export function isStableLoreOrderEnabled(): boolean {
  return isFeatureEnabled("cacheFriendlyPromptLayout");
}

type StableKeyFields = Pick<LorebookEntry, "id" | "lorebookId" | "order" | "position">;

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/** Lorebook id, then entry order, then position, then entry id. Same tie breakers as the full-lore prefix. */
export function compareStableLoreKey(left: StableKeyFields, right: StableKeyFields): number {
  return (
    compareText(left.lorebookId, right.lorebookId) ||
    left.order - right.order ||
    left.position - right.position ||
    compareText(left.id, right.id)
  );
}

const LINGER_MATCH_SOURCES: ReadonlySet<LorebookActivationSource> = new Set(["keyword", "semantic", "recursive"]);
const NO_LINGER_SOURCES: ReadonlySet<LorebookActivationSource> = new Set([
  "current_location",
  "constant",
  "always_loaded",
  "decision",
]);

/**
 * Whether an entry active this turn may linger once it stops being active: only a keyword, semantic or recursive
 * match, never one the current location, a constant, always-loaded, a decision or timing alone brought in.
 */
export function mayStableLoreLinger(activation: Pick<ActivatedEntry, "activationSources">): boolean {
  const sources = activation.activationSources;
  return (
    sources.some((source) => LINGER_MATCH_SOURCES.has(source)) &&
    !sources.some((source) => NO_LINGER_SOURCES.has(source))
  );
}

/** The id of the newest message before the reply, or a fixed key for an empty chat. */
export function stableLoreTurnKey(messages: ReadonlyArray<{ id?: unknown }>): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const id = messages[index]?.id;
    if (typeof id === "string" && id) return id;
  }
  return STABLE_LORE_FIRST_TURN_KEY;
}

/** One key per character scope: the sorted character ids plus the persona. */
export function stableLoreScopeKey(characterIds: readonly string[] | undefined, personaId?: string | null): string {
  const characters = [...new Set(characterIds ?? [])].sort().join(",");
  return `${characters}|${personaId ?? ""}`;
}

export function resolveStableLoreLingerTurns(meta: Record<string, unknown>): number {
  const raw = meta[STABLE_LORE_LINGER_METADATA_KEY];
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return DEFAULT_STABLE_LORE_LINGER_TURNS;
  return Math.min(MAX_STABLE_LORE_LINGER_TURNS, Math.floor(raw));
}

function readSnapshot(value: unknown): StableLoreOrderSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { o?: unknown; l?: unknown; x?: unknown };
  if (!Array.isArray(raw.o)) return null;
  const o = [...new Set(raw.o.filter((id): id is string => typeof id === "string" && id.length > 0))].slice(
    0,
    MAX_STABLE_LORE_IDS,
  );
  const inOrder = new Set(o);
  const l: Record<string, number> = {};
  if (raw.l && typeof raw.l === "object") {
    for (const [id, turns] of Object.entries(raw.l as Record<string, unknown>)) {
      if (typeof turns === "number" && Number.isFinite(turns) && inOrder.has(id)) {
        l[id] = Math.max(-MAX_STABLE_LORE_HELD_TURNS, Math.min(MAX_STABLE_LORE_LINGER_TURNS, Math.floor(turns)));
      }
    }
  }
  const x = Array.isArray(raw.x)
    ? [...new Set(raw.x.filter((id): id is string => typeof id === "string" && inOrder.has(id)))]
    : [];
  return {
    o,
    ...(Object.keys(l).length > 0 ? { l } : {}),
    ...(x.length > 0 ? { x } : {}),
  };
}

/** Parse the stored value; anything malformed reads as no state (the next turn starts from the stable key). */
export function readStableLoreOrderMetadata(value: unknown): StableLoreOrderMetadata | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { v?: unknown; n?: unknown; scopes?: unknown };
  if (raw.v !== STABLE_LORE_STATE_VERSION || !raw.scopes || typeof raw.scopes !== "object") return null;
  const scopes: Record<string, StableLoreOrderScopeState> = {};
  for (const [key, scopeValue] of Object.entries(raw.scopes as Record<string, unknown>)) {
    if (!scopeValue || typeof scopeValue !== "object") continue;
    const scope = scopeValue as { t?: unknown; b?: unknown; n?: unknown };
    const current = readSnapshot(scopeValue);
    const base = readSnapshot(scope.b);
    if (typeof scope.t !== "string" || !current || !base) continue;
    scopes[key] = { ...current, t: scope.t, b: base, n: typeof scope.n === "number" ? scope.n : 0 };
  }
  return { v: 2, n: typeof raw.n === "number" && Number.isFinite(raw.n) ? raw.n : 0, scopes };
}

function snapshotOf(value: StableLoreOrderSnapshot): StableLoreOrderSnapshot {
  return { o: value.o, ...(value.l ? { l: value.l } : {}), ...(value.x ? { x: value.x } : {}) };
}

/**
 * The order this turn starts from. A new turn starts from what the last request sent; a regenerate or swipe of
 * the turn the state was built for starts from that turn's own starting point, so it sends the same order.
 */
export function priorStableLoreOrder(state: unknown, scopeKey: string, turnKey: string): StableLoreOrderSnapshot {
  const scope = readStableLoreOrderMetadata(state)?.scopes[scopeKey];
  if (!scope) return { o: [] };
  return snapshotOf(scope.t === turnKey ? scope.b : scope);
}

export interface StableLoreOrderResult {
  ordered: ActivatedEntry[];
  snapshot: StableLoreOrderSnapshot;
  /** Ids kept from the previous order without a match this turn (lingering or held). */
  lingered: string[];
  /** The part of `lingered` whose linger ran out, held because the order did not change otherwise. */
  held: string[];
  /** Ids appended at the end this turn. */
  appended: string[];
}

/**
 * Order the selected entries after the previous request: kept entries in their previous relative order, then
 * newly activated ones by the stable key. `lingerEntry` is asked, in previous order, for each entry that dropped
 * out, may linger and still has linger turns left; it returns the activation to keep (and books its budget) or
 * null. Entries whose linger ran out are asked last, and only when nothing else in the order changed: they stay
 * (held) only if every one of them still passes, because removing one would change the block anyway.
 */
export function orderActivatedEntriesStably(args: {
  selected: readonly ActivatedEntry[];
  prior: StableLoreOrderSnapshot;
  lingerTurns: number;
  lingerEntry?: (id: string) => ActivatedEntry | null;
}): StableLoreOrderResult {
  const selectedById = new Map(args.selected.map((activation) => [activation.entry.id, activation]));
  const priorIds = [...new Set(args.prior.o)];
  const noLinger = new Set(args.prior.x ?? []);
  const kept = new Map<string, ActivatedEntry>();
  const linger: Record<string, number> = {};
  const lingerIds = new Set<string>();
  const heldCandidates: Array<{ id: string; turnsLeft: number }> = [];
  for (const id of priorIds) {
    const active = selectedById.get(id);
    if (active) {
      kept.set(id, active);
      continue;
    }
    if (args.lingerTurns <= 0 || !args.lingerEntry || noLinger.has(id)) continue;
    // Entries that were active last turn may linger lingerTurns times; an entry already lingering uses up
    // what it has left. A lingering entry that matches again is simply active (its counter is dropped above).
    const turnsLeft = args.prior.l?.[id] ?? args.lingerTurns;
    if (turnsLeft > 0) {
      const activation = args.lingerEntry(id);
      if (!activation) continue;
      kept.set(id, activation);
      linger[id] = turnsLeft - 1;
      lingerIds.add(id);
    } else if (turnsLeft > -MAX_STABLE_LORE_HELD_TURNS) {
      heldCandidates.push({ id, turnsLeft });
    }
  }
  const appended = args.selected
    .filter((activation) => !kept.has(activation.entry.id))
    .sort((left, right) => compareStableLoreKey(left.entry, right.entry));
  const held: string[] = [];
  if (heldCandidates.length > 0 && appended.length === 0 && args.lingerEntry) {
    const candidateIds = new Set(heldCandidates.map((candidate) => candidate.id));
    // Holding only pays off when the order would otherwise be exactly last turn's.
    if (priorIds.every((id) => kept.has(id) || candidateIds.has(id))) {
      const resolved: Array<{ id: string; turnsLeft: number; activation: ActivatedEntry }> = [];
      for (const candidate of heldCandidates) {
        const activation = args.lingerEntry(candidate.id);
        if (!activation) break;
        resolved.push({ ...candidate, activation });
      }
      if (resolved.length === heldCandidates.length) {
        for (const { id, turnsLeft, activation } of resolved) {
          kept.set(id, activation);
          linger[id] = turnsLeft - 1;
          lingerIds.add(id);
          held.push(id);
        }
      }
    }
  }
  const ordered = [...priorIds.flatMap((id) => kept.get(id) ?? []), ...appended];
  const excluded = ordered
    .filter((activation) => !lingerIds.has(activation.entry.id) && !mayStableLoreLinger(activation))
    .map((activation) => activation.entry.id);
  const snapshot: StableLoreOrderSnapshot = {
    o: ordered.map((activation) => activation.entry.id).slice(0, MAX_STABLE_LORE_IDS),
    ...(Object.keys(linger).length > 0 ? { l: linger } : {}),
    ...(excluded.length > 0 ? { x: excluded } : {}),
  };
  return {
    ordered,
    snapshot,
    lingered: priorIds.filter((id) => lingerIds.has(id)),
    held,
    appended: appended.map((activation) => activation.entry.id),
  };
}

/** Stable key order with no previous request (previews, scans without a chat, first turns). */
export function sortActivatedEntriesByStableKey(selected: readonly ActivatedEntry[]): ActivatedEntry[] {
  return [...selected].sort((left, right) => compareStableLoreKey(left.entry, right.entry));
}

/** The metadata value to store after a request, merged into whatever the chat holds now. */
export function nextStableLoreOrderMetadata(
  current: unknown,
  update: { scopeKey: string; turnKey: string; prior: StableLoreOrderSnapshot; snapshot: StableLoreOrderSnapshot },
): StableLoreOrderMetadata {
  const parsed = readStableLoreOrderMetadata(current) ?? { v: 2 as const, n: 0, scopes: {} };
  const n = parsed.n + 1;
  const scopes: Record<string, StableLoreOrderScopeState> = {
    ...parsed.scopes,
    [update.scopeKey]: { ...update.snapshot, t: update.turnKey, b: update.prior, n },
  };
  const keys = Object.keys(scopes);
  if (keys.length > MAX_STABLE_LORE_SCOPES) {
    for (const key of keys
      .sort((left, right) => scopes[left]!.n - scopes[right]!.n)
      .slice(0, keys.length - MAX_STABLE_LORE_SCOPES)) {
      delete scopes[key];
    }
  }
  return { v: 2, n, scopes };
}

/**
 * Provider metadata for a keyword lore block that is its own system message and is in stable lore order. The
 * Anthropic provider puts a cache marker just before such a block (resolveStableLoreSystemBreakpoint); other
 * providers ignore it.
 */
export function stableLoreBlockMetadata(scan: {
  stableOrder?: boolean;
}): { providerMetadata: { marinaraStableLoreBlock: true } } | Record<string, never> {
  return scan.stableOrder === true ? { providerMetadata: { marinaraStableLoreBlock: true } } : {};
}
