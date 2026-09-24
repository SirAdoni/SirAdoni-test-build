import {
  reasoningEffortChoices,
  relevantGenerationParameters,
  supportsClaudeThinkingDisable,
  type GenerationParameterContext,
  type StoredEffortLevel,
} from "./generation-parameter-relevance.js";
import { isClaudeAdaptiveOnlyNoSamplingModel, isClaudeOpus55Model } from "./model-lists.js";

/**
 * Per-game reasoning effort for the Game Master's narration turn (including regenerate and continue of that turn).
 *
 * Stored in chat metadata under `gameGmReasoningEffort` and carried to later sessions of the same game. Absent or
 * "default" leaves the request exactly as the ordinary parameter resolution builds it. Side calls that set their own
 * effort (scene analysis, planners, continuity, agents) never read it.
 */
export const GAME_GM_REASONING_EFFORT_METADATA_KEY = "gameGmReasoningEffort";

export const GAME_GM_REASONING_EFFORTS = ["default", "none", "low", "medium", "high", "xhigh", "maximum"] as const;
export type GameGmReasoningEffort = (typeof GAME_GM_REASONING_EFFORTS)[number];

export function normalizeGameGmReasoningEffort(value: unknown): GameGmReasoningEffort {
  return typeof value === "string" && (GAME_GM_REASONING_EFFORTS as readonly string[]).includes(value)
    ? (value as GameGmReasoningEffort)
    : "default";
}

/** Whether asking for no reasoning really turns it off. Opus 5.5 always thinks: both Claude providers send "low". */
function canTurnReasoningOff(model: string): boolean {
  if (isClaudeOpus55Model(model)) return false;
  if (isClaudeAdaptiveOnlyNoSamplingModel(model)) return supportsClaudeThinkingDisable(model);
  return true;
}

/**
 * The choices worth offering for this connection, "default" first. Levels that send the same value to the provider
 * are shown once (keeping the selected one), and a model without an effort control only gets "default".
 */
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

/**
 * The effort to force for the GM narration turn, clamped to what the model supports, or undefined to leave the
 * resolved parameters untouched. A null result means "reasoning off". Levels above the model's ceiling are lowered
 * afterwards by resolveProviderReasoningEffort, so an unsupported level is never sent as is.
 */
export function resolveGameGmReasoningEffort(args: {
  provider: string | null | undefined;
  model: string | null | undefined;
  setting: unknown;
}): StoredEffortLevel | null | undefined {
  const setting = normalizeGameGmReasoningEffort(args.setting);
  if (setting === "default") return undefined;
  const options = gameGmReasoningEffortOptions({ provider: args.provider, model: args.model });
  // No effort control on this model: sending one would change nothing or be rejected.
  if (options.length === 1) return undefined;
  if (setting === "none") {
    if (options.includes("none")) return null;
    return options.find((option): option is StoredEffortLevel => option !== "default" && option !== "none");
  }
  return setting;
}
