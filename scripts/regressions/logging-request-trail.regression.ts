import assert from "node:assert/strict";
import { Writable } from "node:stream";
import pino from "../../packages/server/node_modules/pino/pino.js";
import Fastify from "../../packages/server/node_modules/fastify/fastify.js";

// Every line a request causes carries its requestId, including lines written through the shared
// logger from service code and lines written after a body was parsed. The id is echoed as
// x-request-id, and query strings stay out of the request lines.
const { logger } = await import("../../packages/server/src/lib/logger.js");
const { getLogContext, logContextMixin } = await import("../../packages/server/src/lib/log-context.js");
const { genRequestId, registerRequestLogging, RequestLogController, sanitizeIncomingRequestId } =
  await import("../../packages/server/src/lib/request-logging.js");

const productionMixin = Reflect.get(logger, pino.symbols.mixinSym);
assert.equal(typeof productionMixin, "function", "the shared logger installs a context mixin");
const { runWithRootLogContext } = await import("../../packages/server/src/lib/log-context.js");
const { withDiagnosticContext } = await import("../../packages/server/src/lib/diagnostics.js");
const productionContext = runWithRootLogContext({ requestId: "trace-1234abcd", route: "/api/items/:id" }, () =>
  withDiagnosticContext(
    { operation: "fixture", operationId: "fixture-operation", stage: "mixin token=synthetic-secret" },
    () =>
      (productionMixin as (mergeObject: object, level: number, log: typeof logger) => Record<string, unknown>)(
        {},
        30,
        logger,
      ),
  ),
);
assert.equal(productionContext.requestId, "trace-1234abcd", "the production mixin preserves request context");
assert.equal(productionContext.route, "/api/items/:id", "the production mixin preserves route context");
assert.equal(productionContext.operation, "fixture", "the production mixin keeps diagnostic fields");
assert.equal(productionContext.operationId, "fixture-operation");
assert.equal(productionContext.stage, "mixin token=[REDACTED]", "the production mixin sanitizes diagnostic values");

assert.equal(sanitizeIncomingRequestId("trace-1234abcd"), "trace-1234abcd");
assert.equal(sanitizeIncomingRequestId("short"), undefined, "ids under 8 characters are replaced");
assert.equal(sanitizeIncomingRequestId("bad id\nwith newline"), undefined, "ids with spaces or newlines are replaced");
assert.equal(sanitizeIncomingRequestId(["trace-1234abcd"]), undefined);

const lines: Array<Record<string, unknown>> = [];
const sink = new Writable({
  write(chunk, _encoding, done) {
    for (const line of String(chunk).split("\n")) if (line.trim()) lines.push(JSON.parse(line));
    done();
  },
});
// Same mixin and serializers as lib/logger.ts, writing JSON to memory instead of pino-pretty.
const shared = pino(
  {
    level: "debug",
    mixin: logContextMixin,
    serializers: { err: pino.stdSerializers.err, error: pino.stdSerializers.err },
  },
  sink,
);

const app = Fastify({
  loggerInstance: shared,
  logController: new RequestLogController(),
  genReqId: genRequestId,
});
registerRequestLogging(app);
app.get("/api/items/:id", async (request) => {
  shared.warn("service line for %s", (request.params as { id: string }).id);
  request.log.info("route line");
  return { ok: true, context: getLogContext() };
});
app.post("/api/items", async (request) => {
  await new Promise((resolve) => setTimeout(resolve, 5));
  shared.warn("after body parse");
  return { received: (request.body as { name: string }).name };
});
await app.ready();

const getResponse = await app.inject({ method: "GET", url: "/api/items/abc123?token=synthetic-secret-query" });
assert.equal(getResponse.statusCode, 200);
const requestId = getResponse.headers["x-request-id"];
assert.ok(typeof requestId === "string" && requestId.length >= 8, "x-request-id is returned");
assert.equal(getResponse.json().context.requestId, requestId, "handler code sees the request context");

const serviceLine = lines.find((line) => line.msg === "service line for abc123");
assert.equal(serviceLine?.requestId, requestId, "shared-logger lines inside a request carry requestId");
const routeLine = lines.find((line) => line.msg === "route line");
assert.equal(routeLine?.requestId, requestId, "req.log lines carry the same requestId");
assert.equal(
  Object.keys(routeLine ?? {}).filter((key) => key === "requestId").length,
  1,
  "a request child logger does not get requestId twice",
);
const incoming = lines.find((line) => line.msg === "incoming request" && line.requestId === requestId);
const incomingReq = incoming?.req as Record<string, unknown> | undefined;
assert.equal(incomingReq?.url, "/api/items/abc123", "the incoming request line has no query string");
assert.equal(incomingReq?.method, "GET");
assert.ok(
  ["host", "remoteAddress"].every((key) => key in (incomingReq ?? {})),
  "the incoming request line keeps Fastify's req fields",
);
assert.equal(typeof incomingReq?.remoteAddress, "string", "remoteAddress stays on the incoming request line");
assert.equal(incoming?.route, "/api/items/:id", "the incoming request line names the route pattern");
assert.ok(!JSON.stringify(lines).includes("synthetic-secret-query"), "query strings never reach the log");

lines.length = 0;
const postResponse = await app.inject({
  method: "POST",
  url: "/api/items",
  headers: { "x-request-id": "client-trace-0001" },
  payload: { name: "Sample" },
});
assert.equal(postResponse.statusCode, 200);
assert.equal(postResponse.headers["x-request-id"], "client-trace-0001", "a well-formed client id is kept");
const afterBody = lines.find((line) => line.msg === "after body parse");
assert.equal(afterBody?.requestId, "client-trace-0001", "lines after body parsing keep the requestId");
assert.equal(afterBody?.route, "/api/items", "lines carry the route pattern");

const badId = await app.inject({ method: "GET", url: "/api/items/x", headers: { "x-request-id": "no" } });
assert.notEqual(badId.headers["x-request-id"], "no", "a malformed client id is replaced");

lines.length = 0;
await app.inject({ method: "GET", url: "/api/missing?token=synthetic-secret-query" });
const notFound = lines.find((line) => String(line.msg).startsWith("Route GET:"));
assert.equal(notFound?.msg, "Route GET:/api/missing not found");
assert.ok(!JSON.stringify(lines).includes("synthetic-secret-query"));

// Outside a request nothing is added.
lines.length = 0;
shared.warn("outside");
assert.equal(lines[0]?.requestId, undefined, "lines outside a request carry no requestId");

await app.close();

// LOG_DISABLE_REQUEST_LOGGING also silences the abort line.
{
  const quietLines: string[] = [];
  const quietSink = new Writable({
    write(chunk, _encoding, done) {
      quietLines.push(String(chunk));
      done();
    },
  });
  const quiet = pino({ level: "debug", mixin: logContextMixin }, quietSink);
  const controller = new RequestLogController({ disableRequestLogging: true });
  const quietApp = Fastify({ loggerInstance: quiet, logController: controller, genReqId: genRequestId });
  registerRequestLogging(quietApp, controller);
  quietApp.get("/api/ping", async () => ({ ok: true }));
  await quietApp.ready();
  const fakeRequest = { method: "GET", routeOptions: { url: "/api/ping" }, log: quiet } as never;
  controller.clientAborted(fakeRequest);
  await quietApp.inject({ method: "GET", url: "/api/ping" });
  assert.deepEqual(quietLines, [], "disabled request logging writes no request or abort lines");
  await quietApp.close();
  const loud = new RequestLogController();
  loud.clientAborted(fakeRequest);
  assert.ok(
    quietLines.some((line) => line.includes("Client aborted request")),
    "the abort line is on by default",
  );
}

// followLogLevel keeps a child on the shared level and can be undone, so repeated
// buildApp() calls do not stack listeners on the shared logger.
{
  const { followLogLevel } = await import("../../packages/server/src/lib/logger.js");
  const before = logger.listenerCount("level-change");
  const child = { level: "info" };
  const stop = followLogLevel(child);
  assert.equal(logger.listenerCount("level-change"), before + 1);
  const original = logger.level;
  logger.level = original === "trace" ? "debug" : "trace";
  assert.equal(child.level, logger.level, "the child follows a runtime level change");
  logger.level = original;
  stop();
  assert.equal(logger.listenerCount("level-change"), before, "the unsubscribe removes the listener");
}

// The shared JSON logger keeps the per-process boot identifier in its bindings.
const bindings = logger.bindings();
assert.match(String(bindings.bootId), /^[0-9a-f]{8}$/u);

console.info("Logging request trail regression passed");
