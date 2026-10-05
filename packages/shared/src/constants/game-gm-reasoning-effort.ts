import {
  reasoningEffortChoices,
  relevantGenerationParameters,
  supportsClaudeThinkingDisable,
  type GenerationParameterContext,
  type StoredEffortLevel,
} from "./generation-parameter-relevance.js";
import {
  isClaudeAdaptiveOnlyNoSamplingModel,
  isClaudeOpus55Model,
  resolveProviderReasoningEffort,
} from "./model-lists.js";

/** Per-game narration override, stored in chat metadata. Side calls do not read this setting. */
export const GAME_GM_REASONING_EFFORTS = ["default", "none", "low", "medium", "high", "xhigh", "maximum"] as const;
export type GameGmReasoningEffort = (typeof GAME_GM_REASONING_EFFORTS)[number];

export function normalizeGameGmReasoningEffort(value: unknown): GameGmReasoningEffort {
  return typeof value === "string" && (GAME_GM_REASONING_EFFORTS as readonly string[]).includes(value)
    ? (value as GameGmReasoningEffort)
    : "default";
}

/** Opus 5.5 always thinks; adaptive Claude models use their provider-supported disable capability. */
function canTurnReasoningOff(model: string): boolean {
  if (isClaudeOpus55Model(model)) return false;
  if (isClaudeAdaptiveOnlyNoSamplingModel(model)) return supportsClaudeThinkingDisable(model);
  return true;
}

/** Choices offered by the known provider/model rules, with the normal setting first. */
export function gameGmReasoningEffortOptions(
  context: GenerationParameterContext & { selected?: GameGmReasoningEffort | null },
): GameGmReasoningEffort[] {
  const options: GameGmReasoningEffort[] = ["default"];
  const provider = String(context.provider ?? "").trim();
  const model = String(context.model ?? "")
    .trim()
    .toLowerCase();
  if (provider && !relevantGenerationParameters({ ...context, reasoningEffort: undefined }).has("reasoningEffort")) {
    return options;
  }
  const selected = context.selected;
  const selectedLevel: StoredEffortLevel | null =
    selected && selected !== "default" && selected !== "none" ? selected : null;
  for (const choice of reasoningEffortChoices({ ...context, reasoningEffort: undefined, selected: selectedLevel })) {
    if (choice.value === null) {
      if (choice.kind !== "default" && canTurnReasoningOff(model)) options.push("none");
      continue;
    }
    if (!options.includes(choice.value)) options.push(choice.value);
  }
  return options;
}

/** Undefined preserves ordinary resolution; null means off; stored levels map through the provider/model rules. */
export function resolveGameGmReasoningEffort(args: {
  provider: string | null | undefined;
  model: string | null | undefined;
  setting: unknown;
}): StoredEffortLevel | null | undefined {
  const setting = normalizeGameGmReasoningEffort(args.setting);
  if (setting === "default") return undefined;
  const options = gameGmReasoningEffortOptions({ provider: args.provider, model: args.model });
  if (options.length === 1) return undefined;
  if (setting === "none") {
    if (options.includes("none")) return null;
    return options.find((option): option is StoredEffortLevel => option !== "default" && option !== "none");
  }
  const resolved = resolveProviderReasoningEffort({
    provider: String(args.provider ?? ""),
    model: String(args.model ?? ""),
    reasoningEffort: setting,
  });
  return resolved === "max" ? "maximum" : resolved;
}
