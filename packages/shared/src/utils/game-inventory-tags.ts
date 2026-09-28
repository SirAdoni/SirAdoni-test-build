/**
 * The Game Master's `[inventory: ...]` tags, applied to the stacks.
 *
 * The server calls this once for the reply it saves. Every tag becomes one resolved tag per item,
 * carrying what really happened, so the Game Master reads its refusals back next turn and the client
 * only has to announce what the tags say. Pure: the caller saves the stacks and the journal.
 */
import { normalizeCharacterLookupName } from "./character-lookup-name.js";
import {
  applyGameInventoryOps,
  type GameInventoryJournalEntry,
  type GameInventoryOp,
  type GameInventoryOpResult,
} from "./game-inventory-ops.js";
import {
  gameInventoryCountItems,
  gameInventoryItemsNamed,
  giveFromGameInventoryNamed,
  type GameInventoryBagRef,
  type GameInventoryItemRules,
  type GameInventoryStack,
} from "./game-inventory-stacks.js";
import {
  createInventoryTagRegex,
  parseInventoryTagBody,
  serializeInventoryTag,
  type InventoryTagOutcome,
} from "./inventory-command-tag.js";

/** Who can carry things in this game. */
export interface GameInventoryParty {
  /** The player's own character's name, when it is known. */
  player?: string;
  /** Every other party member's name, as their card has it. */
  members: readonly string[];
}

/** The most tags one reply may carry before the rest are left unapplied. */
export const MAX_INVENTORY_TAGS = 40;

export type GameInventoryHolderLookup =
  | { ok: true; bag: GameInventoryBagRef | undefined }
  | { ok: false; reason: "unknown-character" | "ambiguous-character" };

/**
 * The bag a `who=` or `to=` names, matched the way a sheet command's `who` is: case, accents and
 * punctuation aside. The player's own name is the player's bag; `party`, or no name at all, names no
 * bag in particular (`bag` undefined). Somebody who has left the party but still holds something can
 * still be named.
 */
export function resolveGameInventoryHolder(
  name: string | undefined,
  party: GameInventoryParty,
  stacks: readonly GameInventoryStack[] = [],
): GameInventoryHolderLookup {
  const key = name ? normalizeCharacterLookupName(name) : "";
  if (!key || key === "party") return { ok: true, bag: undefined };
  if (party.player && normalizeCharacterLookupName(party.player) === key) return { ok: true, bag: {} };
  // Two members of one name are two people, so neither can be told apart from the other.
  const members = party.members.filter((member) => normalizeCharacterLookupName(member) === key);
  if (members.length > 1) return { ok: false, reason: "ambiguous-character" };
  if (members.length === 1) return { ok: true, bag: { holder: members[0]! } };
  const former = stacks.find((stack) => stack.holder && normalizeCharacterLookupName(stack.holder) === key)?.holder;
  return former ? { ok: true, bag: { holder: former } } : { ok: false, reason: "unknown-character" };
}

export interface GameInventoryTagsOutcome {
  content: string;
  stacks: GameInventoryStack[];
  journal: GameInventoryJournalEntry[];
  /** How many tags were found, answered or not. Zero means the reply changed nothing here. */
  tags: number;
}

function outcomeOf(result: GameInventoryOpResult | undefined): InventoryTagOutcome {
  if (!result) return { ok: false, reason: "refused" };
  return result.ok
    ? { ok: true, count: result.count ?? 0, now: result.now ?? 0 }
    : { ok: false, reason: result.reason };
}

/**
 * Every tag in the reply, in order, each on the stacks the one before it left. A `result` the Game
 * Master wrote itself is ignored, as it is on a sheet command: it only ever asks, and the Engine
 * answers. The server runs this on the text a turn generated, never on a reply already saved.
 */
export function applyGameInventoryTags(
  content: string,
  stacks: GameInventoryStack[],
  party: GameInventoryParty,
  newId?: () => string,
  /** What the game's ruleset says about its items: a name that is one of them adds that item. */
  rules?: GameInventoryItemRules,
): GameInventoryTagsOutcome {
  let current = stacks;
  const journal: GameInventoryJournalEntry[] = [];
  let tags = 0;

  const apply = (ops: GameInventoryOp[]): GameInventoryOpResult[] => {
    const outcome = applyGameInventoryOps(current, ops, newId, rules);
    current = outcome.stacks;
    journal.push(...outcome.journal);
    return outcome.results;
  };

  const next = content.replace(createInventoryTagRegex(), (_whole, body: string) => {
    tags += 1;
    // Past the cap a tag is answered as refused rather than left as written, so a result the Game
    // Master wrote itself can never read as something that happened.
    if (tags > MAX_INVENTORY_TAGS) return refuseTagBody(body, "too-many");
    const request = parseInventoryTagBody(body);
    if (!request) return serializeInventoryTag({ raw: body.trim() }, { ok: false, reason: "unreadable" });

    const who = resolveGameInventoryHolder(request.who, party, current);
    const to = request.action === "give" ? resolveGameInventoryHolder(request.to, party, current) : null;
    return request.items
      .map((item) => {
        const shown = {
          action: request.action,
          item,
          count: request.count,
          ...(request.who ? { who: request.who } : {}),
          ...(request.to ? { to: request.to } : {}),
        };
        if (!who.ok) return serializeInventoryTag(shown, { ok: false, reason: who.reason });
        if (request.action === "add") {
          const [result] = apply([{ op: "add", name: item, count: request.count, holder: who.bag?.holder, log: true }]);
          return serializeInventoryTag(shown, outcomeOf(result));
        }
        if (request.action === "remove") {
          const [result] = apply([
            { op: "take", name: item, count: request.count, ...(who.bag ? { from: who.bag } : {}), as: "lost" },
          ]);
          return serializeInventoryTag(shown, outcomeOf(result));
        }
        // A give names who receives it, and a receiver nobody can find leaves the item where it is.
        // It comes out of who's own bag, the player's when who is left out: never out of somebody
        // the Game Master did not name.
        if (!to || !to.ok)
          return serializeInventoryTag(shown, { ok: false, reason: to && !to.ok ? to.reason : "no-recipient" });
        if (!to.bag) return serializeInventoryTag(shown, { ok: false, reason: "no-recipient" });
        // Stack by stack, so the item stays the same item and a nickname stays on its stack.
        // The items it names are settled first, and counted by item in the receiver's bag, where the
        // name may be a nickname nothing there carries.
        const items = gameInventoryItemsNamed(current, item, who.bag ?? {});
        const handed = giveFromGameInventoryNamed(
          current,
          item,
          request.count,
          who.bag ?? {},
          to.bag.holder,
          newId,
          rules,
        );
        if (handed.given === 0) return serializeInventoryTag(shown, { ok: false, reason: "none-held" });
        current = handed.stacks;
        return serializeInventoryTag(shown, {
          ok: true,
          count: handed.given,
          now: gameInventoryCountItems(current, items, to.bag),
        });
      })
      .join(" ");
  });

  return { content: next, stacks: current, journal, tags };
}

/** One tag body answered as refused: one tag per item it names, or its sanitized text when it names
 *  none. */
function refuseTagBody(body: string, reason: string): string {
  const request = parseInventoryTagBody(body);
  if (!request) return serializeInventoryTag({ raw: body.trim() }, { ok: false, reason });
  return request.items
    .map((item) =>
      serializeInventoryTag(
        {
          action: request.action,
          item,
          count: request.count,
          ...(request.who ? { who: request.who } : {}),
          ...(request.to ? { to: request.to } : {}),
        },
        { ok: false, reason },
      ),
    )
    .join(" ");
}

/**
 * Every inventory tag in `content` answered as refused, for a reply whose tags the Engine could not
 * carry out at all. Whatever the tags said, they then say that nothing happened, which is true.
 */
export function refuseGameInventoryTags(content: string, reason: string): string {
  return content.replace(createInventoryTagRegex(), (_whole, body: string) => refuseTagBody(body, reason));
}
