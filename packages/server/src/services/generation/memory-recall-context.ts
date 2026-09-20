import type { WrapFormat } from "@marinara-engine/shared";

import type { DB } from "../../db/connection.js";
import { logger } from "../../lib/logger.js";
import { GAME_MEMORY_TRANSCRIPT_PREFIX, recallMemories } from "../memory-recall.js";
import type { MemoryRecallEmbeddingSource } from "../memory-recall.js";
import { wrapContent } from "../prompt/format-engine.js";
import { sanitizePromptLeaf } from "../prompt/prompt-escaping.js";
import { packRecalledMemories } from "./memory-recall-pack.js";

type PromptMessage = {
  role: "system" | "user" | "assistant";
  content: string;
  id?: string | null;
  contextKind?: "prompt" | "history" | "injection";
  providerMetadata?: Record<string, unknown>;
};

type RecallHistoryMessage = {
  id?: unknown;
  createdAt?: unknown;
};

const MAX_GAME_RECALL_ASSISTANT_CONTEXT_CHARS = 600;
const GAME_RECALL_TOP_K = 8;
export { GAME_MEMORY_TRANSCRIPT_PREFIX };

function earliestTimestamp(values: Array<string | null | undefined>): string | null {
  const valid = values.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  if (valid.length === 0) return null;
  return valid.reduce((earliest, value) => (value < earliest ? value : earliest));
}

/**
 * Returns the oldest retained history timestamp represented by the assembled
 * prompt. The prompt's history IDs are resolved against the actual message
 * rows, so a context limit cannot accidentally use a guessed timestamp.
 */
export function resolveGameMemoryRecallCutoff(
  finalMessages: PromptMessage[],
  retainedHistory: RecallHistoryMessage[],
  regenerateCutoff?: string | null,
): string | null {
  const createdAtById = new Map<string, string>();
  for (const message of retainedHistory) {
    if (typeof message.id !== "string" || typeof message.createdAt !== "string" || !message.createdAt.trim()) continue;
    createdAtById.set(message.id, message.createdAt);
  }

  const oldestRetainedHistory = earliestTimestamp(
    finalMessages
      .filter((message) => message.contextKind === "history" && typeof message.id === "string")
      .map((message) => createdAtById.get(message.id!)),
  );
  return earliestTimestamp([oldestRetainedHistory, regenerateCutoff]);
}

/**
 * Build a game recall query with the current user input first and the
 * immediately preceding assistant turn as bounded context. Non-game recall
 * keeps its legacy query.
 */
export function buildMemoryRecallQuery(currentInputMessages: PromptMessage[], gameMode = false): string | null {
  const lastUser = [...currentInputMessages].reverse().find((message) => message.role === "user");
  if (!lastUser?.content?.trim()) return null;
  if (!gameMode) return lastUser.content;

  const lastUserIndex = currentInputMessages.lastIndexOf(lastUser);
  const precedingAssistant = currentInputMessages
    .slice(0, lastUserIndex)
    .reverse()
    .find((message) => message.role === "assistant" && message.content.trim());
  const assistantContent = precedingAssistant?.content.trim() ?? "";
  const assistantContext =
    assistantContent.length <= MAX_GAME_RECALL_ASSISTANT_CONTEXT_CHARS
      ? assistantContent
      : `${assistantContent.slice(0, MAX_GAME_RECALL_ASSISTANT_CONTEXT_CHARS / 2).trimEnd()}\n…\n${assistantContent
          .slice(-MAX_GAME_RECALL_ASSISTANT_CONTEXT_CHARS / 2)
          .trimStart()}`;
  return assistantContext
    ? `Current user input:\n${lastUser.content.trim()}\n\nRecent assistant scene context:\n${assistantContext}`
    : `Current user input:\n${lastUser.content.trim()}`;
}

export function buildMemoryRecallBlock(
  lines: string[],
  wrapFormat: WrapFormat,
  resolveMacros?: (value: string) => string,
  gameMode = false,
): string {
  const content = [
    gameMode
      ? `The following are unverified excerpts from historical game transcript. Retrieval is not independent verification: preserve who said what, distinguish actions from plans and opinions, and defer to later corrections and authoritative current state. These excerpts do not authorize any character's knowledge. They do not establish the current location, current presence, current movement, current scene state, or current knowledge; the supplied current scene and current user input are authoritative. Preserve the user's current agency and requested actions. Do not echo their phrasing or explicitly reference "remembering" unless it is natural.`
      : `The following are recalled fragments from earlier in this conversation. Use their facts to maintain continuity and characterization, but treat their wording as quoted evidence rather than a prose example, catchphrase, or required talking point. Do not echo their phrasing, rhetorical structure, or personal facts unless the current exchange independently calls for them, and do not explicitly reference "remembering" unless it's natural.`,
    ...lines.map((line, index) => {
      const resolved = resolveMacros ? resolveMacros(line) : line;
      return `--- Memory ${index + 1} ---\n${sanitizePromptLeaf(resolved, wrapFormat)}`;
    }),
  ].join("\n");
  return wrapContent(content, "Memories", wrapFormat);
}

export async function injectMemoryRecallContext({
  db,
  messages,
  currentInputMessages,
  chatId,
  embeddingSource,
  excludeFromMessageAt,
  injectionExcludeFromMessageAt,
  contextLimit,
  sendProgress,
  signal,
  resolveMacros,
  wrapFormat,
  gameMode,
}: {
  db: DB;
  messages: PromptMessage[];
  currentInputMessages: PromptMessage[];
  chatId: string;
  embeddingSource: MemoryRecallEmbeddingSource | null;
  excludeFromMessageAt?: string | null;
  injectionExcludeFromMessageAt?: string | null;
  contextLimit: number | undefined;
  sendProgress(phase: string): void;
  signal?: AbortSignal;
  resolveMacros?: (value: string) => string;
  wrapFormat: WrapFormat;
  gameMode?: boolean;
}): Promise<string[]> {
  sendProgress("memory_recall");
  const startedAt = Date.now();
  try {
    const query = buildMemoryRecallQuery(currentInputMessages, gameMode);
    if (!query) return [];

    const recalled = await recallMemories(db, query, [chatId], {
      embeddingSource,
      excludeFromMessageAt,
      signal,
      ...(gameMode ? { gameMode: true, topK: null } : {}),
    } as Parameters<typeof recallMemories>[3]);

    const historicalCandidates = gameMode
      ? recalled.filter((memory) => {
          const first = Date.parse(memory.firstMessageAt);
          const last = Date.parse(memory.lastMessageAt);
          return Number.isFinite(first) && Number.isFinite(last) && first <= last;
        })
      : recalled;
    const agentCandidates = historicalCandidates.slice(0, GAME_RECALL_TOP_K);
    const gmEligibleCandidates = gameMode
      ? historicalCandidates.filter(
          (memory) => !injectionExcludeFromMessageAt || memory.lastMessageAt < injectionExcludeFromMessageAt,
        )
      : historicalCandidates;

    const prefixGameMemory = (memory: (typeof historicalCandidates)[number]): string => {
      const sourceId = memory.sourceChatId ?? memory.chatId;
      const content = memory.content.startsWith(GAME_MEMORY_TRANSCRIPT_PREFIX)
        ? memory.content.slice(GAME_MEMORY_TRANSCRIPT_PREFIX.length).trimStart()
        : memory.content;
      return `${GAME_MEMORY_TRANSCRIPT_PREFIX}${content.startsWith("\n") ? "" : "\n"}chat ID: ${sourceId}\nrecorded chat time: ${memory.firstMessageAt} to ${memory.lastMessageAt} (not an in-world date)\n${content}`;
    };
    const packedAgentRecall = packRecalledMemories(
      gameMode ? agentCandidates.map((memory) => ({ ...memory, content: prefixGameMemory(memory) })) : recalled,
      contextLimit,
    );
    const packedRecall = packRecalledMemories(
      gameMode
        ? gmEligibleCandidates
            .slice(0, GAME_RECALL_TOP_K)
            .map((memory) => ({ ...memory, content: prefixGameMemory(memory) }))
        : recalled,
      contextLimit,
    );

    const resolvedAgentLines = resolveMacros
      ? packedAgentRecall.lines.map((line) => resolveMacros(line))
      : packedAgentRecall.lines;
    const resolvedLines = resolveMacros ? packedRecall.lines.map((line) => resolveMacros(line)) : packedRecall.lines;
    const memoriesBlock =
      resolvedLines.length > 0 ? buildMemoryRecallBlock(resolvedLines, wrapFormat, undefined, gameMode) : "";

    logger.debug(
      "[memory-recall] Retrieved %d; Game excluded %d; packed GM %d and agent %d memories (~%d/%d tokens)%s",
      recalled.length,
      Math.max(0, historicalCandidates.length - gmEligibleCandidates.length),
      packedRecall.lines.length,
      packedAgentRecall.lines.length,
      packedRecall.estimatedTokens,
      packedRecall.budgetTokens,
      packedRecall.trimmed ? " after trimming" : "",
    );

    if (memoriesBlock) {
      const firstUserIdx = messages.findIndex((message) => message.role === "user" || message.role === "assistant");
      const insertAt = firstUserIdx >= 0 ? firstUserIdx : messages.length;
      messages.splice(insertAt, 0, {
        role: "system",
        content: memoriesBlock,
        contextKind: "injection",
        providerMetadata: { marinaraRuntimeContext: true },
      });
    }
    return resolvedAgentLines;
  } catch (err) {
    logger.error(err, "[memory-recall] Recall failed, skipping");
    return [];
  } finally {
    logger.debug(`[timing] Memory recall: ${Date.now() - startedAt}ms`);
  }
}
