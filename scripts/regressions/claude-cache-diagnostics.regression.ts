import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.LOG_DIR = mkdtempSync(join(tmpdir(), "marinara-claude-cache-diagnostics-"));
process.env.LOG_LEVEL = "info";
process.env.LOG_FILE_LEVEL = "info";
const { __setSdkForTesting, ClaudeSubscriptionProvider } =
  await import("../../packages/server/src/services/llm/providers/claude-subscription.provider.js");
const { beginClaudeCacheDiagnostic, logClaudeCacheResult } =
  await import("../../packages/server/src/services/llm/providers/claude-cache-diagnostics.js");
const { logger } = await import("../../packages/server/src/lib/logger.js");

type FakeMessage = Record<string, unknown>;
let messages: FakeMessage[] = [];
let observedOutput = "";
__setSdkForTesting({
  query: (() =>
    (async function* () {
      yield* messages;
    })()) as never,
});

async function collect(provider: ClaudeSubscriptionProvider, stream: boolean): Promise<string> {
  let output = "";
  observedOutput = "";
  for await (const chunk of provider.chat([{ role: "user", content: "PROMPT_SECRET_SENTINEL" }], {
    model: "claude-opus-5",
    stream,
  })) {
    output += chunk;
    observedOutput += chunk;
  }
  return output;
}

const previousResume = process.env.CLAUDE_SUBSCRIPTION_USE_RESUME;
process.env.CLAUDE_SUBSCRIPTION_USE_RESUME = "false";
try {
  const provider = new ClaudeSubscriptionProvider("", "");
  messages = [
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "stream" } } },
    { type: "result", subtype: "success", result: "", usage: { input_tokens: 1, output_tokens: 1 } },
  ];
  assert.equal(await collect(provider, true), "stream");

  messages = [
    { type: "assistant", message: { content: [{ type: "text", text: "nonstream" }] } },
    { type: "result", subtype: "success", result: "", usage: { input_tokens: 1, output_tokens: 1 } },
  ];
  assert.equal(await collect(provider, false), "nonstream");

  messages = [{ type: "result", subtype: "success", result: "" }];
  await assert.rejects(collect(provider, true), /returned no content/u);

  messages = [
    {
      type: "result",
      subtype: "success",
      is_error: true,
      api_error_status: 429,
      terminal_reason: "api_error",
      result: "Provider error text",
    },
  ];
  await assert.rejects(collect(provider, true), (error: unknown) => {
    assert.equal((error as Error & { cause: { status: number } }).cause.status, 429);
    return true;
  });
  assert.equal(observedOutput, "");

  messages = [
    { type: "assistant", error: "rate_limit", message: { content: [{ type: "text", text: "do not yield" }] } },
    { type: "result", subtype: "success", result: "Must not emit fallback text" },
  ];
  await assert.rejects(collect(provider, false), /request failed/u);
  assert.equal(observedOutput, "");

  messages = [
    { type: "assistant", error: "rate_limit", message: { content: [{ type: "text", text: "do not yield" }] } },
    { type: "result", subtype: "success", result: "Must not emit fallback text", is_error: false },
  ];
  await assert.rejects(collect(provider, true), /request failed/u);
  assert.equal(observedOutput, "");

  messages = [
    {
      type: "assistant",
      error: "invalid_request",
      message: { content: [{ type: "text", text: "Must not emit assistant error" }] },
    },
  ];
  await assert.rejects(collect(provider, false), /request failed/u);
  assert.equal(observedOutput, "");

  messages = [];
  __setSdkForTesting({
    query: (() => {
      throw new Error("transport-failure");
    }) as never,
  });
  await assert.rejects(collect(provider, true), /request failed/u);
  __setSdkForTesting({
    query: (() =>
      (async function* () {
        yield { type: "result", subtype: "success", result: "ok" };
      })()) as never,
  });
} finally {
  if (previousResume === undefined) delete process.env.CLAUDE_SUBSCRIPTION_USE_RESUME;
  else process.env.CLAUDE_SUBSCRIPTION_USE_RESUME = previousResume;
  __setSdkForTesting(null);
}

const many = Array.from({ length: 600 }, (_, index) => ({ role: "user", content: `tail-${index}` }));
const changedTail = many.map((message, index) =>
  index === 599 ? { ...message, content: "changed last omitted turn" } : message,
);
const firstAttempt = beginClaudeCacheDiagnostic(
  many,
  {
    model: "claude-opus-5",
    customParameters: "secret-value",
    cwd: "C:\\private\\cwd",
  },
  {
    requestedModel: "claude-opus-5",
    path: "fold",
    systemPrompt: ["static", "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__", "dynamic"],
  },
);
const secondAttempt = beginClaudeCacheDiagnostic(
  many,
  {
    model: "claude-opus-5",
    customParameters: "secret-value",
    cwd: "C:\\other\\cwd",
    resume: "other-session",
  },
  {
    requestedModel: "claude-opus-5",
    path: "resume",
    sessionHash: "other-session",
    systemPrompt: ["static", "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__", "dynamic"],
  },
);
assert.match(firstAttempt.cacheRequestId, /^[0-9a-f-]{36}$/u);
assert.match(secondAttempt.cacheRequestId, /^[0-9a-f-]{36}$/u);
logClaudeCacheResult(firstAttempt, {
  subtype: "success",
  usage: { input_tokens: 10, cache_creation: { ephemeral_5m_input_tokens: 7, ephemeral_1h_input_tokens: 3 } },
});
logClaudeCacheResult(firstAttempt, { subtype: "success" });
const changedAttempt = beginClaudeCacheDiagnostic(
  changedTail,
  { model: "claude-opus-5" },
  { requestedModel: "claude-opus-5", path: "fold" },
);
const changedVisible = beginClaudeCacheDiagnostic(
  [
    { role: "user", content: "tail-0" },
    { role: "user", content: "changed second turn", providerMetadata: { secret: "METADATA_SECRET_SENTINEL" } },
  ],
  { model: "claude-opus-5", env: { token: "ENV_SECRET_SENTINEL" } },
  { requestedModel: "claude-opus-5", path: "fold" },
);

const logFiles = readdirSync(process.env.LOG_DIR!)
  .map((name) => readFileSync(join(process.env.LOG_DIR!, name), "utf8"))
  .join("\n");
const diagnosticEvents = logFiles
  .split("\n")
  .filter((line) => line.includes('"observationBoundary":"sdk-input"'))
  .map((line) => JSON.parse(line) as Record<string, unknown>);
const firstBase = diagnosticEvents.find(
  (event) => event.cacheRequestId === firstAttempt.cacheRequestId && event.inputCount === 600,
);
assert.ok(firstBase);
assert.equal(firstBase.inputOmittedCount, 88);
const firstInput = diagnosticEvents.find(
  (event) => event.cacheRequestId === firstAttempt.cacheRequestId && event.inputMessages,
);
assert.ok(firstInput);
assert.equal((firstInput.inputMessages as unknown[]).length, 24);
assert.equal((firstInput.inputMessages as Array<{ index: number }>).at(-1)?.index, 23);
const inputBatches = diagnosticEvents.filter(
  (event) => event.cacheRequestId === firstAttempt.cacheRequestId && event.inputMessages,
);
assert.equal(inputBatches.length, 22);
assert.equal((inputBatches.at(-1)?.inputMessages as Array<{ index: number }>).at(-1)?.index, 511);
const resultEvent = diagnosticEvents.find(
  (event) =>
    event.providerEvent === "result" &&
    (event.usage as Record<string, unknown> | undefined)?.ephemeral5mInputTokens === 7,
);
assert.ok(resultEvent);
assert.equal(resultEvent.observationBoundary, "sdk-input");
assert.equal(JSON.stringify(resultEvent).includes("secret-value"), false);
assert.equal(JSON.stringify(resultEvent).includes("private"), false);
assert.equal((resultEvent.usage as Record<string, unknown>).ephemeral5mInputTokens, 7);
assert.equal((resultEvent.usage as Record<string, unknown>).ephemeral1hInputTokens, 3);

const secondBase = diagnosticEvents.find(
  (event) => event.cacheRequestId === secondAttempt.cacheRequestId && event.inputCount === 600,
);
assert.ok(firstBase && secondBase);
assert.equal(firstBase.sdkOptionsFingerprint, secondBase.sdkOptionsFingerprint);
assert.notDeepEqual(firstBase.sdkIdentity, secondBase.sdkIdentity);
const changedBase = diagnosticEvents.find(
  (event) => event.cacheRequestId === changedAttempt.cacheRequestId && event.inputCount === 600,
)!;
assert.notEqual(firstBase.inputAggregateHash, changedBase.inputAggregateHash, "aggregate covers omitted tail");
const changedBatch = diagnosticEvents.find(
  (event) => event.cacheRequestId === changedVisible.cacheRequestId && event.inputMessages,
)!;
const originalItems = firstInput.inputMessages as Array<{ messageHash: string; prefixHash: string }>;
const changedItems = changedBatch.inputMessages as Array<{ messageHash: string; prefixHash: string }>;
assert.equal(originalItems[0]!.messageHash, changedItems[0]!.messageHash);
assert.equal(originalItems[0]!.prefixHash, changedItems[0]!.prefixHash);
assert.notEqual(originalItems[1]!.prefixHash, changedItems[1]!.prefixHash);
assert.equal((firstBase.system as { dynamicBoundaryIndex: number }).dynamicBoundaryIndex, 1);
assert.ok(diagnosticEvents.some((event) => event.apiErrorStatus === 429));
const cacheLog = JSON.stringify(diagnosticEvents);
for (const secret of [
  "PROMPT_SECRET_SENTINEL",
  "METADATA_SECRET_SENTINEL",
  "ENV_SECRET_SENTINEL",
  "tail-599",
  "other-session",
]) {
  assert.equal(cacheLog.includes(secret), false, `cache logs must omit ${secret}`);
}
assert.equal(logFiles.includes("secret-value"), false);
assert.equal(logFiles.includes("private"), false);
const failureEvent = diagnosticEvents.filter((event) => event.providerEvent === "failure").at(-1);
assert.ok(failureEvent?.cacheRequestId, "transport failure must retain request correlation");
assert.ok(
  diagnosticEvents.some(
    (event) => event.cacheRequestId === failureEvent.cacheRequestId && event.msg === "Claude SDK request attempt",
  ),
);
assert.equal(
  diagnosticEvents.some(
    (event) => event.cacheRequestId === failureEvent.cacheRequestId && event.providerEvent === "result",
  ),
  false,
  "transport failure has no fabricated result usage",
);
const missingUsageEvent = diagnosticEvents.find((event) => event.providerEvent === "result" && event.usage === null);
assert.ok(missingUsageEvent, "missing SDK usage must remain null");

const circular: Record<string, unknown> = {};
circular.self = circular;
assert.doesNotThrow(() =>
  beginClaudeCacheDiagnostic(
    [{ role: "user", content: "visible", providerMetadata: circular }],
    {},
    { requestedModel: "claude-opus-5", path: "direct" },
  ),
);
const infoBefore = logger.info;
logger.info = (() => {
  throw new Error("log sink failure");
}) as typeof logger.info;
assert.doesNotThrow(() =>
  beginClaudeCacheDiagnostic(
    [{ role: "user", content: "visible" }],
    {},
    { requestedModel: "claude-opus-5", path: "direct" },
  ),
);
logger.info = infoBefore;

console.log("claude cache diagnostics regression passed");
