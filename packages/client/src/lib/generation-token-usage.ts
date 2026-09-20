export interface GenerationTokenUsageInput {
  provider?: string | null;
  tokensPrompt?: number | null;
  tokensCompletion?: number | null;
  tokensCachedPrompt?: number | null;
  tokensCacheWritePrompt?: number | null;
}

export interface NormalizedGenerationTokenUsage {
  freshInput: number | null;
  inputTotal: number | null;
  inputTotalExact: boolean;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  cacheHitRatio: number | null;
}

function isClaudeSubscription(provider: string | null | undefined): boolean {
  return typeof provider === "string" && provider.toLowerCase() === "claude_subscription";
}

function reportedCount(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function normalizeGenerationTokenUsage(
  generationInfo: GenerationTokenUsageInput | null | undefined,
): NormalizedGenerationTokenUsage | null {
  if (!generationInfo) return null;
  const reportedPrompt = reportedCount(generationInfo.tokensPrompt);
  const cacheRead = reportedCount(generationInfo.tokensCachedPrompt);
  const cacheWrite = reportedCount(generationInfo.tokensCacheWritePrompt);
  const claudeSubscription = isClaudeSubscription(generationInfo.provider);
  const freshInput = claudeSubscription ? reportedPrompt : null;
  const inputTotalExact = claudeSubscription
    ? freshInput != null && cacheRead != null && cacheWrite != null
    : reportedPrompt != null;
  const inputTotal = claudeSubscription
    ? inputTotalExact
      ? (freshInput ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
      : null
    : reportedPrompt;
  const cacheHitRatio =
    inputTotal != null && inputTotal > 0 && cacheRead != null && cacheRead <= inputTotal
      ? cacheRead / inputTotal
      : null;
  return {
    freshInput,
    inputTotal,
    inputTotalExact,
    output: reportedCount(generationInfo.tokensCompletion),
    cacheRead,
    cacheWrite,
    cacheHitRatio,
  };
}
