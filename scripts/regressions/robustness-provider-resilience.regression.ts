import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Provider resilience: the rate-limit-aware decorator (installed on every connection by
// createLLMProvider and around both fallback legs) must retry transient transport / gateway
// failures a small bounded number of times, never after a token reached the consumer, never after
// an abort, and never on a header/body timeout or a 504 (the model may already be billing).
const root = mkdtempSync(join(tmpdir(), "marinara-provider-resilience-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = `${process.env.DATA_DIR}/storage`; // never the live store named in .env
process.env.LOG_LEVEL = "silent";
process.env.LOG_FILE_LEVEL = "silent";

let server: Server | undefined;
try {
  const { BaseLLMProvider, LLMHttpError, isRateLimitError } = await import(
    "../../packages/server/src/services/llm/base-provider.js"
  );
  type ChatCompletionResult = import("../../packages/server/src/services/llm/base-provider.js").ChatCompletionResult;
  type ChatOptions = import("../../packages/server/src/services/llm/base-provider.js").ChatOptions;
  const {
    MAX_RATE_LIMIT_RETRIES,
    MAX_TRANSIENT_RETRIES,
    STALE_SOCKET_MAX_ELAPSED_MS,
    computeRetryDelayMs,
    isTransientProviderError,
    withRateLimitAwareProvider,
  } = await import("../../packages/server/src/services/llm/rate-limit-aware-provider.js");
  const { createLLMProvider } = await import("../../packages/server/src/services/llm/provider-registry.js");

  // Shaped like llmFetch's LLMTransportError: elapsedMs on the wrapper, socket code on the cause.
  const netError = (code: string, elapsedMs: number | null = 5) =>
    Object.assign(new TypeError("fetch failed"), {
      ...(elapsedMs === null ? {} : { elapsedMs }),
      cause: Object.assign(new Error(`socket ${code}`), { code }),
    });

  // ── classification ──────────────────────────────────────────────
  assert.equal(isTransientProviderError(new LLMHttpError("bad gateway", { status: 502 })), true, "502 is transient");
  assert.equal(isTransientProviderError(new LLMHttpError("unavailable", { status: 503 })), true, "bare 503 is transient");
  assert.equal(isRateLimitError(new LLMHttpError("unavailable", { status: 503 })), false, "bare 503 is still not a rate limit");
  assert.equal(isTransientProviderError(new LLMHttpError("gw timeout", { status: 504 })), false, "504 may be billed: no retry");
  assert.equal(isTransientProviderError(new LLMHttpError("oops", { status: 500 })), false, "500 is not retried");
  assert.equal(isTransientProviderError(new LLMHttpError("bad", { status: 400 })), false, "400 is not retried");
  assert.equal(isTransientProviderError(netError("ECONNRESET")), true, "a fast (stale keep-alive) reset is transient");
  assert.equal(isTransientProviderError(netError("UND_ERR_SOCKET")), true, "a fast undici socket close is transient");
  assert.equal(isTransientProviderError(netError("EPIPE")), true, "a fast broken pipe is transient");
  // Review fix: a socket dropped after the upstream had the request for a while (proxy idle
  // timeout, worker crash) may already be processed and billed, headers or not.
  for (const code of ["ECONNRESET", "UND_ERR_SOCKET", "EPIPE"]) {
    assert.equal(
      isTransientProviderError(netError(code, STALE_SOCKET_MAX_ELAPSED_MS + 1)),
      false,
      `a slow ${code} (upstream may have processed it) is not retried`,
    );
    assert.equal(isTransientProviderError(netError(code, null)), false, `${code} with unknown timing is not retried`);
  }
  for (const code of ["ECONNREFUSED", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]) {
    assert.equal(isTransientProviderError(netError(code, 60_000)), true, `connect-phase ${code} is retried regardless of timing`);
    assert.equal(isTransientProviderError(netError(code, null)), true, `connect-phase ${code} needs no timing`);
  }
  assert.equal(isTransientProviderError(netError("UND_ERR_HEADERS_TIMEOUT")), false, "a headers timeout is not retried");
  assert.equal(isTransientProviderError(netError("UND_ERR_BODY_TIMEOUT")), false, "a body timeout is not retried");
  assert.equal(
    isTransientProviderError(Object.assign(new Error("aborted"), { name: "AbortError", cause: { code: "ECONNRESET" } })),
    false,
    "an abort is never transient even when the socket reset underneath it",
  );
  assert.equal(isTransientProviderError(new Error("plain")), false, "a plain Error is not transient");
  // Review fix: a socket closed while the BODY was being read (undici "terminated") means the
  // upstream already accepted and billed the request, so it must never be retried.
  const bodyPhase = (code: string) =>
    Object.assign(new TypeError("terminated"), { cause: Object.assign(new Error("other side closed"), { code }) });
  assert.equal(isTransientProviderError(bodyPhase("UND_ERR_SOCKET")), false, "a body-phase socket close is not retried");
  assert.equal(isTransientProviderError(bodyPhase("ECONNRESET")), false, "a body-phase reset is not retried");
  assert.equal(
    isTransientProviderError(new Error("LLM transport failed: terminated", { cause: bodyPhase("UND_ERR_SOCKET") })),
    false,
    "a wrapped body-phase failure is not retried",
  );
  assert.equal(
    isTransientProviderError(new Error("LLM transport failed: fetch failed", { cause: netError("ECONNRESET") })),
    true,
    "a wrapped fast pre-response reset is still retried",
  );
  assert.equal(
    isTransientProviderError(new Error("Stream error: fetch failed", { cause: netError("ECONNRESET", 30_000) })),
    false,
    "a wrapped slow pre-response reset is not retried",
  );

  // ── backoff: Retry-After honoured exactly, otherwise capped exponential with jitter ──
  assert.equal(computeRetryDelayMs(0, 0, "transient", () => 0.9), 0, "Retry-After 0 stays instant");
  assert.equal(computeRetryDelayMs(3, 7_000, "rate_limit", () => 0.9), 7_000, "Retry-After is honoured, not jittered");
  assert.equal(computeRetryDelayMs(0, 10 * 60_000, "rate_limit"), 60_000, "a huge Retry-After is capped");
  assert.equal(computeRetryDelayMs(0, undefined, "transient", () => 0), 500, "transient attempt 0 low end");
  assert.equal(computeRetryDelayMs(0, undefined, "transient", () => 1), 1_000, "transient attempt 0 high end");
  assert.equal(computeRetryDelayMs(1, undefined, "rate_limit", () => 0), 2_000, "rate-limit attempt 1 low end");
  assert.equal(computeRetryDelayMs(1, undefined, "rate_limit", () => 1), 4_000, "rate-limit attempt 1 high end");
  assert.equal(computeRetryDelayMs(20, undefined, "rate_limit", () => 1), 60_000, "backoff never exceeds the cap");
  const spread = new Set(Array.from({ length: 20 }, () => computeRetryDelayMs(2, undefined, "rate_limit")));
  assert.ok(spread.size > 1, "default backoff is jittered so simultaneous failures do not retry in lockstep");

  // ── decorator behaviour with a scripted inner provider ──────────
  const OK = {
    content: "done",
    toolCalls: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    finishReason: "stop",
  } as unknown as ChatCompletionResult;
  type Step =
    | "ok"
    | "502"
    | "503"
    | "504"
    | "reset"
    | "429"
    | "token-then-reset"
    | "callback-token-then-reset"
    | "thinking-then-reset"
    | "headers-timeout";
  const stepError = (step: Step): unknown => {
    if (step === "502") return new LLMHttpError("bad gateway", { status: 502, retryAfterMs: 0 });
    if (step === "503") return new LLMHttpError("unavailable", { status: 503 });
    if (step === "504") return new LLMHttpError("gateway timeout", { status: 504 });
    if (step === "429") return new LLMHttpError("rate limited", { status: 429, retryAfterMs: 0 });
    if (step === "headers-timeout") return netError("UND_ERR_HEADERS_TIMEOUT");
    return netError("ECONNRESET");
  };
  class Scripted extends BaseLLMProvider {
    calls = 0;
    constructor(private readonly plan: Step[]) {
      super("", "", 1000, null, null);
    }
    private next(): Step {
      const step = this.plan[Math.min(this.calls, this.plan.length - 1)]!;
      this.calls += 1;
      return step;
    }
    async *chat(_messages: unknown, opts: ChatOptions): AsyncGenerator<string, void, unknown> {
      const step = this.next();
      if (step === "thinking-then-reset") {
        opts.onThinking?.("pondering");
        throw netError("ECONNRESET");
      }
      if (step === "token-then-reset") {
        yield "Hello";
        throw netError("ECONNRESET");
      }
      if (step !== "ok") throw stepError(step);
      yield "done";
    }
    async chatComplete(_messages: unknown, opts: ChatOptions): Promise<ChatCompletionResult> {
      const step = this.next();
      if (step === "callback-token-then-reset") {
        await opts.onToken?.("Hi");
        throw netError("UND_ERR_SOCKET");
      }
      if (step !== "ok") throw stepError(step);
      return OK;
    }
    async embed(): Promise<number[][]> {
      const step = this.next();
      if (step !== "ok") throw stepError(step);
      return [[1]];
    }
  }
  const options = { model: "test" } as ChatOptions;
  const collect = async (gen: AsyncGenerator<string, unknown, unknown>) => {
    const out: string[] = [];
    for await (const chunk of gen) out.push(chunk);
    return out.join("");
  };

  const gw = new Scripted(["502", "ok"]);
  assert.equal((await withRateLimitAwareProvider(gw, "c-502").chatComplete([], options)).content, "done");
  assert.equal(gw.calls, 2, "a gateway 502 is retried once and the same request completes");

  const reset = new Scripted(["reset", "ok"]);
  const resetStarted = Date.now();
  assert.equal(await collect(withRateLimitAwareProvider(reset, "c-reset").chat([], options)), "done");
  const resetWaited = Date.now() - resetStarted;
  assert.equal(reset.calls, 2, "a pre-first-token socket reset is retried on the stream path");
  assert.ok(resetWaited >= 450 && resetWaited < 3_000, `transient retry uses jittered backoff (${resetWaited}ms)`);

  const embedReset = new Scripted(["reset", "ok"]);
  assert.deepEqual(await withRateLimitAwareProvider(embedReset, "c-embed").embed(["x"], "m"), [[1]]);
  assert.equal(embedReset.calls, 2, "embeddings get the same transient retry");

  const midStream = new Scripted(["token-then-reset", "ok"]);
  const seen: string[] = [];
  await assert.rejects(async () => {
    for await (const chunk of withRateLimitAwareProvider(midStream, "c-mid").chat([], options)) seen.push(chunk);
  }, /fetch failed/);
  assert.deepEqual(seen, ["Hello"], "the consumer saw the streamed token once");
  assert.equal(midStream.calls, 1, "a stream that already yielded tokens is never replayed");

  // The tool path streams through onToken inside chatComplete: a mid-body socket close after a
  // token reached the user must not replay the request (duplicate text, double billing).
  const cbTokens: string[] = [];
  const cbStream = new Scripted(["callback-token-then-reset", "ok"]);
  await assert.rejects(
    () =>
      withRateLimitAwareProvider(cbStream, "c-cb").chatComplete([], {
        ...options,
        onToken: (chunk) => void cbTokens.push(chunk),
      }),
    /fetch failed/,
  );
  assert.deepEqual(cbTokens, ["Hi"], "the onToken consumer saw the token exactly once");
  assert.equal(cbStream.calls, 1, "chatComplete is not replayed after onToken streamed text");

  // A callback that was supplied but never fired does not block the retry.
  const cbQuiet = new Scripted(["reset", "ok"]);
  const quietTokens: string[] = [];
  const quietResult = await withRateLimitAwareProvider(cbQuiet, "c-cb-quiet").chatComplete([], {
    ...options,
    onToken: (chunk) => void quietTokens.push(chunk),
  });
  assert.equal(quietResult.content, "done", "a pre-token reset on the tool path is still retried");
  assert.equal(cbQuiet.calls, 2, "exactly one retry when onToken never fired");

  // Streamed reasoning counts as output the user already saw.
  const thoughts: string[] = [];
  const thinking = new Scripted(["thinking-then-reset", "ok"]);
  await assert.rejects(
    () => collect(withRateLimitAwareProvider(thinking, "c-think").chat([], { ...options, onThinking: (t) => thoughts.push(t) })),
    /fetch failed/,
  );
  assert.deepEqual(thoughts, ["pondering"], "reasoning was shown once");
  assert.equal(thinking.calls, 1, "a stream is not replayed after onThinking streamed reasoning");

  const persistent = new Scripted(["502"]);
  await assert.rejects(() => withRateLimitAwareProvider(persistent, "c-persist").chatComplete([], options), /bad gateway/);
  assert.equal(persistent.calls, MAX_TRANSIENT_RETRIES + 1, "persistent gateway failures stop after the small budget");
  const persistentError = await withRateLimitAwareProvider(new Scripted(["502"]), "c-persist-2")
    .chatComplete([], options)
    .catch((error: unknown) => error as { retryAttempts?: number });
  assert.equal(persistentError.retryAttempts, MAX_TRANSIENT_RETRIES, "transient give-up records retryAttempts");
  assert.ok(MAX_TRANSIENT_RETRIES < MAX_RATE_LIMIT_RETRIES, "transient budget is smaller than the rate-limit one");

  for (const step of ["504", "headers-timeout"] as const) {
    const once = new Scripted([step, "ok"]);
    await assert.rejects(() => withRateLimitAwareProvider(once, `c-${step}`).chatComplete([], options));
    assert.equal(once.calls, 1, `${step} is attempted exactly once (no double-billed retry)`);
  }

  // Budgets are separate: a transient blip does not eat the rate-limit budget or vice versa.
  const mixed = new Scripted(["502", "429", "502", "429", "ok"]);
  assert.equal((await withRateLimitAwareProvider(mixed, "c-mixed").chatComplete([], options)).content, "done");
  assert.equal(mixed.calls, 5, "mixed rate-limit and gateway failures each use their own budget");

  // Transient retries do not report a rate-limit pause (continuity treats that as quota exhaustion).
  const pauses: string[] = [];
  const quiet = new Scripted(["502", "ok"]);
  await withRateLimitAwareProvider(quiet, "c-quiet").chatComplete([], {
    ...options,
    onRateLimitPause: (info) => pauses.push(info.reason),
  });
  assert.deepEqual(pauses, [], "a gateway retry is not reported as a rate-limit pause");

  // Abort during the backoff wait stops immediately with no further attempt.
  const aborted = new Scripted(["503", "ok"]);
  const controller = new AbortController();
  const abortStarted = Date.now();
  setTimeout(() => controller.abort(new Error("user cancelled")), 50);
  await assert.rejects(
    () => withRateLimitAwareProvider(aborted, "c-abort").chatComplete([], { ...options, signal: controller.signal }),
    /user cancelled/,
  );
  assert.equal(aborted.calls, 1, "no retry is sent after the caller aborted");
  assert.ok(Date.now() - abortStarted < 450, "abort interrupts the backoff wait");

  // Already aborted before the failure surfaced: propagate, never retry.
  const preAborted = new Scripted(["reset", "ok"]);
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(() =>
    withRateLimitAwareProvider(preAborted, "c-preabort").chatComplete([], { ...options, signal: pre.signal }),
  );
  assert.equal(preAborted.calls, 1, "an aborted request is never retried");

  // ── end to end through the real OpenAI-compatible provider and undici ──
  let hits = 0;
  let mode: "reset-once" | "502-once" | "504" | "partial-body" | "slow-drop" = "reset-once";
  const SLOW_DROP_MS = STALE_SOCKET_MAX_ELAPSED_MS + 300;
  server = createServer(async (request, response) => {
    if (mode === "reset-once" && hits === 0) {
      // Stale keep-alive shape: the socket dies before the server handles the request at all.
      hits += 1;
      request.socket.destroy();
      return;
    }
    let body = "";
    for await (const chunk of request) body += String(chunk);
    hits += 1;
    if (mode === "slow-drop") {
      // Accepted, read in full, "generated" for a while, then the connection drops before any
      // header (proxy idle timeout / worker crash). The upstream may have billed this request.
      setTimeout(() => request.socket.destroy(), SLOW_DROP_MS);
      return;
    }
    if (mode === "502-once" && hits === 1) {
      response.writeHead(502, { "content-type": "application/json", "retry-after": "0" });
      response.end(JSON.stringify({ error: { message: "upstream down" } }));
      return;
    }
    if (mode === "partial-body") {
      // Accepted and answering (200 + part of the body), then the socket dies mid-body.
      const sse = body.includes('"stream":true');
      response.writeHead(200, { "content-type": sse ? "text/event-stream" : "application/json" });
      response.write(
        sse ? 'data: {"id":"x","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n' : '{"id":"x","choi',
      );
      setTimeout(() => request.socket.destroy(), 30);
      return;
    }
    if (mode === "504") {
      response.writeHead(504, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "upstream timed out" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: "x",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "real ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const real = () =>
    createLLMProvider("openai", base, "test", null, null, null, false, true, undefined, `resilience-${mode}`);
  const realOptions = { model: "local-model", stream: false, maxTokens: 16 } as ChatOptions;

  const resetResult = await real().chatComplete([{ role: "user", content: "hi" }], realOptions);
  assert.equal(resetResult.content, "real ok", "a real socket reset before the reply is retried transparently");
  assert.equal(hits, 2, "exactly one retry after the real reset");

  hits = 0;
  mode = "502-once";
  const gwResult = await real().chatComplete([{ role: "user", content: "hi" }], realOptions);
  assert.equal(gwResult.content, "real ok", "a real 502 with Retry-After: 0 is retried transparently");
  assert.equal(hits, 2, "exactly one retry after the real 502");

  hits = 0;
  mode = "504";
  await assert.rejects(() => real().chatComplete([{ role: "user", content: "hi" }], realOptions));
  assert.equal(hits, 1, "a real 504 is not retried");

  // Review fix: 200 headers plus part of the body, then the socket is destroyed. The request was
  // accepted (and billed), so exactly one upstream call on both the JSON and the streaming path.
  mode = "partial-body";
  for (const stream of [false, true]) {
    hits = 0;
    const partialOptions = { ...realOptions, stream } as ChatOptions;
    await assert.rejects(() => real().chatComplete([{ role: "user", content: "hi" }], partialOptions));
    assert.equal(hits, 1, `a mid-body socket close after a 200 is not replayed (stream=${stream})`);
    hits = 0;
    await assert.rejects(() => collect(real().chat([{ role: "user", content: "hi" }], partialOptions)));
    assert.equal(hits, 1, `chat(): a mid-body socket close after a 200 is not replayed (stream=${stream})`);
  }

  // Review fix: body read in full, a delay, then the socket is destroyed before any header. One
  // upstream call only, on the JSON path and the SSE path, for chatComplete and chat.
  mode = "slow-drop";
  for (const stream of [false, true]) {
    const dropOptions = { ...realOptions, stream } as ChatOptions;
    hits = 0;
    await assert.rejects(() => real().chatComplete([{ role: "user", content: "hi" }], dropOptions));
    assert.equal(hits, 1, `a slow pre-header drop is not replayed (chatComplete, stream=${stream})`);
    hits = 0;
    await assert.rejects(() => collect(real().chat([{ role: "user", content: "hi" }], dropOptions)));
    assert.equal(hits, 1, `a slow pre-header drop is not replayed (chat, stream=${stream})`);
  }

  console.log("robustness-provider-resilience regression: OK");
} finally {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  rmSync(root, { recursive: true, force: true });
}
