// Logging batch 5 v1.0 (2026-09-23): generation satellites. agent.result lines carry
// a reference the SSE payload reuses and never result.data; invalid preset parameters
// warn once with presetId and size; raw, dry-run and retry routes report failures
// through the shared helpers. Temporary log directory; no provider, no live server.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const logDir = mkdtempSync(join(tmpdir(), "marinara-logging-b5-"));
process.env.LOG_DIR = logDir;
process.env.LOG_FILE_LEVEL = "debug";
process.env.LOG_LEVEL = "fatal";

const GENERATED = "PLANTED GENERATED TEXT the knight sighs";
const root = join(import.meta.dirname, "../..");
const src = (path: string) => readFileSync(join(root, "packages/server/src", path), "utf8");

type Line = Record<string, any>;
function mainLines(): Line[] {
  return readdirSync(logDir)
    .filter((name) => /^marinara-.*\.log/.test(name))
    .flatMap((name) => readFileSync(join(logDir, name), "utf8").split("\n"))
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Line);
}

try {
  const { logger } = await import("../../packages/server/src/lib/logger.js");
  const { createAgentEventDispatcher } =
    await import("../../packages/server/src/services/generation/agent-event-dispatcher.js");
  const { parsePresetParameters } = await import("../../packages/server/src/services/prompt/assembler.js");

  // 1. agent.result: one line per result, reference shared with the SSE payload.
  const sent: Record<string, any>[] = [];
  const dispatcher = createAgentEventDispatcher({
    resolvedAgents: [],
    sendEvent: (payload) => sent.push(payload),
    getOwnership: () => ({ chatId: "chat-1", messageId: "msg-1", swipeIndex: 0, generationId: "gen-1" }),
  });
  const failed = {
    agentId: "a1",
    agentType: "director",
    type: "director_event",
    data: GENERATED,
    tokensUsed: 0,
    durationMs: 42,
    success: false,
    error: "x".repeat(500),
  } as any;
  dispatcher.sendAgentResultEvent(failed);
  dispatcher.sendAgentResultEvent(failed);
  dispatcher.sendAgentResultEvent({ ...failed, agentId: "a2", success: true, error: null });

  // 2. Invalid preset parameters warn with presetId and chars.
  const params = parsePresetParameters("{not json", "preset-9");
  assert.equal(typeof params, "object");

  logger.flush?.();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const lines = mainLines();

  const agentLines = lines.filter((line) => line.event === "agent.result");
  assert.equal(agentLines.length, 2, "one agent.result line per result object");
  const failLine = agentLines.find((line) => line.outcome === "failed")!;
  assert.equal(failLine.level, 40);
  assert.equal(failLine.elapsedMs, 42);
  assert.equal(failLine.jobId, "gen-1");
  assert.equal(failLine.messageId, "msg-1");
  assert.ok(failLine.errorId && failLine.errorCode, "failure line carries errorId and errorCode");
  assert.ok(String(failLine.errorSummary).length <= 215, "error summary is capped at 200 characters plus the marker");
  const failPayload = sent[0].data;
  assert.equal(failPayload.errorId, failLine.errorId, "SSE payload reuses the logged errorId");
  assert.equal(failPayload.code, failLine.errorCode);
  assert.equal(agentLines.find((line) => line.outcome === "ok")!.level, 30);
  assert.ok(!JSON.stringify(lines).includes(GENERATED), "result.data never reaches the log");

  const presetLine = lines.find((line) => line.event === "prompt.preset.params_invalid");
  assert.ok(presetLine, "prompt.preset.params_invalid logged");
  assert.equal(presetLine!.presetId, "preset-9");
  assert.equal(presetLine!.chars, 9);

  // 3. Source checks for the routes (no provider needed).
  const raw = src("routes/generate/raw-route.ts");
  assert.match(raw, /emitSseFailure\(reply, err, \{ event: "raw\.generation\.failed"/);
  assert.match(raw, /replyWithDiagnostic\(reply, 500, err/);
  assert.doesNotMatch(raw, /logger\.error\(err, "\[raw\]/);
  const dry = src("routes/generate/dry-run-route.ts");
  assert.doesNotMatch(dry, /logger\.error\(err, "\[dryRun\]/);
  assert.equal((dry.match(/emitSseFailure\(reply, err/g) ?? []).length, 2);
  const retry = src("routes/generate/retry-agents-route.ts");
  assert.match(retry, /operation: "agents\.retry"/);
  assert.match(retry, /event: "agent\.retry", outcome: "cancelled"/);
  assert.doesNotMatch(retry, /\.catch\(\(\) => null\)/);
  assert.equal((retry.match(/event: "agent\.run\.persist"/g) ?? []).length, 2);
  assert.doesNotMatch(retry, /illData\.reason as string \| undefined\)\?\.slice/);
  const gm = src("services/generation/game-gm-prompt-runtime.ts");
  assert.match(gm, /errorCode: "CAMPAIGN_MEMORY_PROJECTION_UNAVAILABLE"/);
  assert.match(src("services/prompt/assembler.ts"), /event: "prompt\.section\.skipped"/);

  console.log("logging-b5 regression passed");
} finally {
  try {
    rmSync(logDir, { recursive: true, force: true });
  } catch {
    // Windows may still hold the log file open.
  }
}
