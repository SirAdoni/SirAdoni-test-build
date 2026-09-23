import type { AgentResult } from "@marinara-engine/shared";
import type { ResolvedAgent } from "../agents/agent-pipeline.js";
import { shouldDeferSpotifyAgentEvent } from "./spotify-agent-runtime.js";
import { createDiagnostic, sanitizeDiagnosticText } from "../../lib/diagnostics.js";
import { logger } from "../../lib/logger.js";

export type AgentResultOwnership = {
  chatId: string;
  messageId: string | null;
  swipeIndex: number | null;
  generationId: string;
};

export function shouldDeferExpressionAgentEvent(result: AgentResult): boolean {
  return result.success && result.agentType === "expression" && result.type === "sprite_change";
}

export function createAgentEventDispatcher({
  resolvedAgents,
  sendEvent,
  getOwnership,
}: {
  resolvedAgents: ResolvedAgent[];
  sendEvent(payload: Record<string, unknown>): void;
  getOwnership?: (result: AgentResult) => AgentResultOwnership;
}) {
  // One agent.result line per result object, even if a deferred event is sent again later.
  const loggedResults = new WeakSet<AgentResult>();
  const sendAgentResultEvent = (result: AgentResult) => {
    const ownership = getOwnership?.(result);
    // A failed result gets its reference here, so sse.ts forwards it instead of reporting again.
    const errorSummary = result.success ? undefined : sanitizeDiagnosticText(result.error || "Agent failed", 200);
    const ref = errorSummary === undefined ? undefined : createDiagnostic(new Error(errorSummary));
    if (!loggedResults.has(result)) {
      loggedResults.add(result);
      // Never result.data: it can hold generated text.
      logger[result.success ? "info" : "warn"](
        {
          event: "agent.result",
          agentType: result.agentType,
          resultType: result.type,
          outcome: result.success ? "ok" : "failed",
          elapsedMs: result.durationMs,
          messageId: ownership?.messageId ?? undefined,
          jobId: ownership?.generationId,
          ...(ref ? { errorCode: ref.code, errorId: ref.errorId, errorSummary } : {}),
        },
        result.success ? "Agent result" : "Agent result failed",
      );
    }
    sendEvent({
      type: "agent_result",
      data: {
        agentType: result.agentType,
        agentName: resolvedAgents.find((agent) => agent.type === result.agentType)?.name ?? result.agentType,
        resultType: result.type,
        data: result.data,
        success: result.success,
        error: result.error,
        durationMs: result.durationMs,
        ...(ownership ?? {}),
        ...(ref ?? {}),
      },
    });
  };

  const sendAgentEvent = (result: AgentResult, options: { finalized?: boolean } = {}) => {
    if (!options.finalized && (shouldDeferSpotifyAgentEvent(result) || shouldDeferExpressionAgentEvent(result))) {
      return;
    }
    sendAgentResultEvent(result);
  };

  return { sendAgentEvent, sendAgentResultEvent };
}
