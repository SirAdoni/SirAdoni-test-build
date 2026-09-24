// ──────────────────────────────────────────────
// Storage: Generation Usage Ledger
// ──────────────────────────────────────────────
import { and, gte, lte } from "../../db/file-query.js";
import type { DB } from "../../db/connection.js";
import { generationUsage } from "../../db/schema/index.js";
import { newTimeSortableId, now } from "../../utils/id-generator.js";
import { isFeatureEnabled } from "../features/feature-settings.js";

export interface GenerationUsageInput {
  chatId: string | null;
  messageId: string | null;
  connectionId: string | null;
  provider: string | null;
  model: string | null;
  inputTokens: number | null | undefined;
  outputTokens: number | null | undefined;
  cachedInputTokens: number | null | undefined;
  cacheWriteInputTokens?: number | null | undefined;
}

export type GenerationUsageRow = typeof generationUsage.$inferSelect;

function tokenCount(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/**
 * Total input tokens for one request. Claude subscription reports only the
 * fresh (uncached) part as prompt tokens, matching the client's per-message
 * usage display in generation-token-usage.ts.
 */
export function ledgerInputTokens(input: GenerationUsageInput): number {
  const prompt = tokenCount(input.inputTokens);
  if (input.provider?.toLowerCase() !== "claude_subscription") return prompt;
  return prompt + tokenCount(input.cachedInputTokens) + tokenCount(input.cacheWriteInputTokens);
}

export function createGenerationUsageStorage(db: DB) {
  return {
    /**
     * Records one completed generation. Returns null when the provider reported no tokens at all, or
     * when Settings > Features "Usage and activation stats" is off (nothing is written, as upstream).
     */
    async record(input: GenerationUsageInput, createdAt: string = now()): Promise<GenerationUsageRow | null> {
      if (!isFeatureEnabled("usageAndActivationStats")) return null;
      const inputTokens = ledgerInputTokens(input);
      const outputTokens = tokenCount(input.outputTokens);
      if (inputTokens === 0 && outputTokens === 0) return null;
      const row: GenerationUsageRow = {
        id: newTimeSortableId(),
        day: createdAt.slice(0, 10),
        chatId: input.chatId || null,
        messageId: input.messageId || null,
        connectionId: input.connectionId || null,
        provider: input.provider ?? "",
        model: input.model ?? "",
        inputTokens,
        outputTokens,
        cachedInputTokens: Math.min(tokenCount(input.cachedInputTokens), inputTokens),
        createdAt,
      };
      await db.insert(generationUsage).values(row);
      return row;
    },

    /** Rows whose createdAt falls within [fromIso, toIso] (both inclusive ISO timestamps). */
    async listBetween(fromIso: string, toIso: string): Promise<GenerationUsageRow[]> {
      return db
        .select()
        .from(generationUsage)
        .where(and(gte(generationUsage.createdAt, fromIso), lte(generationUsage.createdAt, toIso)));
    },
  };
}
