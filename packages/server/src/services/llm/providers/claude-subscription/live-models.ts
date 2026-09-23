import { isClaudeAdaptiveOnlyNoSamplingModel, type ModelParameterCapabilities } from "@marinara-engine/shared";
import { logger } from "../../../../lib/logger.js";

/**
 * Live model catalog for the Claude subscription connection.
 *
 * The Claude Agent SDK answers `supportedModels()` over its control channel for the signed-in account: which models
 * the installed Claude Code runtime offers, and for each one the effort levels, adaptive thinking and fast mode it
 * supports. Asking costs no model call; the prompt stream never yields a message. The answer is cached so opening a
 * connection does not start a Claude Code process every time.
 */

/** Live capabilities always carry these fields for the Claude subscription (the SDK reports each of them). */
export type LiveModelCapabilities = ModelParameterCapabilities &
  Required<
    Pick<
      ModelParameterCapabilities,
      "effortLevels" | "effortLabels" | "adaptiveThinking" | "fastMode" | "samplingRejected"
    >
  >;

export interface LiveConnectionModel {
  id: string;
  name: string;
  description?: string;
  context?: number;
  maxOutput?: number;
  capabilities?: LiveModelCapabilities;
}

type SdkModelInfo = {
  value: string;
  resolvedModel?: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
};

const CACHE_MS = 6 * 60 * 60_000;
let cached: { at: number; models: LiveConnectionModel[] } | null = null;
let inflight: Promise<LiveConnectionModel[]> | null = null;

/** Map one SDK row to a connection model; the id is the canonical model id Marinara already stores. */
export function toLiveConnectionModel(row: SdkModelInfo): LiveConnectionModel | null {
  const canonical = (row.resolvedModel ?? row.value).replace(/\[1m\]$/u, "").trim();
  if (!canonical || !canonical.startsWith("claude-")) return null;
  const oneMillion = /\[1m\]$/u.test(row.resolvedModel ?? row.value) || /1M context/iu.test(row.description);
  const effortLabels: LiveModelCapabilities["effortLabels"] = {};
  const effortLevels: LiveModelCapabilities["effortLevels"] = [];
  for (const reported of row.supportedEffortLevels ?? []) {
    const stored = reported === "max" ? "maximum" : reported;
    if (!["low", "medium", "high", "xhigh", "maximum"].includes(stored)) continue;
    const level = stored as (typeof effortLevels)[number];
    effortLevels.push(level);
    effortLabels[level] = reported;
  }
  const title = row.description.split("·")[0]?.trim() || row.displayName;
  return {
    id: canonical,
    name: title,
    description: row.description,
    ...(oneMillion ? { context: 1_000_000 } : {}),
    capabilities: {
      effortLevels: row.supportsEffort === false ? [] : effortLevels,
      effortLabels: row.supportsEffort === false ? {} : effortLabels,
      adaptiveThinking: row.supportsAdaptiveThinking === true,
      fastMode: row.supportsFastMode === true,
      samplingRejected: isClaudeAdaptiveOnlyNoSamplingModel(canonical),
    },
  };
}

async function querySupportedModels(): Promise<LiveConnectionModel[]> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  let release: () => void = () => undefined;
  // A prompt stream that never yields: Claude Code starts and answers control requests, but no message is sent.
  const idle = (async function* () {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  })();
  const session = query({
    prompt: idle as never,
    options: {
      tools: [],
      skills: [],
      settingSources: [],
      maxTurns: 1,
      env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: "false" },
    } as never,
  });
  try {
    const rows = (await Promise.race([
      session.supportedModels(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("supportedModels timed out")), 60_000)),
    ])) as SdkModelInfo[];
    const byId = new Map<string, LiveConnectionModel>();
    for (const row of rows) {
      const model = toLiveConnectionModel(row);
      if (model && !byId.has(model.id)) byId.set(model.id, model);
    }
    return [...byId.values()];
  } finally {
    release();
    await session.interrupt().catch(() => undefined);
  }
}

/** Live list for the signed-in subscription, cached for six hours. Throws when the SDK cannot answer. */
export async function fetchClaudeSubscriptionModels(
  options: { refresh?: boolean } = {},
): Promise<LiveConnectionModel[]> {
  if (!options.refresh && cached && Date.now() - cached.at < CACHE_MS) return cached.models;
  if (!inflight) {
    inflight = querySupportedModels()
      .then((models) => {
        if (models.length) cached = { at: Date.now(), models };
        return models;
      })
      .catch((error) => {
        logger.warn({ err: error }, "[claude-subscription] live model list unavailable; using the built-in list");
        throw error;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}
