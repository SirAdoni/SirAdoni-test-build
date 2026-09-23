import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const logDirectory = mkdtempSync(join(tmpdir(), "marinara-openai-cache-"));
const previousLogDir = process.env.LOG_DIR;
const previousLogLevel = process.env.LOG_LEVEL;
const previousLogFileLevel = process.env.LOG_FILE_LEVEL;
const previousCacheDiagnostics = process.env.MARINARA_CACHE_DIAGNOSTICS;
process.env.LOG_DIR = logDirectory;
process.env.LOG_LEVEL = "silent";
process.env.LOG_FILE_LEVEL = "info";
// Per-item input batch lines log at debug unless this flag is on (logging pass); the test reads them.
process.env.MARINARA_CACHE_DIAGNOSTICS = "1";

const originalFetch = globalThis.fetch;
const calls: Array<{ body: Record<string, unknown>; serialized: string }> = [];
let mode: "normal" | "retry" | "failed" | "incomplete" | "transport" = "normal";
const transportError = Object.assign(new Error("transport sentinel"), { code: "ECONNRESET" });

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function streamResponse(events: Array<Record<string, unknown>>): Response {
  const text = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(new TextEncoder().encode(text), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function responseBody(id: string, model: string, serviceTier: string, status = "completed") {
  return {
    id,
    model,
    service_tier: serviceTier,
    status,
    ...(status === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
    output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
    usage: {
      input_tokens: 19,
      output_tokens: 3,
      total_tokens: 22,
      input_tokens_details: { cached_tokens: 7 },
      attribution: {
        request_fields: {
          instructions: { input_tokens: 11, cached_tokens: 5, cache_write_tokens: 2, output_tokens: 1 },
        },
      },
    },
  };
}

globalThis.fetch = (async (_url, init) => {
  const serialized = String(init?.body ?? "");
  const body = JSON.parse(serialized) as Record<string, unknown>;
  calls.push({ body, serialized });
  const index = calls.length;
  if (mode === "transport") throw transportError;
  if (mode === "retry" && index === 4) {
    return jsonResponse({ error: { message: "encrypted content could not be decrypted" } }, 400);
  }
  if (mode === "failed") {
    if (body.stream !== true) return jsonResponse({ id: "resp-failed-json", status: "failed" });
    return streamResponse([{ type: "response.failed", response: { id: "resp-failed", status: "failed" } }]);
  }
  const status = mode === "incomplete" ? "incomplete" : "completed";
  const response = responseBody(`resp-${index}`, String(body.model), "flex", status);
  if (body.stream === true) {
    if (mode === "incomplete") {
      return streamResponse([{ type: "response.incomplete", response }]);
    }
    return streamResponse([
      { type: "response.output_text.delta", delta: "ok" },
      { type: "response.completed", response },
    ]);
  }
  return jsonResponse(response);
}) as typeof fetch;

try {
  await import("../../packages/server/src/lib/logger.js");
  const { OpenAIProvider } = await import("../../packages/server/src/services/llm/providers/openai.provider.js");
  const provider = new OpenAIProvider(
    "http://127.0.0.1:43123/v1",
    "credential-sentinel",
    undefined,
    undefined,
    undefined,
    "openai",
  );

  async function complete(
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    options: Record<string, unknown>,
  ) {
    return provider.chatComplete(messages, options as never);
  }

  const prefix = Array.from({ length: 40 }, (_, index) => ({ role: "user" as const, content: `item-${index}` }));
  await complete([...prefix, { role: "user", content: "tail-a" }], {
    model: "gpt-5.6",
    stream: false,
    customParameters: { service_tier: "flex" },
  });
  await complete([...prefix, { role: "user", content: "tail-b" }], {
    model: "gpt-5.6-pro",
    stream: false,
    customParameters: { service_tier: "flex" },
  });
  await complete([{ role: "user", content: "stream" }], { model: "gpt-5.6", stream: true });

  mode = "retry";
  await complete(
    [
      { role: "user", content: "prior" },
      { role: "assistant", content: "prior answer" },
      { role: "user", content: "retry" },
    ],
    {
      model: "gpt-5.6",
      stream: false,
      customParameters: { service_tier: "flex" },
      reasoningEffort: "high",
      encryptedReasoningItems: [{ type: "reasoning", encrypted_content: "credential-sentinel" }],
    },
  );
  const retryBodies = calls.slice(-2);
  assert.equal(retryBodies.length, 2);
  assert.notEqual(retryBodies[0]?.serialized, retryBodies[1]?.serialized);
  assert.equal(JSON.stringify(retryBodies[1]?.body).includes("credential-sentinel"), false);

  mode = "incomplete";
  await complete([{ role: "user", content: "incomplete" }], { model: "gpt-5.6", stream: true });
  mode = "failed";
  await assert.rejects(() => complete([{ role: "user", content: "failed" }], { model: "gpt-5.6", stream: true }));
  await assert.rejects(() => complete([{ role: "user", content: "failed" }], { model: "gpt-5.6", stream: false }));
  mode = "transport";
  await assert.rejects(
    () => complete([{ role: "user", content: "transport" }], { model: "gpt-5.6", stream: false }),
    // llmFetch wraps transport failures and keeps the original on `cause`.
    (error: unknown) => error instanceof Error && error.name === "LLMTransportError" && error.cause === transportError,
  );

  mode = "normal";
  for (const stream of [true, false]) {
    const messages = stream
      ? [{ role: "user" as const, content: "stream sentinel" }]
      : Array.from({ length: 600 }, (_, index) => ({ role: "user" as const, content: `bounded sentinel ${index}` }));
    const iterator = provider.chat(messages, { model: "gpt-5.6", stream });
    let output = "";
    while (true) {
      const chunk = await iterator.next();
      if (chunk.done) {
        assert.equal(chunk.value?.cachedPromptTokens, 7);
        break;
      }
      output += chunk.value;
    }
    assert.equal(output, "ok");
  }

  const logText = readdirSync(logDirectory)
    .filter((name) => name.endsWith(".log"))
    .map((name) => readFileSync(join(logDirectory, name), "utf8"))
    .join("\n");
  const records = logText
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const requestRecords = records.filter((record) => record.msg === "OpenAI Responses request attempt");
  assert.ok(records.some((record) => record.responseId === "resp-failed-json" && record.returnedStatus === "failed"));
  const inputBatches = records.filter((record) => record.msg === "OpenAI Responses request input batch");
  assert.equal(requestRecords.filter((record) => record.route === "chatResponses").length, 2);
  const largeRequest = requestRecords.find((record) => record.inputCount === 600)!;
  assert.equal(largeRequest.inputOmittedCount, 88);
  const largeItems = inputBatches
    .filter((record) => record.cacheRequestId === largeRequest.cacheRequestId)
    .flatMap((record) => record.inputItems as Array<Record<string, unknown>>);
  assert.equal(largeItems.length, 512);
  assert.equal(largeItems.at(-1)?.index, 511);
  const usageRecord = records.find((record) => record.providerEvent === "nonstream")?.usage as Record<string, unknown>;
  assert.deepEqual(usageRecord, {
    inputTokens: 19,
    outputTokens: 3,
    totalTokens: 22,
    cachedInputTokens: 7,
    instructionInputTokens: 11,
    instructionCachedTokens: 5,
    instructionCacheWriteTokens: 2,
    instructionOutputTokens: 1,
  });
  const firstBatchItems = (inputBatches[0]?.inputItems ?? []) as Array<Record<string, unknown>>;
  const firstTailBatchItems = (inputBatches[1]?.inputItems ?? []) as Array<Record<string, unknown>>;
  const secondBatchItems = (inputBatches[2]?.inputItems ?? []) as Array<Record<string, unknown>>;
  const secondTailBatchItems = (inputBatches[3]?.inputItems ?? []) as Array<Record<string, unknown>>;
  assert.equal(firstBatchItems[0]?.itemHash, secondBatchItems[0]?.itemHash);
  assert.notEqual(
    firstTailBatchItems[firstTailBatchItems.length - 1]?.itemHash,
    secondTailBatchItems[secondTailBatchItems.length - 1]?.itemHash,
  );
  assert.notEqual(requestRecords[0]?.bodyFingerprint, requestRecords[1]?.bodyFingerprint);
  assert.notEqual(requestRecords[0]?.cacheRequestId, requestRecords[1]?.cacheRequestId);
  const retryRecords = requestRecords.slice(3, 5);
  assert.equal(retryRecords.length, 2);
  assert.notEqual(retryRecords[0]?.cacheRequestId, retryRecords[1]?.cacheRequestId);
  assert.notEqual(retryRecords[0]?.bodyFingerprint, retryRecords[1]?.bodyFingerprint);
  assert.ok(logText.length > 0);
  assert.ok(logText.includes("cacheRequestId"));
  assert.ok(logText.includes("cachedInputTokens"));
  assert.ok(logText.includes("instructionInputTokens"));
  assert.ok(logText.includes("instructionCachedTokens"));
  assert.ok(logText.includes("instructionCacheWriteTokens"));
  assert.ok(logText.includes("instructionOutputTokens"));
  assert.ok(logText.includes('"index":40'));
  assert.ok(logText.includes('"inputBatchIndex":1'));
  assert.ok(logText.includes("resp-failed"));
  assert.ok(logText.includes("resp-"));
  assert.equal(logText.includes("item-0"), false);
  assert.equal(logText.includes("credential-sentinel"), false);
  assert.equal(logText.includes("transport sentinel"), false);
  assert.equal(logText.includes("bounded sentinel"), false);
  assert.equal(logText.includes("stream sentinel"), false);
} finally {
  globalThis.fetch = originalFetch;
  if (previousLogDir === undefined) delete process.env.LOG_DIR;
  else process.env.LOG_DIR = previousLogDir;
  if (previousLogLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = previousLogLevel;
  if (previousLogFileLevel === undefined) delete process.env.LOG_FILE_LEVEL;
  else process.env.LOG_FILE_LEVEL = previousLogFileLevel;
  if (previousCacheDiagnostics === undefined) delete process.env.MARINARA_CACHE_DIAGNOSTICS;
  else process.env.MARINARA_CACHE_DIAGNOSTICS = previousCacheDiagnostics;
  rmSync(logDirectory, { recursive: true, force: true });
}

console.log("openai cache diagnostics regression passed");
