// Logging batch 8 v1.0 (2026-09-23): continuity runtime job lifecycle, breaker
// start and recovery, startup recovery summary, provider transient classification,
// worker gauges and session summary refresh lines.
// Runs against a temporary data and log directory; no provider, no live server.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "marinara-logging-b8-"));
const logDir = join(root, "logs");
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.LOG_DIR = logDir;
process.env.LOG_FILE_LEVEL = "debug";
process.env.LOG_LEVEL = "fatal";

type Line = Record<string, any>;

function mainLines(): Line[] {
  let names: string[] = [];
  try {
    names = readdirSync(logDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => /^marinara-.*\.log/.test(name))
    .flatMap((name) => readFileSync(join(logDir, name), "utf8").split("\n"))
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Line);
}

const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));
const src = join(import.meta.dirname, "../../packages/server/src");

try {
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { apiConnections, chats, messages } = await import("../../packages/server/src/db/schema/index.js");
  const { createGameContinuityRuntime } = await import("../../packages/server/src/services/game/continuity-runtime.js");
  const { isTransientContinuityStageError, ContinuityError } =
    await import("../../packages/server/src/services/game/continuity-provider.js");
  const { createSessionSummaryRefreshService } =
    await import("../../packages/server/src/services/game/session-summary-refresh.js");
  const { sampleWorkerGauges } = await import("../../packages/server/src/lib/worker-gauges.js");

  // (1) Provider transient classification: handled provider and runtime conditions skip the stack.
  for (const code of [
    "CONTINUITY_TIMEOUT",
    "CONTINUITY_PROVIDER_UNAVAILABLE",
    "CONTINUITY_PROVIDER_LIMITED",
    "CONTINUITY_ABORTED",
    "CONTINUITY_CONFIG_CHANGED",
  ])
    assert.equal(isTransientContinuityStageError(new ContinuityError(code)), true, code);
  assert.equal(isTransientContinuityStageError(new ContinuityError("CONTINUITY_STAGE_FAILED")), false);
  assert.equal(isTransientContinuityStageError(new ContinuityError("CONTINUITY_INVALID_JSON")), false);
  assert.equal(
    isTransientContinuityStageError(Object.assign(new Error("socket"), { code: "ECONNRESET" })),
    true,
    "network codes are transient",
  );

  // (2) Runtime: one limit failure opens the breaker, the next answered stage closes it, and the job
  // writes accepted, running, progress and completed lines in its own root context.
  const db = await createFileNativeDB();
  const t = (seconds: number) => new Date(Date.UTC(2026, 8, 15, 0, 0, seconds)).toISOString();
  await db.insert(apiConnections).values({ id: "conn", name: "B8 test", provider: "custom", model: "test-model" });
  await db.insert(chats).values({
    id: "b8-chat",
    name: "b8-chat",
    mode: "game",
    connectionId: "conn",
    metadata: JSON.stringify({
      gameContinuity: { mode: "shadow", extractionInstructions: "x", verificationInstructions: "y" },
    }),
    createdAt: t(0),
    updatedAt: t(0),
  });
  await db.insert(messages).values([
    { id: "b8-u", chatId: "b8-chat", role: "user", content: "I promise to return.", createdAt: t(1) },
    { id: "b8-a", chatId: "b8-chat", role: "assistant", content: "Acknowledged.", createdAt: t(2) },
    { id: "b8-u2", chatId: "b8-chat", role: "user", content: "Thanks.", createdAt: t(3) },
  ]);
  let limitsRemaining = 1;
  const complete = async ({ stage, receipt }: { stage: "extract" | "review" | "repair"; receipt: any }) => {
    if (limitsRemaining > 0) {
      limitsRemaining -= 1;
      throw new Error("CONTINUITY_PROVIDER_LIMITED");
    }
    const dispositions = receipt.sources.map((source: any) => ({
      messageId: source.messageId,
      status: "no_durable_facts",
      reason: "nothing durable",
    }));
    return stage === "extract" ? { records: [], dispositions } : { findings: [], dispositions };
  };
  const runtime = createGameContinuityRuntime(db, {
    complete,
    maxDrainMs: 3000,
    providerBackoffMs: { initial: 200, max: 400 },
  });
  assert.ok("continuity" in sampleWorkerGauges(), "continuity gauge registered");
  const gauge = sampleWorkerGauges().continuity as Record<string, unknown>;
  assert.deepEqual(Object.keys(gauge).sort(), ["active", "pausedUntil", "pending"]);

  await runtime.start();
  const receipt = await runtime.enqueueCommittedTurn({ chatId: "b8-chat", assistantMessageId: "b8-a" });
  assert.ok(receipt, "turn enqueued");
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const current = await runtime.get(receipt!.id);
    if (current && !["queued", "extracting", "reviewing", "repairing"].includes(current.status) && !current.errorCode)
      break;
    await settle(50);
  }
  await settle();
  let lines = mainLines();
  const jobLines = lines.filter((line) => line.event === "job.state" && line.jobKind === "continuity");
  const states = jobLines.filter((line) => line.jobId === receipt!.id).map((line) => line.state);
  for (const state of ["accepted", "running", "progress", "completed"])
    assert.ok(states.includes(state), `continuity job.state ${state} logged (got ${states.join(",")})`);
  const completed = jobLines.find((line) => line.state === "completed" && line.jobId === receipt!.id)!;
  assert.equal(completed.outcome, "ok");
  assert.equal(completed.operation, "game.continuity");
  assert.equal(typeof completed.operationId, "string");
  assert.equal(completed.chatId, "b8-chat");
  assert.equal(typeof completed.elapsedMs, "number");
  assert.ok("reviewStatus" in completed && "published" in completed && "repairAttempts" in completed);
  const recovery = jobLines.find((line) => line.state === "recovered" && line.scanned !== undefined);
  assert.ok(recovery, "startup recovery writes one summary line");
  for (const key of ["published", "publishFailed", "markedFailed", "requeued", "configUnavailable"])
    assert.equal(typeof recovery![key], "number", key);

  const breaker = lines.filter((line) => line.event === "continuity.breaker");
  const opened = breaker.find((line) => line.state === "running");
  assert.ok(opened, "breaker start logged");
  assert.equal(opened!.errorCode, "CONTINUITY_PROVIDER_LIMITED");
  assert.equal(typeof opened!.delayMs, "number");
  assert.ok(!("code" in opened!), "legacy code field renamed to errorCode");
  const recovered = breaker.find((line) => line.state === "recovered");
  assert.ok(recovered, "breaker recovery logged");
  assert.equal(typeof recovered!.pausedMs, "number");
  assert.equal(typeof recovered!.suppressedFailures, "number");

  await runtime.stop();
  assert.ok(!("continuity" in sampleWorkerGauges()), "continuity gauge removed on stop");

  // (3) Session summary refresh: gauge lifecycle.
  const summaries = createSessionSummaryRefreshService(db, {
    generate: async () => {
      throw new Error("not called");
    },
  });
  assert.ok("sessionSummary" in sampleWorkerGauges(), "sessionSummary gauge registered");
  await summaries.stop();
  assert.ok(!("sessionSummary" in sampleWorkerGauges()), "sessionSummary gauge removed on stop");

  // (4) Source checks for paths this regression does not drive.
  const summarySource = readFileSync(join(src, "services/game/session-summary-refresh.ts"), "utf8");
  assert.ok(summarySource.includes('name: "TimeoutError", code: "ETIMEDOUT"'), "timeout abort reason is classifiable");
  assert.ok(summarySource.includes('errorCode: "ME_TIMEOUT"'), "silent timeout return writes a line");
  assert.ok(!/log\.warn\(error,/.test(summarySource), "no bare error-first warn lines left");
  const runtimeSource = readFileSync(join(src, "services/game/continuity-runtime.ts"), "utf8");
  assert.ok(!/\{\s*code[:,]/.test(runtimeSource.replace(/errorCode/g, "")), "no `code:` log fields in the runtime");
  const notifierSource = readFileSync(join(src, "services/game/continuity-change-notifier.ts"), "utf8");
  assert.ok(notifierSource.includes('operation: "game.continuity.reconcile"'), "reconcile runs in a root context");

  // Nothing here may log prompt text or message content.
  lines = mainLines();
  const text = JSON.stringify(lines);
  assert.ok(!text.includes("I promise to return."), "message content never logged");

  console.log("logging-b8 regression passed");
} finally {
  await settle(50);
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows can still hold a log file open; the temp directory is harmless.
  }
}
