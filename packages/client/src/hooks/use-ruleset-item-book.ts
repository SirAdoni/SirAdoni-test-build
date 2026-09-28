// The items a game's ruleset lists, read the way the server reads them (`rulesetItemBook`), so the
// inventory screen shows an item's details and offers the ruleset's items in its picker. Every item
// catalog is fetched with the query the sheet editor's picker uses, so one copy is cached.
import { useCallback, useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import {
  rulesetItemBook,
  rulesetItemCatalogIds,
  type RulesetCatalogEntry,
  type RulesetItemBook,
} from "@marinara-engine/shared";
import { rulesetCatalogQuery } from "./use-capability-packages";
import type { ResolvedGameRulesetClient } from "./use-game-ruleset";

/** The book for the player's own changes: undefined while the game has no ruleset with an `items`
 *  block. A catalog still loading, or one that failed, is simply not in it yet. */
export function useRulesetItemBook(ruleset: ResolvedGameRulesetClient): RulesetItemBook | undefined {
  const definition = ruleset.status === "ok" && ruleset.definition.items ? ruleset.definition : undefined;
  const layerOptions = ruleset.status === "ok" ? ruleset.layerOptions : undefined;
  const catalogIds = useMemo(() => (definition ? rulesetItemCatalogIds(definition) : []), [definition]);
  // Stable while the catalogs are, so useQueries only combines again when a query's result changes,
  // and the book below is only rebuilt when a catalog arrives.
  const combine = useCallback(
    (results: ReadonlyArray<{ data?: { entries: RulesetCatalogEntry[] } }>) => {
      const loaded: Record<string, RulesetCatalogEntry[]> = {};
      results.forEach((result, index) => {
        if (result.data) loaded[catalogIds[index]!] = result.data.entries;
      });
      return loaded;
    },
    [catalogIds],
  );
  const entries = useQueries({
    queries: catalogIds.map((catalogId) => rulesetCatalogQuery(definition!.id, catalogId, definition!.version)),
    combine,
  });
  return useMemo(
    () =>
      definition
        ? rulesetItemBook(definition, entries, {
            layerOptions,
            plain: definition.items?.freeform === "refuse" ? "refuse" : "allow",
          })
        : undefined,
    [definition, entries, layerOptions],
  );
}
