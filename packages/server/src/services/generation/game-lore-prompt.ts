import type { LorebookEntry } from "@marinara-engine/shared";
import type { LorebookScanResult } from "../lorebook/index.js";

export interface GameLorePromptParts {
  stable?: string;
  runtime?: string;
}

type StoredLoreMetadata = Pick<LorebookEntry, "alwaysLoaded" | "content" | "order" | "position">;

const hasMacroTemplateSyntax = (value: string): boolean => /\{\{[^{}]+\}\}/u.test(value);

/**
 * Split fallback game lore without rescanning or promoting macro-bearing content
 * into the provider's stable cache prefix.
 */
export function splitGameLorePrompt(
  scan: Pick<LorebookScanResult, "worldInfoBefore" | "worldInfoAfter" | "activatedEntries">,
  storedById: ReadonlyMap<string, StoredLoreMetadata | null | undefined>,
): GameLorePromptParts {
  const activated = scan.activatedEntries;
  const metadata = activated.map((entry) => ({ entry, stored: storedById.get(entry.id) }));
  if (metadata.some(({ stored }) => !stored)) {
    const runtime = [scan.worldInfoBefore, scan.worldInfoAfter].filter(Boolean).join("\n");
    return runtime ? { runtime } : {};
  }

  const stableBefore: Array<{ order: number; index: number; content: string }> = [];
  const stableAfter: Array<{ order: number; index: number; content: string }> = [];
  const runtimeBefore: Array<{ order: number; index: number; content: string }> = [];
  const runtimeAfter: Array<{ order: number; index: number; content: string }> = [];

  metadata.forEach(({ entry, stored }, index) => {
    if (!stored || (stored.position !== 0 && stored.position !== 1)) return;
    const destination =
      stored.position === 0
        ? stored.alwaysLoaded === true && !hasMacroTemplateSyntax(stored.content)
          ? stableBefore
          : runtimeBefore
        : stored.alwaysLoaded === true && !hasMacroTemplateSyntax(stored.content)
          ? stableAfter
          : runtimeAfter;
    destination.push({ order: stored.order, index, content: entry.content });
  });

  const orderParts = (parts: Array<{ order: number; index: number; content: string }>): string =>
    parts
      .slice()
      .sort((left, right) => left.order - right.order || left.index - right.index)
      .map((part) => part.content)
      .join("\n\n");
  const stable = [orderParts(stableBefore), orderParts(stableAfter)].filter(Boolean).join("\n");
  const runtime = [orderParts(runtimeBefore), orderParts(runtimeAfter)].filter(Boolean).join("\n");
  return {
    ...(stable ? { stable } : {}),
    ...(runtime ? { runtime } : {}),
  };
}
