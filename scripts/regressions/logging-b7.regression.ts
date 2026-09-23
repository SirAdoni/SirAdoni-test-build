// Logging plan v1.0, batch B8 (LLM providers): typed provider errors, no
// log-then-throw, stream frame stats, the encrypted-reasoning retry line,
// shape-only empty-response logging and debug-level per-item cache detail.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const logDirectory = mkdtempSync(join(tmpdir(), "marinara-logging-b7-"));
const dataDirectory = mkdtempSync(join(tmpdir(), "marinara-logging-b7-data-"));
const saved = {
  LOG_DIR: process.env.LOG_DIR,
  LOG_LEVEL: process.env.LOG_LEVEL,
  LOG_FILE_LEVEL: process.env.LOG_FILE_LEVEL,
  DATA_DIR: process.env.DATA_DIR,
  MARINARA_CACHE_DIAGNOSTICS: process.env.MARINARA_CACHE_DIAGNOSTICS,
  CLAUDE_SUBSCRIPTION_USE_RESUME: process.env.CLAUDE_SUBSCRIPTION_USE_RESUME,
};
process.env.LOG_DIR = logDirectory;
process.env.LOG_LEVEL = "silent";
process.env.LOG_FILE_LEVEL = "debug";
process.env.DATA_DIR = dataDirectory;
process.env.CLAUDE_SUBSCRIPTION_USE_RESUME = "false";
delete process.env.MARINARA_CACHE_DIAGNOSTICS;

const PROMPT_SENTINEL = "PROMPT_B7_SENTINEL";
const BODY_SENTINEL = "BODY_B7_SENTINEL";
const ARGS_SENTINEL = "ARGS_B7_SENTINEL";

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;
let handler: Handler = () => new Response("{}", { status: 200 });
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) =>
  handler(String(url instanceof Request ? url.url : url), init)) as typeof fetch;

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function sse(frames: string[]): Response {
  return new Response(new TextEncoder().encode(frames.map((frame) => `${frame}\n\n`).join("")), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function drain(iterator: AsyncGenerator<string, unknown, unknown>): Promise<string> {
  let text = "";
  for await (const chunk of iterator) text += chunk;
  return text;
}

type Rec = Record<string, unknown>;
function readRecords(): Rec[] {
  return readdirSync(logDirectory)
    .filter((name) => name.endsWith(".log"))
    .map((name) => readFileSync(join(logDirectory, name), "utf8"))
    .join("\n")
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Rec);
}

const user = [{ role: "user" as const, content: PROMPT_SENTINEL }];

try {
  const { LLMHttpError } = await import("../../packages/server/src/services/llm/base-provider.js");
  const { AnthropicProvider } = await import("../../packages/server/src/services/llm/providers/anthropic.provider.js");
  const { GoogleProvider } = await import("../../packages/server/src/services/llm/providers/google.provider.js");
  const { OpenAIProvider } = await import("../../packages/server/src/services/llm/providers/openai.provider.js");
  const { __setSdkForTesting, ClaudeSubscriptionProvider } =
    await import("../../packages/server/src/services/llm/providers/claude-subscription.provider.js");

  const isHttp = (error: unknown, status: number, providerCode?: string) => {
    assert.ok(error instanceof LLMHttpError, `expected LLMHttpError, got ${String(error)}`);
    assert.equal(error.status, status);
    if (providerCode !== undefined) assert.equal(error.providerCode, providerCode);
    return true;
  };

  // ── (3) Anthropic stream `event: error` becomes a typed error; (6) malformed frames are counted ──
  const anthropic = new AnthropicProvider("http://127.0.0.1:43171/v1", "credential-b7");
  handler = () =>
    sse([
      "data: {not json",
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    ]);
  await assert.rejects(drain(anthropic.chat(user, { model: "claude-b7-model", stream: true })), (error) =>
    isHttp(error, 529, "overloaded_error"),
  );
  handler = () => sse(['data: {"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}']);
  await assert.rejects(drain(anthropic.chat(user, { model: "claude-b7-model", stream: true })), (error) =>
    isHttp(error, 429, "rate_limit_error"),
  );
  handler = () => sse(['data: {"type":"error","error":{"type":"api_error","message":"boom"}}']);
  await assert.rejects(drain(anthropic.chat(user, { model: "claude-b7-model", stream: true })), (error) =>
    isHttp(error, 502, "api_error"),
  );

  // ── (1) HTTP failures carry status, providerCode and the provider request id ──
  handler = () =>
    json({ type: "error", error: { type: "invalid_request_error", message: "bad request" } }, 400, {
      "request-id": "req_b7",
    });
  await assert.rejects(drain(anthropic.chat(user, { model: "claude-b7-model", stream: true })), (error) => {
    isHttp(error, 400, "invalid_request_error");
    assert.match((error as Error).message, /^Anthropic API error \(400\): bad request/u);
    assert.equal((error as { providerRequestId?: string }).providerRequestId, "req_b7");
    return true;
  });

  // ── (8) Bad tool arguments fold to {} and log only their length ──
  handler = () => json({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" });
  const toolResult = await anthropic.chatComplete(
    [
      { role: "user", content: "call a tool" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call-b7", type: "function", function: { name: "b7_tool", arguments: `{${ARGS_SENTINEL}` } },
        ],
      },
      { role: "tool", content: "done", tool_call_id: "call-b7" },
    ],
    {
      model: "claude-sonnet-5",
      stream: false,
      tools: [
        { type: "function", function: { name: "b7_tool", description: "fixture", parameters: { type: "object" } } },
      ],
    } as never,
  );
  assert.equal(toolResult.content, "ok");

  // ── (3) Gemini payload errors and prompt blocks ──
  const gemini = new GoogleProvider("http://127.0.0.1:43172/v1beta", "credential-b7");
  handler = () => sse(['data: {"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"quota"}}']);
  await assert.rejects(drain(gemini.chat(user, { model: "gemini-2.0-flash", stream: true })), (error) =>
    isHttp(error, 429, "RESOURCE_EXHAUSTED"),
  );
  handler = () => json({ error: { status: "INTERNAL", message: "no code" } });
  await assert.rejects(drain(gemini.chat(user, { model: "gemini-2.0-flash", stream: false })), (error) =>
    isHttp(error, 502, "INTERNAL"),
  );
  handler = () => json({ promptFeedback: { blockReason: "SAFETY" } });
  await assert.rejects(drain(gemini.chat(user, { model: "gemini-2.0-flash", stream: false })), (error) => {
    assert.equal((error as { code?: string }).code, "GEMINI_PROMPT_BLOCKED");
    return true;
  });
  handler = () => json({ error: { code: 503, status: "UNAVAILABLE", message: "try later" } }, 503);
  await assert.rejects(drain(gemini.chat(user, { model: "gemini-2.0-flash", stream: false })), (error) => {
    isHttp(error, 503, "503");
    assert.match((error as Error).message, /^Gemini API error \(503\)/u);
    return true;
  });

  // ── (3) OpenAI parseJsonBody: typed, sanitized, no preview for an event stream ──
  const openai = new OpenAIProvider(
    "http://127.0.0.1:43173/v1",
    "credential-b7",
    undefined,
    undefined,
    undefined,
    "openai",
  );
  handler = () =>
    new Response(`data: {broken ${BODY_SENTINEL}\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  await assert.rejects(openai.chatComplete(user, { model: "gpt-4o", stream: false }), (error) => {
    isHttp(error, 502, "invalid_json");
    const fields = error as { contentType?: string; bodyBytes?: number; message: string };
    assert.equal(fields.contentType, "text/event-stream");
    assert.ok((fields.bodyBytes ?? 0) > 0);
    assert.equal(fields.message.includes(BODY_SENTINEL), false);
    return true;
  });
  handler = () =>
    new Response("<html><title>Bad Gateway</title><body>proxy</body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  await assert.rejects(openai.chatComplete(user, { model: "gpt-4o", stream: false }), (error) => {
    isHttp(error, 502, "invalid_json");
    assert.match((error as Error).message, /Body starts with: Bad Gateway/u);
    return true;
  });

  // ── (3) Missing choices keep the provider code ──
  handler = () => json({ error: { code: "context_length_exceeded", message: "too long" } });
  await assert.rejects(openai.chatComplete(user, { model: "gpt-4o", stream: false }), (error) => {
    assert.equal((error as { providerCode?: string }).providerCode, "context_length_exceeded");
    return true;
  });

  // ── (3) Responses failures are always typed ──
  handler = () => json({ id: "resp-b7", status: "failed", error: { code: "rate_limit_exceeded", message: "slow" } });
  await assert.rejects(openai.chatComplete(user, { model: "gpt-5.6", stream: false }), (error) =>
    isHttp(error, 429, "rate_limit_exceeded"),
  );
  handler = () => json({ id: "resp-b7", status: "failed", error: { code: "server_error", message: "x" } });
  await assert.rejects(openai.chatComplete(user, { model: "gpt-5.6", stream: false }), (error) =>
    isHttp(error, 502, "server_error"),
  );

  // ── (7) Encrypted reasoning retry writes one llm.retry warn ──
  let responsesCalls = 0;
  handler = () => {
    responsesCalls++;
    if (responsesCalls === 1) {
      return json({ error: { message: "The encrypted content could not be decrypted" } }, 400);
    }
    return json({
      id: "resp-ok",
      model: "gpt-5.6",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
    });
  };
  const retried = await openai.chatComplete(
    [
      { role: "user", content: "prior" },
      { role: "assistant", content: "prior answer" },
      { role: "user", content: PROMPT_SENTINEL },
    ],
    {
      model: "gpt-5.6",
      stream: false,
      reasoningEffort: "high",
      encryptedReasoningItems: [{ type: "reasoning", encrypted_content: "credential-b7" }],
    } as never,
  );
  assert.equal(retried.content, "ok");
  assert.equal(responsesCalls, 2);

  // ── (5) An empty chat-completions answer logs its shape and a capture path, not the body ──
  handler = () =>
    json({
      id: "chatcmpl-b7",
      choices: [{ message: { content: "", refusal: null, reasoning: BODY_SENTINEL }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 0, total_tokens: 3 },
    });
  const empty = await openai.chatComplete(user, { model: "gpt-4o", stream: false });
  assert.ok(!empty.content);

  // ── (4) Claude subscription: typed wrapper keeps the cause; a cancelled call passes through ──
  const sdkFailure = Object.assign(new Error("sdk failure"), { status: 429, terminal_reason: "api_error" });
  __setSdkForTesting({
    query: (() => {
      throw sdkFailure;
    }) as never,
  });
  const claude = new ClaudeSubscriptionProvider("", "");
  await assert.rejects(drain(claude.chat(user, { model: "claude-opus-5", stream: true })), (error) => {
    isHttp(error, 429, "api_error");
    assert.equal((error as { cause?: unknown }).cause, sdkFailure);
    assert.match((error as Error).message, /request failed/u);
    return true;
  });
  const controller = new AbortController();
  const aborted = Object.assign(new Error("aborted"), { name: "AbortError" });
  __setSdkForTesting({
    query: (() => {
      controller.abort();
      throw aborted;
    }) as never,
  });
  await assert.rejects(
    drain(claude.chat(user, { model: "claude-opus-5", stream: true, signal: controller.signal })),
    (error) => error === aborted,
  );
  __setSdkForTesting(null);

  // ── Log assertions ──
  const { logger } = await import("../../packages/server/src/lib/logger.js");
  logger.flush?.();
  await new Promise((resolve) => setTimeout(resolve, 200));
  const records = readRecords();
  const logText = JSON.stringify(records);

  const malformed = records.find(
    (record) => record.event === "llm.stream.malformed" && record.provider === "anthropic",
  );
  assert.ok(malformed, "malformed anthropic frames produce one llm.stream.malformed warn");
  assert.equal(malformed.level, 40);
  assert.equal(malformed.malformedFrames, 1);

  const invalidArgs = records.find((record) => record.event === "llm.toolcall.invalid_args");
  assert.ok(invalidArgs, "bad tool arguments are logged once");
  assert.equal(invalidArgs.toolName, "b7_tool");
  assert.equal(typeof invalidArgs.argsLength, "number");

  const retry = records.find((record) => record.event === "llm.retry");
  assert.ok(retry, "encrypted reasoning retry logs llm.retry");
  assert.equal(retry.level, 40);
  assert.equal(retry.reason, "encrypted-reasoning-rejected");
  assert.equal(retry.attempt, 2);
  assert.equal(retry.httpStatus, 400);
  assert.ok((retry.strippedItems as number) >= 1);

  const attempt = records.find((record) => record.msg === "OpenAI Responses request attempt");
  assert.ok(attempt);
  assert.equal(attempt.level, 30);
  assert.equal(typeof attempt.inputKinds, "object");
  const batches = records.filter((record) => record.msg === "OpenAI Responses request input batch");
  assert.ok(batches.length > 0);
  assert.ok(
    batches.every((record) => record.level === 20),
    "per-item batches are debug without MARINARA_CACHE_DIAGNOSTICS",
  );
  const httpResult = records.find((record) => record.msg === "OpenAI Responses HTTP result");
  assert.equal(typeof httpResult?.elapsedMs, "number");

  const unexpected = records.find((record) => record.event === "provider.response.unexpected");
  assert.ok(unexpected, "empty chat completion logs its shape");
  assert.equal(unexpected.response, undefined);
  assert.deepEqual(unexpected.responseKeys, ["id", "choices", "usage"]);
  assert.equal(unexpected.reasoningLength, BODY_SENTINEL.length);
  assert.equal(typeof unexpected.capturePath, "string");

  const claudeFailure = records.filter((record) => record.msg === "Claude SDK provider failure");
  assert.equal(claudeFailure.length, 1, "the cancelled Claude call logs no failure line");
  assert.equal(claudeFailure[0]?.level, 40);
  assert.equal(claudeFailure[0]?.httpStatus, 429);
  assert.equal(claudeFailure[0]?.terminalReason, "api_error");
  assert.equal(typeof claudeFailure[0]?.elapsedMs, "number");
  assert.equal(
    records.some((record) =>
      /Claude Agent SDK query failed|Stream ended with response.failed/u.test(String(record.msg)),
    ),
    false,
    "providers no longer log and then throw",
  );

  for (const sentinel of [PROMPT_SENTINEL, BODY_SENTINEL, ARGS_SENTINEL, "credential-b7"]) {
    assert.equal(logText.includes(sentinel), false, `${sentinel} must not reach the log`);
  }
} finally {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(logDirectory, { recursive: true, force: true });
  rmSync(dataDirectory, { recursive: true, force: true });
}

console.log("logging b7 regression passed");
