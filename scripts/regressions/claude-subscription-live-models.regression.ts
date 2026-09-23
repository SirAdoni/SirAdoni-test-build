import assert from "node:assert/strict";

// The Claude subscription connection used a hand-written model list, so a new model (or one the account cannot use)
// never matched what the signed-in account really offers, and the parameter panel offered settings those models
// reject. The Agent SDK reports the account's models with their effort levels, adaptive thinking and fast mode; these
// rows are the real answer captured from the SDK on 17 September 2026.
const { toLiveConnectionModel } = await import(
  "../../packages/server/src/services/llm/providers/claude-subscription/live-models.js"
);

const rows = [
  {
    value: "default",
    resolvedModel: "claude-opus-5[1m]",
    displayName: "Default (recommended)",
    description: "Opus 5 with 1M context · Best for everyday, complex tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsFastMode: true,
  },
  {
    value: "claude-fable-5[1m]",
    resolvedModel: "claude-fable-5",
    displayName: "Fable",
    description: "Fable 5 · Most capable for your hardest and longest-running tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
  },
  {
    value: "haiku",
    resolvedModel: "claude-haiku-4-5-20251001",
    displayName: "Haiku",
    description: "Haiku 4.5 · Fastest for quick answers",
  },
];

const opus = toLiveConnectionModel(rows[0]!)!;
assert.equal(opus.id, "claude-opus-5", "the id is the canonical model id connections already store, without the [1m] tag");
assert.equal(opus.name, "Opus 5 with 1M context");
assert.equal(opus.context, 1_000_000);
assert.deepEqual(opus.capabilities?.effortLevels, ["low", "medium", "high", "xhigh", "maximum"], "API 'max' maps to Marinara's 'maximum'");
assert.deepEqual(
  opus.capabilities?.effortLabels,
  { low: "low", medium: "medium", high: "high", xhigh: "xhigh", maximum: "max" },
  "each button is labelled with the provider's own name for the level",
);
assert.equal(opus.capabilities?.fastMode, true);
assert.equal(opus.capabilities?.samplingRejected, true, "Opus 5 rejects temperature and top-p");

const fable = toLiveConnectionModel(rows[1]!)!;
assert.equal(fable.id, "claude-fable-5");
assert.equal(fable.capabilities?.fastMode, false, "fast mode is only offered where the account reports it");
assert.equal(fable.capabilities?.adaptiveThinking, true);

const haiku = toLiveConnectionModel(rows[2]!)!;
assert.equal(haiku.id, "claude-haiku-4-5-20251001");
assert.deepEqual(haiku.capabilities?.effortLevels, [], "a model without effort support offers no effort levels");
assert.equal(haiku.capabilities?.samplingRejected, false, "Haiku 4.5 still accepts sampling settings");

assert.equal(toLiveConnectionModel({ value: "opusplan", displayName: "Plan", description: "x" } as never), null, "non-model aliases are skipped");

console.log("claude-subscription-live-models regression passed");
