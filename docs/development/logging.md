# Server logging guide

v1.0 (2026-09-23)

For anyone writing code in `packages/server`. User-facing settings (LOG*DIR, LOG_FILE_LEVEL, LOG_LEVEL and so on) and the ME*\* error categories are documented in `LOGGING.md` at the repository root. This page covers how to write log lines.

## 1. Where lines go

- There is one Pino logger: `import { logger } from "../lib/logger.js"`. Fastify's `request.log` is a child of that logger.
- The main files are `DATA_DIR/logs/marinara-<pid>-<run>.log`, written as JSON lines. The default file level is info. The default console level is warn.
- Lines flagged `debugPrompt` (written by `logDebugOverride`) go only to `DATA_DIR/logs/prompt-debug/` and to the console. They never reach the main files that `lookup_error` and the problem views read.
- Every line has `time`, `level`, `pid`, `bootId` and `msg`. It also has whatever DiagnosticContext is active (`requestId`, `operationId`, `operation`, `stage`, `chatId`, and so on), which the logger mixin adds.

## 2. Levels

| Level | Use it for                                                                                                                                                                                                                                        |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fatal | The process is about to exit: uncaught exception, failed bootstrap.                                                                                                                                                                               |
| error | A failure that lost work or needs action: a 5xx response, a job that failed for good, data that was not persisted, a package that failed to activate, a required startup phase that failed.                                                       |
| warn  | Degraded but still running: a retry was scheduled, a fallback was used, an optional step failed, a slow request, memory pressure, a rate limit. Worth reading if it repeats.                                                                      |
| info  | Lifecycle facts worth keeping in the default file: startup and shutdown summaries, job state changes, `generation.finished`, cancellations, recoveries, config reloads. Aim for a handful of lines per user action, never one per loop iteration. |
| debug | Step detail: successful sub-operations, per-item progress, retries that stay inside a normal budget, per-request `request.end`.                                                                                                                   |

Rules:

- Cancellation (`ME_CANCELLED`: stop button, abort, shutdown) is info. It is never error.
- Client mistakes (400, 401, 403, 404, 413, 422) are warn or info, not error.
- If unsure, use `levelFor(errorCode)` from `lib/diagnostics.ts`. It maps ME_CANCELLED to info, ME_VALIDATION/ME_AUTH/ME_RATE_LIMIT to warn, and everything else to error.

## 3. Shared vocabulary

Use these names exactly. Do not use synonyms such as `durationMs`, `took`, `status` meaning outcome, `reqId`, or `code` for a specific stable code.

Context fields. These are set through `withDiagnosticContext` or `runWithRootDiagnosticContext` and appear on every line automatically:
`requestId, operationId, operation, stage, chatId, messageId, jobId, provider, model, connectionId, attempt`

`state`, `kind` and `errorCode` are shared with the generation-jobs work (E02): a stored job record and its log lines use the same values, so a job id found in either place reads the same way in the other. Do not add a job state, a media kind or a job error code in one place without the other. The TypeScript types are `JobState`, `JobKind` and `Outcome` in `lib/log-events.ts`.

Line fields:

- `event`: a stable dotted name (section 4).
- `elapsedMs`: an integer duration in milliseconds. Other quantities carry a unit suffix: `...Bytes`, `...MiB`, `...Count`, or a plain plural such as `failedDays`.
- `outcome`: `ok | failed | cancelled | skipped`. Use it only on terminal events.
- `state`: `accepted | running | progress | completed | failed | cancelled | recovered | expired`. Use it for jobs, workers, breakers and pressure states.
- `kind`: `image | sprite | tts | video | illustration`. Use it for media jobs. Put the route-specific name (`gallery-selfie`, `sprite-sheet`) in `jobKind`.
- `errorId`, `diagnostic`: these come from `createDiagnostic` or `reportDiagnosticError`. Never make them up.
- `errorCode`: a stable code string. It defaults to the ME*\* category. Use a specific code when you have one, for example `CONTINUITY_WORKER_FAILED` or `ME_EARLY_BOOT`. The older `code` field still holds the ME*\* category for existing tools, so do not put anything else in `code`.
- `err`: the Error object itself. Never put it under `error`, never pass only its message, and never pass it as a format argument.
- `reason`: a short machine-readable reason for skipped, fallback or cancelled, for example `persisted-error` or `client_disconnect`.
- Common plain fields: `packageId`, `version`, `agentType`, `table`, `path`, `route`, `method`, `statusCode`, `httpStatus`, `providerCode`, `host`, `delayMs`, `timeoutMs`, `suppressedCount`.

## 4. Event names

Format: `<area>.<subject>[.<detail>]`, using lowercase letters, digits, dots and underscores. A name describes a kind of fact, not a sentence. The known names are listed in `EventName` in `lib/log-events.ts`. The main families:

| Area               | Events                                                                                                                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| startup            | `startup.build`, `startup.config`, `startup.phase`, `startup.early_boot`, `startup.inject_held`, `startup.inject_released`, `startup.build_check`, `startup.ready`, `startup.failed`                      |
| shutdown / process | `shutdown.service`, `shutdown.complete`, `process.fatal`, `process.warning`                                                                                                                               |
| http               | `request.end`, `request.slow`, `request.stream.end`, `request.aborted`, `request.error`                                                                                                                   |
| operations         | `operation.start`, `operation.end`, `operation.slow`, `diagnostic.failure`, `diagnostic.rethrown`                                                                                                         |
| packages           | `package.activate`, `package.activate.summary`, `package.rollback`, `package.state`, `package.tables`, `package.contribute`, `package.service.missing`                                                    |
| generation         | `generation.start`, `generation.finished`, `generation.abort`, `generation.empty_response`, `agent.result`, `agent.run`, `agent.batch`, `agent.retry`, `agent.pipeline.failed`, `agent.pipeline.degraded` |
| llm                | `llm.call`, `llm.http`, `llm.retry`, `llm.throttle`, `llm.fallback`, `llm.stream.malformed`, `llm.context.trim`, `llm.config.invalid`                                                                     |
| jobs / media       | `job.state`, `job.progress`, `job.summary`, `media.queue`, `media.generate`, `media.fallback`                                                                                                             |
| workers            | `continuity.stage`, `continuity.breaker`, `continuity.reconcile`, `autonomous.backoff`, `conversation.summary`                                                                                            |
| storage            | `storage.load`, `storage.flush`, `storage.flush.slow`, `storage.recover`, `storage.migrate`, `storage.close`, `storage.json_corrupt`, `storage.read.fallback`                                             |
| runtime            | `runtime.memory`, `runtime.memory_pressure`, `runtime.freeze`, `log.write_failed`, `log.dropped`                                                                                                          |

When you need a new family, add it to `EventName`.

## 5. Fields, not interpolation

Put ids and numbers in fields and keep `msg` short and constant. Start it with the subsystem tag, as existing code does.

```ts
// Good
logger.warn({ event: "job.state", kind: "video", jobId, state: "failed", attempt, errorCode }, "[video] job failed");
// Bad: the id is only in the text, so it cannot be filtered and lookup_error only finds it by accident
logger.warn(`Video job ${jobId} failed on attempt ${attempt}`);
```

Never use template strings or `%s` for ids, counts or durations. For HTTP lines, use the route template (`/api/chats/:id`), never the raw URL.

## 6. Required fields by kind of line

| Kind                     | Required fields                                                                                          |
| ------------------------ | -------------------------------------------------------------------------------------------------------- |
| HTTP request line        | requestId, method, route, statusCode, elapsedMs                                                          |
| Background job or worker | jobId, kind or operation, state, attempt, chatId; elapsedMs and outcome on terminal lines                |
| LLM call                 | provider, model, connectionId, attempt, elapsedMs, outcome; httpStatus/providerCode/errorCode on failure |
| Capability package       | packageId, version, stage, outcome, elapsedMs                                                            |
| Storage                  | table and/or path, elapsedMs; errorCode (errno) on failure                                               |
| Startup phase            | stage, elapsedMs, outcome                                                                                |
| Any failure              | err, errorId, errorCode, outcome                                                                         |

## 7. Context propagation

- HTTP requests are bound automatically by `registerDiagnosticHttpHooks`. It binds the context in `onRequest` and again in `preValidation`, so routes with a request body keep it. `operation` is `"<METHOD> <route template>"`.
- As chat, message, provider or model become known, add them with `withDiagnosticContext({ chatId }, () => work())`. Later lines then carry them without extra effort.
- Background work must start a fresh root context. This covers timers, queues, workers, debounced flushes, schedulers and package ticks:
  ```ts
  runWithRootDiagnosticContext({ operation: "game.continuity", operationId: randomUUID(), jobId, chatId }, () =>
    process(jobId),
  );
  ```
  Without a root context, the work inherits the requestId of whichever request (or startup phase) armed the timer, and `lookup_error` then shows it as part of that request. If the trigger matters, log `triggeredByRequestId` once.
- Event-emitter callbacks run outside the request context. Examples: socket `close`, child process `exit`, stream `data`. Either pass requestId/chatId explicitly or wrap the callback with `bindCurrentDiagnosticContext(fn)`.
- Internal `app.inject()` calls should send an `x-request-id` header so the inner request's id can be linked back.

## 8. Logging errors: one failure, one error line

- Log the error at the boundary that handles it. That is the place that turns it into an HTTP response, an SSE event or a job state, or gives up. Inner layers that rethrow do not log. They add context to the error instead:
  ```ts
  throw new Error("Continuity extract failed", { cause: err });
  // or
  throw Object.assign(err, { stage: "extract", packageId });
  ```
- Never write `logger.error(err, "..."); throw err;`.
- For the boundary line, use `reportDiagnosticError(err, context, code?, { message, event, level, fields })`. It writes exactly one line with `err`, `errorId`, `errorCode` and `diagnostic`, and marks the error as reported. Any later report of the same error object writes only a debug `diagnostic.rethrown` line. Logging an Error at error level through `logger.error` also counts as reporting it.
- If you only need an id to return to the client, call `createDiagnostic(err)`. It does not log. The same object always gets the same errorId, and a wrapper whose `cause` already has an errorId inherits it.
- `runDiagnosticOperation` owns start, end and failure lines for the work it wraps. Do not add your own failure line around it.
- HTTP: throw, or call `replyWithDiagnostic(reply, status, err)`. A 5xx body without `errorId` is a bug.
- SSE: call `emitSseFailure(reply, err, {...})`. Do not log the error and then also send `sendSseEvent({ type: "error", data: message })`, because that creates a second, unrelated errorId.
- Non-terminal lines, such as a retry that will be attempted, must not pass the Error as the first argument, because the logger hook would mint an errorId for them. Log `errorCode`, `httpStatus`, `attempt` and `delayMs` instead.
- Keep cause chains. Wrap with `{ cause }`, never with `new Error(err.message)`. The serializer follows up to 8 causes and includes `AggregateError.errors`.

## 9. No silent catches

An empty or comment-only catch hides failures from everyone. If a failure is allowed:

```ts
catch (err) { logSuppressed(err, { event: "agent.run.persist", stage: "saveRun", chatId }); }
const state = await orFallback(storage.getLatest(chatId), null, { event: "storage.read.fallback", stage: "game-state.latest", chatId });
```

A few catches may stay quiet or log at debug: cleanup of temporary files and handles, reading an error response body, and probing optional features. The empty-catch ratchet regression fails if the count of empty catches goes up.

## 10. Repeated warnings

Anything that can fire on every turn, poll, flush or file must be rate-limited:

```ts
logRepeated(
  `prompt-context:${packageId}`,
  "warn",
  { event: "package.contribute", packageId, outcome: "failed", errorCode },
  "[capability] prompt-context contributor failed",
);
// when it works again
logRecovered(`prompt-context:${packageId}`);
```

The first occurrence logs normally. Repeats inside the window (15 minutes by default) are counted, one summary line with `suppressedCount` follows, and `logRecovered` writes a `state: "recovered"` info line. Breakers and pauses log once when they start and once when they recover, not on every attempt.

## 11. What never to log

- Prompt text, message content, character or lorebook text, model output, reasoning, tool-call arguments, image prompts. Log sizes instead: `promptChars`, `messageCount`, `outputChars`.
- API keys, tokens, cookies, authorization headers, OAuth bodies, passwords, `.env` values. The only exception is allowlisted non-secret settings such as LOG_LEVEL or PORT.
- Full URLs with query strings. For provider calls, log the host only.
- Raw provider or response bodies. Log their shape: `topLevelKeys`, `finishReason`, `bodyBytes`.
- Base64 media.

The sanitizer redacts known keys and patterns. It is a safety net, not a license. Text interpolated into `msg` bypasses key-based redaction. Prompt debugging goes only through `logDebugOverride`.

## 12. How lookup_error follows a request

1. The user reports the `errorId` from a toast or API error. The client can also show the `x-request-id` response header.
2. `lookup_error` greps the recent log files for that id. It takes `requestId` from the matching line, or `operationId` for background work that has no request.
3. It then collects every other line with the same id.

This only works if:

- every line of a request carries `requestId` (context binding, section 7);
- one failure produces one errorId, not three (section 8);
- background work has its own `operationId` instead of borrowing a request's id;
- ids are unique across restarts (request ids are UUIDs, and every line has `bootId`).

## 13. Startup

- The first line of `main()` is `startup.build`: version, commit, runtime (dist or tsx), node, pid, bootId, heapLimitMiB.
- Every step of `buildApp` runs through `startup.phase(stage, fn, { optional })`. That writes `{ event: "startup.phase", stage, elapsedMs, outcome }` at debug, at info above 1 s, at warn above 5 s, and at error on failure (warn if the phase is optional). A failure records the stage, so a bootstrap failure names the phase that threw.
- If Fastify boots before registration finishes, the server writes one error line: `startup.early_boot` with `errorCode: "ME_EARLY_BOOT"` and a stack. Later plugins would fail with "Root plugin has already booted", so this line names the cause.
- After `listen`, the server writes one `startup.ready` line. It is at info, or at warn if any package failed or the build is stale:

```json
{
  "level": 30,
  "bootId": "a1b2c3d4",
  "event": "startup.ready",
  "elapsedMs": 41250,
  "version": "2.4.6",
  "commit": "a03fe63a5abc",
  "runtime": "dist",
  "node": "v22.12.0",
  "url": "http://127.0.0.1:7860",
  "buildStale": false,
  "phases": {
    "count": 24,
    "slowest": [
      { "stage": "capability.runtime", "elapsedMs": 18200 },
      { "stage": "storage.init", "elapsedMs": 9100 }
    ]
  },
  "packages": {
    "activated": ["hierarchical-maps", "conversation-calls"],
    "failed": [
      { "packageId": "long-term-memory", "stage": "activate", "errorCode": "ME_EARLY_BOOT", "errorId": "..." }
    ],
    "skipped": [{ "packageId": "noodle", "reason": "persisted-error" }]
  },
  "storage": { "elapsedMs": 9100, "totalRows": 182340, "recovered": 0, "quarantined": 0 },
  "memory": { "heapUsedMiB": 612.4, "heapLimitMiB": 4144, "rssMiB": 1020.2, "peakRssMiB": 1311.0 },
  "msg": "Marinara Engine ready on http://127.0.0.1:7860 in 41250 ms (2 packages active, 1 failed)"
}
```

`/api/health` returns the same object as `startup`, so tools can read it without grepping.

## 14. Slow work

- Each HTTP request ends with one `request.end` line at debug. It is at info when LOG_DISABLE_REQUEST_LOGGING is off or the status is 5xx.
- `request.slow` (warn) is written when a non-streaming request takes at least `MARINARA_SLOW_REQUEST_MS` (default 5000). Streaming (SSE) responses end with `request.stream.end` at info. A client disconnect is `request.aborted` at info.
- `runDiagnosticOperation` writes `operation.slow` (warn) above `slowMs` (default 10 s). Storage uses `storage.flush.slow` above 1 s and `storage.lazy.full_residency` at warn above 250 ms.

## 15. Memory and runtime

- `runtime.memory` is written at debug every 5 minutes and at info every 30 minutes. It contains heapUsedMiB, heapTotalMiB, heapLimitMiB, rssMiB, externalMiB, arrayBuffersMiB, eventLoopDelayP99Ms and worker queue gauges.
- `runtime.memory_pressure` is written at warn, once per episode, when the heap reaches 85% of its limit, RSS reaches `MARINARA_RSS_WARN_MIB` (default: the heap limit), or p99 loop delay goes above 1 s. It is followed by `state: "recovered"` at info.
- Large operations (boot load, big flush, backup, import, large job result) add a memory snapshot to their terminal line.

## 16. Checklist for a change

- [ ] Every new line has an `event` and uses the vocabulary above.
- [ ] Ids and numbers are fields, not text.
- [ ] Each failure is logged once, at the handling boundary, with `err`.
- [ ] Cancellations are info, and client errors are not error.
- [ ] Background work runs in its own root context.
- [ ] Repeating warnings go through `logRepeated`.
- [ ] No prompt, content, secrets, raw bodies or query strings.
- [ ] No new empty catch.

## 17. Helper reference

All helpers live under `packages/server/src`. Import them; do not copy them.

| Module                             | Export                                                                                                                                                                                                                                                 | Use                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `lib/logger.ts`                    | `logger`, `getBootId(): string`, `logDebugOverride(overrideEnabled, message, ...args)`                                                                                                                                                                 | The one Pino logger; prompt debugging only through `logDebugOverride`.                                |
| `lib/diagnostics.ts`               | `withDiagnosticContext(context, work)`, `runWithRootDiagnosticContext(context, work)`, `bindCurrentDiagnosticContext(fn)`, `getDiagnosticContext()`                                                                                                    | Context propagation (section 7).                                                                      |
| `lib/diagnostics.ts`               | `createDiagnostic(error, context?, code?)`, `levelFor(code)`, `markDiagnosticReported(error)`, `wasDiagnosticReported(error)`, `isSecretEnvKey(key)`, `sanitizeDiagnosticText(text, limit?)`                                                           | Error ids, levels and redaction.                                                                      |
| `lib/diagnostic-operation.ts`      | `reportDiagnosticError(error, context?, code?, { message, event, level, fields })`, `runDiagnosticOperation(context, work, { slowMs, isTransient })`                                                                                                   | One failure, one error line (section 8).                                                              |
| `lib/log-events.ts`                | `logEvent(level, event, fields?, msg?)`, `timed(event, fields, work, { level, slowMs })`, `logRepeated(key, level, fields, msg, { windowMs })`, `logRecovered(key, fields?, msg?)`, types `EventName`, `EventFields`, `Outcome`, `JobState`, `JobKind` | Structured lines and rate limiting (sections 4 and 10).                                               |
| `lib/best-effort.ts`               | `logSuppressed(error, fields)`, `orFallback(promise, fallback, fields)`, `bestEffort(fields, work)`                                                                                                                                                    | Allowed failures (section 9).                                                                         |
| `lib/http-diagnostics.ts`          | `replyWithDiagnostic(reply, status, error, { message, body, event, fields })`, `routeLabel(request)`, `sanitizeIncomingRequestId(value)`, `MarinaraLogController`, `kDiagnosticContext`                                                                | HTTP errors and request lines.                                                                        |
| `routes/generate/sse.ts`           | `emitSseFailure(reply, error, { type, data, agentType, agentName, retryTarget, level, event, message, fields })`                                                                                                                                       | SSE failures with one errorId.                                                                        |
| `lib/startup-timeline.ts`          | `startup.phase(stage, work, { optional })`, `startup.record(key, value)`, `startup.stageOf(error)`, `startup.summary()`                                                                                                                                | Startup phases and the `startup.ready` facts (section 13).                                            |
| `lib/worker-gauges.ts`             | `registerWorkerGauge(name, sample): () => void`, `sampleWorkerGauges()`                                                                                                                                                                                | Queue and worker numbers on `runtime.memory` lines.                                                   |
| `lib/child-process-diagnostics.ts` | `describeChildFailure(err, { command, timeoutMs, startedAt, stderr })`                                                                                                                                                                                 | ME_CHILD_TIMEOUT, ME_CHILD_EXIT or ME_CHILD_SPAWN with exit code, signal and a sanitized stderr tail. |
| `lib/build-integrity.ts`           | `checkBuildIntegrity()`, `verifyDistAgainstMeta(serverRoot, targetCommit?)`                                                                                                                                                                            | Stale or partial dist detection.                                                                      |
| `services/llm/provider-error.ts`   | `llmHttpErrorFromResponseBody(label, response)`, `providerRequestIdFrom(headers)`, `safeHost(url)`, `parseToolArgumentsLogged(value, toolName, provider)`, `SseFrameStats`                                                                             | Provider failures without bodies or prompts.                                                          |
