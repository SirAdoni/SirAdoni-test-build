// Logging batch B5 (plan batch 4), v1.0 (2026-09-23): the main generation route.
// Checks the generation trace (one generation.finished line, idempotent, stage
// times, counters, context fields) and source-level guarantees in
// generate.routes.ts (no [timing] lines, no content previews, structured abort,
// pre-gen failure, empty-response and SSE failure paths). No provider, no server.
import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const logDir = mkdtempSync(join(tmpdir(), "marinara-logging-b4-"));
process.env.LOG_DIR = logDir;
process.env.LOG_FILE_LEVEL = "debug";
process.env.LOG_LEVEL = "fatal";

type Line = Record<string, any>;

function mainLines(): Line[] {
  return readdirSync(logDir)
    .filter((name) => /^marinara-.*\.log/.test(name))
    .flatMap((name) => readFileSync(join(logDir, name), "utf8").split("\n"))
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Line);
}

const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  const { startGenerationTrace } = await import("../../packages/server/src/services/generation/generation-trace.js");
  const { withDiagnosticContext } = await import("../../packages/server/src/lib/diagnostics.js");
  await settle(0);

  // ── Trace: one line, idempotent, stage times and counters ──
  await withDiagnosticContext({ operation: "generate", operationId: "gen-b4-1", chatId: "chat-b4" }, async () => {
    const trace = startGenerationTrace({ chatId: "chat-b4", chatMode: "roleplay", generationId: "gen-b4-1" });
    trace.stage("assemble");
    await settle(25);
    trace.stage("provider");
    trace.markFirstToken();
    trace.set({
      provider: "openai",
      model: "test-model",
      connectionId: "conn-1",
      messageId: "msg-1",
      finishReason: "stop",
      usage: { promptTokens: 100, completionTokens: 20, cachedPromptTokens: 80, completionReasoningTokens: 5 },
    });
    trace.count("requestCount", 2);
    trace.count("agentsFailed");
    trace.count("promptSectionsSkipped", 3);
    trace.count("followUps");
    assert.equal(trace.currentStage, "provider");
    trace.finish("ok");
    trace.finish("failed", { reason: "late" });
    trace.count("requestCount", 5);
    assert.equal(trace.finished, true);
  });
  await settle();

  const finished = mainLines().filter((line) => line.event === "generation.finished");
  assert.equal(finished.length, 1, "a trace writes exactly one generation.finished line");
  const [line] = finished;
  assert.equal(line.outcome, "ok");
  assert.equal(line.operationId, "gen-b4-1");
  assert.equal(line.chatId, "chat-b4");
  assert.equal(line.operation, "generate", "the diagnostic context reaches the summary line");
  assert.equal(line.chatMode, "roleplay");
  assert.equal(line.provider, "openai");
  assert.equal(line.model, "test-model");
  assert.equal(line.connectionId, "conn-1");
  assert.equal(line.messageId, "msg-1");
  assert.equal(line.finishReason, "stop");
  assert.equal(line.requestCount, 2, "counts after finish are ignored");
  assert.equal(line.agentsFailed, 1);
  assert.equal(line.promptSectionsSkipped, 3);
  assert.equal(line.parallelAgentsFailed, 0);
  assert.equal(line.fallbackUsed, false);
  assert.deepEqual(line.counts, { followUps: 1 });
  assert.deepEqual(line.usage, { promptTokens: 100, completionTokens: 20, cachedPromptTokens: 80 });
  assert.ok(typeof line.elapsedMs === "number" && line.elapsedMs >= 20);
  assert.ok(typeof line.firstChunkMs === "number", "time to the first streamed chunk is recorded");
  assert.ok(line.stageMs.assemble >= 20, "the assemble stage time is recorded");
  assert.ok(typeof line.stageMs.provider === "number");
  assert.equal(line.msg, "[generate] Generation finished");

  // ── A failed finish carries the reference fields ──
  const failing = startGenerationTrace({ chatId: "chat-b4", chatMode: "game", generationId: "gen-b4-2" });
  failing.finish("failed", { reason: "empty_response", errorId: "err-1", errorCode: "ME_EMPTY_RESPONSE" });
  failing.finish("ok");
  await settle();
  const failedLines = mainLines().filter((l) => l.event === "generation.finished" && l.operationId === "gen-b4-2");
  assert.equal(failedLines.length, 1);
  assert.equal(failedLines[0].outcome, "failed");
  assert.equal(failedLines[0].reason, "empty_response");
  assert.equal(failedLines[0].errorId, "err-1");
  assert.equal(failedLines[0].errorCode, "ME_EMPTY_RESPONSE");

  // ── Source guarantees in the generate route ──
  const source = readFileSync(
    new URL("../../packages/server/src/routes/generate.routes.ts", import.meta.url),
    "utf8",
  ).replace(/\r\n/g, "\n");
  assert.doesNotMatch(source, /\[timing\]/u, "timing debug lines became trace stages");
  assert.doesNotMatch(source, /responsePreview/u, "no response previews in logs");
  assert.doesNotMatch(source, /raw: \(result\.content/u, "the group selector logs sizes, not output");
  assert.doesNotMatch(source, /hData\.raw as string\)\?\.slice/u, "haptic parse failures log sizes, not output");
  assert.doesNotMatch(source, /prompt="\$\{imagePrompt/u, "illustrator decisions log sizes, not the prompt");
  assert.doesNotMatch(source, /chatId=%s, chatMode=%s/u);
  assert.match(source, /event: "generation\.start"/u);
  assert.match(source, /startGenerationTrace\(/u);
  assert.match(source, /operation: "generate",\s*operationId: generationId/u, "the route binds a generate context");

  const closeStart = source.indexOf("const onClose = () => {");
  const closeEnd = source.indexOf("const detachCloseListener = onGenerationOutputClose(reply, onClose)", closeStart);
  assert.ok(closeStart !== -1 && closeEnd > closeStart, "client disconnect handler exists");
  const onClose = source.slice(closeStart, closeEnd);
  assert.match(onClose, /event: "generation\.abort",\s*reason: "client_disconnect"/u);
  assert.match(onClose, /generation\.backend_abort_failed/u);
  assert.doesNotMatch(onClose, /\.catch\(\(\) => \{\}\)/u, "the backend abort failure is logged");

  // The adapter still observes HTTP disconnects and detaches the listener after generation.
  const { onGenerationOutputClose } = await import("../../packages/server/src/routes/generate/sse.js");
  const closeEvents = new EventEmitter();
  let closes = 0;
  const detach = onGenerationOutputClose(
    { raw: closeEvents } as unknown as Parameters<typeof onGenerationOutputClose>[0],
    () => {
      closes += 1;
    },
  );
  closeEvents.emit("close");
  assert.equal(closes, 1, "HTTP disconnect reaches the registered handler");
  detach();
  closeEvents.emit("close");
  assert.equal(closes, 1, "completed generation detaches its disconnect handler");

  const abortStart = source.indexOf('app.post("/abort"');
  const abortRoute = source.slice(abortStart, abortStart + 3_000);
  assert.match(abortRoute, /event: "generation\.abort",\s*reason: "explicit"/u);
  assert.match(abortRoute, /outcome: "failed"/u);

  assert.equal((source.match(/reportPreGenFailures\(/gu) ?? []).length, 2, "one helper for both pre-gen gates");
  assert.match(source, /"ME_AGENT_CRITICAL"/u);
  assert.match(source, /event: "agent\.pipeline\.failed"/u);
  assert.match(source, /event: "agent\.pipeline\.degraded"/u);
  assert.match(source, /event: "agent\.pipeline\.parallel_failed"/u);
  assert.match(source, /"ME_EMPTY_RESPONSE"/u);
  assert.match(source, /event: "generation\.empty_response"/u);
  assert.match(source, /event: "lorebook\.semantic\.unavailable"/u);
  assert.match(source, /errorCode: "LOREBOOK_KEEPER_PERSIST_FAILED"/u);
  assert.match(source, /event: "campaign_memory\.projection_unavailable"/u);
  assert.ok(
    (source.match(/emitSseFailure\(reply/gu) ?? []).length >= 4,
    "agent SSE failures go through emitSseFailure",
  );
  assert.ok((source.match(/event: "agent\.run\.persist"/gu) ?? []).length >= 3);
  assert.match(source, /trace\.finish\("skipped", \{ reason: "cache_guard_hold"/u);
  assert.match(source, /trace\.finish\("cancelled"/u);

  const catchStart = source.indexOf("if (err instanceof CacheGuardHold)");
  const topCatch = source.slice(catchStart, catchStart + 3_000);
  assert.match(topCatch, /stage: currentStage/u, "the top-level failure reports the current stage");
  assert.match(topCatch, /fromProvider \? "ME_PROVIDER_ERROR" : undefined/u);

  console.log("logging-b4 regression passed");
} finally {
  rmSync(logDir, { recursive: true, force: true });
}
