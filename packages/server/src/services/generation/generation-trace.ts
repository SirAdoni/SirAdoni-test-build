// ──────────────────────────────────────────────
// Generation trace: one summary line per generation
// ──────────────────────────────────────────────
// The generate route records stages, facts and counters here while it runs and
// writes exactly one `generation.finished` line at the end, whatever the path
// (success, abort, cache-guard hold, failure). Never put prompt text or message
// content into set(): only ids, counts, durations and codes.
import { logger } from "../../lib/logger.js";
import type { Outcome } from "../../lib/log-events.js";

export interface GenerationTraceStart {
  chatId: string;
  chatMode: string;
  generationId: string;
}

export interface GenerationUsage {
  promptTokens?: number;
  completionTokens?: number;
  cachedPromptTokens?: number;
}

export interface GenerationTraceFinishExtra {
  reason?: string;
  errorId?: string;
  errorCode?: string;
  [key: string]: unknown;
}

export interface GenerationTrace {
  /** Starts stage `name`; the previous stage stops and its time is added to stageMs. */
  stage(name: string): void;
  /** Name of the stage running now ("setup" before the first stage call). */
  readonly currentStage: string;
  /** Records summary fields (messageId, provider, model, finishReason, usage, ...). */
  set(fields: Record<string, unknown>): void;
  /** Adds `n` to the counter `key` (for example agentsFailed or requestCount). */
  count(key: string, n?: number): void;
  /** Records the time to the first streamed token; later calls are ignored. */
  markFirstToken(): void;
  /** Writes the one `generation.finished` line. Later calls do nothing. */
  finish(outcome: Outcome, extra?: GenerationTraceFinishExtra): void;
  readonly finished: boolean;
}

const COUNTERS = ["requestCount", "agentsFailed", "parallelAgentsFailed", "promptSectionsSkipped"] as const;

export function startGenerationTrace(start: GenerationTraceStart): GenerationTrace {
  const startedAt = Date.now();
  const stageMs: Record<string, number> = {};
  const counters: Record<string, number> = {};
  const fields: Record<string, unknown> = {};
  let current = "setup";
  let currentStartedAt = startedAt;
  let firstTokenMs: number | undefined;
  let done = false;

  const closeStage = (now: number) => {
    stageMs[current] = (stageMs[current] ?? 0) + (now - currentStartedAt);
  };

  return {
    stage(name) {
      if (done || name === current) return;
      const now = Date.now();
      closeStage(now);
      current = name;
      currentStartedAt = now;
    },
    get currentStage() {
      return current;
    },
    set(next) {
      if (done) return;
      Object.assign(fields, next);
    },
    count(key, n = 1) {
      if (done) return;
      counters[key] = (counters[key] ?? 0) + n;
    },
    markFirstToken() {
      if (firstTokenMs === undefined) firstTokenMs = Date.now() - startedAt;
    },
    get finished() {
      return done;
    },
    finish(outcome, extra = {}) {
      if (done) return;
      done = true;
      const now = Date.now();
      closeStage(now);
      const usage = fields.usage as GenerationUsage | undefined;
      const { reason, errorId, errorCode, ...rest } = extra;
      const otherCounters: Record<string, number> = {};
      for (const [key, value] of Object.entries(counters)) {
        if (!(COUNTERS as readonly string[]).includes(key)) otherCounters[key] = value;
      }
      logger.info(
        {
          ...fields,
          ...rest,
          event: "generation.finished",
          outcome,
          chatId: start.chatId,
          chatMode: start.chatMode,
          operationId: start.generationId,
          elapsedMs: now - startedAt,
          // Named firstChunkMs, not firstTokenMs: the log sanitizer redacts any key containing "token".
          firstChunkMs: firstTokenMs,
          stageMs: {
            assemble: stageMs.assemble,
            preGenAgents: stageMs.preGenAgents,
            provider: stageMs.provider,
            postAgents: stageMs.postAgents,
            ...Object.fromEntries(
              Object.entries(stageMs).filter(
                ([key]) => !["assemble", "preGenAgents", "provider", "postAgents"].includes(key),
              ),
            ),
          },
          messageId: fields.messageId,
          provider: fields.provider,
          model: fields.model,
          connectionId: fields.connectionId,
          fallbackUsed: fields.fallbackUsed === true,
          requestCount: counters.requestCount ?? 0,
          finishReason: fields.finishReason,
          usage: usage
            ? {
                promptTokens: usage.promptTokens,
                completionTokens: usage.completionTokens,
                cachedPromptTokens: usage.cachedPromptTokens,
              }
            : undefined,
          agentsFailed: counters.agentsFailed ?? 0,
          promptSectionsSkipped: counters.promptSectionsSkipped ?? (fields.promptSectionsSkipped as number | undefined),
          lorebookSemantic: fields.lorebookSemantic,
          parallelAgentsFailed: counters.parallelAgentsFailed ?? 0,
          ...(Object.keys(otherCounters).length ? { counts: otherCounters } : {}),
          reason,
          errorId,
          errorCode,
        },
        "[generate] Generation finished",
      );
    },
  };
}
