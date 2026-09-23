import assert from "node:assert/strict";
import {
  __setSdkForTesting,
  ClaudeSubscriptionProvider,
} from "../../packages/server/src/services/llm/providers/claude-subscription.provider.js";

let sdkUsage: Record<string, number> = { input_tokens: 11, output_tokens: 3 };
__setSdkForTesting({
  query: (() =>
    (async function* () {
      yield {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "reply" } },
      };
      yield {
        type: "result",
        subtype: "success",
        result: "",
        usage: sdkUsage,
        modelUsage: { "claude-opus-5": {} },
        fast_mode_state: "off",
      };
    })()) as never,
});

async function collectUsage(provider: ClaudeSubscriptionProvider) {
  const iterator = provider.chat([{ role: "user", content: "test" }], {
    model: "claude-opus-5",
    stream: true,
  });
  let step = await iterator.next();
  while (!step.done) step = await iterator.next();
  return step.value;
}

try {
  const provider = new ClaudeSubscriptionProvider("", "");

  sdkUsage = {
    input_tokens: 11,
    output_tokens: 3,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  assert.deepEqual(await collectUsage(provider), {
    promptTokens: 11,
    completionTokens: 3,
    totalTokens: 14,
    cachedPromptTokens: 0,
    cacheWritePromptTokens: 0,
  });

  sdkUsage = {
    input_tokens: 11,
    output_tokens: 3,
    cache_read_input_tokens: 7,
    cache_creation_input_tokens: 5,
  };
  assert.deepEqual(await collectUsage(provider), {
    promptTokens: 11,
    completionTokens: 3,
    totalTokens: 14,
    cachedPromptTokens: 7,
    cacheWritePromptTokens: 5,
  });

  sdkUsage = { input_tokens: 11, output_tokens: 3, cache_read_input_tokens: 0 };
  assert.deepEqual(await collectUsage(provider), {
    promptTokens: 11,
    completionTokens: 3,
    totalTokens: 14,
    cachedPromptTokens: 0,
  });

  sdkUsage = { input_tokens: 11, output_tokens: 3 };
  assert.deepEqual(await collectUsage(provider), {
    promptTokens: 11,
    completionTokens: 3,
    totalTokens: 14,
  });
} finally {
  __setSdkForTesting(null);
}

console.log("claude cache usage regression passed");
