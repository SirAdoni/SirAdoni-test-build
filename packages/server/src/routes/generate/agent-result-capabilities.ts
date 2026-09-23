import { customAgentHasCapability, getCustomAgentResultCapability, type AgentResult } from "@marinara-engine/shared";

import type { ResolvedAgent } from "../../services/agents/agent-pipeline.js";

export function findResultAgent(result: AgentResult, agents: ResolvedAgent[]): ResolvedAgent | null {
  return agents.find((agent) => agent.id === result.agentId || agent.type === result.agentType) ?? null;
}

export function isAbortLikeError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function shouldAutomaticallyRetryAgentResult(result: Pick<AgentResult, "success" | "error">): boolean {
  if (result.success) return false;
  return !/\b(?:timed?\s*out|timeout|etimedout|deadline exceeded)\b/i.test(result.error ?? "");
}

export function customAgentCanApplyResult(
  result: AgentResult,
  agents: ResolvedAgent[],
  builtInAgentTypes: Set<string>,
  capability: Parameters<typeof customAgentHasCapability>[1],
): boolean {
  if (builtInAgentTypes.has(result.agentType)) return true;
  const agent = findResultAgent(result, agents);
  return agent ? customAgentHasCapability(agent.settings, capability) : false;
}

export function customAgentCanEmitResult(
  result: AgentResult,
  agents: ResolvedAgent[],
  builtInAgentTypes: Set<string>,
): boolean {
  if (builtInAgentTypes.has(result.agentType)) return true;
  if (result.type === "lorebook_update") {
    return (
      customAgentCanApplyResult(result, agents, builtInAgentTypes, "edit_lorebooks") ||
      customAgentCanApplyResult(result, agents, builtInAgentTypes, "create_lorebooks")
    );
  }
  const capability = getCustomAgentResultCapability(result.type);
  return capability ? customAgentCanApplyResult(result, agents, builtInAgentTypes, capability) : true;
}
