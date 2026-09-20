import { extractLeadingThinkingBlocks } from "@marinara-engine/shared";
import { parseGameJsonish } from "./jsonish.js";
import { canRefreshLocalContext } from "../llm/local-context-limit.js";

export const STORYBOARD_FALLBACK_BEAT_MAX_CHARS = 2000;

export function shouldRetryStoryboardWithoutReasoning(
  connection: { provider: string; baseUrl: string; treatAsLocalEndpoint?: unknown },
  reasoningEffort?: string,
): boolean {
  return reasoningEffort !== "none" && connection.provider === "custom" && canRefreshLocalContext(connection);
}

/** Retry unusable local structured output once without spending the budget on hidden reasoning. */
export async function completeStoryboardPlan(args: {
  generate: (withoutReasoning: boolean) => Promise<{ content: string | null; finishReason?: string }>;
  retryWithoutReasoning: boolean;
  customThinkingTags?: unknown;
}): Promise<unknown> {
  let failureDetail = "";
  for (let attempt = 0; attempt < (args.retryWithoutReasoning ? 2 : 1); attempt++) {
    const result = await args.generate(attempt > 0);
    const content = extractLeadingThinkingBlocks(result.content || "", args.customThinkingTags).content;
    failureDetail = [
      !content.trim() ? "empty final answer" : "",
      result.finishReason === "length" ? "output token limit reached" : "",
    ]
      .filter(Boolean)
      .join("; ");
    try {
      const plan = parseGameJsonish(content);
      if (storyboardPlanHasRenderableKeyframe(plan) || storyboardPlanHasNoVisualBeats(plan)) return plan;
    } catch {
      // Malformed/empty model output is retryable; transport failures and cancellation are not.
    }
  }
  throw new Error(`Storyboard Illustrator returned no usable keyframes${failureDetail ? ` (${failureDetail})` : ""}`);
}

const STORYBOARD_REVIEW_PLAN_KIND = "marinara-storyboard-review-plan-v1";
const STORYBOARD_PLANNER_ERROR_MAX_CHARS = 1200;

const RETRYABLE_STORYBOARD_PLANNER_TRANSPORT_ERRORS = [
  "terminated",
  "socket hang up",
  "premature close",
  "econnreset",
  "und_err_socket",
  "fetch failed",
];

function storyboardPlannerErrorParts(error: unknown): string[] {
  if (!error || typeof error !== "object") return [String(error ?? "")];
  const record = error as Record<string, unknown>;
  const cause = record.cause && typeof record.cause === "object" ? (record.cause as Record<string, unknown>) : null;
  return [record.message, record.code, cause?.message, cause?.code]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase());
}

/** Retry only transport failures that can end an otherwise healthy provider SSE stream. */
export function isRetryableStoryboardPlannerTransportError(error: unknown): boolean {
  const candidate = error && typeof error === "object" ? (error as Record<string, unknown>) : null;
  const cause =
    candidate?.cause && typeof candidate.cause === "object" ? (candidate.cause as Record<string, unknown>) : null;
  if (
    candidate?.name === "AbortError" ||
    candidate?.code === "ABORT_ERR" ||
    cause?.name === "AbortError" ||
    cause?.code === "ABORT_ERR" ||
    candidate?.name === "SyntaxError" ||
    cause?.name === "SyntaxError"
  ) {
    return false;
  }
  return storyboardPlannerErrorParts(error).some((part) =>
    RETRYABLE_STORYBOARD_PLANNER_TRANSPORT_ERRORS.some((candidate) => part.includes(candidate)),
  );
}

export interface StoryboardReviewPlanEnvelope {
  kind: typeof STORYBOARD_REVIEW_PLAN_KIND;
  plan: unknown;
  plannerError: string | null;
  usedFallbackPlanner: boolean;
}

export function compactStoryboardTextAtWordBoundary(value: unknown, maxChars: number): string {
  if (maxChars <= 0) return "";
  const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (text.length <= maxChars) return text;
  if (maxChars <= 3) return ".".repeat(maxChars);

  const contentLimit = maxChars - 3;
  const candidate = text.slice(0, contentLimit + 1);
  const wordBoundary = candidate.lastIndexOf(" ");
  const cutoff = wordBoundary > 0 ? wordBoundary : contentLimit;
  return `${candidate.slice(0, cutoff).trimEnd()}...`;
}

export function compactStoryboardFallbackBeat(value: unknown): string {
  return compactStoryboardTextAtWordBoundary(value, STORYBOARD_FALLBACK_BEAT_MAX_CHARS);
}

/** An explicit empty list is a valid decision not to illustrate, not a broken plan. */
export function storyboardPlanHasNoVisualBeats(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keyframes = (value as Record<string, unknown>).keyframes;
  return Array.isArray(keyframes) && keyframes.length === 0;
}

export function storyboardPlanHasRenderableKeyframe(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keyframes = (value as Record<string, unknown>).keyframes;
  if (!Array.isArray(keyframes)) return false;
  return keyframes.some((rawFrame) => {
    if (!rawFrame || typeof rawFrame !== "object" || Array.isArray(rawFrame)) return false;
    const frame = rawFrame as Record<string, unknown>;
    return [frame.narrationBeat, frame.imagePrompt, frame.mangaPanelPrompt].some(
      (candidate) => typeof candidate === "string" && candidate.trim().length > 0,
    );
  });
}

export function formatStoryboardFallbackSectionText(content: string, speaker?: string | null): string {
  const cleanContent = content.trim();
  const cleanSpeaker = speaker?.trim() ?? "";
  if (!cleanSpeaker) return cleanContent;
  const escapedSpeaker = cleanSpeaker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const prefixPattern = new RegExp(`^${escapedSpeaker}\\s*:\\s*`, "iu");
  let body = cleanContent;
  while (body) {
    const existingPrefix = body.match(prefixPattern);
    if (!existingPrefix) break;
    body = body.slice(existingPrefix[0].length).trim();
  }
  return body ? `${cleanSpeaker}: ${body}` : `${cleanSpeaker}:`;
}

export function createStoryboardReviewPlanEnvelope(args: {
  plan: unknown;
  plannerError: string | null;
  usedFallbackPlanner: boolean;
}): StoryboardReviewPlanEnvelope {
  return {
    kind: STORYBOARD_REVIEW_PLAN_KIND,
    plan: args.plan,
    plannerError: args.plannerError,
    usedFallbackPlanner: args.usedFallbackPlanner,
  };
}

export function resolveStoryboardReviewPlanEnvelope(value: unknown): {
  plan: unknown;
  plannerError: string | null;
  usedFallbackPlanner: boolean;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { plan: value, plannerError: null, usedFallbackPlanner: false };
  }

  const record = value as Record<string, unknown>;
  if (record.kind !== STORYBOARD_REVIEW_PLAN_KIND || !("plan" in record)) {
    return { plan: value, plannerError: null, usedFallbackPlanner: false };
  }

  const plannerError =
    typeof record.plannerError === "string"
      ? record.plannerError.trim().slice(0, STORYBOARD_PLANNER_ERROR_MAX_CHARS) || null
      : null;
  return {
    plan: record.plan,
    plannerError,
    usedFallbackPlanner: record.usedFallbackPlanner === true || plannerError != null,
  };
}
