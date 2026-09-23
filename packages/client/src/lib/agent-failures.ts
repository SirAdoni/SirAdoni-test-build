import { isConcurrencyLimitError } from "./generation-parameter-errors";

export type IllustratorRetryTarget = "illustration" | "background";

export interface AgentFailure {
  agentType: string;
  agentName: string;
  error: string | null;
  reasonLabel: string | null;
  retryTarget: IllustratorRetryTarget | null;
}

interface RawAgentFailure {
  agentType: string;
  agentName?: string | null;
  error?: string | null;
  retryTarget?: unknown;
}

function parseIllustratorRetryTarget(value: unknown): IllustratorRetryTarget | null {
  return value === "illustration" || value === "background" ? value : null;
}

function classifyAgentFailureReason(error: string | null | undefined): string | null {
  if (!error) return null;
  const value = error.toLowerCase();

  if (
    /\b(max(?:imum)? length|too many tokens|prompt too long|context_length_exceeded)\b/.test(value) ||
    (/\b(context|prompt|input)\b/.test(value) &&
      /\b(limit|length|window|too long|max(?:imum)? tokens?|tokens? limit)\b/.test(value))
  ) {
    return "Context limit";
  }
  if (/\b(timed?\s*out|timeout|etimedout|deadline|aborted|aborterror)\b/.test(value)) {
    return "Timeout";
  }
  if (/\b(refus(?:ed|al)|reject(?:ed|ion)|blocked|content policy|safety|moderation)\b/.test(value)) {
    return "Rejection";
  }
  if (/\b(unauthorized|forbidden|invalid api key|api key|401|403|permission|credential|auth)\b/.test(value)) {
    return "Authentication";
  }
  if (isConcurrencyLimitError(value)) {
    return "Concurrency limit";
  }
  if (/\b(rate limit|too many requests|quota|429)\b/.test(value)) {
    return "Rate limit";
  }
  if (/\b(network|fetch failed|econn|enotfound|dns|socket|connection|connect)\b/.test(value)) {
    return "Connection";
  }
  if (/\b(json|parse|schema|invalid response|malformed)\b/.test(value)) {
    return "Invalid response";
  }
  if (/\btool\b/.test(value)) {
    return "Tool error";
  }

  return null;
}

export function toAgentFailure(raw: RawAgentFailure): AgentFailure {
  const fallbackName = raw.agentType.trim() || "Agent";
  const agentName = raw.agentName?.trim() || fallbackName;
  const error = raw.error?.trim() || null;

  return {
    agentType: raw.agentType,
    agentName,
    error,
    reasonLabel: classifyAgentFailureReason(error),
    retryTarget: raw.agentType === "illustrator" ? parseIllustratorRetryTarget(raw.retryTarget) : null,
  };
}

export function mergeAgentFailures(existing: AgentFailure[], incoming: AgentFailure[]): AgentFailure[] {
  const merged = [...existing];
  for (const failure of incoming) {
    for (let index = merged.length - 1; index >= 0; index--) {
      const current = merged[index]!;
      if (current.agentType !== failure.agentType) continue;
      if (current.retryTarget === null || failure.retryTarget === null || current.retryTarget === failure.retryTarget) {
        merged.splice(index, 1);
      }
    }
    merged.push(failure);
  }
  return merged;
}

export function illustratorRetryTargetsForFailures(failures: AgentFailure[]): IllustratorRetryTarget[] | undefined {
  const illustratorFailures = failures.filter((failure) => failure.agentType === "illustrator");
  if (illustratorFailures.length === 0 || illustratorFailures.some((failure) => failure.retryTarget === null)) {
    return undefined;
  }
  return Array.from(new Set(illustratorFailures.map((failure) => failure.retryTarget as IllustratorRetryTarget)));
}

export function formatAgentFailureTitle(failure: AgentFailure): string {
  return failure.reasonLabel ? `${failure.agentName} (${failure.reasonLabel})` : failure.agentName;
}

export function formatAgentFailureDetail(failure: AgentFailure): string {
  if (failure.reasonLabel && failure.error) return `${failure.reasonLabel}: ${failure.error}`;
  if (failure.reasonLabel) return failure.reasonLabel;
  return failure.error ?? "No error details were provided.";
}

export function formatAgentFailuresToast(failures: AgentFailure[]): string {
  if (failures.length === 0) return "Agent retry failed.";

  if (failures.length === 1) {
    const failure = failures[0]!;
    const detail = formatAgentFailureDetail(failure);
    return `${failure.agentName} failed: ${detail}. Use Retry Failed Agents in the Agents menu to try again.`;
  }

  const visible = failures.slice(0, 3).map(formatAgentFailureTitle).join(", ");
  const remaining = failures.length > 3 ? `, +${failures.length - 3} more` : "";
  return `${failures.length} agents failed: ${visible}${remaining}. Use Retry Failed Agents in the Agents menu to try again.`;
}
