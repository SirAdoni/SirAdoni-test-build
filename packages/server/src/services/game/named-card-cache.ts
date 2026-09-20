import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../../lib/logger.js";
import { DATA_DIR } from "../../utils/data-dir.js";

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
}

export interface NamedCardLayout {
  /** Rendered into the cached reference blocks, exactly as stored. */
  stable: NamedCard[];
  /** Rendered into the uncached per-turn section: new people and newer text for cached ones. */
  updates: NamedCard[];
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
  limits: { foldCount?: number; foldChars?: number } = {},
): NamedCardLayout {
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
export async function layoutNamedCards(chatId: string, current: readonly NamedCard[]): Promise<NamedCardLayout> {
  const layout = planNamedCardLayout(await readNamedCardSnapshot(chatId), current);
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
