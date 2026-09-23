// Logging batch 6 (LLM core): llm.http, llm.call, llm.retry, llm.fallback, llm.config.invalid
// and llm.provider.unknown lines. Offline: the only socket is a refused loopback connect.
import assert from "node:assert/strict";
import {
  BaseLLMProvider,
  LLMHttpError,
  llmFetch,
  type ChatCompletionResult,
  type ChatMessage,
  type ChatOptions,
  type LLMUsage,
} from "../../packages/server/src/services/llm/base-provider.js";
import { withDiagnosticProvider } from "../../packages/server/src/services/llm/diagnostic-provider.js";
import { withRateLimitAwareProvider } from "../../packages/server/src/services/llm/rate-limit-aware-provider.js";
import {
  ConnectionFallbackProvider,
  fallbackConnectionUnusableReason,
  type FallbackConnection,
} from "../../packages/server/src/services/llm/connection-fallback-provider.js";
import { parseConnectionCustomParameters } from "../../packages/server/src/services/llm/connection-default-provider.js";
import { createLLMProvider } from "../../packages/server/src/services/llm/provider-registry.js";
import { logger } from "../../packages/server/src/lib/logger.js";

await new Promise((resolve) => setImmediate(resolve));
type Row = Record<string, unknown> & { level: string };
const rows: Row[] = [];
const levels = ["debug", "info", "warn", "error"] as const;
const originals = Object.fromEntries(levels.map((level) => [level, logger[level]])) as Record<
  (typeof levels)[number],
  typeof logger.info
>;
for (const level of levels) {
  logger[level] = ((first: unknown) => {
    if (first && typeof first === "object" && !(first instanceof Error)) rows.push({ ...(first as object), level });
  }) as typeof logger.info;
}
const take = (event: string) => rows.filter((row) => row.event === event);
const reset = () => rows.splice(0, rows.length);

try {
  // 1. llmFetch: a transport failure warns host/errorCode/elapsedMs without err, path or query,
  //    and rethrows a typed LLMTransportError carrying the cause.
  reset();
  const failure = await llmFetch("http://127.0.0.1:1/v1/private-path?key=abc123", { method: "POST" }).then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.ok(failure instanceof Error, "llmFetch must reject on a refused connection");
  assert.equal(failure.name, "LLMTransportError");
  assert.ok(failure.message.startsWith("LLM transport failed: "));
  assert.ok(failure.cause, "cause is kept");
  assert.equal((failure as Error & { host?: string }).host, "127.0.0.1:1");
  const http = take("llm.http");
  assert.equal(http.length, 1);
  assert.equal(http[0]!.outcome, "failed");
  assert.equal(http[0]!.level, "warn");
  assert.equal(http[0]!.host, "127.0.0.1:1");
  assert.equal(http[0]!.method, "POST");
  assert.equal(http[0]!.err, undefined, "the caller reports the error, not llmFetch");
  assert.equal(typeof http[0]!.elapsedMs, "number");
  assert.ok(!JSON.stringify(rows).includes("private-path"), "path is never logged");
  assert.ok(!JSON.stringify(rows).includes("abc123"), "query is never logged");

  // 2. DiagnosticProvider writes one failure line with the HTTP fields, and a debug start line.
  class Failing extends BaseLLMProvider {
    constructor(private readonly error: unknown) {
      super("", "");
    }
    async *chat(): AsyncGenerator<string, LLMUsage | void> {
      throw this.error;
    }
    override chatComplete(): Promise<ChatCompletionResult> {
      return Promise.reject(this.error);
    }
  }
  reset();
  const httpError = new LLMHttpError("Bad gateway", { status: 502, providerCode: "upstream" });
  await assert.rejects(withDiagnosticProvider(new Failing(httpError), "fake", "conn-b6").chatComplete([], { model: "m" }));
  const calls = take("llm.call");
  assert.deepEqual(
    calls.map((row) => [row.level, row.stage]),
    [
      ["debug", "start"],
      ["error", "failure"],
    ],
  );
  assert.equal(calls[1]!.httpStatus, 502);
  assert.equal(calls[1]!.providerCode, "upstream");
  assert.equal(calls[1]!.callKind, "complete");
  assert.equal(calls[1]!.outcome, "failed");
  assert.ok(!rows.some((row) => row.msg === "LLM completion failed"));

  reset();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    withDiagnosticProvider(new Failing(new Error("aborted")), "fake").chatComplete([], {
      model: "m",
      signal: controller.signal,
    }),
  );
  const cancelled = take("llm.call").find((row) => row.stage === "cancelled");
  assert.ok(cancelled);
  assert.equal(cancelled.level, "info");
  assert.equal(cancelled.outcome, "cancelled");
  assert.equal(cancelled.err, undefined);

  // 3. Rate-limit give-up: retryAttempts on the error, one exhausted line.
  reset();
  const limited = new LLMHttpError("Too many", { status: 429, retryAfterMs: 0 });
  await assert.rejects(withRateLimitAwareProvider(new Failing(limited), "conn-rl").chatComplete([], { model: "m" }));
  assert.equal((limited as LLMHttpError & { retryAttempts?: number }).retryAttempts, 6);
  const retries = take("llm.retry");
  assert.equal(retries.filter((row) => row.reason === "rate_limit").length, 6);
  const gaveUp = retries.filter((row) => row.outcome === "failed");
  assert.equal(gaveUp.length, 1);
  assert.equal(gaveUp[0]!.reason, "exhausted");
  assert.ok(retries.every((row) => row.err === undefined));

  // 4. Fallback: activation carries the primary errorId; the result line and a failed fallback carry primaryErrorId.
  class Answering extends BaseLLMProvider {
    constructor(private readonly text: string) {
      super("", "");
    }
    async *chat(_messages: ChatMessage[], _options: ChatOptions): AsyncGenerator<string, LLMUsage | void> {
      yield this.text;
    }
  }
  const connection: FallbackConnection = {
    id: "conn-fb",
    provider: "openai",
    baseUrl: "http://127.0.0.1:1",
    apiKey: "",
    model: "fb-model",
  };
  reset();
  const primaryError = new Error("primary down");
  const ok = await new ConnectionFallbackProvider(
    new Failing(primaryError),
    new Answering("hello"),
    connection,
    "main",
    async () => {},
    undefined,
    undefined,
    true,
    true,
    "conn-primary",
  ).chatComplete([], { model: "m" });
  assert.equal(ok.content, "hello");
  const activate = take("llm.fallback").find((row) => row.stage === "activate");
  assert.ok(activate);
  assert.equal(activate.reason, "primary-error");
  assert.equal(activate.primaryConnectionId, "conn-primary");
  assert.equal(activate.fallbackConnectionId, "conn-fb");
  assert.equal(typeof activate.errorId, "string");
  const result = take("llm.fallback").find((row) => row.stage === "result");
  assert.ok(result);
  assert.equal(result.outcome, "ok");
  assert.equal(result.primaryErrorId, activate.errorId);

  reset();
  const fallbackError = new Error("fallback down");
  await assert.rejects(
    new ConnectionFallbackProvider(
      new Failing(new Error("primary down again")),
      new Failing(fallbackError),
      connection,
      "agents",
      async () => {},
    ).chatComplete([], { model: "m" }),
    (error) => error === fallbackError,
  );
  assert.equal(typeof (fallbackError as Error & { primaryErrorId?: string }).primaryErrorId, "string");

  reset();
  await new ConnectionFallbackProvider(new Answering("  "), new Answering("late"), connection, "main", async () => {})
    .chatComplete([], { model: "m" })
    .then((value) => assert.equal(value.content, "late"));
  const empty = take("llm.fallback").find((row) => row.stage === "activate");
  assert.equal(empty?.reason, "primary-empty");
  assert.equal(empty?.errorId, undefined, "no synthetic Error for an empty primary");

  assert.equal(fallbackConnectionUnusableReason(connection, "conn-fb", "http://x"), "same-connection");
  assert.equal(fallbackConnectionUnusableReason(null, "a", "http://x"), "not-configured");
  assert.equal(fallbackConnectionUnusableReason(connection, "a", " "), "no-base-url");
  assert.equal(fallbackConnectionUnusableReason(connection, "a", "http://x"), null);

  // 5. Invalid connection defaults warn once, with issue paths only.
  reset();
  parseConnectionCustomParameters("{not json", "conn-cfg");
  parseConnectionCustomParameters("{not json", "conn-cfg");
  parseConnectionCustomParameters("", "conn-cfg");
  const invalid = take("llm.config.invalid");
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0]!.field, "defaultParameters");
  assert.ok(!JSON.stringify(invalid).includes("not json"));

  // 6. An unknown provider type warns once per value.
  reset();
  createLLMProvider("b6-unknown-provider", "http://127.0.0.1:1", "");
  createLLMProvider("b6-unknown-provider", "http://127.0.0.1:1", "");
  const unknown = take("llm.provider.unknown");
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0]!.provider, "b6-unknown-provider");
} finally {
  Object.assign(logger, originals);
}

console.log("logging-b6 regression: ok");
