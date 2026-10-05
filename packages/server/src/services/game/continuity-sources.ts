import { createHash } from "node:crypto";
import { resolveGameAddressMode } from "./game-address-mode.js";
import { applyAllSegmentEdits, stripGmCommandTags } from "./segment-edits.js";
import { batchLorebookKeeperTranscript } from "./lorebook-keeper-batches.js";

// Keep these source slices local to evidence checking. Prompt/runtime source
// types are deferred from this storage/API phase and are not shared contracts.
type GameContinuitySource = {
  messageId: string;
  swipeIndex: number;
  hash: string;
  role: string;
  content: string;
  start?: number;
  end?: number;
};
type GameContinuityContextSource = GameContinuitySource;

export type ContinuityRawMessage = {
  id: string;
  role: string;
  content?: string | null;
  activeSwipeIndex?: number | null;
  extra?: unknown;
};

type Prepared = GameContinuitySource;
export type ContinuityBatch = {
  sources: GameContinuitySource[];
  context: GameContinuityContextSource[];
};

function parseExtra(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

function isSessionConclusion(content: string): boolean {
  const trimmed = content.trim();
  return trimmed.startsWith("**Session ") && trimmed.includes(" Concluded**");
}

function hashPrepared(message: Pick<Prepared, "messageId" | "swipeIndex" | "role" | "content">): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        messageId: message.messageId,
        swipeIndex: message.swipeIndex,
        role: message.role,
        content: message.content,
      }),
    )
    .digest("hex");
}

function codePoints(value: string): string[] {
  return Array.from(value);
}
function sliceByCodePoints(value: string, start: number, end: number): string {
  return codePoints(value).slice(start, end).join("");
}

export type ContinuityExclusionReason =
  | "hidden_from_ai"
  | "derived_source"
  | "recap_source"
  | "summary_source"
  | "conclusion_source"
  | "system_role"
  | "session_conclusion"
  | "empty_content";
export type ContinuityExclusion = { messageId: string; role: string; reason: ContinuityExclusionReason };

/** Why a raw message is never a continuity source, or null when it is eligible. */
export function continuityExclusionReason(message: ContinuityRawMessage): ContinuityExclusionReason | null {
  const extra = parseExtra(message.extra);
  const source = String(extra.continuitySource ?? extra.source ?? "").toLowerCase();
  if (extra.hiddenFromAI === true) return "hidden_from_ai";
  if (source.startsWith("derived_")) return "derived_source";
  if (source.includes("recap")) return "recap_source";
  if (source.includes("summary")) return "summary_source";
  if (source.includes("conclusion")) return "conclusion_source";
  if (message.role === "system") return "system_role";
  return null;
}

export function prepareContinuitySources(
  messages: ContinuityRawMessage[],
  meta: Record<string, unknown>,
): GameContinuitySource[] {
  return prepareContinuitySourcesWithExclusions(messages, meta).prepared;
}

/** Same preparation as `prepareContinuitySources`, also listing every dropped message with its reason. */
export function prepareContinuitySourcesWithExclusions(
  messages: ContinuityRawMessage[],
  meta: Record<string, unknown>,
): { prepared: GameContinuitySource[]; excluded: ContinuityExclusion[] } {
  const excluded: ContinuityExclusion[] = [];
  const included: ContinuityRawMessage[] = [];
  for (const message of messages) {
    const reason = continuityExclusionReason(message);
    if (reason) excluded.push({ messageId: message.id, role: message.role, reason });
    else included.push(message);
  }
  const includedById = new Map(included.map((message) => [message.id, message]));
  const mapped = included.map((message) => ({ id: message.id, role: message.role, content: message.content ?? "" }));
  applyAllSegmentEdits(mapped, meta, included);
  let inOocExchange = false;
  const prepared: Prepared[] = [];
  for (const mappedMessage of mapped) {
    const original = includedById.get(mappedMessage.id);
    if (!original) continue;
    const content = stripGmCommandTags(mappedMessage.content).trim();
    if (!content || isSessionConclusion(content)) {
      excluded.push({
        messageId: mappedMessage.id,
        role: original.role,
        reason: content ? "session_conclusion" : "empty_content",
      });
      continue;
    }
    if (mappedMessage.role === "user") inOocExchange = resolveGameAddressMode(content) === "gm";
    const role =
      inOocExchange && mappedMessage.role === "assistant"
        ? "assistant OOC acknowledgement"
        : inOocExchange && mappedMessage.role === "user"
          ? "user OOC correction"
          : mappedMessage.role;
    const item: Prepared = {
      messageId: mappedMessage.id,
      swipeIndex: original.activeSwipeIndex ?? 0,
      hash: "",
      role,
      content,
      start: 0,
      end: codePoints(content).length,
    };
    item.hash = hashPrepared(item);
    prepared.push(item);
  }
  return { prepared, excluded };
}

function sourceSlice(message: Prepared, start: number, end: number): GameContinuitySource {
  return {
    messageId: message.messageId,
    swipeIndex: message.swipeIndex,
    hash: message.hash,
    role: message.role,
    content: sliceByCodePoints(message.content, start, end),
    start,
    end,
  };
}

function contextSize(result: GameContinuityContextSource[]): number {
  return result.reduce((total, item) => total + codePoints(item.content).length, 0);
}

function addContext(
  result: GameContinuityContextSource[],
  message: Prepared,
  start: number,
  end: number,
  budget: number,
): number {
  if (start > end) return contextSize(result);
  const remaining = budget - contextSize(result);
  if (remaining <= 0) return contextSize(result);
  const boundedEnd = Math.min(end, start + remaining);
  if (boundedEnd <= start) return contextSize(result);
  const item = sourceSlice(message, start, boundedEnd);
  if (
    !result.some(
      (existing) => existing.messageId === item.messageId && existing.start === item.start && existing.end === item.end,
    )
  )
    result.push(item);
  return contextSize(result);
}

export function planContinuityTurnBatches(
  prepared: GameContinuitySource[],
  assistantId: string,
  maxChars = 8000,
): ContinuityBatch[] {
  return planContinuityTurnGroupBatches(prepared, [assistantId], maxChars);
}

/**
 * Plan the provider batches for one or more consecutive accepted turns.
 *
 * Historical backfill groups turns so a whole session is not paid for one round trip per turn; live
 * play still passes a single id, which produces exactly the batches it always did. The span runs from
 * the start of the first turn to the last accepted assistant message, and every accepted assistant in
 * between is kept as a primary source so no narration is silently dropped from the middle of a group.
 */
export function planContinuityTurnGroupBatches(
  prepared: GameContinuitySource[],
  assistantIds: readonly string[],
  maxChars = 8000,
): ContinuityBatch[] {
  if (assistantIds.length === 0) throw new Error("CONTINUITY_ASSISTANT_NOT_FOUND");
  const accepted = new Set(assistantIds);
  const indexes = assistantIds.map((id) => {
    const index = prepared.findIndex((message) => message.messageId === id);
    if (index < 0) throw new Error("CONTINUITY_ASSISTANT_NOT_FOUND");
    if (!prepared[index]!.role.startsWith("assistant")) throw new Error("CONTINUITY_ACCEPTED_MESSAGE_NOT_ASSISTANT");
    return index;
  });
  const firstIndex = Math.min(...indexes);
  const acceptedIndex = Math.max(...indexes);
  let start = firstIndex - 1;
  while (start >= 0 && !prepared[start]!.role.startsWith("assistant")) start -= 1;
  start += 1;
  const primaryMessages = prepared
    .slice(start, acceptedIndex + 1)
    .filter(
      (message, index, all) =>
        index === all.length - 1 ||
        message.role.startsWith("user") ||
        message.role === "assistant OOC acknowledgement" ||
        accepted.has(message.messageId),
    );
  const loreMessages = primaryMessages.map((message) => ({
    id: message.messageId,
    role: message.role,
    content: message.content,
  }));
  const batches = batchLorebookKeeperTranscript(loreMessages, maxChars);
  const previous = prepared.slice(Math.max(0, start - 2), start);
  const preparedById = new Map(prepared.map((message) => [message.messageId, message]));
  return batches.map((batch) => {
    const sources = batch.sourceRefs.map((ref) => {
      const message = preparedById.get(ref.messageId)!;
      return sourceSlice(message, ref.start, ref.end);
    });
    const context: GameContinuityContextSource[] = [];
    const contextBudget = 2000;
    const previousContextBudget = 1000;
    const firstNeighborBudget = 1500;
    for (const message of [...previous].reverse()) {
      const length = codePoints(message.content).length;
      const remaining = previousContextBudget - contextSize(context);
      if (remaining <= 0) break;
      addContext(context, message, Math.max(0, length - remaining), length, previousContextBudget);
    }
    const first = batch.sourceRefs[0];
    const last = batch.sourceRefs[batch.sourceRefs.length - 1];
    if (first) {
      const message = preparedById.get(first.messageId)!;
      addContext(context, message, Math.max(0, first.start - 2000), first.start, firstNeighborBudget);
    }
    if (last) {
      const message = preparedById.get(last.messageId)!;
      const length = codePoints(message.content).length;
      addContext(context, message, last.end, Math.min(length, last.end + 2000), contextBudget);
    }
    return { sources, context };
  });
}

function matchesCurrent(current: Prepared, item: GameContinuitySource | GameContinuityContextSource): boolean {
  const length = codePoints(current.content).length;
  const start = item.start ?? 0;
  const end = item.end ?? length;
  return (
    start >= 0 &&
    end >= start &&
    end <= length &&
    current.messageId === item.messageId &&
    current.swipeIndex === item.swipeIndex &&
    hashPrepared(current) === item.hash &&
    current.role === item.role &&
    sliceByCodePoints(current.content, start, end) === item.content
  );
}

export function validateContinuityManifest(
  currentPrepared: GameContinuitySource[],
  sources: GameContinuitySource[],
  context: GameContinuityContextSource[],
): boolean {
  const current = new Map(currentPrepared.map((message) => [message.messageId, message]));
  return [...sources, ...context].every((item) => {
    const found = current.get(item.messageId);
    return found ? matchesCurrent(found, item) : false;
  });
}
