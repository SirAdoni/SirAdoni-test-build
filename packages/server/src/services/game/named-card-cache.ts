import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../../lib/logger.js";
import { DATA_DIR } from "../../utils/data-dir.js";
import { isSubstantivelySameText } from "./card-text-similarity.js";

/**
 * Keeps the named-character cards in the GM prompt byte-stable between turns.
 *
 * The cards sit in the cached part of the prompt, ahead of the chat history, so any change to them rewrites the cache
 * for everything after (about 330,000 tokens in a long session). In play they changed constantly: Game Mode rewrites
 * its own NPC cards as scenes develop, creates cards for people named long ago (which a first-mention ordering slotted
 * into the middle), and the set shrank when someone joined the party.
 *
 * The layout here never changes the cached part on its own:
 * - Cached cards are stored with the exact text they were cached with, in the order they were added.
 * - A card is never dropped from the cached part during a session.
 * - A newly named person, or a cached card whose library text changed, goes into a small uncached section instead.
 * - Only once that section grows past a limit is it folded into the cached part, one planned rewrite instead of one per
 *   change.
 */

export const NAMED_CARD_CACHE_VERSION = 1;
/** Fold once this many cards are waiting in the uncached section. */
export const NAMED_CARD_FOLD_COUNT = 6;
/** Or once the uncached section is this long, whichever comes first. */
export const NAMED_CARD_FOLD_CHARS = 30_000;

export interface NamedCard {
  id: string;
  name: string;
  card: string;
}

export interface NamedCardSnapshot {
  version: number;
  /** Cached cards in cache order, with the text they were cached with. */
  stable: NamedCard[];
  /** Session-frozen mode only: the session the frozen cards belong to. */
  sessionKey?: string;
  /** Session-frozen mode only: characters of card changes carried in the tail, summed over turns. */
  carried?: number;
  /** Session-frozen mode only: the turn whose changes were last added to `carried`. */
  turnKey?: number;
}

/**
 * Settings > Features "Session-frozen NPC cards" (gameFreezeNpcCardsPerSession).
 * The cached cards stay as they were when the session started or the person first appeared. A later change rides in
 * the uncached section as the changed lines only, and is folded into the cached cards at the next session, or once
 * the changes carried in the tail (summed over the turns they rode there) reach the cost of re-sending everything
 * after the cards: the rent-or-buy rule the cache-stable Game layout uses.
 */
export interface NamedCardFreezeOptions {
  /** Changes when a new session starts; a change folds every waiting update in once. */
  sessionKey: string;
  /** Increases once per turn (the history length), so a preview or retry does not count a turn twice. */
  turnKey: number;
  /** Characters after the cached cards (the history and the tail) that a fold would re-send. */
  suffixChars: number;
}

/** Never fold a frozen card list for fewer carried characters than this, however short the session. */
export const NAMED_CARD_FREEZE_MIN_FOLD_CHARS = 60_000;
/** A card change longer than this share of the card is sent as the whole card instead of its changed lines. */
const NAMED_CARD_DELTA_MAX_SHARE = 0.6;
/** Long lines are compared sentence by sentence so a one-sentence edit in a paragraph costs one sentence. */
const NAMED_CARD_SENTENCE_SPLIT_CHARS = 200;

export interface NamedCardUpdate extends NamedCard {
  /** Session-frozen mode: true when `card` holds only the changed lines of a cached card. */
  delta?: boolean;
}

export interface NamedCardLayout {
  /** Rendered into the cached reference blocks, exactly as stored. */
  stable: NamedCard[];
  /** Rendered into the uncached per-turn section: new people and newer text for cached ones. */
  updates: NamedCardUpdate[];
  /** The snapshot to persist; `changed` says whether it differs from the one that was read. */
  snapshot: NamedCardSnapshot;
  changed: boolean;
  folded: boolean;
}

/**
 * Plan which cards stay cached and which ride in the uncached section this turn.
 * `current` is the live selection with current card text, in any order.
 */
export function planNamedCardLayout(
  previous: NamedCardSnapshot | null,
  current: readonly NamedCard[],
  limits: { foldCount?: number; foldChars?: number; freeze?: NamedCardFreezeOptions } = {},
): NamedCardLayout {
  if (limits.freeze) return planFrozenNamedCardLayout(previous, current, limits.freeze);
  const foldCount = limits.foldCount ?? NAMED_CARD_FOLD_COUNT;
  const foldChars = limits.foldChars ?? NAMED_CARD_FOLD_CHARS;
  const valid = previous && previous.version === NAMED_CARD_CACHE_VERSION && Array.isArray(previous.stable);

  // First turn with this layout: cache what is there now.
  if (!valid) {
    const snapshot = { version: NAMED_CARD_CACHE_VERSION, stable: current.map((card) => ({ ...card })) };
    return { stable: snapshot.stable, updates: [], snapshot, changed: true, folded: false };
  }

  const stable = previous.stable;
  const cachedById = new Map(stable.map((card) => [card.id, card]));
  const updates: NamedCard[] = [];
  for (const card of current) {
    const cached = cachedById.get(card.id);
    if (!cached || cached.card !== card.card) updates.push(card);
  }

  const updateChars = updates.reduce((sum, card) => sum + card.card.length, 0);
  if (updates.length >= foldCount || updateChars >= foldChars) {
    const updatedById = new Map(updates.map((card) => [card.id, card]));
    const folded = [
      ...stable.map((card) => updatedById.get(card.id) ?? card),
      ...updates.filter((card) => !cachedById.has(card.id)),
    ];
    const snapshot = { version: NAMED_CARD_CACHE_VERSION, stable: folded };
    return { stable: folded, updates: [], snapshot, changed: true, folded: true };
  }

  return { stable, updates, snapshot: previous, changed: false, folded: false };
}

function cardUnits(text: string): string[] {
  const units: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    if (line.length <= NAMED_CARD_SENTENCE_SPLIT_CHARS) units.push(line);
    else for (const sentence of line.split(/(?<=[.!?])\s+/u)) if (sentence.trim()) units.push(sentence);
  }
  return units;
}

/**
 * The changed lines of a cached card, or null when the change is too large to be worth it (the whole card is then
 * sent). Lines and sentences compare as a multiset, so reordering costs nothing.
 */
export function buildNamedCardDelta(name: string, cached: string, current: string): string | null {
  const count = (units: string[]) => {
    const counts = new Map<string, number>();
    for (const unit of units) counts.set(unit, (counts.get(unit) ?? 0) + 1);
    return counts;
  };
  const before = count(cardUnits(cached));
  const after = count(cardUnits(current));
  const removed: string[] = [];
  const added: string[] = [];
  for (const [unit, times] of before) for (let n = after.get(unit) ?? 0; n < times; n += 1) removed.push(unit);
  for (const [unit, times] of after) for (let n = before.get(unit) ?? 0; n < times; n += 1) added.push(unit);
  if (removed.length === 0 && added.length === 0) return null;
  const delta = [
    `Changes to the library card for ${name} since its copy above; everything else in that card is unchanged and current.`,
    ...(removed.length > 0 ? ["No longer true:", ...removed.map((unit) => `- ${unit}`)] : []),
    ...(added.length > 0 ? ["Now true:", ...added.map((unit) => `+ ${unit}`)] : []),
  ].join("\n");
  return delta.length <= current.length * NAMED_CARD_DELTA_MAX_SHARE ? delta : null;
}

function planFrozenNamedCardLayout(
  previous: NamedCardSnapshot | null,
  current: readonly NamedCard[],
  freeze: NamedCardFreezeOptions,
): NamedCardLayout {
  const valid = previous && previous.version === NAMED_CARD_CACHE_VERSION && Array.isArray(previous.stable);
  if (!valid) {
    const snapshot: NamedCardSnapshot = {
      version: NAMED_CARD_CACHE_VERSION,
      stable: current.map((card) => ({ ...card })),
      sessionKey: freeze.sessionKey,
      carried: 0,
      turnKey: freeze.turnKey,
    };
    return { stable: snapshot.stable, updates: [], snapshot, changed: true, folded: false };
  }

  const stable = previous.stable;
  const cachedById = new Map(stable.map((card) => [card.id, card]));
  const updates: NamedCardUpdate[] = [];
  const replacements = new Map<string, NamedCard>();
  for (const card of current) {
    const cached = cachedById.get(card.id);
    if (!cached) {
      updates.push(card);
      continue;
    }
    if (cached.card === card.card || isSubstantivelySameText(cached.card, card.card)) continue;
    replacements.set(card.id, card);
    const delta = buildNamedCardDelta(card.name, cached.card, card.card);
    updates.push(delta === null ? card : { ...card, card: delta, delta: true });
  }

  const foldAll = (): NamedCardLayout => {
    const folded = [
      ...stable.map((card) => replacements.get(card.id) ?? card),
      ...updates.filter((card) => !cachedById.has(card.id)).map(({ id, name, card }) => ({ id, name, card })),
    ];
    const snapshot: NamedCardSnapshot = {
      version: NAMED_CARD_CACHE_VERSION,
      stable: folded,
      sessionKey: freeze.sessionKey,
      carried: 0,
      turnKey: freeze.turnKey,
    };
    const changed = JSON.stringify(snapshot) !== JSON.stringify(previous);
    return { stable: folded, updates: [], snapshot, changed, folded: updates.length > 0 };
  };

  // A new session starts from the cards as they are now: the one planned rewrite per session.
  if (previous.sessionKey !== freeze.sessionKey) return foldAll();

  const updateChars = updates.reduce((sum, card) => sum + card.card.length, 0);
  const carriedBefore = Number.isFinite(previous.carried) ? previous.carried! : 0;
  const newTurn = previous.turnKey !== freeze.turnKey;
  const carried = newTurn ? carriedBefore + updateChars : carriedBefore;
  const threshold = Math.max(NAMED_CARD_FREEZE_MIN_FOLD_CHARS, freeze.suffixChars);
  if (updates.length > 0 && carried >= threshold) return foldAll();

  const snapshot: NamedCardSnapshot = { ...previous, carried, turnKey: freeze.turnKey };
  const changed = newTurn && JSON.stringify(snapshot) !== JSON.stringify(previous);
  return { stable, updates, snapshot: changed ? snapshot : previous, changed, folded: false };
}

function snapshotPath(chatId: string): string {
  return join(DATA_DIR, "named-card-cache", `${encodeURIComponent(chatId)}.json`);
}

export async function readNamedCardSnapshot(chatId: string): Promise<NamedCardSnapshot | null> {
  try {
    const parsed = JSON.parse(await readFile(snapshotPath(chatId), "utf8")) as NamedCardSnapshot;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeNamedCardSnapshot(chatId: string, snapshot: NamedCardSnapshot): Promise<void> {
  const path = snapshotPath(chatId);
  await mkdir(join(DATA_DIR, "named-card-cache"), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(snapshot), "utf8");
  await rename(temporary, path);
}

/** Read, plan and persist in one step. A storage failure falls back to the live cards so generation never stops. */
export async function layoutNamedCards(
  chatId: string,
  current: readonly NamedCard[],
  freeze?: NamedCardFreezeOptions,
): Promise<NamedCardLayout> {
  const layout = planNamedCardLayout(await readNamedCardSnapshot(chatId), current, freeze ? { freeze } : {});
  if (layout.changed) {
    try {
      await writeNamedCardSnapshot(chatId, layout.snapshot);
      if (layout.folded)
        logger.info(
          { chatId, cached: layout.stable.length },
          "[game/named-cards] folded waiting card updates into the cached prompt",
        );
    } catch (error) {
      logger.warn({ err: error, chatId }, "[game/named-cards] could not save the card cache snapshot");
    }
  }
  return layout;
}
