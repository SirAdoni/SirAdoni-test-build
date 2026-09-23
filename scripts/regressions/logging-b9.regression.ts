// Logging batch 9 v1.0 (2026-09-23): autonomous scheduler backoff, conversation
// summary failures, agent failure lines and memory-recall repeats.
// Runs against a temporary log directory; no provider, no live server.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const logDir = mkdtempSync(join(tmpdir(), "marinara-logging-b9-"));
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

const settle = () => new Promise((resolve) => setTimeout(resolve, 120));
const root = join(import.meta.dirname, "../../packages/server/src");

try {
  const { parseAutonomousErrorBody, autonomousBackoffLevel } =
    await import("../../packages/server/src/services/conversation/server-autonomous-scheduler.service.js");
  const { SummaryTimeoutError, conversationSummaryFailureFields } =
    await import("../../packages/server/src/services/conversation/auto-summary.service.js");
  const { logAgentFailure } = await import("../../packages/server/src/services/agents/agent-executor.js");
  const { createDiagnostic, markDiagnosticReported } = await import("../../packages/server/src/lib/diagnostics.js");

  // (1) The error handler's JSON body yields ids, never the body text in the log.
  const parsed = parseAutonomousErrorBody(
    JSON.stringify({ error: "Upstream failed", code: "ME_PROVIDER_ERROR", errorId: "e-1", requestId: "auto-x" }),
  );
  assert.deepEqual(parsed, {
    message: "Upstream failed",
    errorCode: "ME_PROVIDER_ERROR",
    causeErrorId: "e-1",
    causeRequestId: "auto-x",
  });
  assert.deepEqual(parseAutonomousErrorBody("<html>not json</html>"), { message: "" });

  // (2) Backoff lines: warn for attempts 1-2, debug from 3 unless the error changed.
  assert.equal(autonomousBackoffLevel(1, false), "warn");
  assert.equal(autonomousBackoffLevel(2, false), "warn");
  assert.equal(autonomousBackoffLevel(3, false), "debug");
  assert.equal(autonomousBackoffLevel(5, true), "warn");

  const schedulerSource = readFileSync(
    join(root, "services/conversation/server-autonomous-scheduler.service.ts"),
    "utf8",
  );
  assert.ok(!schedulerSource.includes("payload.slice(0, 300)"), "scheduler must not log raw response bodies");
  assert.ok(schedulerSource.includes('"x-request-id": requestId'), "generate inject carries x-request-id");
  assert.ok(schedulerSource.includes('registerWorkerGauge("autonomous"'), "autonomous worker gauge registered");

  // (3) Summary timeouts classify as ME_TIMEOUT and carry timeoutMs; one summary line.
  const timeout = new SummaryTimeoutError(1234);
  assert.equal(timeout.timeoutMs, 1234);
  assert.equal(timeout.message, "Summary timeout");
  assert.equal(createDiagnostic(timeout).code, "ME_TIMEOUT");
  assert.equal(
    conversationSummaryFailureFields("c1", {
      failedDays: [],
      failedWeeks: [],
      processedDayCount: 1,
      remainingMissingDayCount: 0,
    }),
    null,
  );
  const summary = conversationSummaryFailureFields("c1", {
    failedDays: [
      { date: "2026-09-01", error: "secret provider text", errorId: "d1", errorCode: "ME_TIMEOUT" },
      { date: "2026-09-02", error: "x", errorId: "d2", errorCode: "ME_TIMEOUT" },
    ],
    failedWeeks: [{ weekKey: "2026-08-24", error: "y", errorId: "w1", errorCode: "ME_PROVIDER_ERROR" }],
    processedDayCount: 2,
    remainingMissingDayCount: 3,
  });
  assert.ok(summary);
  assert.equal(summary.event, "conversation.summary");
  assert.deepEqual(summary.failedDays, ["2026-09-01", "2026-09-02"]);
  assert.deepEqual(summary.failedWeeks, ["2026-08-24"]);
  assert.deepEqual(summary.errorCodes, ["ME_TIMEOUT", "ME_PROVIDER_ERROR"]);
  assert.equal(summary.sampleErrorId, "d1");
  assert.ok(!JSON.stringify(summary).includes("secret provider text"), "summary line carries no error text");

  // (4) Agent failure: unreported error logs once at error with err; a repeat or an
  // already-reported error logs at warn with only the errorId.
  const fresh = new Error("agent boom");
  logAgentFailure(fresh, { agentType: "tracker", agentId: "a1", phase: "post", elapsedMs: 5 });
  logAgentFailure(fresh, { agentType: "director", agentId: "a2", phase: "post", elapsedMs: 5 });
  const earlier = new Error("already logged");
  markDiagnosticReported(earlier);
  logAgentFailure(earlier, { event: "agent.batch", agentTypes: ["a", "b"], elapsedMs: 7 }, "[agent-batch] failed");
  await settle();
  const agentLines = mainLines().filter((line) => line.event === "agent.run" || line.event === "agent.batch");
  const first = agentLines.find((line) => line.agentId === "a1");
  const second = agentLines.find((line) => line.agentId === "a2");
  const batch = agentLines.find((line) => line.event === "agent.batch");
  assert.ok(first && second && batch);
  assert.equal(first.level, 50);
  assert.equal(first.outcome, "failed");
  assert.ok(first.err, "first line carries the error");
  assert.equal(second.level, 40);
  assert.equal(second.err, undefined);
  assert.equal(second.errorId, first.errorId, "one incident keeps one errorId");
  assert.equal(batch.level, 40);
  assert.equal(batch.err, undefined);

  // (5) Agent executor no longer writes prompt or response text into the main log.
  const executorSource = readFileSync(join(root, "services/agents/agent-executor.ts"), "utf8");
  assert.ok(!/logger\.(debug|info)\([^)]*\$\{msg\.content\}/.test(executorSource), "no prompt dumps via logger");
  assert.ok(!executorSource.includes("raw response: ${"), "no raw response dumps via logger");
  assert.ok(!executorSource.includes("logger.debug(`[agent-batch] ${responseText}`)"), "no batch response dump");

  // (6) Memory recall source failures go through logRepeated / logRecovered.
  const embeddingSource = readFileSync(join(root, "services/memory-recall-embedding.ts"), "utf8");
  assert.ok(embeddingSource.includes("logRepeated(") && embeddingSource.includes("logRecovered("));
  const advancedSource = readFileSync(join(root, "services/advanced-memory.ts"), "utf8");
  assert.ok(advancedSource.includes("`ltm.recall:query:${source}`"));

  console.log("logging-b9 regression passed");
} finally {
  rmSync(logDir, { recursive: true, force: true });
}
