import assert from "node:assert/strict";
import { normalizeGenerationTokenUsage } from "../../packages/client/src/lib/generation-token-usage.js";

const openAi = normalizeGenerationTokenUsage({
  provider: "openai",
  tokensPrompt: 100,
  tokensCompletion: 20,
  tokensCachedPrompt: 40,
  tokensCacheWritePrompt: 0,
});
assert.deepEqual(openAi, {
  freshInput: null,
  inputTotal: 100,
  inputTotalExact: true,
  output: 20,
  cacheRead: 40,
  cacheWrite: 0,
  cacheHitRatio: 0.4,
  effort: null,
});

const claude = normalizeGenerationTokenUsage({
  provider: "claude_subscription",
  tokensPrompt: 100,
  tokensCompletion: 20,
  tokensCachedPrompt: 40,
  tokensCacheWritePrompt: 10,
});
assert.equal(claude?.inputTotal, 150);
assert.equal(claude?.freshInput, 100);
assert.equal(claude?.inputTotalExact, true);

const legacyClaude = normalizeGenerationTokenUsage({
  provider: "claude_subscription",
  tokensPrompt: 100,
  tokensCompletion: 20,
});
assert.equal(legacyClaude?.inputTotal, null);
assert.equal(legacyClaude?.freshInput, 100);
assert.equal(legacyClaude?.cacheHitRatio, null);

const anthropic = normalizeGenerationTokenUsage({
  provider: "anthropic",
  tokensPrompt: 300,
  tokensCompletion: 20,
  tokensCachedPrompt: 20000,
  tokensCacheWritePrompt: 500,
});
assert.equal(anthropic?.inputTotal, 20800);
assert.equal(anthropic?.freshInput, 300);
assert.equal(anthropic?.inputTotalExact, true);
assert.equal(anthropic?.cacheHitRatio, 20000 / 20800);

const anthropicNoCache = normalizeGenerationTokenUsage({ provider: "anthropic", tokensPrompt: 300 });
assert.equal(anthropicNoCache?.inputTotal, 300);
assert.equal(anthropicNoCache?.inputTotalExact, true);

assert.equal(normalizeGenerationTokenUsage({ provider: "openai", tokensPrompt: -1 })?.inputTotal, null);
assert.equal(
  normalizeGenerationTokenUsage({ provider: "openai", tokensPrompt: 0, tokensCachedPrompt: 0 })?.cacheHitRatio,
  null,
);

// The usage line names the effort the turn actually resolved to, when generation info stored one.
assert.equal(normalizeGenerationTokenUsage({ provider: "claude_subscription", reasoningEffort: "low" })?.effort, "low");
assert.equal(normalizeGenerationTokenUsage({ provider: "openai", reasoningEffort: null })?.effort, null);
assert.equal(normalizeGenerationTokenUsage({ provider: "openai", reasoningEffort: " " })?.effort, null);

console.info("Generation token usage regressions passed.");
