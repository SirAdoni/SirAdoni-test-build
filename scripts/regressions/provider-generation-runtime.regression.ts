import assert from "node:assert/strict";

import { resolveGenerationProviderRuntime } from "../../packages/server/src/services/generation/provider-generation-runtime.js";

const runtime = resolveGenerationProviderRuntime({
  connectionId: "chatgpt",
  connection: {
    provider: "openai_chatgpt",
    model: "gpt-5.6-sol",
    apiKey: "",
    defaultParameters: {
      verbosity: "high",
      enabledParameters: { verbosity: true },
    },
  },
  baseUrl: "",
  chatMode: "game",
  isSceneChat: false,
  chatParameters: null,
  managedParameterDefinitions: [],
  modelAccessPolicy: { suppressModelParameters: false },
  initial: {
    temperature: undefined,
    maxTokens: 4096,
    topP: undefined,
    topK: 0,
    minP: 0,
    frequencyPenalty: 0,
    presencePenalty: 0,
    showThoughts: false,
    reasoningEffort: null,
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

assert.equal(runtime.verbosity, "high", "Game Mode must preserve the selected verbosity");
assert.equal(runtime.enabledParameters?.verbosity, true, "Game Mode must preserve the verbosity send toggle");

console.log("provider generation runtime regression passed");
