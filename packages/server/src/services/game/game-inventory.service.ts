// Saving a change to Game Mode's inventory.
//
// The stacks live in the chat's metadata, the journal beside them, and the detailed inventory on a
// game-state row. Every change (the inventory screen, the Game Master's tags, a fight spending an
// item) goes through `commitGameInventoryChange`, which works the change out once and writes all
// three inside one metadata-queue slot and one transaction, so they can never disagree.
import {
  followGameInventoryDetails,
  forgetGameInventoryTelling,
  gameInventoryForTelling,
  normalizeGameInventoryStacks,
  readGameInventoryTurn,
  rulesetItemBook,
  rulesetLayerOptionKey,
  type GameInventoryJournalEntry,
  type GameInventoryStack,
  type InventoryItem,
  type PlayerStats,
  type RulesetCatalogEntry,
  type RulesetItemBook,
} from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { logger } from "../../lib/logger.js";
import { loadRulesetCatalogEntries } from "./ruleset-catalog.service.js";
import { loadRulesetRegistry, resolveGameRuleset, type ResolvedGameRuleset } from "./ruleset-registry.service.js";
import { createChatsStorage, withChatMetadataPatchQueue } from "../storage/chats.storage.js";
import { createGameStateStorage } from "../storage/game-state.storage.js";
import { resolveVisibleGameStateAnchor } from "../../routes/generate/generate-route-utils.js";
import { addInventoryEntry, createJournal, type Journal } from "./journal.service.js";

/** What a change works out from the stacks it is given. The same stacks and nothing else leave
 *  everything as it was. */
export interface GameInventoryChange<T> {
  stacks: GameInventoryStack[];
  journal: readonly GameInventoryJournalEntry[];
  /** Other metadata that belongs with this change, saved in the same write (a turn's record). */
  metadata?: Record<string, unknown>;
  value: T;
}

/** Which game-state row carries the detailed inventory for this change. */
export type GameInventoryRowTarget =
  /** The row the player sees: the last assistant message's active swipe, else the newest row. */
  | { kind: "visible" }
  /** None yet: the caller follows it later with `followGameInventoryOnRow`, once the row it belongs
   *  to exists (a turn whose reply is not saved yet). */
  | { kind: "none" }
  /** One message's swipe, cloned from `baseSnapshot` when it has no row yet (a turn just saved). */
  | {
      kind: "message";
      messageId: string;
      swipeIndex: number;
      baseSnapshot?: Awaited<ReturnType<ReturnType<typeof createGameStateStorage>["getLatest"]>>;
    };

export interface GameInventoryCommitted<T> {
  stacks: GameInventoryStack[];
  /** The game state's stats after the change, when a row with a detailed inventory was written. */
  playerStats?: PlayerStats;
  value: T;
}

function readMetadata(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parsePlayerStats(raw: unknown): PlayerStats | null {
  if (!raw) return null;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as PlayerStats) : null;
  } catch {
    return null;
  }
}

/**
 * The items a game's ruleset lists, for a change that needs them: which names are its items, how
 * many one stack holds, and what the Game Master is shown about each. Undefined for a game with no
 * ruleset, one this install cannot honour, or one without an `items` block. `who` is whose change it
 * is: the player's typed-in items follow the ruleset's `freeform`, and the Game Master's are always
 * allowed until the native switch arrives. A catalog that cannot be read is logged and left out.
 */
export async function loadGameInventoryItemBook(
  db: DB,
  source: { chatId: string } | { metadata: Record<string, unknown>; resolved?: ResolvedGameRuleset | null },
  who: "player" | "game-master",
): Promise<RulesetItemBook | undefined> {
  let metadata: Record<string, unknown>;
  if ("chatId" in source) {
    const chat = await createChatsStorage(db).getById(source.chatId);
    if (!chat) return undefined;
    metadata = readMetadata(chat.metadata);
  } else metadata = source.metadata;
  if (metadata.gameRuleset == null) return undefined;
  const resolved =
    ("resolved" in source ? source.resolved : null) ?? resolveGameRuleset(metadata, await loadRulesetRegistry(db));
  if (resolved.status !== "ok" || !resolved.definition.items) return undefined;
  const { definition, packageId } = resolved;
  const entries: Record<string, RulesetCatalogEntry[]> = {};
  // ponytail: read on every change that needs it, like a turn's `use` catalogs. An asset catalog is
  // re-read and re-checked each time; a cache keyed by the asset's hash is the upgrade path if an
  // inventory with a large file ever feels slow.
  for (const catalog of definition.catalogs ?? []) {
    if (catalog.holds !== "items") continue;
    try {
      const read = await loadRulesetCatalogEntries(packageId, definition, catalog);
      if (read.ok) entries[catalog.id] = read.entries;
      else
        logger.warn(
          "[game/inventory] Item catalog %s of %s could not be read: %s",
          catalog.id,
          definition.id,
          read.issues.slice(0, 3).join("; "),
        );
    } catch (error) {
      logger.warn(error, "[game/inventory] Could not read item catalog %s of %s", catalog.id, definition.id);
    }
  }
  return rulesetItemBook(definition, entries, {
    layerOptions: Object.fromEntries(resolved.layers.map((layer) => [rulesetLayerOptionKey(layer.id), true])),
    plain: who === "player" && definition.items?.freeform === "refuse" ? "refuse" : "allow",
  });
}

/**
 * Work a change out on the stacks as saved and write everything it touches. `change` runs with the
 * chat's metadata queue held, so nothing else can move the stacks between the read and the write;
 * it may throw to refuse the whole change. Null when the chat does not exist.
 */
export async function commitGameInventoryChange<T>(
  db: DB,
  chatId: string,
  change: (stacks: GameInventoryStack[], metadata: Record<string, unknown>) => GameInventoryChange<T>,
  target: GameInventoryRowTarget = { kind: "visible" },
): Promise<GameInventoryCommitted<T> | null> {
  return withChatMetadataPatchQueue(chatId, () =>
    db.transaction(() => applyGameInventoryChangeHeld(db, chatId, change, target)),
  );
}

/**
 * `commitGameInventoryChange` for a caller that already holds the chat's metadata queue and runs
 * inside a transaction of its own (a fight saving its turn), so both commit or neither does.
 */
export async function applyGameInventoryChangeHeld<T>(
  db: DB,
  chatId: string,
  change: (stacks: GameInventoryStack[], metadata: Record<string, unknown>) => GameInventoryChange<T>,
  target: GameInventoryRowTarget = { kind: "visible" },
): Promise<GameInventoryCommitted<T> | null> {
  const chats = createChatsStorage(db);
  const chat = await chats.getById(chatId);
  if (!chat) return null;
  const metadata = readMetadata(chat.metadata);
  const before = normalizeGameInventoryStacks(metadata.gameInventory);
  const outcome = change(before, metadata);
  if (outcome.stacks === before && outcome.journal.length === 0 && !outcome.metadata) {
    return { stacks: before, value: outcome.value };
  }

  await chats.patchMetadata(
    chatId,
    (current) => {
      const patch: Record<string, unknown> = { ...outcome.metadata };
      if (outcome.stacks !== before) patch.gameInventory = outcome.stacks;
      if (outcome.journal.length > 0) {
        let journal = (current.gameJournal as Journal | undefined) ?? createJournal();
        for (const entry of outcome.journal) {
          journal = addInventoryEntry(journal, entry.item, entry.action, entry.quantity);
        }
        patch.gameJournal = journal;
      }
      return patch;
    },
    { metadataQueueHeld: true },
  );
  if (outcome.stacks === before || target.kind === "none") return { stacks: outcome.stacks, value: outcome.value };
  const playerStats = await followOnRow(db, chatId, before, outcome.stacks, target);
  return { stacks: outcome.stacks, ...(playerStats ? { playerStats } : {}), value: outcome.value };
}

/** The detailed inventory on one row, moved by the difference between two stack lists. Returns the
 *  stats written, or null when that row keeps no detailed inventory. Runs inside the caller's
 *  transaction. */
async function followOnRow(
  db: DB,
  chatId: string,
  before: readonly GameInventoryStack[],
  after: readonly GameInventoryStack[],
  target: Exclude<GameInventoryRowTarget, { kind: "none" }>,
): Promise<PlayerStats | null> {
  const chats = createChatsStorage(db);
  const states = createGameStateStorage(db);
  let row: Awaited<ReturnType<typeof states.getLatest>> = null;
  // Where the detailed inventory is read from: the row the stacks were at `before`. For a telling
  // just saved that is the row it started from (`baseSnapshot`), not whatever its own row was
  // cloned from, since another telling of the same turn may have left that one.
  let source: Awaited<ReturnType<typeof states.getLatest>> = null;
  if (target.kind === "message") {
    row = await states.getByChatAndMessage(chatId, target.messageId, target.swipeIndex);
    source = target.baseSnapshot ?? row;
  } else {
    // The row the in-game sheet shows, found the way the sheet and a fight find it.
    const visibleAnchor = resolveVisibleGameStateAnchor(await chats.listMessages(chatId));
    row = await states.getForGeneration(chatId, { preferLatestVisible: true, visibleAnchor });
    source = row;
  }
  const sourceStats = parsePlayerStats(source?.playerStats);
  if (!source || !sourceStats || !Array.isArray(sourceStats.inventory)) return null;
  const inventory = followGameInventoryDetails(sourceStats.inventory as InventoryItem[], before, after);
  const stats = parsePlayerStats(row?.playerStats) ?? sourceStats;
  if (row && inventory === sourceStats.inventory && JSON.stringify(stats.inventory) === JSON.stringify(inventory)) {
    return null;
  }
  const playerStats = { ...stats, inventory };
  if (target.kind === "message") {
    await states.updateByMessage(target.messageId, target.swipeIndex, chatId, { playerStats }, undefined, {
      baseSnapshot: target.baseSnapshot ?? null,
    });
  } else if (row) {
    await states.updateByMessage(row.messageId, row.swipeIndex, chatId, { playerStats });
  }
  return playerStats;
}

/**
 * The detailed inventory on a turn's own row, once that row can exist: what a turn's tags did to the
 * stacks (saved before the reply by `commitGameInventoryChange` with `{ kind: "none" }`) laid onto the
 * row the reply was saved with.
 */
export async function followGameInventoryOnRow(
  db: DB,
  chatId: string,
  before: readonly GameInventoryStack[],
  after: readonly GameInventoryStack[],
  target: Extract<GameInventoryRowTarget, { kind: "message" }>,
): Promise<PlayerStats | null> {
  return db.transaction(() => followOnRow(db, chatId, before, after, target));
}

/**
 * The player switched `messageId` from the telling at `from` to the one at `to`: the stacks become
 * what `to` left, when they are still exactly what `from` left (see `gameInventoryForTelling`). Each
 * telling's own game-state row already carries its detailed inventory, so only the stacks move.
 * Returns the stacks now shown, or null when nothing changed.
 */
export async function switchGameInventoryTelling(
  db: DB,
  chatId: string,
  messageId: string,
  from: number,
  to: number,
): Promise<GameInventoryStack[] | null> {
  const committed = await commitGameInventoryChange(
    db,
    chatId,
    (stacks, metadata) => ({
      stacks:
        gameInventoryForTelling(readGameInventoryTurn(metadata.gameInventoryTurn), stacks, messageId, from, to) ??
        stacks,
      journal: [],
      value: stacks,
    }),
    { kind: "none" },
  );
  return committed && committed.stacks !== committed.value ? committed.stacks : null;
}

/**
 * The telling at `removed` of `messageId` was deleted, and the message now shows the one at `shown`,
 * counted after the deletion. The record's later tellings move down one, as the swipes did. When the
 * deleted telling was the one shown, the stacks become what the telling now shown left, exactly as
 * switching to it would.
 */
export async function removeGameInventoryTelling(
  db: DB,
  chatId: string,
  messageId: string,
  removed: number,
  wasShown: boolean,
  shown: number,
): Promise<void> {
  await commitGameInventoryChange(
    db,
    chatId,
    (stacks, metadata) => {
      const turn = readGameInventoryTurn(metadata.gameInventoryTurn);
      if (turn?.messageId !== messageId) return { stacks, journal: [], value: null };
      // The telling now shown, counted before the deletion.
      const moved = wasShown
        ? gameInventoryForTelling(turn, stacks, messageId, removed, shown >= removed ? shown + 1 : shown)
        : null;
      return {
        stacks: moved ?? stacks,
        journal: [],
        metadata: { gameInventoryTurn: forgetGameInventoryTelling(turn, messageId, removed) },
        value: null,
      };
    },
    { kind: "none" },
  );
}
