// ──────────────────────────────────────────────
// Lorebook: Prompt Injector
// Takes activated lorebook entries and injects
// them into the prompt at the correct positions
// (WORLD_INFO_BEFORE / WORLD_INFO_AFTER / depth).
// ──────────────────────────────────────────────
import { estimateTextTokens, type LorebookRole } from "@marinara-engine/shared";
import type { ActivatedEntry } from "./keyword-scanner.js";

/** A prompt message ready for injection. */
export interface PromptMessage {
  role: "system" | "user" | "assistant";
  content: string;
  contextKind?: "prompt" | "history" | "injection";
  /** Optional name for multi-character */
  name?: string;
}

export interface ProcessActivatedEntriesOptions {
  /**
   * Keep the given entry order inside each block, depth and outlet instead of sorting by entry order. Set when the
   * entries are already in their stable lore order (stable-lore-order.ts), so the block only grows at its end.
   */
  preserveOrder?: boolean;
}

export interface InjectAtDepthOptions {
  /** Earliest index an entry may be inserted at. */
  minIndex?: number;
  /** Index considered "after the last message" for depth 0. Defaults to the full prompt length. */
  anchorIndex?: number;
}

/**
 * Build the World Info content blocks from activated entries.
 * Position 0 = WORLD_INFO_BEFORE (before character defs)
 * Position 1 = WORLD_INFO_AFTER (after character defs)
 */
export function buildWorldInfoBlocks(
  activatedEntries: ActivatedEntry[],
  options: ProcessActivatedEntriesOptions = {},
): {
  before: string;
  after: string;
} {
  const beforeParts: string[] = [];
  const afterParts: string[] = [];

  // Sort by order, unless the caller already put the entries in their stable (cache-friendly) order.
  const sorted = options.preserveOrder
    ? [...activatedEntries]
    : [...activatedEntries].sort((a, b) => a.entry.order - b.entry.order);

  for (const { entry } of sorted) {
    if (entry.position <= 0) {
      beforeParts.push(entry.content);
    } else if (entry.position === 1) {
      afterParts.push(entry.content);
    }
    // Position 2 entries are handled by getDepthInjectedEntries.
    // Position 7 entries are named Outlets and are never injected automatically.
  }

  return {
    before: beforeParts.join("\n\n"),
    after: afterParts.join("\n\n"),
  };
}

/**
 * Get entries that should be injected at specific depths in the message array.
 * Only entries with position 2 (depth injection mode) are included.
 * Position 0/1 entries always go to worldInfoBefore/After via buildWorldInfoBlocks.
 */
export function getDepthInjectedEntries(
  activatedEntries: ActivatedEntry[],
  options: ProcessActivatedEntriesOptions = {},
): Array<{
  content: string;
  role: LorebookRole;
  depth: number;
  order: number;
}> {
  return activatedEntries
    .filter((a) => a.entry.position === 2 && a.entry.depth >= 0)
    .map((a, index) => ({
      content: a.entry.content,
      role: a.entry.role,
      depth: a.entry.depth,
      order: a.entry.order,
      index,
    }))
    .sort((a, b) => {
      // An explicit depth always wins. Within one depth: entry order, or the stable order the caller kept.
      if (a.depth !== b.depth) return a.depth - b.depth;
      return options.preserveOrder ? a.index - b.index : a.order - b.order;
    })
    .map(({ content, role, depth, order }) => ({ content, role, depth, order }));
}

/**
 * Inject depth-based entries into a message array.
 * Depth 0 = after the latest message, depth 1 = before the last message, etc.
 */
export function injectAtDepth(
  messages: PromptMessage[],
  depthEntries: Array<{ content: string; role: LorebookRole; depth: number }>,
  options: InjectAtDepthOptions = {},
): PromptMessage[] {
  if (depthEntries.length === 0) return messages;

  const result = [...messages];
  const baseLength = messages.length;
  const minIndex = Math.min(Math.max(0, options.minIndex ?? 0), baseLength);
  const anchorIndex = Math.min(Math.max(minIndex, options.anchorIndex ?? baseLength), baseLength);

  // Group entries by the final original-array insertion index. Computing
  // all targets before splicing keeps depth 0 anchored after the original
  // last message even when deeper entries are inserted earlier.
  const byIndex = new Map<number, Array<{ content: string; role: LorebookRole; depth: number; order: number }>>();
  for (const [order, entry] of depthEntries.entries()) {
    const depth = Number.isFinite(entry.depth) ? Math.max(0, Math.floor(entry.depth)) : 0;
    const insertionIndex = Math.max(minIndex, anchorIndex - depth);
    const list = byIndex.get(insertionIndex) ?? [];
    list.push({ content: entry.content, role: entry.role, depth, order });
    byIndex.set(insertionIndex, list);
  }

  // Process later original indices first so earlier insertions do not shift them.
  const insertionIndexes = [...byIndex.keys()].sort((a, b) => b - a);

  for (const insertionIndex of insertionIndexes) {
    const entries = (byIndex.get(insertionIndex) ?? []).sort((a, b) => a.depth - b.depth || a.order - b.order);

    const toInsert: PromptMessage[] = entries.map((e) => ({
      role: e.role,
      content: e.content,
      contextKind: "injection",
    }));

    result.splice(insertionIndex, 0, ...toInsert);
  }

  return result;
}

/**
 * Apply token budget to activated entries.
 * Trims entries (by priority/order) until total tokens are within budget.
 * Uses the shared lightweight token estimator.
 */
export function applyTokenBudget(activatedEntries: ActivatedEntry[], tokenBudget: number): ActivatedEntry[] {
  if (tokenBudget <= 0) return activatedEntries;

  let totalTokens = 0;
  const result: ActivatedEntry[] = [];

  // Sort: explicit Always Loaded entries first, then compatibility constants, then order.
  const sorted = [...activatedEntries].sort((a, b) => {
    if (a.entry.alwaysLoaded && !b.entry.alwaysLoaded) return -1;
    if (!a.entry.alwaysLoaded && b.entry.alwaysLoaded) return 1;
    if (a.entry.constant && !b.entry.constant) return -1;
    if (!a.entry.constant && b.entry.constant) return 1;
    return a.entry.order - b.entry.order;
  });

  for (const entry of sorted) {
    const entryTokens = estimateTextTokens(entry.entry.content);
    if (entry.entry.alwaysLoaded) {
      result.push(entry);
      continue;
    }
    if (totalTokens + entryTokens > tokenBudget) {
      // Budget exhausted — skip remaining entries
      break;
    }
    totalTokens += entryTokens;
    result.push(entry);
  }

  return result;
}

/**
 * Full pipeline: process activated entries into injectable content.
 */
export function processActivatedEntries(
  activatedEntries: ActivatedEntry[],
  tokenBudget: number = 0,
  options: ProcessActivatedEntriesOptions = {},
): {
  worldInfoBefore: string;
  worldInfoAfter: string;
  depthEntries: Array<{ content: string; role: LorebookRole; depth: number; order: number }>;
  outlets: Record<string, string>;
  totalEntries: number;
  totalTokensEstimate: number;
} {
  // Apply budget
  // Legacy unnamed outlets have no injection target and must not count as included.
  const budgeted = applyTokenBudget(
    activatedEntries.filter(({ entry }) => entry.position !== 7 || Boolean(entry.outletName?.trim())),
    tokenBudget,
  );

  // Build blocks
  const { before, after } = buildWorldInfoBlocks(budgeted, options);

  // Get depth entries
  const depthEntries = getDepthInjectedEntries(budgeted, options);

  // Outlet names are deliberately exact and case-sensitive. Activated entries
  // with the same name are joined in insertion order, but are not injected at
  // any automatic lorebook position.
  const outletParts = new Map<string, string[]>();
  const outletOrder = options.preserveOrder
    ? [...budgeted]
    : [...budgeted].sort((a, b) => a.entry.order - b.entry.order);
  for (const { entry } of outletOrder) {
    if (entry.position !== 7 || !entry.outletName) continue;
    const parts = outletParts.get(entry.outletName) ?? [];
    parts.push(entry.content);
    outletParts.set(entry.outletName, parts);
  }
  const outlets = Object.fromEntries(Array.from(outletParts, ([name, parts]) => [name, parts.join("\n")]));

  // Estimate tokens
  const totalTokensEstimate = estimateTextTokens(budgeted.map((a) => a.entry.content).join(""));

  return {
    worldInfoBefore: before,
    worldInfoAfter: after,
    depthEntries,
    outlets,
    totalEntries: budgeted.length,
    totalTokensEstimate,
  };
}
