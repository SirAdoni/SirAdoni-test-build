import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../../lib/logger.js";
import { DATA_DIR } from "../../utils/data-dir.js";
import { isFeatureEnabled } from "../features/feature-settings.js";
import type { PromptCacheLayoutMessage } from "./prompt-cache-layout.js";

/**
 * Settings > Features "Cache-stable Game prompt" (gameCacheStableLayout).
 *
 * On the Claude subscription everything after the last finished exchange is written to the prompt cache again on
 * every turn, because the new exchange lands in front of it. A Game turn used to carry about 85,000 characters of
 * per-turn blocks there (format instructions, campaign memory, continuity records, the map, story secrets, pending
 * character cards), although most of them were byte-identical from one turn to the next.
 *
 * This layout keeps a per-chat baseline of those session-level blocks and sends it once, in the cached part of the
 * prompt just before the history. Each turn:
 * - a block that still matches its baseline leaves the tail (a short status note names it as current);
 * - a block that changed stays in the tail in full, and the note says it replaces the earlier copy;
 * - only the small live values (weather, morale, time, HUD values, inventory, recent transcript evidence) always ride
 *   in the tail.
 * The baseline is rewritten (one full cache rebuild) only when the settled changes carried in the tail, summed over
 * the turns they rode there, reach the size of that rebuild (everything from the baseline to the end of the prompt,
 * at least `GAME_STABLE_MIN_FOLD_CHARS`): the classic rent-or-buy rule, never more than twice the best choice in
 * hindsight. A block that changes on every turn never enters the baseline, so it never forces a rebuild; it simply
 * stays in the tail as before.
 */

export const GAME_STABLE_LAYOUT_VERSION = 1;
/** Never rebuild the baseline for less than this many carried characters, however short the chat. */
export const GAME_STABLE_MIN_FOLD_CHARS = 12_000;

/** Session-level blocks: large, and unchanged across most turns. Everything else stays where it is. */
export const GAME_SESSION_STABLE_TAGS: ReadonlySet<string> = new Set([
  "output_format",
  "story_arc_secret",
  "plot_twists_secret",
  "campaign_plan_secret",
  "gm_only_tracked_npcs",
  "gm_only_player_notes",
  "party",
  "named_character_updates",
  "campaign_memory",
  "game_continuity_context",
  "spatial_context",
]);

/** Lines of `<game_continuity_context>` from which the per-turn part begins (recent transcript evidence). */
const CONTINUITY_RECENT_MARKERS = ["UNREVIEWED RECENT SOURCE", "CONTINUITY_SUMMARY"];

export const GAME_STABLE_BASELINE_HEADER =
  "<session_context>\nSession-level GM context kept from earlier turns. Each block here is current unless the latest turn context restates it (the restated version replaces it) or lists it as no longer current.\n</session_context>";

export interface GameStableLayoutSnapshot {
  version: number;
  /** Blocks in the cached baseline, in their cached order, with the exact text they were cached with. */
  baseline: Array<{ key: string; text: string }>;
  /** Every session-level block of the previous build, to tell a settled change from one that keeps moving. */
  lastSeen: Record<string, string>;
  /** Characters of settled changes carried in the tail since the last rebuild, summed over turns. */
  carried?: number;
}

export interface GameStableLayoutResult<T> {
  messages: T[];
  snapshot: GameStableLayoutSnapshot | null;
  changed: boolean;
  folded: boolean;
  stats: {
    baselineChars: number;
    unchanged: string[];
    /** Changed blocks sent as line changes against the cached copy. */
    updated: string[];
    /** Changed blocks restated in full. */
    restated: string[];
    dropped: string[];
  };
}

interface Block {
  tag: string;
  open: string;
  start: number;
  end: number;
}

interface CurrentBlock {
  key: string;
  tag: string;
  text: string;
  /** Text left in place when the block is served from the baseline (continuity's recent evidence), or "". */
  residual: string;
  messageIndex: number;
  start: number;
  end: number;
}

/** Top-level `<tag ...>` ... `</tag>` blocks whose open and close tags each sit on their own line. */
export function parseTopLevelBlocks(content: string): Block[] {
  const blocks: Block[] = [];
  const lines: Array<{ text: string; start: number }> = [];
  let offset = 0;
  for (const text of content.split("\n")) {
    lines.push({ text, start: offset });
    offset += text.length + 1;
  }
  const openPattern = /^<([a-z][a-z0-9_]*)(?:\s[^<>]*)?>$/;
  for (let index = 0; index < lines.length; index += 1) {
    const match = openPattern.exec(lines[index]!.text);
    if (!match) continue;
    const tag = match[1]!;
    let depth = 0;
    let closeIndex = -1;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const text = lines[cursor]!.text;
      if (text === `</${tag}>`) {
        if (depth === 0) {
          closeIndex = cursor;
          break;
        }
        depth -= 1;
      } else if (text === `<${tag}>` || text.startsWith(`<${tag} `)) {
        depth += 1;
      }
    }
    if (closeIndex < 0) continue;
    const start = lines[index]!.start;
    const end = lines[closeIndex]!.start + lines[closeIndex]!.text.length;
    blocks.push({ tag, open: lines[index]!.text, start, end });
    index = closeIndex;
  }
  return blocks;
}

/** Split continuity into its record part (session-level) and the recent-evidence part (per turn). */
function splitContinuity(text: string): { stable: string; residual: string } {
  const lines = text.split("\n");
  const splitAt = lines.findIndex(
    (line, index) =>
      index > 0 && index < lines.length - 1 && CONTINUITY_RECENT_MARKERS.some((marker) => line.startsWith(marker)),
  );
  if (splitAt < 0) return { stable: text, residual: "" };
  const head = lines.slice(0, splitAt);
  while (head.length > 1 && head[head.length - 1]!.trim() === "") head.pop();
  const recent = lines.slice(splitAt, -1);
  return {
    stable: [...head, lines[lines.length - 1]!].join("\n"),
    residual: ["<game_continuity_recent>", ...recent, "</game_continuity_recent>"].join("\n"),
  };
}

/** A delta is used only while it is at most this share of the full block. */
const GAME_STABLE_DELTA_MAX_SHARE = 0.6;

/**
 * Line changes from the cached copy of a block to its current text, as a small block of its own, or null when the
 * change is too large to be worth it (the block is then restated in full). Lines compare as a multiset, so a
 * reordered list costs nothing and a changed line shows as one removal and one addition.
 */
export function buildBlockDelta(tag: string, cached: string, current: string): string | null {
  const count = (text: string) => {
    const counts = new Map<string, number>();
    for (const line of text.split("\n")) if (line.trim()) counts.set(line, (counts.get(line) ?? 0) + 1);
    return counts;
  };
  const before = count(cached);
  const after = count(current);
  const removed: string[] = [];
  const added: string[] = [];
  for (const [line, times] of before) for (let n = after.get(line) ?? 0; n < times; n += 1) removed.push(line);
  for (const [line, times] of after) for (let n = before.get(line) ?? 0; n < times; n += 1) added.push(line);
  if (removed.length === 0 && added.length === 0) return null;
  const delta = [
    `<${tag}_changes>`,
    `Line changes to <${tag}> since its copy in <session_context>; every other line there is unchanged and current.`,
    ...(removed.length > 0 ? [`Removed lines:`, ...removed.map((line) => `- ${line}`)] : []),
    ...(added.length > 0 ? [`Added lines:`, ...added.map((line) => `+ ${line}`)] : []),
    `</${tag}_changes>`,
  ].join("\n");
  return delta.length <= current.length * GAME_STABLE_DELTA_MAX_SHARE ? delta : null;
}

/** What a changed block costs in the tail each turn: its delta, or the whole block. */
function tailCost(cached: string | undefined, block: { tag: string; text: string }): number {
  if (cached === undefined) return block.text.length;
  return buildBlockDelta(block.tag, cached, block.text)?.length ?? block.text.length;
}

function isEligibleTailMessage(message: PromptCacheLayoutMessage): boolean {
  return (
    message.contextKind === "injection" &&
    typeof message.content === "string" &&
    message.providerMetadata?.marinaraGmReference !== true &&
    message.providerMetadata?.marinaraFullLoreContext !== true
  );
}

/**
 * Plan one turn. Pure: `previous` is the stored snapshot (or null), and the result carries the snapshot to store.
 * Messages come from normalizePromptCacheLayout, so the per-turn blocks sit after the last finished exchange.
 */
export function planGameStableLayout<T extends PromptCacheLayoutMessage>(
  input: readonly T[],
  previous: GameStableLayoutSnapshot | null,
  options: { foldChars?: number } = {},
): GameStableLayoutResult<T> {
  const untouched: GameStableLayoutResult<T> = {
    messages: input.slice(),
    snapshot: previous,
    changed: false,
    folded: false,
    stats: { baselineChars: 0, unchanged: [], updated: [], restated: [], dropped: [] },
  };
  let lastAssistant = -1;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    if (input[index]?.contextKind === "history" && input[index]?.role === "assistant") {
      lastAssistant = index;
      break;
    }
  }
  // A first turn has no finished exchange to cache behind; it keeps today's layout.
  if (lastAssistant < 0) return untouched;

  const current: CurrentBlock[] = [];
  const occurrences = new Map<string, number>();
  for (let messageIndex = lastAssistant + 1; messageIndex < input.length; messageIndex += 1) {
    const message = input[messageIndex]!;
    if (!isEligibleTailMessage(message)) continue;
    for (const block of parseTopLevelBlocks(message.content)) {
      if (!GAME_SESSION_STABLE_TAGS.has(block.tag)) continue;
      const seen = occurrences.get(block.open) ?? 0;
      occurrences.set(block.open, seen + 1);
      const raw = message.content.slice(block.start, block.end);
      const { stable, residual } =
        block.tag === "game_continuity_context" ? splitContinuity(raw) : { stable: raw, residual: "" };
      current.push({
        key: `${block.open}#${seen}`,
        tag: block.tag,
        text: stable,
        residual,
        messageIndex,
        start: block.start,
        end: block.end,
      });
    }
  }
  if (current.length === 0 && !previous?.baseline?.length) return untouched;

  const valid =
    previous !== null &&
    previous.version === GAME_STABLE_LAYOUT_VERSION &&
    Array.isArray(previous.baseline) &&
    previous.lastSeen !== null &&
    typeof previous.lastSeen === "object";
  const currentByKey = new Map(current.map((block) => [block.key, block]));
  let baseline: Array<{ key: string; text: string }>;
  let folded = false;
  let pressure = 0;
  let carried = 0;
  if (!valid) {
    baseline = current.map(({ key, text }) => ({ key, text }));
    folded = true;
  } else {
    const previousBaseline = new Map(previous.baseline.map((entry) => [entry.key, entry.text]));
    const settled = (block: CurrentBlock) => previous.lastSeen[block.key] === block.text;
    for (const block of current) {
      const cached = previousBaseline.get(block.key);
      if (cached !== block.text && settled(block)) pressure += tailCost(cached, block);
    }
    for (const entry of previous.baseline) if (!currentByKey.has(entry.key)) pressure += entry.text.length;
    // Rent or buy: a settled change costs its size on every turn it rides in the tail, and folding it into the
    // baseline costs one rewrite of everything after the baseline. Fold once the carried cost reaches that rewrite.
    const carriedSoFar = (Number.isFinite(previous.carried) ? previous.carried! : 0) + pressure;
    const firstHistory = input.findIndex((message) => message.contextKind === "history");
    const rewriteChars =
      input.slice(Math.max(0, firstHistory)).reduce((sum, message) => sum + message.content.length, 0) +
      previous.baseline.reduce((sum, entry) => sum + entry.text.length, 0);
    const threshold = options.foldChars ?? Math.max(GAME_STABLE_MIN_FOLD_CHARS, rewriteChars);
    carried = carriedSoFar;
    if (pressure > 0 && carriedSoFar >= threshold) {
      folded = true;
      // Blocks that still move every turn stay out of the new baseline: they would only force the next rebuild.
      const keep = (block: CurrentBlock) => previousBaseline.get(block.key) === block.text || settled(block);
      const kept = previous.baseline.flatMap((entry) => {
        const block = currentByKey.get(entry.key);
        return block && keep(block) ? [{ key: block.key, text: block.text }] : [];
      });
      const added = current
        .filter((block) => !previousBaseline.has(block.key) && keep(block))
        .map(({ key, text }) => ({ key, text }));
      baseline = [...kept, ...added];
    } else {
      baseline = previous.baseline.map((entry) => ({ ...entry }));
    }
  }

  const baselineByKey = new Map(baseline.map((entry) => [entry.key, entry.text]));
  const unchanged: string[] = [];
  const restated: string[] = [];
  const updated: string[] = [];
  const cuts = new Map<number, Array<{ start: number; end: number; replacement: string }>>();
  const cut = (block: CurrentBlock, replacement: string) => {
    const list = cuts.get(block.messageIndex) ?? [];
    list.push({ start: block.start, end: block.end, replacement });
    cuts.set(block.messageIndex, list);
  };
  for (const block of current) {
    const cached = baselineByKey.get(block.key);
    if (cached === block.text) {
      unchanged.push(block.tag);
      cut(block, block.residual);
    } else if (cached !== undefined) {
      // Mostly the same as the cached copy: send only the lines that changed. Otherwise restate it whole.
      const delta = buildBlockDelta(block.tag, cached, block.text);
      if (delta !== null) {
        updated.push(block.tag);
        cut(block, [delta, block.residual].filter(Boolean).join("\n\n"));
      } else {
        restated.push(block.tag);
      }
    }
  }
  const droppedTags = baseline
    .filter((entry) => !currentByKey.has(entry.key))
    .map((entry) => /^<([a-z][a-z0-9_]*)/.exec(entry.key)?.[1] ?? "block");

  const next: T[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const message = input[index]!;
    const messageCuts = cuts.get(index);
    if (!messageCuts) {
      next.push(message);
      continue;
    }
    let content = message.content;
    for (const cut of [...messageCuts].sort((left, right) => right.start - left.start)) {
      content = content.slice(0, cut.start) + cut.replacement + content.slice(cut.end);
    }
    content = content.replace(/\n{3,}/g, "\n\n").replace(/^\n+|\n+$/g, "");
    if (!content.trim()) continue;
    next.push({ ...message, content });
  }

  const statusLines: string[] = [];
  const list = (tags: string[]) => [...new Set(tags)].map((tag) => `<${tag}>`).join(", ");
  if (unchanged.length > 0)
    statusLines.push(`Current and unchanged (full text in <session_context>): ${list(unchanged)}.`);
  if (updated.length > 0)
    statusLines.push(
      `Changed this turn (apply the listed line changes to the copy in <session_context>): ${list(updated)}.`,
    );
  if (restated.length > 0)
    statusLines.push(
      `Changed this turn (the copy in this turn's context replaces the earlier one): ${list(restated)}.`,
    );
  if (droppedTags.length > 0) statusLines.push(`No longer current (disregard the earlier copy): ${list(droppedTags)}.`);
  if (statusLines.length > 0) {
    // First thing after the last finished exchange, ahead of this turn's blocks.
    const anchor = next.indexOf(input[lastAssistant]!);
    const insertAt = anchor >= 0 ? anchor + 1 : -1;
    const note = {
      role: "user",
      content: ["<session_context_status>", ...statusLines, "</session_context_status>"].join("\n"),
      contextKind: "injection",
      providerMetadata: { marinaraGameStableStatus: true },
    } as unknown as T;
    next.splice(insertAt >= 0 ? insertAt : next.length, 0, note);
  }

  let baselineChars = 0;
  if (baseline.length > 0) {
    const content = [GAME_STABLE_BASELINE_HEADER, ...baseline.map((entry) => entry.text)].join("\n\n");
    baselineChars = content.length;
    const firstHistory = next.findIndex((message) => message.contextKind === "history");
    next.splice(firstHistory >= 0 ? firstHistory : next.length, 0, {
      role: "user",
      content,
      contextKind: "injection",
      providerMetadata: { marinaraGameStableBaseline: true },
    } as unknown as T);
  }

  const snapshot: GameStableLayoutSnapshot = {
    version: GAME_STABLE_LAYOUT_VERSION,
    baseline,
    lastSeen: Object.fromEntries(current.map((block) => [block.key, block.text])),
    carried: folded ? 0 : carried,
  };
  const changed = !valid || JSON.stringify(snapshot) !== JSON.stringify(previous);
  return {
    messages: next,
    snapshot,
    changed,
    folded,
    stats: { baselineChars, unchanged, updated, restated, dropped: droppedTags },
  };
}

function snapshotPath(chatId: string): string {
  return join(DATA_DIR, "game-stable-layout", `${encodeURIComponent(chatId)}.json`);
}

export async function readGameStableLayoutSnapshot(chatId: string): Promise<GameStableLayoutSnapshot | null> {
  try {
    const parsed = JSON.parse(await readFile(snapshotPath(chatId), "utf8")) as GameStableLayoutSnapshot;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function writeGameStableLayoutSnapshot(chatId: string, snapshot: GameStableLayoutSnapshot): Promise<void> {
  const path = snapshotPath(chatId);
  await mkdir(join(DATA_DIR, "game-stable-layout"), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(snapshot), "utf8");
  await rename(temporary, path);
}

/** Whether a Game turn on this provider uses the cache-stable layout (both layout switches on). */
export function isGameStableLayoutActive(
  chatMode: string | null | undefined,
  provider: string | null | undefined,
): boolean {
  return (
    chatMode === "game" &&
    provider === "claude_subscription" &&
    isFeatureEnabled("cacheFriendlyPromptLayout") &&
    isFeatureEnabled("gameCacheStableLayout")
  );
}

/** Read, plan and persist in one step. A storage failure keeps generation going with the planned layout. */
export async function layoutGameStableContext<T extends PromptCacheLayoutMessage>(
  chatId: string,
  messages: readonly T[],
  options: { persist?: boolean } = {},
): Promise<T[]> {
  const plan = planGameStableLayout(messages, await readGameStableLayoutSnapshot(chatId));
  if (plan.changed && plan.snapshot && options.persist !== false) {
    try {
      await writeGameStableLayoutSnapshot(chatId, plan.snapshot);
    } catch (error) {
      logger.warn({ err: error, chatId }, "[game/stable-layout] could not save the layout snapshot");
    }
  }
  logger.debug(
    {
      event: "prompt.layout.game_stable",
      chatId,
      folded: plan.folded,
      baselineChars: plan.stats.baselineChars,
      unchanged: plan.stats.unchanged,
      updated: plan.stats.updated,
      restated: plan.stats.restated,
      dropped: plan.stats.dropped,
    },
    "[game/stable-layout] session context laid out",
  );
  return plan.messages;
}
