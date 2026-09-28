/**
 * Game Mode inventory stacks (#6759): ids, any amount, splitting, merging, and the named operations
 * the Game Master's tag and a fight use when one item sits in several stacks.
 *
 * Pinned here:
 *   - A saved inventory with no ids reads with the same ids every time, two stacks of one name apart.
 *   - Adding by name goes onto the first stack of that name only; taking by name runs top to bottom
 *     across stacks, removes the ones it empties, and never takes more than there is.
 *   - Setting a count, splitting (300 by 100 is 200 and 100, beside each other), merging (same item
 *     only, into the target's place), and renaming one stack, with every refused change returning
 *     the same array.
 *   - A new session keeps every stack and id (the old carry-over kept only the first of a name).
 *   - The amount field: a count, or +N / -N, bounded like a stack.
 *   - Ruleset items (#6795): a stack that is one is that item whatever it is called, a name that is one
 *     adds it (over a plain item only called that), a stack of one holds up to its `stack` (adding,
 *     setting, merging and giving past it start new stacks, never too many), only the ruleset's items
 *     may be added under `freeform: "refuse"`, and a new session brings one back as itself.
 */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import {
  addGameInventoryRulesetItem,
  addToGameInventory,
  addToGameInventoryNamed,
  applyGameInventoryOps,
  carryGameInventory,
  GAME_INVENTORY_MAX_NEW_STACKS,
  GAME_INVENTORY_MAX_QUANTITY,
  gameInventoryItemsOwnNamed,
  gameInventoryCount,
  gameInventoryItemId,
  gameInventoryPlainItemId,
  gameInventoryStackLabel,
  gameInventoryTotals,
  mergeGameInventoryStacks,
  normalizeGameInventoryStacks,
  sameGameInventory,
  renameGameInventoryStack,
  setGameInventoryStackQuantity,
  splitGameInventoryStack,
  giveGameInventoryStack,
  takeFromGameInventory,
  type GameInventoryItemRules,
  type GameInventoryRulesetItem,
  type GameInventoryStack,
} from "../../packages/shared/src/index.js";
import {
  defaultInventorySplitSize,
  parseInventoryAmount,
} from "../../packages/client/src/lib/game-inventory-amount.js";

const ids = (stacks: GameInventoryStack[]) => stacks.map((stack) => stack.id);
const piles = (stacks: GameInventoryStack[]) => stacks.map((stack) => [gameInventoryStackLabel(stack), stack.quantity]);
const fixedId = (id: string) => () => id;

// ── Reading a saved inventory ──
{
  const saved = [
    { name: " Apple ", quantity: 300 },
    { name: "Rope", quantity: "2" },
    { name: "apple", quantity: 5 },
    { name: "", quantity: 1 },
    null,
    { name: "Coin", quantity: 0 },
    { name: "Hoard", quantity: GAME_INVENTORY_MAX_QUANTITY + 50 },
  ];
  const once = normalizeGameInventoryStacks(saved);
  const twice = normalizeGameInventoryStacks(saved);
  assert.deepEqual(ids(once), ids(twice), "the same saved list reads with the same ids");
  assert.equal(new Set(ids(once)).size, once.length, "every stack has its own id");
  assert.deepEqual(piles(once), [
    ["Apple", 300],
    ["Rope", 2],
    ["apple", 5],
    ["Coin", 1],
    ["Hoard", GAME_INVENTORY_MAX_QUANTITY],
  ]);
  // Stored ids are kept; a duplicated stored id is replaced on the second entry only.
  const stored = normalizeGameInventoryStacks([
    { id: "st-a", name: "Apple", quantity: 1 },
    { id: "st-a", name: "Apple", quantity: 2 },
  ]);
  assert.equal(stored[0]!.id, "st-a");
  assert.notEqual(stored[1]!.id, "st-a");
  assert.deepEqual(normalizeGameInventoryStacks("not a list"), []);
  // A worked-out id trims dashes from both ends, and a name that is a long run of them stays quick.
  assert.equal(normalizeGameInventoryStacks([{ name: " --Apple-- ", quantity: 1 }])[0]!.id, "st-apple-0");
  const started = performance.now();
  const dashes = normalizeGameInventoryStacks([{ name: `${"-".repeat(100_000)}x`, quantity: 1 }]);
  assert.equal(dashes[0]!.id, "st-x-0");
  assert.ok(performance.now() - started < 200, "a long run of dashes is read in linear time");
  // Stored ids are reserved first: an entry saved without an id never takes a later entry's id.
  const reserved = normalizeGameInventoryStacks([
    { name: "Apple", quantity: 1 },
    { id: "st-apple-0", name: "Apple", quantity: 2 },
  ]);
  assert.equal(reserved[1]!.id, "st-apple-0", "the stack saved with the id keeps it");
  assert.notEqual(reserved[0]!.id, "st-apple-0");
}

const apples = (): GameInventoryStack[] => [
  { id: "a1", name: "Apple", quantity: 200 },
  { id: "r1", name: "Rope", quantity: 1 },
  { id: "a2", name: "Apple", quantity: 100 },
];

// ── Adding by name ──
{
  const added = addToGameInventory(apples(), "  apple ", 5);
  assert.deepEqual(
    piles(added),
    [
      ["Apple", 205],
      ["Rope", 1],
      ["Apple", 100],
    ],
    "onto the first stack of that name, and no other",
  );
  const fresh = addToGameInventory(apples(), "Lantern", 2, fixedId("new"));
  assert.deepEqual(fresh.at(-1), { id: "new", name: "Lantern", item: gameInventoryPlainItemId("Lantern"), quantity: 2 });
  // What the first stack cannot hold starts a new stack; nothing added is lost.
  const nearlyFull: GameInventoryStack[] = [{ id: "c1", name: "Coin", quantity: GAME_INVENTORY_MAX_QUANTITY - 5 }];
  assert.deepEqual(addToGameInventory(nearlyFull, "coin", 20, fixedId("c2")), [
    { id: "c1", name: "Coin", quantity: GAME_INVENTORY_MAX_QUANTITY },
    { id: "c2", name: "Coin", item: gameInventoryPlainItemId("Coin"), quantity: 15 },
  ]);
  const full: GameInventoryStack[] = [{ id: "c1", name: "Coin", quantity: GAME_INVENTORY_MAX_QUANTITY }];
  assert.deepEqual(piles(addToGameInventory(full, "Coin", 3, fixedId("c2"))), [
    ["Coin", GAME_INVENTORY_MAX_QUANTITY],
    ["Coin", 3],
  ]);
  const same = apples();
  assert.equal(addToGameInventory(same, "Apple", 0), same, "adding nothing changes nothing");
  for (const count of [Number.NaN, Number.POSITIVE_INFINITY, GAME_INVENTORY_MAX_QUANTITY + 1]) {
    assert.equal(addToGameInventory(same, "Apple", count), same, `adding ${count} is refused`);
    assert.equal(addToGameInventory(same, "Lantern", count), same, `a new stack of ${count} is refused`);
  }
  assert.equal(addToGameInventory(same, "   ", 3), same);
}

// ── Taking by name ──
{
  const partly = takeFromGameInventory(apples(), "Apple", 50);
  assert.equal(partly.taken, 50);
  assert.deepEqual(piles(partly.stacks), [
    ["Apple", 150],
    ["Rope", 1],
    ["Apple", 100],
  ]);
  const across = takeFromGameInventory(apples(), "apple", 250);
  assert.equal(across.taken, 250);
  assert.deepEqual(ids(across.stacks), ["r1", "a2"], "the emptied stack is removed");
  assert.deepEqual(piles(across.stacks), [
    ["Rope", 1],
    ["Apple", 50],
  ]);
  const everything = takeFromGameInventory(apples(), "Apple", 9999);
  assert.equal(everything.taken, 300, "more than there is takes all of it, and says how many");
  assert.deepEqual(ids(everything.stacks), ["r1"]);
  // Taking is not held to one stack's bound: several full stacks can be emptied at once.
  const hoard: GameInventoryStack[] = [
    { id: "h1", name: "Coin", quantity: GAME_INVENTORY_MAX_QUANTITY },
    { id: "h2", name: "Coin", quantity: GAME_INVENTORY_MAX_QUANTITY },
  ];
  const bigTake = takeFromGameInventory(hoard, "Coin", GAME_INVENTORY_MAX_QUANTITY + 10);
  assert.equal(bigTake.taken, GAME_INVENTORY_MAX_QUANTITY + 10);
  assert.deepEqual(piles(bigTake.stacks), [["Coin", GAME_INVENTORY_MAX_QUANTITY - 10]]);
  const same = apples();
  const none = takeFromGameInventory(same, "Lantern", 1);
  assert.equal(none.stacks, same);
  assert.equal(none.taken, 0);
  assert.equal(gameInventoryCount(apples(), " APPLE"), 300);
  assert.deepEqual(gameInventoryTotals(apples()), [
    { name: "Apple", quantity: 300, item: gameInventoryPlainItemId("Apple") },
    { name: "Rope", quantity: 1, item: gameInventoryPlainItemId("Rope") },
  ]);
}

// ── One stack's count ──
{
  const same = apples();
  assert.deepEqual(piles(setGameInventoryStackQuantity(same, "a2", 150)).at(-1), ["Apple", 150]);
  assert.deepEqual(ids(setGameInventoryStackQuantity(same, "r1", 0)), ["a1", "a2"], "zero removes the stack");
  assert.equal(setGameInventoryStackQuantity(same, "a1", 200), same);
  assert.equal(setGameInventoryStackQuantity(same, "missing", 3), same);
  assert.equal(setGameInventoryStackQuantity(same, "a1", Number.NaN), same);
  assert.equal(
    setGameInventoryStackQuantity(same, "a1", GAME_INVENTORY_MAX_QUANTITY * 2)[0]!.quantity,
    GAME_INVENTORY_MAX_QUANTITY,
  );
}

// ── Splitting ──
{
  const pile: GameInventoryStack[] = [
    { id: "a", name: "Apple", quantity: 300 },
    { id: "r", name: "Rope", quantity: 1 },
  ];
  const split = splitGameInventoryStack(pile, "a", 100, fixedId("b"));
  assert.deepEqual(
    split,
    [
      { id: "a", name: "Apple", quantity: 200 },
      { id: "b", name: "Apple", quantity: 100 },
      { id: "r", name: "Rope", quantity: 1 },
    ],
    "300 split by 100 is 200 and 100, side by side",
  );
  for (const size of [0, 300, 301, -1, 1.5, Number.NaN]) {
    assert.equal(splitGameInventoryStack(pile, "a", size), pile, `a split of ${size} changes nothing`);
  }
  assert.equal(splitGameInventoryStack(pile, "r", 1), pile, "a single item cannot be split");
  const fresh = splitGameInventoryStack(pile, "a", 1);
  assert.equal(new Set(ids(fresh)).size, 3, "a split without a given id still makes a new one");
}

// ── Merging ──
{
  const same = apples();
  const merged = mergeGameInventoryStacks(same, "a2", "a1");
  assert.deepEqual(
    merged,
    [
      { id: "a1", name: "Apple", quantity: 300 },
      { id: "r1", name: "Rope", quantity: 1 },
    ],
    "into the target, which keeps its place",
  );
  assert.equal(mergeGameInventoryStacks(same, "r1", "a1"), same, "two different items never merge");
  assert.equal(mergeGameInventoryStacks(same, "a1", "a1"), same);
  assert.equal(mergeGameInventoryStacks(same, "a1", "missing"), same);
  const full: GameInventoryStack[] = [
    { id: "x", name: "Coin", quantity: GAME_INVENTORY_MAX_QUANTITY },
    { id: "y", name: "Coin", quantity: 1 },
  ];
  assert.equal(mergeGameInventoryStacks(full, "y", "x"), full, "nothing pours into a full stack");
  const nearlyFull: GameInventoryStack[] = [
    { id: "x", name: "Coin", quantity: GAME_INVENTORY_MAX_QUANTITY - 2 },
    { id: "y", name: "Coin", quantity: 5 },
  ];
  assert.deepEqual(
    mergeGameInventoryStacks(nearlyFull, "y", "x").map((stack) => [stack.id, stack.quantity]),
    [
      ["x", GAME_INVENTORY_MAX_QUANTITY],
      ["y", 3],
    ],
    "only what fits pours in, and the rest stays where it was",
  );
}

// ── Renaming one stack: a nickname, never another item ──
{
  const same = apples();
  const renamed = renameGameInventoryStack(same, "a2", "Green apple")!;
  assert.equal(renamed.id, "a2");
  assert.deepEqual(
    renamed.stacks[2],
    { id: "a2", name: "Apple", nickname: "Green apple", item: gameInventoryPlainItemId("Apple"), quantity: 100 },
    "only that stack is called something else, and it is still an apple",
  );
  assert.equal(gameInventoryItemId(renamed.stacks[2]!), gameInventoryItemId(same[0]!));
  assert.equal(gameInventoryCount(renamed.stacks, "Apple"), 300, "named by its own name");
  assert.equal(gameInventoryCount(renamed.stacks, "green APPLE"), 300, "or by the nickname, any case");
  assert.deepEqual(gameInventoryTotals(renamed.stacks), [
    { name: "Apple", quantity: 300, item: gameInventoryPlainItemId("Apple") },
    { name: "Rope", quantity: 1, item: gameInventoryPlainItemId("Rope") },
  ]);
  const into = renameGameInventoryStack(same, "r1", "Apple")!;
  assert.equal(into.id, "r1", "a rope called Apple is never poured into the apples");
  assert.deepEqual(piles(into.stacks), [
    ["Apple", 200],
    ["Apple", 1],
    ["Apple", 100],
  ]);
  assert.equal(gameInventoryCount(into.stacks, "rope"), 1, "it is still a rope");
  assert.equal(mergeGameInventoryStacks(into.stacks, "r1", "a1"), into.stacks, "and never merges with them");
  const back = renameGameInventoryStack(renamed.stacks, "a2", "  APPLE ")!;
  assert.deepEqual(back.stacks[2], { ...same[2], item: gameInventoryPlainItemId("Apple") }, "the item's own name, in any case, clears the nickname");
  assert.equal(renameGameInventoryStack(same, "a2", "APPLE")!.stacks, same, "which is nothing to clear here");
  assert.equal(renameGameInventoryStack(same, "a1", "Apple")!.stacks, same);
  assert.equal(renameGameInventoryStack(renamed.stacks, "a2", "Green apple")!.stacks, renamed.stacks);
  assert.equal(renameGameInventoryStack(same, "missing", "X"), null);
  assert.equal(renameGameInventoryStack(same, "a1", "   "), null);
  // Nicknames read back as they were saved, and one that is the own name again is dropped.
  assert.deepEqual(
    normalizeGameInventoryStacks([
      { id: "x", name: "Rope", nickname: "  Grandpa's   rope ", quantity: 2 },
      { id: "y", name: "Rope", nickname: "ROPE", quantity: 1 },
      { id: "z", name: "Rope", nickname: 7, quantity: 1 },
    ]),
    [
      { id: "x", name: "Rope", nickname: "Grandpa's rope", item: gameInventoryPlainItemId("Rope"), quantity: 2 },
      { id: "y", name: "Rope", item: gameInventoryPlainItemId("Rope"), quantity: 1 },
      { id: "z", name: "Rope", item: gameInventoryPlainItemId("Rope"), quantity: 1 },
    ],
  );
}

// ── Which item a name makes ──
{
  assert.equal(gameInventoryPlainItemId("Rope"), "plain:rope");
  assert.equal(gameInventoryPlainItemId("  ROPE!! "), "plain:rope", "case, spacing and punctuation aside");
  assert.equal(gameInventoryPlainItemId("Health Potion"), "plain:health-potion");
  assert.equal(gameInventoryPlainItemId("Épée"), "plain:epee", "accents aside");
  assert.equal(gameInventoryPlainItemId("Меч"), "plain:меч", "every script keeps its letters");
  assert.notEqual(gameInventoryPlainItemId("Меч"), gameInventoryPlainItemId("Щит"), "so two such items stay two");
  assert.notEqual(
    gameInventoryPlainItemId("がく"),
    gameInventoryPlainItemId("かく"),
    "a dakuten is part of the letter",
  );
  assert.notEqual(gameInventoryPlainItemId("किताब"), gameInventoryPlainItemId("कताब"), "and so is a vowel sign");
  assert.equal(
    gameInventoryPlainItemId("\u304c"),
    gameInventoryPlainItemId("\u304b\u3099"),
    "however the name was typed: composed or not",
  );
  assert.notEqual(gameInventoryPlainItemId("Sword +1"), gameInventoryPlainItemId("Sword -1"), "a sign is kept");
  assert.notEqual(gameInventoryPlainItemId("Sword +1"), gameInventoryPlainItemId("Sword 1"));
  assert.equal(gameInventoryPlainItemId("Sword+1"), gameInventoryPlainItemId("Sword +1"), "spaced or not");
  assert.equal(gameInventoryPlainItemId("Sword \u22121"), gameInventoryPlainItemId("Sword -1"), "a real minus too");
  assert.equal(gameInventoryPlainItemId("-1 Sword"), gameInventoryPlainItemId("\u22121 sword"), "at the start too");
  assert.equal(gameInventoryPlainItemId("Mk-2 Lamp"), gameInventoryPlainItemId("Mk 2 Lamp"), "a hyphen is a dash");
  assert.equal(gameInventoryPlainItemId("Rope + Hook"), gameInventoryPlainItemId("Rope Hook"), "no number, no sign");
  assert.notEqual(gameInventoryPlainItemId("🍎"), gameInventoryPlainItemId("🍐"));
  const long = `${"a".repeat(50)}1`;
  assert.notEqual(gameInventoryPlainItemId(long), gameInventoryPlainItemId(`${"a".repeat(50)}2`), "not cut into one");
  assert.ok(gameInventoryPlainItemId(long).length <= 48);
}

// ── A new session carries every stack ──
{
  const carried = carryGameInventory(
    [
      { id: "st-a", name: "Apple", quantity: 200 },
      { id: "st-b", name: "Apple", quantity: 100 },
    ],
    [
      { name: "apple", description: "", quantity: 300, location: "on_person" },
      { name: "Map", description: "Of the valley", quantity: 1, location: "on_person" },
    ],
  );
  assert.deepEqual(
    piles(carried),
    [
      ["Apple", 200],
      ["Apple", 100],
      ["Map", 1],
    ],
    "both apple stacks survive, and the detailed inventory adds only what no stack holds",
  );
  assert.deepEqual(ids(carried).slice(0, 2), ["st-a", "st-b"]);
  // Nicknames carry over, and an entry that follows an item by id is that item under any name.
  assert.deepEqual(
    carryGameInventory(
      [{ id: "st-r", name: "Rope", nickname: "Grandpa's rope", item: gameInventoryPlainItemId("Rope"), quantity: 2 }],
      [
        { item: gameInventoryPlainItemId("Rope"), name: "Old faithful", description: "", quantity: 2, location: "" },
        { name: "grandpa's rope", description: "", quantity: 2, location: "" },
      ],
    ),
    [{ id: "st-r", name: "Rope", nickname: "Grandpa's rope", item: gameInventoryPlainItemId("Rope"), quantity: 2 }],
  );
  // An entry that follows an item nobody holds any more is carried, even when its name (a nickname)
  // is another held item's own name: it comes back as its own item, not onto the rope.
  const cordCarried = carryGameInventory(
    [{ id: "st-r", name: "Rope", quantity: 2 }],
    [
      { item: gameInventoryPlainItemId("Cord"), name: "Rope", description: "", quantity: 1, location: "" },
      { item: gameInventoryPlainItemId("Lamp"), name: "Lamp", description: "", quantity: 1, location: "" },
    ],
  );
  assert.deepEqual(
    cordCarried.map(({ name, nickname, quantity }) => [name, nickname ?? null, quantity]),
    [
      ["Rope", null, 2],
      ["cord", "Rope", 1],
      ["Lamp", null, 1],
    ],
  );
  assert.equal(gameInventoryItemId(cordCarried[1]!), gameInventoryPlainItemId("Cord"));
  // A signed name reads back off its id, so a nicknamed "Sword -1" comes back as that very item.
  const [cursed] = carryGameInventory(
    [],
    [{ item: gameInventoryPlainItemId("Sword -1"), name: "Old Bitey", description: "", quantity: 1, location: "" }],
  );
  assert.equal(gameInventoryItemId(cursed!), gameInventoryPlainItemId("Sword -1"));
  assert.equal(gameInventoryStackLabel(cursed!), "Old Bitey");
  // An id that cannot be read back into a name (a fingerprint) comes back by name, and one cut short
  // comes back as the same item, the nickname shown over whatever own name it read back.
  const fingerprinted = gameInventoryPlainItemId("🍎");
  assert.deepEqual(
    carryGameInventory(
      [],
      [{ item: fingerprinted, name: "Apple charm", description: "", quantity: 1, location: "" }],
    ).map(({ name, nickname, quantity }) => [name, nickname ?? null, quantity]),
    [["Apple charm", null, 1]],
  );
  const longId = gameInventoryPlainItemId(`${"a".repeat(50)}1`);
  const [heirloom] = carryGameInventory(
    [],
    [{ item: longId, name: "Heirloom", description: "", quantity: 1, location: "" }],
  );
  assert.equal(gameInventoryItemId(heirloom!), longId);
  assert.equal(gameInventoryStackLabel(heirloom!), "Heirloom");
  assert.deepEqual(piles(carryGameInventory(undefined, [{ name: "Map", quantity: 1 }])), [["Map", 1]]);
  assert.deepEqual(
    piles(
      carryGameInventory(
        [],
        [
          { name: "Map", quantity: 1 },
          { name: "map", quantity: 2 },
        ],
      ),
    ),
    [["Map", 3]],
    "two detailed entries of a name no stack holds both count",
  );
}

// ── Ruleset items ──
{
  const known: GameInventoryRulesetItem[] = [
    { item: "outfitter/arrows", name: "Arrows", stack: 20 },
    { item: "outfitter/hand-axe", name: "Hand axe" },
    { item: "kit/relic", name: "Relic", stack: 1 },
    // A layer of this game hides it: it can be held, but not added by its id.
    { item: "kit/veiled", name: "Veiled lamp" },
  ];
  const rules = (plain: "allow" | "refuse" = "allow"): GameInventoryItemRules => ({
    itemNamed: (name) =>
      known.find((each) => each.item !== "kit/veiled" && each.name.toLowerCase() === name.trim().toLowerCase()),
    itemOf: (item) => known.find((each) => each.item === item),
    offers: (item) => item !== "kit/veiled" && known.some((each) => each.item === item),
    plain,
  });
  let n = 0;
  const next = () => `n${++n}`;
  const shape = (stacks: GameInventoryStack[]) =>
    stacks.map((stack) => [gameInventoryStackLabel(stack), stack.item ?? null, stack.quantity, stack.holder ?? null]);

  // A stack of a ruleset item is that item, whatever it is called, and apart from a plain one.
  assert.equal(gameInventoryItemId({ name: "Arrows", item: "outfitter/arrows" }), "outfitter/arrows");
  assert.notEqual(
    gameInventoryItemId({ name: "Arrows", item: "outfitter/arrows" }),
    gameInventoryItemId({ name: "Arrows" }),
  );
  assert.equal(gameInventoryItemId({ name: "Quiver", item: "outfitter/arrows" }), "outfitter/arrows");
  // Read back as saved; anything that is not a catalog and an entry is dropped.
  assert.deepEqual(
    normalizeGameInventoryStacks([
      { id: "a", name: "Arrows", item: "outfitter/arrows", quantity: 3 },
      { id: "b", name: "Rope", item: "plain:rope", quantity: 1 },
      { id: "c", name: "Axe", item: "Outfitter/Axe", quantity: 1 },
      { id: "d", name: "Axe", item: `outfitter/${"a".repeat(130)}`, quantity: 1 },
    ]).map((stack) => stack.item ?? null),
    ["outfitter/arrows", "plain:rope", "plain:axe", "plain:axe"],
  );

  // A name that is one of the ruleset's items adds that item, called by its label.
  const axe = addToGameInventoryNamed([], "HAND AXE", 1, next, undefined, rules());
  assert.deepEqual(shape(axe!.stacks), [["Hand axe", "outfitter/hand-axe", 1, null]]);
  // Its nickname finds it too, and a plain item called by the same name is another item.
  const nicknamed: GameInventoryStack[] = [
    { id: "q", name: "Arrows", nickname: "Quiver", item: "outfitter/arrows", quantity: 5 },
  ];
  assert.deepEqual(shape(addToGameInventoryNamed(nicknamed, "quiver", 2, next, undefined, rules())!.stacks), [
    ["Quiver", "outfitter/arrows", 7, null],
  ]);
  // A plain stack that only has the ruleset item's name as its own gives way to the ruleset's item.
  const plainArrows: GameInventoryStack[] = [{ id: "p", name: "Arrows", quantity: 4 }];
  assert.deepEqual(shape(addToGameInventoryNamed(plainArrows, "Arrows", 2, next, undefined, rules())!.stacks), [
    ["Arrows", null, 4, null],
    ["Arrows", "outfitter/arrows", 2, null],
  ]);
  // Without rules a name is a plain item, as before.
  assert.deepEqual(shape(addToGameInventoryNamed([], "Hand axe", 1, next)!.stacks), [["Hand axe", "plain:hand-axe", 1, null]]);
  // By its id; one the ruleset does not have is refused.
  assert.deepEqual(shape(addGameInventoryRulesetItem([], "outfitter/hand-axe", 2, next, "Bram", rules())!.stacks), [
    ["Hand axe", "outfitter/hand-axe", 2, "Bram"],
  ]);
  assert.equal(addGameInventoryRulesetItem([], "outfitter/missing", 1, next, undefined, rules()), null);
  assert.equal(addGameInventoryRulesetItem([], "kit/veiled", 1, next, undefined, rules()), null, "a layer hides it");
  assert.equal(addGameInventoryRulesetItem([], "outfitter/hand-axe", 1, next), null, "no rules, no ruleset items");

  // Only the ruleset's items, and items already held, when plain ones are refused.
  assert.equal(addToGameInventoryNamed([], "Rope", 1, next, undefined, rules("refuse")), null);
  assert.ok(addToGameInventoryNamed([], "Arrows", 1, next, undefined, rules("refuse")));
  const heldRope: GameInventoryStack[] = [{ id: "r", name: "Rope", quantity: 1 }];
  assert.deepEqual(shape(addToGameInventoryNamed(heldRope, "rope", 1, next, undefined, rules("refuse"))!.stacks), [
    ["Rope", null, 2, null],
  ]);
  const refusedOps = applyGameInventoryOps(
    [],
    [
      { op: "add", name: "Rope", count: 1 },
      { op: "add", name: "Relic", item: "kit/missing", count: 1 },
      { op: "add", name: "Veiled lamp", item: "kit/veiled", count: 1 },
      { op: "add", name: "Relic", item: "kit/relic", count: 1 },
      { op: "add", name: "Relic", item: "kit/relic", count: GAME_INVENTORY_MAX_NEW_STACKS + 1 },
    ],
    next,
    rules("refuse"),
  );
  assert.deepEqual(
    refusedOps.results.map((result) => (result.ok ? "ok" : result.reason)),
    ["not-ruleset-item", "not-ruleset-item", "not-ruleset-item", "ok", "refused"],
  );

  // A stack of arrows holds 20: an addition fills the bag's stacks of it in order, then starts new
  // ones of at most 20.
  const quivers: GameInventoryStack[] = [
    { id: "a1", name: "Arrows", item: "outfitter/arrows", quantity: 18 },
    { id: "rope", name: "Rope", quantity: 1 },
    { id: "a2", name: "Arrows", item: "outfitter/arrows", quantity: 15 },
    { id: "a3", name: "Arrows", item: "outfitter/arrows", quantity: 2, holder: "Bram" },
  ];
  const topped = addToGameInventoryNamed(quivers, "arrows", 30, next, undefined, rules())!;
  assert.deepEqual(
    topped.stacks.map((stack) => [stack.id.startsWith("n") ? "new" : stack.id, stack.quantity, stack.holder ?? null]),
    [
      ["a1", 20, null],
      ["rope", 1, null],
      ["a2", 20, null],
      ["a3", 2, "Bram"],
      ["new", 20, null],
      ["new", 3, null],
    ],
  );
  assert.equal(topped.id, "a1", "the stack it went onto first");
  // One change never starts more than GAME_INVENTORY_MAX_NEW_STACKS stacks.
  assert.equal(addToGameInventoryNamed([], "Relic", GAME_INVENTORY_MAX_NEW_STACKS + 1, next, undefined, rules()), null);
  assert.equal(
    addToGameInventoryNamed([], "Relic", GAME_INVENTORY_MAX_NEW_STACKS, next, undefined, rules())!.stacks.length,
    GAME_INVENTORY_MAX_NEW_STACKS,
  );
  // Setting past 20 fills that stack and puts the rest in new stacks right after it.
  const set = setGameInventoryStackQuantity(quivers, "a2", 45, next, rules());
  assert.deepEqual(
    set.map((stack) => [stack.id.startsWith("n") ? "new" : stack.id, stack.quantity]),
    [
      ["a1", 18],
      ["rope", 1],
      ["a2", 20],
      ["new", 20],
      ["new", 5],
      ["a3", 2],
    ],
  );
  assert.ok(set.every((stack) => stack.item === quivers.find((each) => each.name === stack.name)?.item));
  assert.equal(setGameInventoryStackQuantity(quivers, "a2", 12, next, rules())[2]!.quantity, 12);
  const relics: GameInventoryStack[] = [{ id: "z", name: "Relic", item: "kit/relic", quantity: 1 }];
  assert.equal(
    setGameInventoryStackQuantity(relics, "z", GAME_INVENTORY_MAX_NEW_STACKS + 2, next, rules()),
    relics,
    "a count that would start too many stacks changes nothing",
  );
  const setOps = applyGameInventoryOps(
    quivers,
    [
      { op: "set", id: "a2", quantity: 45 },
      { op: "set", id: "a1", quantity: 5000 },
    ],
    next,
    rules(),
  );
  assert.deepEqual(
    setOps.results.map((result) => (result.ok ? [result.count, result.now] : result.reason)),
    [[30, 20], "refused"],
  );
  // Pouring fills the stack poured into up to 20 and leaves the rest.
  assert.deepEqual(
    mergeGameInventoryStacks(quivers, "a2", "a1", rules()).map((stack) => [stack.id, stack.quantity]),
    [
      ["a1", 20],
      ["rope", 1],
      ["a2", 13],
      ["a3", 2],
    ],
  );
  // Giving onto a receiver's stack fills it and starts a new one there for the rest.
  const given = giveGameInventoryStack(quivers, "a2", "Bram", 15, next, rules())!;
  assert.deepEqual(shape(given.stacks), [
    ["Arrows", "outfitter/arrows", 18, null],
    ["Rope", null, 1, null],
    ["Arrows", "outfitter/arrows", 17, "Bram"],
  ]);
  // Past what the receiver's stack can take, the rest starts a new stack in their bag.
  const overflowing = giveGameInventoryStack(given.stacks, "a1", "Bram", 18, next, rules())!;
  assert.deepEqual(shape(overflowing.stacks), [
    ["Rope", null, 1, null],
    ["Arrows", "outfitter/arrows", 20, "Bram"],
    ["Arrows", "outfitter/arrows", 15, "Bram"],
  ]);
  assert.equal(overflowing.id, "a3", "the receiver's stack it went onto first");
  // A plain item has no such limit.
  assert.deepEqual(shape(addToGameInventoryNamed(heldRope, "Rope", 500, next)!.stacks), [["Rope", null, 501, null]]);

  // Taking and counting by name find the ruleset item by its own name; a split keeps the item.
  assert.deepEqual(shape(takeFromGameInventory(quivers, "ARROWS", 20).stacks), [
    ["Rope", null, 1, null],
    ["Arrows", "outfitter/arrows", 13, null],
    ["Arrows", "outfitter/arrows", 2, "Bram"],
  ]);
  assert.equal(gameInventoryCount(quivers, "arrows"), 35);
  assert.deepEqual([...gameInventoryItemsOwnNamed([...quivers, ...plainArrows], "Arrows")].sort(), [
    "outfitter/arrows",
    gameInventoryPlainItemId("Arrows"),
  ]);
  assert.ok(splitGameInventoryStack(quivers, "a1", 5, next).every((stack) => stack.name !== "Arrows" || stack.item));
  assert.equal(renameGameInventoryStack(quivers, "a1", "Quiver")!.stacks[0]!.item, "outfitter/arrows");
  assert.deepEqual(gameInventoryTotals(quivers)[0], { name: "Arrows", quantity: 35, item: "outfitter/arrows" });
  // Two inventories that differ only in which item a stack is are not the same inventory.
  assert.equal(
    sameGameInventory(
      [{ id: "x", name: "Arrows", item: "outfitter/arrows", quantity: 1 }],
      [{ id: "x", name: "Arrows", quantity: 1 }],
    ),
    false,
  );

  // A new session brings back a ruleset item the detailed inventory names and no stack holds as that
  // item, under the name its entry shows, and never adds one a stack still holds.
  assert.deepEqual(
    shape(
      carryGameInventory(
        [{ id: "a1", name: "Arrows", item: "outfitter/arrows", quantity: 3 }],
        [
          { item: "outfitter/arrows", name: "Arrows", description: "", quantity: 3, location: "" },
          { item: "outfitter/hand-axe", name: "Old Bitey", description: "", quantity: 1, location: "" },
        ],
      ),
    ),
    [
      ["Arrows", "outfitter/arrows", 3, null],
      ["Old Bitey", "outfitter/hand-axe", 1, null],
    ],
  );
  // With the ruleset's items, an id the ruleset no longer has comes back by its entry's name, while one
  // a layer hides is still that item.
  assert.deepEqual(
    shape(
      carryGameInventory(
        [],
        [
          { item: "outfitter/gone", name: "Old lantern", description: "", quantity: 1, location: "" },
          { item: "kit/veiled", name: "Veiled lamp", description: "", quantity: 1, location: "" },
        ],
        rules(),
      ),
    ),
    [
      ["Old lantern", "plain:old-lantern", 1, null],
      ["Veiled lamp", "kit/veiled", 1, null],
    ],
  );
  // With the ruleset's items, what comes back is stacked as its item allows, and an entry written
  // without an id whose name is one of them comes back as that item.
  assert.deepEqual(
    shape(
      carryGameInventory(
        [],
        [
          { item: "outfitter/arrows", name: "Arrows", description: "", quantity: 30, location: "" },
          { name: "hand axe", description: "", quantity: 1, location: "" },
        ],
        rules(),
      ),
    ),
    [
      ["Arrows", "outfitter/arrows", 20, null],
      ["Arrows", "outfitter/arrows", 10, null],
      ["Hand axe", "outfitter/hand-axe", 1, null],
    ],
  );
}

// ── The amount field ──
{
  assert.equal(parseInventoryAmount("300", 10), 300);
  assert.equal(parseInventoryAmount(" +100 ", 300), 400);
  assert.equal(parseInventoryAmount("-50", 300), 250);
  assert.equal(parseInventoryAmount("- 500", 300), 0, "taking more than there is empties the stack");
  assert.equal(parseInventoryAmount("0", 300), 0);
  for (const text of ["", "abc", "1.5", "+", "3e2", "--5"]) {
    assert.equal(parseInventoryAmount(text, 300), null, `"${text}" is not an amount`);
  }
  assert.equal(parseInventoryAmount(String(GAME_INVENTORY_MAX_QUANTITY + 1), 0), null);
  assert.equal(parseInventoryAmount("+1", GAME_INVENTORY_MAX_QUANTITY), null);
  assert.equal(defaultInventorySplitSize(300), 150);
  assert.equal(defaultInventorySplitSize(3), 1);
  assert.equal(defaultInventorySplitSize(2), 1);
}

console.log("game-inventory-stacks regression passed");
