// ──────────────────────────────────────────────
// Game Mode rulesets: the items a game's inventory can hold
//
// A ruleset lists its items in catalogs that hold items. The inventory reads them through one book:
// which name is which item (a label, in any case), how many of one a stack holds, and what the
// screen and the Game Master are shown about it. The server builds the book from the catalogs it
// loads and the browser from the ones it fetches, so both read an item the same way.
// ──────────────────────────────────────────────
import type {
  RulesetCatalogEntry,
  RulesetCatalogItem,
  RulesetDefinition,
  RulesetItemStat,
} from "../../schemas/ruleset.schema.js";
import {
  gameInventoryNameKey,
  type GameInventoryItemRules,
  type GameInventoryRulesetItem,
} from "../../utils/game-inventory-stacks.js";
import { catalogEntryHiddenByLayers, type RulesetLayerOptions } from "./layers.js";

/** One stat an item gives, in the ruleset's words. `text` is absent for a yes-or-no stat that is
 *  yes, whose label says it all. */
export interface RulesetItemStatFact {
  id: string;
  label: string;
  text?: string;
  /** Whether the Game Master is shown it. */
  promptVisible: boolean;
}

/** What an item is, as labels: what the screen and the Game Master show. */
export interface RulesetItemFacts {
  category: string;
  rarity?: string;
  tags: string[];
  /** The stats the item gives, in the order the ruleset declares them. */
  stats: RulesetItemStatFact[];
  /** What it costs, in the unit's own label ("8", "shillings"). */
  cost?: { amount: number; unit: string };
}

export interface RulesetItemBookEntry extends GameInventoryRulesetItem {
  catalogId: string;
  /** The catalog entry, for a picker's search and filters. */
  entry: RulesetCatalogEntry;
  summary?: string;
  facts: RulesetItemFacts;
}

export interface RulesetItemBook extends GameInventoryItemRules {
  /** Every item a layer leaves in, catalog by catalog, in the order the ruleset lists them. */
  entries: readonly RulesetItemBookEntry[];
  /** Also an item a layer has taken out, so one already held still reads as itself. */
  itemOf(item: string): RulesetItemBookEntry | undefined;
  itemNamed(name: string): RulesetItemBookEntry | undefined;
}

function statText(stat: RulesetItemStat, value: string | number | boolean): string | undefined {
  if (stat.type === "boolean") return undefined;
  if (stat.type === "enum") return stat.valueLabels?.[String(value)] ?? String(value);
  return String(value);
}

/** An item's labels and stats, read against the ruleset's `items` block. */
export function rulesetItemFacts(definition: RulesetDefinition, item: RulesetCatalogItem): RulesetItemFacts {
  const block = definition.items;
  const labelOf = (words: ReadonlyArray<{ id: string; label: string }> | undefined, id: string) =>
    words?.find((word) => word.id === id)?.label ?? id;
  const stats = (block?.stats ?? []).flatMap((stat): RulesetItemStatFact[] => {
    const value = item.stats?.[stat.id];
    if (value === undefined || value === false || value === "") return [];
    const text = statText(stat, value);
    return [
      { id: stat.id, label: stat.label, ...(text !== undefined ? { text } : {}), promptVisible: stat.promptVisible },
    ];
  });
  const unit = item.cost
    ? block?.currencies?.flatMap((family) => family.units).find((each) => each.id === item.cost!.unit)
    : undefined;
  return {
    category: labelOf(block?.categories, item.category),
    ...(item.rarity ? { rarity: labelOf(block?.rarities, item.rarity) } : {}),
    tags: (item.tags ?? []).map((tag) => labelOf(block?.tags, tag)),
    stats,
    ...(item.cost ? { cost: { amount: item.cost.amount, unit: unit?.label ?? item.cost.unit } } : {}),
  };
}

/**
 * The book for a game: its ruleset's item catalogs, with the entries each has (`entries` by catalog
 * id; a catalog that could not be read is simply absent). `layerOptions` are the game's pinned layer
 * choices, which may take entries out. `plain` is whether something that is not one of these items
 * may be added: the ruleset's `freeform` for the player, and always for the Game Master until the
 * native switch arrives.
 */
export function rulesetItemBook(
  definition: RulesetDefinition,
  entries: Readonly<Record<string, readonly RulesetCatalogEntry[]>>,
  options: { layerOptions?: RulesetLayerOptions | null; plain?: "allow" | "refuse" } = {},
): RulesetItemBook {
  const all = new Map<string, RulesetItemBookEntry>();
  const visible: RulesetItemBookEntry[] = [];
  const offered = new Set<string>();
  const byName = new Map<string, RulesetItemBookEntry>();
  for (const catalog of definition.catalogs ?? []) {
    if (catalog.holds !== "items") continue;
    for (const entry of entries[catalog.id] ?? []) {
      if (!entry.item) continue;
      const read: RulesetItemBookEntry = {
        item: `${catalog.id}/${entry.id}`,
        name: entry.label,
        ...(entry.item.stack !== undefined ? { stack: entry.item.stack } : {}),
        catalogId: catalog.id,
        entry,
        ...(entry.summary ? { summary: entry.summary } : {}),
        facts: rulesetItemFacts(definition, entry.item),
      };
      all.set(read.item, read);
      if (catalogEntryHiddenByLayers(definition, options.layerOptions, catalog.id, entry)) continue;
      visible.push(read);
      offered.add(read.item);
      // Two items of one name: the first the ruleset lists is the one the name finds.
      const key = gameInventoryNameKey(entry.label);
      if (!byName.has(key)) byName.set(key, read);
    }
  }
  return {
    entries: visible,
    itemOf: (item) => all.get(item),
    offers: (item) => offered.has(item),
    itemNamed: (name) => byName.get(gameInventoryNameKey(name)),
    plain: options.plain ?? "allow",
  };
}

/** The item catalogs a ruleset declares: the ones the book is built from. */
export function rulesetItemCatalogIds(definition: RulesetDefinition): string[] {
  return (definition.catalogs ?? []).filter((catalog) => catalog.holds === "items").map((catalog) => catalog.id);
}

/** An item's facts as one line for the Game Master: category, rarity and tags, then the stats the
 *  ruleset shows it, such as "Weapon, Common, Thrown; Damage 1d6, Reach close". */
export function rulesetItemPromptFacts(facts: RulesetItemFacts): string {
  const kind = [facts.category, facts.rarity, ...facts.tags].filter(Boolean).join(", ");
  const stats = facts.stats
    .filter((stat) => stat.promptVisible)
    .map((stat) => (stat.text !== undefined ? `${stat.label} ${stat.text}` : stat.label))
    .join(", ");
  return stats ? `${kind}; ${stats}` : kind;
}
