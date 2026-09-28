/**
 * Game Mode's inventory as stacks.
 *
 * The inventory is a list of stacks, and two stacks may hold the same item: a player can split 300
 * apples into 200 and 100, and both stay apart until the player merges them again. So every stack
 * has an id, and everything that points at ONE stack (the inventory screen) uses it.
 *
 * Every stack is also some ITEM, and every stack of an item agrees on which (`gameInventoryItemId`).
 * A stack keeps the item's own name, the name it was made with, and a rename only gives it a
 * `nickname` to be shown by instead. So identity, merging, totals and fights never follow what the
 * player calls a stack. What names an item (the Game Master's `[inventory: ...]` tag, a fight
 * spending one) finds it by its own name or by any nickname a stack of it has.
 *
 * A stack can also be one of the game's ruleset's items (`item`, "<catalog>/<entry>"), which is then
 * its identity, whatever it is called. A plain item's id is worked out from its own name, so a plain
 * stack stores none. What a ruleset says about its items (which names are its items, how many one
 * stack holds, whether anything else may be added) reaches the changes as `GameInventoryItemRules`.
 *
 * Every stack is in somebody's bag. `holder` names the party member who carries it, as their card
 * names them; a stack without one is the player's own, which is every stack saved before there were
 * bags. The whole list is the shared view, so a bag is simply the stacks with one holder.
 *
 * Every function is pure and returns the same array when nothing changed, so a caller can tell a
 * refused change from an accepted one by reference.
 */

import { normalizeCharacterLookupName } from "./character-lookup-name.js";

export interface GameInventoryStack {
  /** Identity of this stack, independent from which item it holds. */
  id: string;
  /** The item's canonical name. A rename never changes it. */
  name: string;
  /** What this stack is called instead, when the player renamed it. Never the own name again. */
  nickname?: string;
  /** Semantic item identity: `plain:…` or the ruleset's `<catalog>/<entry>` reference. */
  item: string;
  quantity: number;
  /** The party member who carries it. Absent for the player's own character. */
  holder?: string;
}

/** Whose bag: `holder` as a stack has it, so `{}` is the player's own. */
export interface GameInventoryBagRef {
  holder?: string;
}

/** The longest holder name kept, as long as any name a card may have. */
export const GAME_INVENTORY_HOLDER_MAX_LENGTH = 80;

/** The longest item name or nickname kept. */
export const GAME_INVENTORY_NAME_MAX_LENGTH = 120;

/** The most one stack may hold. Far past any real pile, and small enough to stay an exact integer
 *  through every sum a screen or a prompt makes of it. */
export const GAME_INVENTORY_MAX_QUANTITY = 999_999;

/** What a stack's `item` looks like: a catalog id and one of its entries' ids. A colon never appears
 *  in either, so no ruleset item can share an id with a plain one. */
export const GAME_INVENTORY_ITEM_REF_PATTERN = /^[a-z][a-z0-9_]{0,39}\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The longest `item` kept: the longest catalog id, a slash and the longest entry id. */
const GAME_INVENTORY_ITEM_REF_MAX_LENGTH = 121;

/** One of the ruleset's items, as the inventory's changes need it. */
export interface GameInventoryRulesetItem {
  /** "<catalog>/<entry>". */
  item: string;
  /** Its label, which a stack of it is made with as its own name. */
  name: string;
  /** The most one stack of it holds, when the ruleset limits it. */
  stack?: number;
}

/**
 * What a game's ruleset says about its items, for the changes that need it. A game without a
 * ruleset, or whose ruleset has no items, has none: every item is plain, and a stack holds up to the
 * inventory's bound.
 */
export interface GameInventoryItemRules {
  /** The ruleset's item a name is: its label, in any case. */
  itemNamed(name: string): GameInventoryRulesetItem | undefined;
  /** The ruleset's item with this id, while the ruleset still has it. */
  itemOf(item: string): GameInventoryRulesetItem | undefined;
  /** Whether an item may be added by its id: the ruleset has it and no layer of this game hides it.
   *  An item a layer hides can still be held, and `itemOf` still reads it. */
  offers(item: string): boolean;
  /** "refuse" when only the ruleset's items may be added: a player's typed-in item under
   *  `freeform: "refuse"`. */
  plain?: "allow" | "refuse";
}

/** The most new stacks one change may start, so a small stack size can never flood a bag. */
export const GAME_INVENTORY_MAX_NEW_STACKS = 50;

/** The one spelling two names are compared by: trimmed, single-spaced, any case. */
export function gameInventoryNameKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

function cleanName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

/** The name a stack is shown by: its nickname, or the item's own name when it has none. */
export function gameInventoryStackLabel(stack: { name: string; nickname?: string }): string {
  return stack.nickname ?? stack.name;
}

/** A short, stable fingerprint of a name, for ids that cannot be spelled out (FNV-1a). */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * The id of the item a name makes: `plain:` and the name in lowercase letters and digits of any
 * script, joined by dashes, so "Rope", "rope" and "ROPE!" are one item and "Меч" keeps its letters.
 * A name with no letter or digit (an emoji, "???") gets a fingerprint instead, and a very long one
 * keeps its start and a fingerprint of the whole, so two names never share an id by being cut short.
 */
export function gameInventoryPlainItemId(name: string): string {
  // Accents come off Latin, Greek and Cyrillic letters only ("Épée" is "epee"); in other scripts a mark
  // is part of the letter (a Japanese dakuten, a Devanagari vowel sign), so it stays.
  const key = gameInventoryNameKey(name)
    .normalize("NFKD")
    .replace(/([\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}])\p{M}+/gu, "$1")
    .normalize("NFC");
  // A sign in front of a number is part of the name, so "Sword +1" and "Sword -1" stay two items; a
  // dash right after a letter or digit is only a hyphen. Every other mark between words is a dash.
  const dashed = key
    .replace(/(\+)(?=\p{N})|(?<![\p{L}\p{N}\p{M}])([-\u2212])(?=\p{N})|[^\p{L}\p{N}\p{M}]/gu, (_, plus, minus) =>
      plus ? "-+" : minus ? "-\u2212" : "-",
    )
    .replace(/-+/g, "-");
  // Leading and trailing dashes are trimmed by walking in from each end, not by an anchored pattern,
  // which could backtrack over a long run of dashes in a name the player typed.
  let start = 0;
  let end = dashed.length;
  while (start < end && dashed[start] === "-") start += 1;
  while (end > start && dashed[end - 1] === "-") end -= 1;
  const spelled = [...dashed.slice(start, end)];
  if (spelled.length === 0) return `plain:~${fingerprint(key)}`;
  if (spelled.length > 40) return `plain:${spelled.slice(0, 32).join("")}-${fingerprint(key)}`;
  return `plain:${spelled.join("")}`;
}

/** Which item a stack is: the ruleset item it names, or the plain item its own name makes. Every
 *  stack of an item agrees, whatever its nickname. */
export function gameInventoryItemId(stack: { name: string; item?: string }): string {
  // Legacy in-memory callers may omit item; normalization and every emitted stack persist it.
  return stack.item ?? gameInventoryPlainItemId(stack.name);
}

/** The most one stack of an item holds: what its ruleset says, within the inventory's own bound. */
function stackLimit(item: string, rules: GameInventoryItemRules | undefined): number {
  return Math.min(GAME_INVENTORY_MAX_QUANTITY, rules?.itemOf(item)?.stack ?? GAME_INVENTORY_MAX_QUANTITY);
}

/** A holder as it is kept: cleaned, and absent for nobody in particular. */
export function cleanGameInventoryHolder(holder: unknown): string | undefined {
  if (typeof holder !== "string") return undefined;
  const cleaned = cleanName(holder).slice(0, GAME_INVENTORY_HOLDER_MAX_LENGTH);
  // A name with no letter or digit in it keys to nothing, which cannot be told apart from the
  // player's own bag, so it is the player's.
  return cleaned && normalizeCharacterLookupName(cleaned) ? cleaned : undefined;
}

/** The key two bags are compared by, matched the way a `who=` is: case and accents aside. The
 *  player's own bag is the empty key. */
export function gameInventoryBagKey(holder: string | undefined): string {
  return holder ? normalizeCharacterLookupName(holder) : "";
}

function inBag(stack: GameInventoryStack, bag: GameInventoryBagRef): boolean {
  return gameInventoryBagKey(stack.holder) === gameInventoryBagKey(bag.holder);
}

function withHolder<T extends GameInventoryStack>(stack: T, holder: string | undefined): T {
  const { holder: _dropped, ...rest } = stack;
  return (holder ? { ...rest, holder } : rest) as T;
}

/** A stack as it is kept: the nickname only when it is not the item's own name. */
function makeStack(stack: {
  id: string;
  name: string;
  nickname?: string;
  item?: string;
  quantity: number;
  holder?: string;
}): GameInventoryStack {
  const { id, name, nickname, item, quantity, holder } = stack;
  const named = nickname && gameInventoryNameKey(nickname) !== gameInventoryNameKey(name) ? { nickname } : {};
  return { id, name, ...named, item: item ?? gameInventoryPlainItemId(name), quantity, ...(holder ? { holder } : {}) };
}

function readItemRef(raw: unknown): string | undefined {
  return typeof raw === "string" &&
    raw.length <= GAME_INVENTORY_ITEM_REF_MAX_LENGTH &&
    GAME_INVENTORY_ITEM_REF_PATTERN.test(raw)
    ? raw
    : undefined;
}

function readItemId(raw: unknown, name: string): string {
  if (typeof raw === "string" && raw.startsWith("plain:") && raw.length <= 80) return raw;
  return readItemRef(raw) ?? gameInventoryPlainItemId(name);
}

function clampQuantity(quantity: number): number {
  return Math.max(0, Math.min(GAME_INVENTORY_MAX_QUANTITY, Math.floor(quantity)));
}

function slug(name: string): string {
  const dashed = gameInventoryNameKey(name).replace(/[^a-z0-9]+/g, "-");
  // Leading and trailing dashes are trimmed by walking in from each end, not by an anchored pattern,
  // which could backtrack over a long run of dashes in a name the player typed.
  let start = 0;
  let end = dashed.length;
  while (start < end && dashed[start] === "-") start += 1;
  while (end > start && dashed[end - 1] === "-") end -= 1;
  return dashed.slice(start, Math.min(end, start + 40)) || "item";
}

/** A fresh id no stack in `stacks` has. */
export function newGameInventoryStackId(stacks: readonly { id?: string }[]): string {
  const taken = new Set(stacks.map((stack) => stack.id));
  for (;;) {
    const id = `st-${Math.random().toString(36).slice(2, 10)}`;
    if (!taken.has(id)) return id;
  }
}

/**
 * Stacks as they are stored, read tolerantly. An entry with no name is dropped, and a quantity that
 * is missing, broken or below one reads as one, as it always has. A nickname that is the item's own
 * name again, in any case, is dropped.
 *
 * An entry saved before stacks had ids gets one here, worked out from its name and how many entries
 * of that name came before it. The same saved list therefore reads with the same ids every time,
 * which keeps a selection on screen across a reload, and the id is stored with the next change.
 */
export function normalizeGameInventoryStacks(raw: unknown): GameInventoryStack[] {
  if (!Array.isArray(raw)) return [];
  const entries = raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const source = entry as Record<string, unknown>;
    const name = typeof source.name === "string" ? cleanName(source.name) : "";
    if (!name) return [];
    const parsed =
      typeof source.quantity === "number" ? source.quantity : Number.parseInt(String(source.quantity ?? ""), 10);
    const quantity =
      Number.isFinite(parsed) && parsed > 0 ? Math.min(GAME_INVENTORY_MAX_QUANTITY, Math.floor(parsed)) : 1;
    const stored = typeof source.id === "string" ? source.id.trim() : "";
    const nickname =
      typeof source.nickname === "string"
        ? cleanName(source.nickname).slice(0, GAME_INVENTORY_NAME_MAX_LENGTH) || undefined
        : undefined;
    return [
      {
        name,
        nickname,
        item: readItemId(source.item, name),
        quantity,
        stored,
        holder: cleanGameInventoryHolder(source.holder),
      },
    ];
  });
  // Every stored id is reserved before any is worked out, so an entry saved without one can never
  // take the id of a stack saved after it. A stored id that repeats is kept by its first holder only.
  const used = new Set<string>();
  const keeps = entries.map((entry) => {
    if (!entry.stored || used.has(entry.stored)) return false;
    used.add(entry.stored);
    return true;
  });
  const seenByName = new Map<string, number>();
  return entries.map((entry, index) => {
    const key = gameInventoryNameKey(entry.name);
    const occurrence = seenByName.get(key) ?? 0;
    seenByName.set(key, occurrence + 1);
    const { stored, ...kept } = entry;
    if (keeps[index]) return makeStack({ ...kept, id: stored });
    let id = `st-${slug(entry.name)}-${occurrence}`;
    while (used.has(id)) id = `${id}-x`;
    used.add(id);
    return makeStack({ ...kept, id });
  });
}

/** The items among `stacks` whose own name a name is, spelling aside: a plain item and a ruleset item
 *  may both be called it. */
export function gameInventoryItemsOwnNamed(stacks: readonly GameInventoryStack[], name: string): Set<string> {
  const own = gameInventoryPlainItemId(name);
  return new Set(
    stacks.filter((stack) => gameInventoryPlainItemId(stack.name) === own).map((stack) => gameInventoryItemId(stack)),
  );
}

/**
 * The items a name means among `stacks`: the items whose own name it is, when a stack of one is
 * there; otherwise every item a stack of which is nicknamed that, ignoring case; otherwise the plain
 * item the name would make. So an item's own name always wins over another item's nickname.
 */
function itemsNamed(stacks: readonly GameInventoryStack[], name: string): Set<string> {
  if (!gameInventoryNameKey(name)) return new Set();
  const own = gameInventoryPlainItemId(name);
  const ownNamed = gameInventoryItemsOwnNamed(stacks, name);
  if (ownNamed.size > 0) return ownNamed;
  const key = gameInventoryNameKey(name);
  const nicknamed = stacks.filter((stack) => stack.nickname && gameInventoryNameKey(stack.nickname) === key);
  return new Set(nicknamed.length > 0 ? nicknamed.map(gameInventoryItemId) : [own]);
}

/**
 * The items a name means, read against one bag's stacks when `from` is given (as a take or a give by
 * name reads it). Settled before a change, so what the change did can be counted afterwards by item,
 * even once the stacks the name was found on are gone.
 */
export function gameInventoryItemsNamed(
  stacks: readonly GameInventoryStack[],
  name: string,
  from?: GameInventoryBagRef,
): Set<string> {
  return itemsNamed(from ? stacks.filter((stack) => inBag(stack, from)) : stacks, name);
}

/** How many stacks of these items hold, across every bag or in one bag's. */
export function gameInventoryCountItems(
  stacks: readonly GameInventoryStack[],
  items: ReadonlySet<string>,
  from?: GameInventoryBagRef,
): number {
  return stacks.reduce(
    (total, stack) =>
      total + (items.has(gameInventoryItemId(stack)) && (!from || inBag(stack, from)) ? stack.quantity : 0),
    0,
  );
}

/** One line of `gameInventoryTotals`: an item, the name it is shown by, and how many there are. */
export interface GameInventoryTotal {
  name: string;
  quantity: number;
  /** The item's own name, when `name` is a nickname a player gave it. */
  ownName?: string;
  /** The ruleset item it is, when it is one. */
  item?: string;
}

/** One line per item: every stack of an item added together, in the order the items first appear,
 *  shown by the first stack's name. What the Game Master and a fight read, since a split is the
 *  player's own arrangement. */
export function gameInventoryTotals(stacks: readonly GameInventoryStack[]): GameInventoryTotal[] {
  const totals = new Map<string, GameInventoryTotal>();
  for (const stack of stacks) {
    const item = gameInventoryItemId(stack);
    const existing = totals.get(item);
    if (existing) existing.quantity += stack.quantity;
    else
      totals.set(item, {
        name: gameInventoryStackLabel(stack),
        quantity: stack.quantity,
        ...(stack.nickname ? { ownName: stack.name } : {}),
        item: gameInventoryItemId(stack),
      });
  }
  return [...totals.values()];
}

/** One line a fight lists: a total, under a name no other line has. */
export interface GameInventoryFightLine extends GameInventoryTotal {
  /** The name the item is shown by in the inventory, before anything was added to keep `name` unique. */
  shown: string;
}

/**
 * The lines a fight lists: `gameInventoryTotals`, each under a name no other line has, since a fight
 * tells items apart by name. A nickname that another line also goes by is shown with the item's own
 * name, such as "Potion (Cord)" beside a real "Potion", and a name still taken after that gets a
 * number. `ownName` stays what a spend is taken by.
 */
export function gameInventoryFightLines(stacks: readonly GameInventoryStack[]): GameInventoryFightLine[] {
  const totals = gameInventoryTotals(stacks);
  const uses = new Map<string, number>();
  for (const line of totals) {
    const key = gameInventoryNameKey(line.name);
    uses.set(key, (uses.get(key) ?? 0) + 1);
  }
  const taken = new Set<string>();
  return totals.map((line) => {
    const base =
      line.ownName && (uses.get(gameInventoryNameKey(line.name)) ?? 0) > 1
        ? `${line.name} (${line.ownName})`
        : line.name;
    let name = base;
    for (let n = 2; taken.has(gameInventoryNameKey(name)); n += 1) name = `${base} ${n}`;
    taken.add(gameInventoryNameKey(name));
    // A line listed under anything but the item's own name says what that own name is, which is what
    // a spend is taken by.
    const ownName = line.ownName ?? (name === line.name ? undefined : line.name);
    return { ...line, name, ...(ownName ? { ownName } : {}), shown: line.name };
  });
}

/**
 * A fight's item effects, each under the name of the line it belongs to. Every line first takes the
 * effect named by its item's own name, since a line's listed name may be one another item really
 * goes by (a cord nicknamed "Potion" is listed as "Potion (Cord)" beside an item called that). A
 * line with none then takes one named as it is listed or shown, unless another line took that effect
 * by its own name. Effects no line takes are kept as they are.
 */
export function gameInventoryFightEffects<T extends { name: string }>(
  lines: readonly GameInventoryFightLine[],
  effects: readonly T[],
): T[] {
  const byName = (name: string | undefined) =>
    name ? effects.find((effect) => gameInventoryNameKey(effect.name) === gameInventoryNameKey(name)) : undefined;
  const given = new Map<string, T>();
  for (const line of lines) {
    const effect = byName(line.ownName ?? line.shown);
    if (effect) given.set(line.name, effect);
  }
  const claimed = new Set(given.values());
  for (const line of lines) {
    if (given.has(line.name)) continue;
    const effect = [line.name, line.shown].map(byName).find((found) => found && !claimed.has(found));
    if (effect) given.set(line.name, effect);
  }
  const used = new Set(given.values());
  return [
    ...lines.flatMap((line) => {
      const effect = given.get(line.name);
      return effect ? [effect.name === line.name ? effect : { ...effect, name: line.name }] : [];
    }),
    ...effects.filter((effect) => !used.has(effect)),
  ];
}

/** Each bag's own totals, the player's first and then in the order a holder first appears. Only bags
 *  that hold something are listed. */
export function gameInventoryBags(
  stacks: readonly GameInventoryStack[],
): Array<{ holder?: string; items: GameInventoryTotal[] }> {
  const bags = new Map<string, { holder?: string; stacks: GameInventoryStack[] }>([["", { stacks: [] }]]);
  for (const stack of stacks) {
    const key = gameInventoryBagKey(stack.holder);
    const bag = bags.get(key) ?? { ...(stack.holder ? { holder: stack.holder } : {}), stacks: [] };
    bag.stacks.push(stack);
    bags.set(key, bag);
  }
  return [...bags.values()]
    .filter((bag) => bag.stacks.length > 0)
    .map((bag) => ({ ...(bag.holder ? { holder: bag.holder } : {}), items: gameInventoryTotals(bag.stacks) }));
}

/** How many of an item there are, across all its stacks, or in one bag's. */
export function gameInventoryCount(
  stacks: readonly GameInventoryStack[],
  name: string,
  from?: GameInventoryBagRef,
): number {
  const scope = from ? stacks.filter((stack) => inBag(stack, from)) : stacks;
  const items = itemsNamed(scope, name);
  return scope.reduce((total, stack) => total + (items.has(gameInventoryItemId(stack)) ? stack.quantity : 0), 0);
}

/**
 * `amount` of the item `like` is into one bag: onto the bag's stacks of that item in order, each up to
 * `limit`, then as new stacks of at most `limit` at the end, called what the bag's first stack of it
 * is called (or what `like` is). So nothing added is ever lost, and one change never starts more than
 * `GAME_INVENTORY_MAX_NEW_STACKS` stacks: past that it is refused (null). `id` is the stack it went
 * onto first.
 */
function addLike(
  stacks: GameInventoryStack[],
  like: { name: string; nickname?: string; item?: string },
  amount: number,
  holder: string | undefined,
  makeId: () => string,
  limit: number = GAME_INVENTORY_MAX_QUANTITY,
): { stacks: GameInventoryStack[]; id: string } | null {
  const item = gameInventoryItemId(like);
  const bag = { holder };
  let left = amount;
  let id: string | undefined;
  let first: GameInventoryStack | undefined;
  const next = stacks.map((stack) => {
    if (gameInventoryItemId(stack) !== item || !inBag(stack, bag)) return stack;
    first ??= stack;
    const topUp = Math.min(Math.max(0, limit - stack.quantity), left);
    if (topUp < 1) return stack;
    left -= topUp;
    id ??= stack.id;
    return { ...stack, quantity: stack.quantity + topUp };
  });
  if (left > 0 && Math.ceil(left / limit) > GAME_INVENTORY_MAX_NEW_STACKS) return null;
  const named = first ?? like;
  const fresh: GameInventoryStack[] = [];
  while (left > 0) {
    const quantity = Math.min(left, limit);
    left -= quantity;
    fresh.push(
      makeStack({ id: makeId(), name: named.name, nickname: named.nickname, item: like.item, quantity, holder }),
    );
  }
  return { stacks: fresh.length > 0 ? [...next, ...fresh] : next, id: id ?? fresh[0]?.id ?? first!.id };
}

/**
 * The item a name adds into one bag (the player's when `holder` is absent). The name finds a held
 * item as every name does, the bag's own first, and otherwise the ruleset's item of that name. A
 * ruleset item also wins over a plain item that only has its name as its own. A name that finds
 * neither is a new plain item, unless the rules refuse plain items (undefined).
 */
export function gameInventoryAddedItem(
  stacks: readonly GameInventoryStack[],
  name: string,
  holder?: string,
  rules?: GameInventoryItemRules,
): { name: string; item?: string } | undefined {
  const cleaned = cleanName(name).slice(0, GAME_INVENTORY_NAME_MAX_LENGTH);
  if (!cleaned) return undefined;
  const bag = { holder: cleanGameInventoryHolder(holder) };
  const items = itemsNamed(stacks, cleaned);
  const typed = rules?.itemNamed(cleaned);
  const plainOwn = gameInventoryPlainItemId(cleaned);
  const held = (stack: GameInventoryStack) =>
    items.has(gameInventoryItemId(stack)) && !(typed && gameInventoryItemId(stack) === plainOwn);
  const known = stacks.find((stack) => held(stack) && inBag(stack, bag)) ?? stacks.find(held);
  if (known) return { name: known.name, ...(known.item ? { item: known.item } : {}) };
  if (typed) return { name: typed.name, item: typed.item };
  return rules?.plain === "refuse" ? undefined : { name: cleaned };
}

/**
 * Adding by name into one bag (the player's when `holder` is absent): the item
 * `gameInventoryAddedItem` finds, onto the bag's stacks of it, or as a new stack at the end called by
 * the item's own name. One addition is at most one stack's worth of the inventory's bound, and a
 * count past that, one that is not a number, a name the rules refuse, or an addition that would start
 * too many stacks is refused and changes nothing. `id` is the stack it went onto.
 */
export function addToGameInventoryNamed(
  stacks: GameInventoryStack[],
  name: string,
  count: number,
  newId?: () => string,
  holder?: string,
  rules?: GameInventoryItemRules,
): { stacks: GameInventoryStack[]; id: string } | null {
  if (!Number.isFinite(count)) return null;
  const amount = Math.floor(count);
  if (amount < 1 || amount > GAME_INVENTORY_MAX_QUANTITY) return null;
  const like = gameInventoryAddedItem(stacks, name, holder, rules);
  if (!like) return null;
  const makeId = newId ?? (() => newGameInventoryStackId(stacks));
  const bag = cleanGameInventoryHolder(holder);
  return addLike(stacks, like, amount, bag, makeId, stackLimit(gameInventoryItemId(like), rules));
}

/** One of the ruleset's items added by its id, as `addToGameInventoryNamed` adds by name: refused
 *  when the rules do not offer it (they do not have it, or a layer hides it). */
export function addGameInventoryRulesetItem(
  stacks: GameInventoryStack[],
  item: string,
  count: number,
  newId?: () => string,
  holder?: string,
  rules?: GameInventoryItemRules,
): { stacks: GameInventoryStack[]; id: string } | null {
  const known = rules?.offers(item) ? rules.itemOf(item) : undefined;
  if (!known || !Number.isFinite(count)) return null;
  const amount = Math.floor(count);
  if (amount < 1 || amount > GAME_INVENTORY_MAX_QUANTITY) return null;
  const makeId = newId ?? (() => newGameInventoryStackId(stacks));
  const like = { name: known.name, item: known.item };
  return addLike(stacks, like, amount, cleanGameInventoryHolder(holder), makeId, stackLimit(item, rules));
}

/** `addToGameInventoryNamed`, for a caller that only needs the stacks. */
export function addToGameInventory(
  stacks: GameInventoryStack[],
  name: string,
  count: number,
  newId?: () => string,
  holder?: string,
  rules?: GameInventoryItemRules,
): GameInventoryStack[] {
  return addToGameInventoryNamed(stacks, name, count, newId, holder, rules)?.stacks ?? stacks;
}

/** The stacks a name finds, in the order they are taken or given from: with `from`, only that bag's
 *  (and the name is read against that bag); without, the player's own bag first and then the rest of
 *  the party's, top to bottom. */
function stacksNamed(
  stacks: readonly GameInventoryStack[],
  name: string,
  from?: GameInventoryBagRef,
): Array<{ stack: GameInventoryStack; index: number }> {
  const items = itemsNamed(from ? stacks.filter((stack) => inBag(stack, from)) : stacks, name);
  return stacks
    .map((stack, index) => ({ stack, index }))
    .filter(({ stack }) => items.has(gameInventoryItemId(stack)) && (!from || inBag(stack, from)))
    .sort(
      (a, b) => (from ? 0 : Number(Boolean(a.stack.holder)) - Number(Boolean(b.stack.holder))) || a.index - b.index,
    );
}

/**
 * Taking by name: from the stacks of the item it finds, in `stacksNamed` order, until `count` is met,
 * removing each one it empties. Asking for more than there is takes all of it; `taken` says how many
 * really went.
 */
export function takeFromGameInventory(
  stacks: GameInventoryStack[],
  name: string,
  count: number,
  from?: GameInventoryBagRef,
): { stacks: GameInventoryStack[]; taken: number } {
  // Not held to one stack's bound: the stacks of an item together may hold more than one stack can.
  let left = Number.isFinite(count) ? Math.floor(count) : 0;
  if (!gameInventoryNameKey(name) || left < 1) return { stacks, taken: 0 };
  const takeAt = new Map<number, number>();
  let taken = 0;
  for (const { stack, index } of stacksNamed(stacks, name, from)) {
    if (left < 1) break;
    const take = Math.min(left, stack.quantity);
    left -= take;
    taken += take;
    takeAt.set(index, take);
  }
  if (taken === 0) return { stacks, taken: 0 };
  const next = stacks.flatMap((stack, index) => {
    const take = takeAt.get(index) ?? 0;
    if (take === 0) return [stack];
    return stack.quantity - take > 0 ? [{ ...stack, quantity: stack.quantity - take }] : [];
  });
  return { stacks: next, taken };
}

/**
 * Some or all of one stack handed to another party member (`to` absent for the player): taken off
 * that stack and added to their bag onto their stacks of the same item, or as new stacks called what
 * this one is called. Giving to the bag it is already in, or a count that is not from 1 to the
 * stack's size, changes nothing. `id` is the stack that received it, so a screen can follow it.
 */
export function giveGameInventoryStack(
  stacks: GameInventoryStack[],
  id: string,
  to: string | undefined,
  count?: number,
  newId?: () => string,
  rules?: GameInventoryItemRules,
): { stacks: GameInventoryStack[]; id: string } | null {
  const source = stacks.find((stack) => stack.id === id);
  if (!source) return null;
  const amount = count === undefined ? source.quantity : count;
  if (!Number.isInteger(amount) || amount < 1 || amount > source.quantity) return null;
  const receiver = { holder: cleanGameInventoryHolder(to) };
  if (inBag(source, receiver)) return { stacks, id };
  const makeId = newId ?? (() => newGameInventoryStackId(stacks));
  const item = gameInventoryItemId(source);
  const rest =
    amount === source.quantity
      ? stacks.filter((stack) => stack.id !== id)
      : stacks.map((stack) => (stack.id === id ? { ...stack, quantity: stack.quantity - amount } : stack));
  const existing = rest.find((stack) => gameInventoryItemId(stack) === item && inBag(stack, receiver));
  // A whole stack given to somebody with none of it keeps its id, so a selection follows it.
  if (!existing && amount === source.quantity) {
    const index = stacks.findIndex((stack) => stack.id === id);
    return {
      stacks: stacks.map((stack, i) => (i === index ? withHolder(stack, receiver.holder) : stack)),
      id,
    };
  }
  return addLike(rest, source, amount, receiver.holder, makeId, stackLimit(item, rules));
}

/**
 * Giving by name: `count` of the item a name finds, out of one bag (the player's when `from` is
 * absent) and into another's (`to`), stack by stack in the bag's order, each as
 * `giveGameInventoryStack` hands it over, so nicknames travel with the stacks they are on. Giving
 * into the same bag, or when the bag holds none, changes nothing. `given` says how many went.
 */
export function giveFromGameInventoryNamed(
  stacks: GameInventoryStack[],
  name: string,
  count: number,
  from: GameInventoryBagRef,
  to: string | undefined,
  newId?: () => string,
  rules?: GameInventoryItemRules,
): { stacks: GameInventoryStack[]; given: number } {
  let left = Number.isFinite(count) ? Math.floor(count) : 0;
  const receiver = { holder: cleanGameInventoryHolder(to) };
  if (left < 1 || gameInventoryBagKey(from.holder) === gameInventoryBagKey(receiver.holder)) {
    return { stacks, given: 0 };
  }
  let current = stacks;
  let given = 0;
  for (const { stack } of stacksNamed(stacks, name, from)) {
    if (left < 1) break;
    const amount = Math.min(left, stack.quantity);
    const next = giveGameInventoryStack(current, stack.id, receiver.holder, amount, newId, rules);
    if (!next) break;
    current = next.stacks;
    left -= amount;
    given += amount;
  }
  return given > 0 ? { stacks: current, given } : { stacks, given: 0 };
}

/** Two stacks trading places, wherever they are in the list. */
export function swapGameInventoryStacks(
  stacks: GameInventoryStack[],
  firstId: string,
  secondId: string,
): GameInventoryStack[] {
  const first = stacks.findIndex((stack) => stack.id === firstId);
  const second = stacks.findIndex((stack) => stack.id === secondId);
  if (first < 0 || second < 0 || first === second) return stacks;
  const next = stacks.slice();
  [next[first], next[second]] = [next[second]!, next[first]!];
  return next;
}

/**
 * One stack set to a count. Zero removes it. A count past what one stack of the item holds fills this
 * stack and puts the rest in new stacks right after it, like it, unless that would start too many
 * stacks, which changes nothing. Nothing passes the inventory's bound.
 */
export function setGameInventoryStackQuantity(
  stacks: GameInventoryStack[],
  id: string,
  quantity: number,
  newId: () => string = () => newGameInventoryStackId(stacks),
  rules?: GameInventoryItemRules,
): GameInventoryStack[] {
  const index = stacks.findIndex((stack) => stack.id === id);
  if (index < 0 || !Number.isFinite(quantity)) return stacks;
  const stack = stacks[index]!;
  const next = clampQuantity(quantity);
  if (next === stack.quantity) return stacks;
  if (next === 0) return stacks.filter((_, i) => i !== index);
  const limit = stackLimit(gameInventoryItemId(stack), rules);
  if (next <= limit) return stacks.map((each, i) => (i === index ? { ...each, quantity: next } : each));
  if (Math.ceil((next - limit) / limit) > GAME_INVENTORY_MAX_NEW_STACKS) return stacks;
  const rest: GameInventoryStack[] = [];
  for (let left = next - limit; left > 0; left -= limit) {
    rest.push({ ...stack, id: newId(), quantity: Math.min(left, limit) });
  }
  return [...stacks.slice(0, index), { ...stack, quantity: limit }, ...rest, ...stacks.slice(index + 1)];
}

/**
 * Part of a stack moved into a new stack right after it, with the same item and nickname. The size
 * has to leave something behind and move something, so it is at least one and less than the stack;
 * anything else changes nothing. The total never changes.
 */
export function splitGameInventoryStack(
  stacks: GameInventoryStack[],
  id: string,
  size: number,
  newId: () => string = () => newGameInventoryStackId(stacks),
): GameInventoryStack[] {
  const index = stacks.findIndex((stack) => stack.id === id);
  if (index < 0 || !Number.isInteger(size)) return stacks;
  const stack = stacks[index]!;
  if (size < 1 || size >= stack.quantity) return stacks;
  return [
    ...stacks.slice(0, index),
    { ...stack, quantity: stack.quantity - size },
    { ...stack, id: newId(), quantity: size },
    ...stacks.slice(index + 1),
  ];
}

/** One stack poured into another of the same item, which keeps its place, its bag and its nickname,
 *  so pouring into a stack in somebody else's bag hands it over. Only as much as the stack it is
 *  poured into can hold moves, and the rest stays where it was; into a full stack nothing does. Two
 *  different items never merge, whatever they are called, and a stack never merges into itself. */
export function mergeGameInventoryStacks(
  stacks: GameInventoryStack[],
  fromId: string,
  intoId: string,
  rules?: GameInventoryItemRules,
): GameInventoryStack[] {
  if (fromId === intoId) return stacks;
  const from = stacks.find((stack) => stack.id === fromId);
  const into = stacks.find((stack) => stack.id === intoId);
  if (!from || !into || gameInventoryItemId(from) !== gameInventoryItemId(into)) return stacks;
  const moved = Math.min(from.quantity, stackLimit(gameInventoryItemId(into), rules) - into.quantity);
  if (moved < 1) return stacks;
  return stacks.flatMap((stack) => {
    if (stack.id === intoId) return [{ ...stack, quantity: stack.quantity + moved }];
    if (stack.id !== fromId) return [stack];
    return moved < stack.quantity ? [{ ...stack, quantity: stack.quantity - moved }] : [];
  });
}

/**
 * One stack called something else: its nickname, which is all a rename changes. Renaming it back to
 * the item's own name, in any case, clears the nickname. A rename never changes which item it is and
 * never merges it into anything. An empty name is refused.
 */
export function renameGameInventoryStack(
  stacks: GameInventoryStack[],
  id: string,
  nextName: string,
): { stacks: GameInventoryStack[]; id: string } | null {
  const cleaned = cleanName(nextName).slice(0, GAME_INVENTORY_NAME_MAX_LENGTH);
  const source = stacks.find((stack) => stack.id === id);
  if (!source || !cleaned) return null;
  const renamed = makeStack({ ...source, nickname: cleaned });
  if (gameInventoryStackLabel(renamed) === gameInventoryStackLabel(source)) return { stacks, id };
  return { stacks: stacks.map((stack) => (stack.id === id ? renamed : stack)), id };
}

/**
 * The inventory a new session starts with: every stack the last one ended with, ids, splits, bags and
 * nicknames kept, plus anything the detailed inventory on its last game state names that no stack
 * holds, which goes to the player. `rules` are the game's ruleset's items: what comes back that way is
 * stacked no higher than its item allows, and a name that is one of them comes back as that item.
 */
export function carryGameInventory(
  gameInventory: unknown,
  detailedInventory: unknown,
  rules?: GameInventoryItemRules,
): GameInventoryStack[] {
  let stacks = normalizeGameInventoryStacks(gameInventory);
  // Read against the stacks as saved, so two detailed entries of an item no stack holds both count.
  const saved = stacks;
  const held = new Set(saved.map(gameInventoryItemId));
  for (const raw of Array.isArray(detailedInventory) ? detailedInventory : []) {
    const [entry] = normalizeGameInventoryStacks([raw]);
    if (!entry) continue;
    const item = (raw as { item?: unknown }).item;
    // An entry that follows an item by id is held exactly when that item is; only one without an id
    // is judged by its name.
    if (typeof item === "string" ? held.has(item) : gameInventoryCount(saved, entry.name) > 0) continue;
    // A ruleset item comes back as that item, under the name its entry shows.
    // Only one the ruleset still has, when its items are known; any other goes back by its name.
    const ref = readItemRef(item);
    const typed = ref && (!rules || rules.itemOf(ref)) ? ref : undefined;
    if (typed) {
      const makeId = () => newGameInventoryStackId(stacks);
      stacks =
        addLike(stacks, { name: entry.name, item: typed }, entry.quantity, undefined, makeId, stackLimit(typed, rules))
          ?.stacks ?? stacks;
      continue;
    }
    // An entry whose name is not its item's own (a nickname) comes back as that item, its own name
    // read off the id and the entry's name kept as the nickname, rather than as whatever that name
    // finds. Only an own name that makes that same id again is trusted: one cut short and
    // fingerprinted cannot be read back, and comes back by name.
    const own = typeof item === "string" && item.startsWith("plain:") ? item : undefined;
    if (own && rules?.plain !== "refuse") {
      const makeId = () => newGameInventoryStackId(stacks);
      // Plain IDs encode common names losslessly. Recover that canonical name only when re-encoding
      // proves the mapping is exact; otherwise the saved display name is the only name we can trust.
      const recovered = own.slice("plain:".length).replace(/-/g, " ");
      const recoverable = Boolean(recovered) && gameInventoryPlainItemId(recovered) === own;
      const name = recoverable && gameInventoryPlainItemId(entry.name) !== own ? recovered : entry.name;
      const savedNickname = (raw as { nickname?: unknown }).nickname;
      const nickname =
        typeof savedNickname === "string"
          ? savedNickname
          : recoverable && gameInventoryPlainItemId(entry.name) !== own
            ? entry.name
            : undefined;
      stacks = addLike(stacks, { name, nickname, item: own }, entry.quantity, undefined, makeId)?.stacks ?? stacks;
      continue;
    }
    if (rules?.plain !== "refuse")
      stacks = addToGameInventory(stacks, entry.name, entry.quantity, undefined, undefined, rules);
  }
  return stacks;
}
