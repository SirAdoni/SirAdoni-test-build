import assert from "node:assert/strict";
import {
  BaseLLMProvider,
  LLMHttpError,
  type ChatCompletionResult,
  type ChatMessage,
  type ChatOptions,
} from "../../packages/server/src/services/llm/base-provider.js";
import {
  MAX_TRANSIENT_RETRIES,
  resolvedAddressOffsetForAttempt,
  withRateLimitAwareProvider,
} from "../../packages/server/src/services/llm/rate-limit-aware-provider.js";
import { resetFeatureSettingsForTests } from "../../packages/server/src/services/features/feature-settings.js";

// Settings > Features "Retry failed provider calls" (providerRetry). ON (default) is today: a refused
// connection or a gateway 502/503 is retried up to MAX_TRANSIENT_RETRIES times, each retry on the next
// DNS address. OFF is upstream: only rate limits (429/529) retry and every attempt uses the first
// address. PROVIDER_RETRY_TRANSIENT_ERRORS wins when set. Stub providers only, no network.
delete process.env.PROVIDER_RETRY_TRANSIENT_ERRORS;
const OK = { content: "done", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: "stop" };
type Step = "502" | "refused" | "429" | "ok";

class ScriptedProvider extends BaseLLMProvider {
  calls = 0;
  constructor(private readonly plan: Step[]) {
    super("", "", 1000, null, null);
  }
  // eslint-disable-next-line require-yield
  async *chat(): AsyncGenerator<string, void, unknown> {
    return;
  }
  async chatComplete(_messages: ChatMessage[], _options: ChatOptions): Promise<ChatCompletionResult> {
    const step = this.plan[Math.min(this.calls, this.plan.length - 1)];
    this.calls += 1;
    if (step === "502") throw new LLMHttpError("bad gateway", { status: 502, retryAfterMs: 0 });
    if (step === "429") throw new LLMHttpError("rate limited", { status: 429, retryAfterMs: 0 });
    if (step === "refused") {
      // A connect-phase failure. It is retried only after a short jittered wait (about 1 s).
      throw Object.assign(new Error("fetch failed"), {
        cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }),
      });
    }
    return OK as ChatCompletionResult;
  }
  async embed(): Promise<number[][]> {
    return [];
  }
}
const run = (plan: Step[], id: string) => {
  const stub = new ScriptedProvider(plan);
  return { stub, result: withRateLimitAwareProvider(stub, id).chatComplete([], { model: "test" } as ChatOptions) };
};

try {
  // ON = today
  resetFeatureSettingsForTests();
  const onGateway = run(["502", "ok"], "conn-on-502");
  assert.equal((await onGateway.result).content, "done", "ON: a gateway 502 is retried");
  assert.equal(onGateway.stub.calls, 2);
  const onExhaust = run(["502"], "conn-on-exhaust");
  await assert.rejects(onExhaust.result, /bad gateway/);
  assert.equal(onExhaust.stub.calls, MAX_TRANSIENT_RETRIES + 1, "ON: bounded transient budget");
  const onRefused = run(["refused", "ok"], "conn-on-refused");
  assert.equal((await onRefused.result).content, "done", "ON: a refused connection is retried");
  assert.deepEqual([0, 1, 2].map(resolvedAddressOffsetForAttempt), [0, 1, 2], "ON: each retry tries the next address");

  // OFF = upstream
  resetFeatureSettingsForTests({ providerRetry: false });
  const offGateway = run(["502", "ok"], "conn-off-502");
  await assert.rejects(offGateway.result, /bad gateway/, "OFF: a gateway 502 propagates");
  assert.equal(offGateway.stub.calls, 1, "OFF: no transient retry");
  const offRefused = run(["refused", "ok"], "conn-off-refused");
  await assert.rejects(offRefused.result, /fetch failed/, "OFF: a refused connection propagates");
  assert.equal(offRefused.stub.calls, 1);
  const offRateLimit = run(["429", "ok"], "conn-off-429");
  assert.equal((await offRateLimit.result).content, "done", "OFF: rate limits still retry, as upstream");
  assert.equal(offRateLimit.stub.calls, 2);
  assert.deepEqual([0, 1, 2].map(resolvedAddressOffsetForAttempt), [0, 0, 0], "OFF: always the first address");

  // Env precedence
  process.env.PROVIDER_RETRY_TRANSIENT_ERRORS = "true";
  const envOn = run(["502", "ok"], "conn-env-on");
  assert.equal((await envOn.result).content, "done", "env on wins over a saved off");
  resetFeatureSettingsForTests();
  process.env.PROVIDER_RETRY_TRANSIENT_ERRORS = "false";
  const envOff = run(["502", "ok"], "conn-env-off");
  await assert.rejects(envOff.result, /bad gateway/, "env off wins over the default");
} finally {
  delete process.env.PROVIDER_RETRY_TRANSIENT_ERRORS;
  resetFeatureSettingsForTests();
}

console.log("feature-switch-provider-retry regression passed");
