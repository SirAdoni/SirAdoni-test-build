import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BaseLLMProvider,
  LLMHttpError,
  type ChatCompletionResult,
  type ChatMessage,
  type ChatOptions,
} from "../../packages/server/src/services/llm/base-provider.js";
import { createGenerationJobs } from "../../packages/server/src/services/generation/generation-jobs.js";
import { runMediaGenerationRequest } from "../../packages/server/src/services/image/image-generation-queue.js";
import { getDiagnosticContext } from "../../packages/server/src/lib/diagnostics.js";

class FakeProvider extends BaseLLMProvider {
  constructor(private readonly mode: "success" | "partial" | "rate-limit") {
    super("https://provider.invalid", "redacted", undefined);
  }

  async *chat(_messages: ChatMessage[], _options: ChatOptions): AsyncGenerator<string, undefined> {
    if (this.mode === "rate-limit") throw new LLMHttpError("provider refused", { status: 429 });
    yield "partial";
    if (this.mode === "partial") throw new Error("stream broke");
  }
}

const success = await new FakeProvider("success").chatComplete([], { model: "test-model" });
assert.equal(success.content, "partial");
await assert.rejects(
  () => new FakeProvider("rate-limit").chatComplete([], { model: "test-model" }),
  (error) => {
    assert.equal(error instanceof LLMHttpError, true);
    assert.equal((error as LLMHttpError).status, 429);
    return true;
  },
);
const partial = await new FakeProvider("partial").chatComplete([], { model: "test-model" });
assert.equal(partial.content, "partial");
assert.equal(partial.finishReason, "error");

const root = await mkdtemp(join(tmpdir(), "marinara-diagnostic-generation-"));
try {
  const jobs = createGenerationJobs(root);
  await assert.rejects(() =>
    jobs.run({ kind: "test", label: "failure", timeoutMs: 5000 }, async () => {
      throw new Error("nested generation failure");
    }),
  );
  const metadata = (await jobs.list())[0];
  assert.equal(metadata.status, "failed");
  assert.equal(metadata.error, "nested generation failure");
  assert.match(metadata.errorCode ?? "", /^ME_/);
  assert.match(metadata.errorId ?? "", /^[0-9a-f-]{36}$/i);
  const saved = JSON.parse(await readFile(join(root, `${metadata.id}.json`), "utf8"));
  assert.equal(saved.errorId, metadata.errorId);

  await assert.rejects(
    () => jobs.run({ kind: "test", label: "timeout", timeoutMs: 10 }, () => new Promise(() => undefined)),
    (error) => error instanceof Error && error.name === "AbortError",
  );
  const timedOut = (await jobs.list()).find((item) => item.label === "timeout");
  assert.equal(timedOut?.status, "failed");
  assert.equal(timedOut?.errorCode, "ME_TIMEOUT");
  assert.match(timedOut?.errorId ?? "", /^[0-9a-f-]{36}$/i);

  const interruptedId = "11111111-1111-4111-8111-111111111111";
  await writeFile(
    join(root, `${interruptedId}.json`),
    JSON.stringify({
      id: interruptedId,
      kind: "test",
      label: "interrupted",
      chatId: "chat-1",
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      error: null,
      resultAvailable: false,
    }),
  );
  const recovered = createGenerationJobs(root);
  const recoveredMetadata = (await recovered.list()).find((item) => item.id === interruptedId);
  assert.equal(recoveredMetadata?.status, "interrupted");
  assert.equal(recoveredMetadata?.errorCode, "ME_CANCELLED");
  assert.match(recoveredMetadata?.errorId ?? "", /^[0-9a-f-]{36}$/i);

  const queueError = new Error("queue failure");
  await assert.rejects(
    () =>
      runMediaGenerationRequest({
        connectionKey: "test",
        queue: false,
        task: async () => {
          throw queueError;
        },
      }),
    (error) => error === queueError,
  );

  const parallelContexts = await Promise.all(
    ["a", "b"].map((label) =>
      jobs.run({ kind: "context", label, chatId: `chat-${label}`, timeoutMs: 5000 }, async () => {
        await new Promise((resolve) => setTimeout(resolve, label === "a" ? 5 : 1));
        const context = getDiagnosticContext();
        assert.equal(context.operation, "generation.job");
        assert.equal(context.stage, "work");
        assert.equal(context.chatId, `chat-${label}`);
        assert.match(context.jobId ?? "", /^[0-9a-f-]{36}$/i);
        assert.equal(context.operationId, context.jobId);
        return { jobId: context.jobId, chatId: context.chatId };
      }),
    ),
  );
  assert.notEqual(parallelContexts[0].jobId, parallelContexts[1].jobId);
  assert.notEqual(parallelContexts[0].chatId, parallelContexts[1].chatId);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("diagnostic-generation regression: ok");
