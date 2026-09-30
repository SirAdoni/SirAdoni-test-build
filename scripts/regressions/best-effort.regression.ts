import assert from "node:assert/strict";

// Best-effort helpers: a deliberately swallowed failure is logged (rate limited per event, chat and stage) and the
// caller keeps going with a fallback instead of a thrown error or a silent empty catch.
process.env.LOG_LEVEL = "silent";
const { bestEffort, logSuppressed, orFallback, suppressedLogLine } =
  await import("../../packages/server/src/lib/best-effort.js");
const { logger } = await import("../../packages/server/src/lib/logger.js");
const { takeRateLimitedSlot, resetRateLimitedLogs } = await import("../../packages/server/src/lib/log-rate-limit.js");

// Assert the observable repeat-log contract; the old limiter has an independent map.
const lines: Record<string, unknown>[] = [];
const priorWarn = logger.warn;
const priorNow = Date.now;
let now = 10_000;
logger.warn = ((fields: Record<string, unknown>) => lines.push(fields)) as typeof logger.warn;
Date.now = () => now;
try {
  const fields = { event: "regression.cleanup", chatId: "chat-1" };
  assert.doesNotThrow(() => logSuppressed(new Error("cleanup failed"), fields));
  assert.equal(lines.length, 1, "the first swallowed failure is logged");
  logSuppressed(new Error("cleanup failed again"), fields);
  now += 59_999;
  logSuppressed(new Error("cleanup still failed"), fields);
  assert.equal(lines.length, 1, "repeats inside a minute are suppressed");
  logSuppressed(new Error("other chat"), { ...fields, chatId: "chat-2" });
  logSuppressed(new Error("other stage"), { ...fields, stage: "later" });
  logSuppressed(new Error("other event"), { ...fields, event: "regression.other" });
  assert.equal(lines.length, 4, "event, chat and stage each isolate their repeat key");
  now += 1;
  logSuppressed(new Error("cleanup failed after window"), fields);
  assert.equal(lines.length, 6, "the next window writes a repeat summary and the current failure");
  assert.equal(lines[4]?.suppressedCount, 2, "the summary preserves both suppressed failures");
  assert.equal(lines[4]?.repeatKey, "regression.cleanup:chat-1:");
  assert.equal(lines[5]?.outcome, "failed");
  assert.equal(lines[5]?.suppressed, true);
  assert.ok(lines[5]?.err instanceof Error);
} finally {
  logger.warn = priorWarn;
  Date.now = priorNow;
}

// The standalone legacy limiter keeps its own window contract for its remaining callers.
resetRateLimitedLogs();
assert.equal(takeRateLimitedSlot("regression.cleanup:chat-1:"), 0);
assert.equal(takeRateLimitedSlot("regression.cleanup:chat-1:"), null);
assert.equal(takeRateLimitedSlot("regression.cleanup:chat-2:"), 0, "another chat has its own key");
assert.doesNotThrow(() => logSuppressed("not an Error", { event: "regression.cleanup", level: "debug" }));

// Caller fields cannot overwrite the diagnostic fields of the line.
const failure = new Error("real failure");
const line = suppressedLogLine(failure, {
  event: "regression.fields",
  outcome: "ok",
  suppressed: false,
  err: "caller value",
  level: "debug",
});
assert.equal(line.err, failure, "err is the swallowed error");
assert.equal(line.outcome, "failed");
assert.equal(line.suppressed, true);
assert.equal(line.event, "regression.fields");
assert.equal("level" in line, false, "level only picks the log method");

assert.equal(
  await orFallback(Promise.reject(new Error("read failed")), "fallback", { event: "regression.read" }),
  "fallback",
);
assert.equal(await orFallback(Promise.resolve("value"), "fallback", { event: "regression.read" }), "value");

assert.equal(
  await bestEffort({ event: "regression.work" }, async () => {
    throw new Error("work failed");
  }),
  undefined,
);
assert.equal(await bestEffort({ event: "regression.work" }, async () => 42), 42);

console.log("best-effort regression passed");
