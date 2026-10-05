import assert from "node:assert/strict";
import {
  gameGmReasoningEffortOptions,
  resolveGameGmReasoningEffort,
} from "../../packages/shared/src/constants/game-gm-reasoning-effort.js";
import { resolveGenerationProviderRuntime } from "../../packages/server/src/services/generation/provider-generation-runtime.js";
import { resolveModelAccessPolicy } from "../../packages/server/src/services/generation/model-access-policy.js";

function runtime(
  chatMode: string,
  isSceneChat: boolean,
  setting?: unknown,
  provider = "openai",
  model = "gpt-5",
  enabled = true,
) {
  return resolveGenerationProviderRuntime({
    connectionId: "fixture",
    connection: { provider, model, apiKey: "synthetic" },
    baseUrl: "https://api.openai.com/v1",
    chatMode,
    isSceneChat,
    chatParameters: {},
    gameGmReasoningEffort: setting,
    gameGmReasoningEnabled: enabled,
    managedParameterDefinitions: [],
    modelAccessPolicy: resolveModelAccessPolicy({ provider, model }),
    initial: {
      temperature: 1,
      maxTokens: 4096,
      topP: 1,
      topK: 0,
      minP: 0,
      frequencyPenalty: 0,
      presencePenalty: 0,
      showThoughts: false,
      reasoningEffort: "medium",
      verbosity: null,
      serviceTier: null,
      assistantPrefill: "",
      assistantReasoningPrefill: "",
      customThinkingTags: [],
      customParameters: {},
      enabledParameters: undefined,
      stopSequences: [],
      effectiveMaxContext: undefined,
    },
  });
}

assert.equal(runtime("game", false, "high").reasoningEffort, "high", "Game narration uses the saved override");
assert.equal(
  runtime("game", false, "high", "openai", "gpt-5", false).reasoningEffort,
  "medium",
  "the opt-in being off preserves ordinary chat reasoning despite a saved override",
);
assert.equal(runtime("game", false, "high", "openai", "gpt-5", false).gameGmReasoningApplied, false);
assert.equal(runtime("game", false, "default").reasoningEffort, "medium", "default preserves ordinary resolution");
assert.equal(runtime("conversation", false, "high").reasoningEffort, "medium", "conversation chats ignore it");
assert.equal(runtime("game", true, "low").reasoningEffort, "maximum", "scene calls keep their scene reasoning policy");
assert.equal(
  resolveGameGmReasoningEffort({ provider: "openai", model: "gpt-5.4", setting: "maximum" }),
  "xhigh",
  "saved maximum maps to the provider/model level used by ordinary generation",
);
assert.equal(
  runtime("game", false, "maximum", "openai", "gpt-5.4").resolvedEffort,
  "xhigh",
  "runtime applies the same mapping as the shared control",
);
assert.equal(
  gameGmReasoningEffortOptions({ provider: "openai", model: "gpt-5.4", selected: "maximum" }).includes("maximum"),
  true,
  "the UI retains the saved selection while the provider mapping lowers it",
);
assert.equal(
  runtime("game", false, "maximum", "openrouter", "gpt-5.4").resolvedEffort,
  "xhigh",
  "switching provider/model recomputes the saved selection using the new static mapping",
);
assert.equal(
  runtime("game", false, "maximum", "zai", "glm-5.3").resolvedEffort,
  "max",
  "a provider-specific maximum remains supported where the shared mapping allows it",
);
assert.equal(
  resolveGameGmReasoningEffort({ provider: "openai", model: "gpt-4o", setting: "maximum" }),
  undefined,
  "models with no known effort control keep ordinary request resolution",
);
assert.equal(
  runtime("game", false, "maximum", "custom", "unknown-model").resolvedEffort,
  "high",
  "unknown providers retain generic provider behavior",
);
assert.equal(resolveGameGmReasoningEffort({ provider: "openai", model: "gpt-5", setting: "default" }), undefined);
assert.equal(resolveGameGmReasoningEffort({ provider: "openai", model: "gpt-5", setting: "none" }), null);
assert.equal(
  gameGmReasoningEffortOptions({ provider: "anthropic", model: "claude-opus-5-5", selected: "none" }).includes("none"),
  false,
  "models that always think must not offer reasoning off",
);
assert.equal(
  resolveGameGmReasoningEffort({ provider: "anthropic", model: "claude-opus-5-5", setting: "none" }),
  "low",
  "a saved none choice maps to the minimum supported effort after switching to an always-thinking model",
);
assert.equal(
  runtime("game", false, "none", "anthropic", "claude-opus-5-5").resolvedEffort,
  "low",
  "the narration request uses the mapped effort shown by the control",
);
console.info("Game GM reasoning effort regression passed");
