// Logging infrastructure v1.0 (2026-09-23): request correlation, request.slow,
// one line per failure, cause chains, redaction of secrets and prompts, and the
// shared helpers (logRepeated, startup.phase, inject gate, error handler).
// Runs against a temporary log directory; no provider, no live server.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const logDir = mkdtempSync(join(tmpdir(), "marinara-logging-infra-"));
process.env.LOG_DIR = logDir;
process.env.LOG_FILE_LEVEL = "debug";
process.env.LOG_LEVEL = "fatal";
delete process.env.MARINARA_SLOW_REQUEST_MS;

const SECRET = "sk-plantedSECRETvalue1234567890";
const PROMPT = "PLANTED PROMPT the dragon whispers the password";
const OVERRIDE_PROMPT = "OVERRIDE PROMPT only for prompt-debug";

// Capture stderr too: console output must never carry secrets or prompts either.
const stderr: string[] = [];
const originalStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = ((chunk: string | Uint8Array) => {
  stderr.push(String(chunk));
  return true;
}) as typeof process.stderr.write;

type Line = Record<string, any>;

function mainLines(): Line[] {
  return readdirSync(logDir)
    .filter((name) => /^marinara-.*\.log/.test(name))
    .flatMap((name) => readFileSync(join(logDir, name), "utf8").split("\n"))
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Line);
}

function mainText(): string {
  return readdirSync(logDir)
    .filter((name) => /^marinara-.*\.log/.test(name))
    .map((name) => readFileSync(join(logDir, name), "utf8"))
    .join("\n");
}

function promptDebugText(): string {
  const dir = join(logDir, "prompt-debug");
  if (!existsSync(dir)) return "";
  return readdirSync(dir)
    .map((name) => readFileSync(join(dir, name), "utf8"))
    .join("\n");
}

try {
  const { default: Fastify } = await import("../../packages/server/node_modules/fastify/fastify.js");
  const { ZodError, ZodIssueCode } = await import("../../packages/server/node_modules/zod/index.js");
  const { logger, logDebugOverride, getBootId } = await import("../../packages/server/src/lib/logger.js");
  const { createDiagnostic, runWithRootDiagnosticContext, getDiagnosticContext } =
    await import("../../packages/server/src/lib/diagnostics.js");
  const { reportDiagnosticError, runDiagnosticOperation } =
    await import("../../packages/server/src/lib/diagnostic-operation.js");
  const { MarinaraLogController, sanitizeIncomingRequestId, replyWithDiagnostic } =
    await import("../../packages/server/src/lib/http-diagnostics.js");
  const { registerDiagnosticHttpHooks } = await import("../../packages/server/src/app.js");
  const { errorHandler } = await import("../../packages/server/src/middleware/error-handler.js");
  const { logRepeated, logRecovered, logEvent } = await import("../../packages/server/src/lib/log-events.js");
  const { logSuppressed } = await import("../../packages/server/src/lib/best-effort.js");
  const { startup } = await import("../../packages/server/src/lib/startup-timeline.js");
  const { holdInjectUntilRegistered } = await import("../../packages/server/src/lib/fastify-inject-gate.js");
  const { describeChildFailure } = await import("../../packages/server/src/lib/child-process-diagnostics.js");
  const { randomUUID } = await import("node:crypto");
  // Let the logger's queued level refresh run.
  await new Promise((resolve) => setTimeout(resolve, 0));

  // ── The HTTP app, built the way buildApp builds it ──
  const app = Fastify({
    loggerInstance: logger as any,
    logController: new MarinaraLogController(),
    genReqId: (req: any) => sanitizeIncomingRequestId(req.headers["x-request-id"]) ?? randomUUID(),
  });
  registerDiagnosticHttpHooks(app as any);
  app.setErrorHandler(errorHandler);

  let handlerContext: Record<string, unknown> = {};
  app.post("/t", async (request: any) => {
    handlerContext = { ...getDiagnosticContext() };
    logger.info({ event: "test.handler", bodyKeys: Object.keys(request.body ?? {}) }, "[test] handler ran");
    return { ok: true };
  });
  app.get("/slow", async () => {
    await new Promise((resolve) => setTimeout(resolve, 120));
    return { ok: true };
  });
  const wrapped = new Error("inner boom");
  app.get("/fail", async () =>
    runDiagnosticOperation({ operation: "test.fail" }, async () => {
      throw wrapped;
    }),
  );
  app.get("/zod", async () => {
    throw new ZodError([
      { code: ZodIssueCode.invalid_type, expected: "string", received: "number", path: ["name"], message: "bad" },
    ]);
  });
  app.get("/reply", async (_request: any, reply: any) => replyWithDiagnostic(reply, 502, new Error("upstream down")));

  // 1. requestId is on a log line written inside a POST handler (body parsing runs in another async context).
  const posted = await app.inject({ method: "POST", url: "/t", payload: { prompt: PROMPT, apiKey: SECRET } });
  assert.equal(posted.statusCode, 200);
  const requestId = posted.headers["x-request-id"];
  assert.equal(typeof requestId, "string", "x-request-id response header is set");
  assert.match(String(requestId), /^[0-9a-f-]{36}$/, "request ids are UUIDs");
  assert.equal(handlerContext.requestId, requestId, "the handler runs inside the request's context");
  const handlerLine = mainLines().find((line) => line.event === "test.handler");
  assert.ok(handlerLine, "the handler line was written");
  assert.equal(handlerLine.requestId, requestId, "requestId is on the handler's log line");
  assert.equal(handlerLine.operation, "POST /t", "operation is METHOD plus route template");
  assert.equal(handlerLine.bootId, getBootId(), "every line carries bootId");
  const endLine = mainLines().find((line) => line.event === "request.end" && line.requestId === requestId);
  assert.ok(endLine, "one request.end line closes the request");
  assert.equal(endLine.route, "/t");
  assert.equal(endLine.statusCode, 200);
  assert.equal(typeof endLine.elapsedMs, "number");
  assert.equal(
    mainLines().filter(
      (line) => line.requestId === requestId && /incoming request|request completed/.test(line.msg ?? ""),
    ).length,
    0,
    "Fastify's default request pair is replaced",
  );

  const honoured = await app.inject({
    method: "POST",
    url: "/t",
    payload: {},
    headers: { "x-request-id": "abcdefgh-1234" },
  });
  assert.equal(honoured.headers["x-request-id"], "abcdefgh-1234", "a well-formed client request id is honoured");
  const rejected = await app.inject({ method: "POST", url: "/t", payload: {}, headers: { "x-request-id": "bad id!" } });
  assert.notEqual(rejected.headers["x-request-id"], "bad id!", "a malformed client request id is replaced");

  // 2. request.slow is written at warn for a slow non-streaming request.
  process.env.MARINARA_SLOW_REQUEST_MS = "100";
  const slow = await app.inject({ method: "GET", url: "/slow" });
  delete process.env.MARINARA_SLOW_REQUEST_MS;
  const slowLine = mainLines().find((line) => line.event === "request.slow");
  assert.ok(slowLine, "request.slow is emitted");
  assert.equal(slowLine.level, 40);
  assert.equal(slowLine.requestId, slow.headers["x-request-id"]);
  assert.equal(slowLine.route, "/slow");
  assert.ok(slowLine.elapsedMs >= 100);

  // 3. Duplicate failure lines collapse to one.
  // 3a. runDiagnosticOperation reports, the error handler sees the same error: one error line, one errorId.
  const failed = await app.inject({ method: "GET", url: "/fail" });
  assert.equal(failed.statusCode, 500);
  const failedId = failed.json().errorId;
  const failedLines = mainLines().filter((line) => line.errorId === failedId);
  assert.equal(failedLines.filter((line) => line.level >= 40).length, 1, "exactly one warn-or-worse line per failure");
  assert.ok(
    failedLines.some((line) => line.event === "diagnostic.rethrown" && line.level === 20),
    "the second report is a debug pointer",
  );
  // 3b. reportDiagnosticError twice.
  const twice = new Error("reported twice");
  const first = reportDiagnosticError(twice, { operation: "test.twice" });
  const second = reportDiagnosticError(twice, { operation: "test.twice" });
  assert.equal(first.errorId, second.errorId);
  const twiceLines = mainLines().filter((line) => line.errorId === first.errorId);
  assert.equal(twiceLines.filter((line) => line.level >= 50).length, 1);
  assert.equal(twiceLines.filter((line) => line.event === "diagnostic.rethrown").length, 1);
  // 3c. logger.error(err) counts as the report.
  const direct = new Error("logged directly");
  logger.error({ err: direct }, "[test] direct");
  const directRef = reportDiagnosticError(direct);
  assert.equal(mainLines().filter((line) => line.errorId === directRef.errorId && line.level >= 50).length, 1);
  // 3d. A cancellation is info with no err.
  const abort = Object.assign(new Error("stopped"), { name: "AbortError" });
  await assert.rejects(runDiagnosticOperation({ operation: "test.cancel" }, async () => Promise.reject(abort)));
  const cancelLine = mainLines().find((line) => line.operation === "test.cancel" && line.event === "operation.end");
  assert.ok(cancelLine);
  assert.equal(cancelLine.level, 30);
  assert.equal(cancelLine.outcome, "cancelled");
  assert.equal(cancelLine.err, undefined);
  // 3e. Validation errors are warn with event request.error; 5xx through replyWithDiagnostic is error.
  const zod = await app.inject({ method: "GET", url: "/zod" });
  assert.equal(zod.statusCode, 400);
  const zodLine = mainLines().find((line) => line.errorId === zod.json().errorId && line.event === "request.error");
  assert.ok(zodLine);
  assert.equal(zodLine.level, 40);
  assert.equal(zodLine.issueCount, 1);
  const replied = await app.inject({ method: "GET", url: "/reply" });
  assert.equal(replied.statusCode, 502);
  assert.equal(
    mainLines().filter((line) => line.errorId === replied.json().errorId && line.level >= 50).length,
    1,
    "replyWithDiagnostic logs once and onSend does not report again",
  );

  // 4. Cause chains are serialized, and a wrapper keeps its cause's errorId.
  let chain: Error = Object.assign(new Error("level 0 root"), { errno: -4058, syscall: "open", code: "ENOENT" });
  for (let level = 1; level <= 7; level++) chain = new Error(`level ${level}`, { cause: chain });
  logger.error({ err: chain, event: "test.chain" }, "[test] chain");
  const chainLine = mainLines().find((line) => line.event === "test.chain")!;
  let node = chainLine.err;
  const messages: string[] = [];
  while (node) {
    messages.push(node.message);
    node = node.cause;
  }
  assert.equal(messages.length, 8, "a 7-level cause chain is kept whole");
  assert.equal(messages[7], "level 0 root");
  let root = chainLine.err;
  while (root.cause) root = root.cause;
  assert.equal(root.errno, -4058);
  assert.equal(root.syscall, "open");
  const aggregate = new AggregateError([new Error("first member"), new Error("second member")], "all failed");
  logger.error({ err: aggregate, event: "test.aggregate" }, "[test] aggregate");
  const aggregateLine = mainLines().find((line) => line.event === "test.aggregate")!;
  assert.deepEqual(
    aggregateLine.err.errors.map((item: any) => item.message),
    ["first member", "second member"],
  );
  const inner = new Error("inner");
  const innerRef = createDiagnostic(inner);
  assert.equal(createDiagnostic(new Error("outer", { cause: inner })).errorId, innerRef.errorId);
  // An explicit specific code moves to errorCode; code keeps the ME_* category.
  logger.error({ err: new Error("coded"), code: "X_CODE", event: "test.code" }, "[test] code");
  const codeLine = mainLines().find((line) => line.event === "test.code")!;
  assert.equal(codeLine.errorCode, "X_CODE");
  assert.match(codeLine.code, /^ME_/);

  // 5. A planted secret and prompt never appear in the main files or on the console.
  logger.debug({ event: "test.prompt", prompt: PROMPT, messages: [{ content: PROMPT }] }, "[test] prompt");
  logger.info({ event: "test.secret", apiKey: SECRET, headers: { authorization: `Bearer ${SECRET}` } }, "[test] s");
  logger.warn(
    { event: "test.secret-text", err: new Error(`provider said Authorization: Bearer ${SECRET} for ${SECRET}`) },
    "[test] secret in message",
  );
  logger.info({ event: "test.url", url: `https://api.example.com/v1?key=${SECRET}` }, "[test] url");
  logDebugOverride(true, `[prompt] ${OVERRIDE_PROMPT}`);
  const everything = `${mainText()}\n${stderr.join("")}`;
  assert.ok(!everything.includes(SECRET), "the planted secret never reaches output");
  assert.ok(!everything.includes(PROMPT), "the planted prompt never reaches output");
  assert.ok(!mainText().includes(OVERRIDE_PROMPT), "prompt-debug lines never reach the main files");
  assert.ok(promptDebugText().includes(OVERRIDE_PROMPT), "prompt-debug lines go to prompt-debug/");
  assert.ok(!promptDebugText().includes(SECRET));
  const promptLine = mainLines().find((line) => line.event === "test.prompt")!;
  assert.equal(promptLine.prompt, "[REDACTED]", "debug level no longer unredacts prompt text");

  // 6. logRepeated suppresses repeats; logRecovered closes the episode.
  for (let i = 0; i < 5; i++) {
    logRepeated("test:repeat", "warn", { event: "test.repeat", errorCode: "ME_NETWORK" }, "[test] repeat");
  }
  assert.equal(
    mainLines().filter((line) => line.event === "test.repeat").length,
    1,
    "repeats are counted, not written",
  );
  logRecovered("test:repeat");
  const recovered = mainLines().find((line) => line.event === "test.repeat" && line.state === "recovered")!;
  assert.ok(recovered);
  assert.equal(recovered.suppressedCount, 4);
  logSuppressed(new Error("best effort"), { event: "test.suppressed", stage: "probe", chatId: "chat-1" });
  const suppressedLine = mainLines().find((line) => line.event === "test.suppressed")!;
  assert.equal(suppressedLine.suppressed, true);
  assert.equal(suppressedLine.outcome, "failed");
  logEvent("info", "job.state", { jobId: "job-1", kind: "image", state: "running" });
  const jobLine = mainLines().find((line) => line.event === "job.state")!;
  assert.equal(jobLine.state, "running");
  assert.equal(jobLine.kind, "image");

  // 7. startup.phase records failures; an optional phase returns undefined and logs warn.
  const phaseError = new Error("phase broke");
  await assert.rejects(startup.phase("test.required", () => Promise.reject(phaseError)));
  assert.equal(startup.stageOf(phaseError), "test.required");
  assert.equal(
    await startup.phase("test.optional", () => Promise.reject(new Error("optional broke")), { optional: true }),
    undefined,
  );
  const optionalLine = mainLines().find((line) => line.event === "startup.phase" && line.stage === "test.optional")!;
  assert.equal(optionalLine.level, 40);
  assert.equal(optionalLine.outcome, "failed");
  assert.equal(startup.summary().phases.failed.length, 2);

  // 8. The inject gate reports what it held.
  const gated = Fastify();
  const release = holdInjectUntilRegistered(gated, 60_000);
  const held = gated.inject({ method: "GET", url: "/later?token=hidden" });
  gated.get("/later", async () => "ok");
  release();
  assert.equal((await held).statusCode, 200);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const releasedLine = mainLines().find((line) => line.event === "startup.inject_released")!;
  assert.equal(releasedLine.heldCount, 1);
  assert.deepEqual(releasedLine.urls, ["GET /later"], "query strings are dropped");
  await gated.close();

  // 9. Background work gets a fresh root context, not the caller's.
  runWithRootDiagnosticContext({ requestId: "req-outer", stage: "outer" }, () => {
    runWithRootDiagnosticContext({ operation: "test.timer" }, () => {
      assert.equal(getDiagnosticContext().requestId, undefined, "a root context does not inherit requestId");
      assert.equal(getDiagnosticContext().operation, "test.timer");
    });
  });

  // 10. Child process failures are classified without arguments.
  const timedOut = describeChildFailure(Object.assign(new Error("killed"), { killed: true, signal: "SIGTERM" }), {
    command: "ffmpeg -i secret.mp4",
    timeoutMs: 10,
    startedAt: Date.now() - 50,
    stderr: `line1\nline2\nAuthorization: Bearer ${SECRET}`,
  });
  assert.equal(timedOut.fields.errorCode, "ME_CHILD_TIMEOUT");
  assert.equal(timedOut.error.message, "ffmpeg failed");
  assert.ok(!timedOut.fields.stderrTail?.includes(SECRET));
  const missing = describeChildFailure(Object.assign(new Error("spawn"), { code: "ENOENT" }), {
    command: "git",
    startedAt: Date.now(),
  });
  assert.equal(missing.fields.errorCode, "ME_CHILD_SPAWN");

  await app.close();
  process.stderr.write = originalStderrWrite;
  console.log("logging-infrastructure regression passed");
} finally {
  process.stderr.write = originalStderrWrite;
  rmSync(logDir, { recursive: true, force: true });
}
