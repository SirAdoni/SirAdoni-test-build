# Finding and diagnosing failures

Marinara writes structured JSON Lines to `DATA_DIR/logs`. With the standard Windows installation, this is `packages/server/data/logs` inside the installation folder. Each line is one record; files survive browser closure and server restart. The running process has its own `marinara-<pid>-<run>.log` file.

Errors carry a category (`code`) and a unique `errorId`. Copy the reference shown in an API error or generation error and search the log files for it. Existing application-specific codes remain intact; those responses also include `diagnosticCode` for the logging category. The same original Error keeps its reference as it travels through nested operations.

```powershell
# Run from the Marinara installation folder. Substitute the displayed reference.
Get-ChildItem -LiteralPath ./packages/server/data/logs -File |
  Select-String -SimpleMatch 'PASTE-ERROR-REFERENCE'
```

Records include the timestamp, severity, process, sanitized exception and cause chain. Instrumented operations also include request, operation, chat, message or job identifiers, provider/model when available, stage, and elapsed milliseconds. Use `requestId` to follow an HTTP request and `operationId`/`jobId` to follow asynchronous work. Parallel stage durations overlap; do not add them to calculate total runtime.

## Coverage

- Shared Pino logs, including storage, imports, extensions and other existing server logging, reach the same file sink as Fastify.
- HTTP exceptions, validation failures and directly returned JSON errors receive references while keeping validation and JSON-repair payloads usable.
- HTTP-200 generation-stream failures, failed agent-result events and stream-write exceptions are recorded even after the browser disconnects.
- Model completion, image generation and queued generation jobs record start, completion and failure. Saved generation-job failures retain diagnostic identifiers across reloads.
- Session conclusion and regeneration distinguish preparation, generation, factual review and persistence failures. Existing summary validation and save behavior are unchanged.
- Browser runtime errors, unhandled rejections, React recovery and network failures are submitted through the normal authenticated/CSRF-protected API. A bounded local queue retains reports while offline; reporting failures do not recursively report themselves. If browser storage is unavailable, the queue lasts only for that page's lifetime.
- Startup and process failures use the same sink. Synchronous file writes avoid losing the last error solely because the process exits immediately afterward.

Logs cannot reconstruct failures that happened before logging was installed. A power loss, forced termination before an error is raised, browser crash before its report is saved, or unwritable/full disk can still prevent a record. When file output fails, Marinara emits a bounded `ME_LOG_WRITE` warning to stderr and keeps the original operation behavior.

## Settings

Set these in `.env`. File settings take effect after restarting the server once.

| Setting | Default | Meaning |
| --- | --- | --- |
| `LOG_DIR` | `DATA_DIR/logs` | Log folder; relative paths resolve from `packages/server`. |
| `LOG_FILE_LEVEL` | `info` | Minimum file severity. Use `debug` for explicitly requested verbose diagnostics. |
| `LOG_FILE_MAX_MB` | `10` | Rotation size in MiB, bounded to 1–100. |
| `LOG_FILE_KEEP` | `10` | Maximum inactive files retained, bounded to 1–100. |
| `LOG_LEVEL` | `warn` | Console threshold, independent of file logging; supports existing hot reload. |

Inactive files older than seven days are pruned when the sink opens or rotates. Active files belonging to other processes are preserved, and unknown files and symlinks are not deleted. Ordinary records are bounded; oversized records remain valid JSON and indicate truncation. Retention is local to this folder, so export needed evidence before it ages out.

## Error categories

| Code | Meaning |
| --- | --- |
| `ME_VALIDATION` | Invalid input/schema validation. |
| `ME_AUTH` | Authentication or access rejection. |
| `ME_RATE_LIMIT` | Provider or HTTP rate limit. |
| `ME_TIMEOUT` | Operation timeout. |
| `ME_CANCELLED` | Cancellation or interrupted job. |
| `ME_NETWORK` | Network/connection failure. |
| `ME_PROVIDER_ERROR` | Provider-specific failure. |
| `ME_STORAGE` | Storage/filesystem failure. |
| `ME_SESSION_REVIEW` | Session summary review failed. |
| `ME_HTTP_ERROR` | Other HTTP rejection. |
| `ME_STREAM_WRITE` | Writing to a response stream failed. |
| `ME_CLIENT_RUNTIME` | Browser-reported failure; untrusted client evidence. |
| `ME_INTERNAL` | Failure without a more specific typed category. |
| `ME_LOG_WRITE` | The logging sink itself could not write. |

A category describes the failure boundary, not a proven root cause. Preserve provider status/code and the original cause to distinguish, for example, a rate limit from invalid input.

## Investigating prompt-cache reuse

OpenAI Responses calls (including the ChatGPT subscription connection) record `OpenAI Responses request attempt`, input batches, HTTP results, and provider events at file level `info`. Match records by `cacheRequestId`; existing `requestId` and `operationId` still identify the surrounding work. An encrypted-reasoning retry gets a new attempt identifier and fingerprints its modified request.

Compare `fieldFingerprints` to see whether instructions, tools, reasoning, text settings, model, requested service tier, or cache key changed. `requestShapeFingerprint` covers the other request settings too. Ordered `inputItems` record an index, item hash, and cumulative input-prefix hash; their first differing index locates a changed message without storing its text. These prefix hashes cover input items only: compare the instructions and settings fingerprints separately. Batches contain at most 24 items, with at most 512 detailed items per request; `inputOmittedCount` makes that limit explicit, while the whole-input and body hashes still cover the entire request.

Provider events retain the returned response ID, model and service tier, plus reported input, output and cached-input counts. When supplied, separate instruction counters show reuse of the top-level lore instructions. Missing counters remain absent, rather than becoming zero. Fingerprints prove which outgoing fields changed; identical fingerprints do not prove that the provider retained or reused its cache. The ChatGPT subscription endpoint does not currently accept the public API's `prompt_cache_options` comparison control, so these logs cannot establish its internal reason for a cache miss.

Game Mode places completed-session records and library biographies before history for supported subscription connections. Current scene state remains near the latest user turn. Character edits refresh the reference text normally; identity substitutions such as `{{user}}` remain eligible for reuse, while unknown or changing macros stay in current context. The first request after changing this layout may need to populate the new cache prefix.

Claude subscription calls also record cache attempts at file level `info`, correlated by `cacheRequestId` and the existing operation context. These are explicitly observations at the **SDK-input boundary**, not captures of the final Anthropic HTTP request. Compare system/static/dynamic fingerprints, ordered message fingerprints and generation-option fingerprints across attempts. Session identifiers are hashed; the selected resume/direct/fold path is recorded. Message details are bounded, with omitted counts when a request exceeds the limit; whole-input fingerprints still cover the complete input.

Claude result records include reported fresh input, cache reads, cache writes, output and five-minute/one-hour cache-write counters when available. Missing usage stays unavailable, including on provider failures. These counters describe the SDK's main turn; they do not establish provider-internal cache scope or explain a cache miss by themselves. SDK failure flags take precedence over a result subtype named `success`. A failed warm-cache probe is not a zero-hit measurement. Retained-session cache reuse is not enabled by these diagnostics.

For full-lore text requests with stable system instructions, Claude replay places one additional cache marker on the completed assistant turn before the refreshed context tail. The resume debug record includes `historyBreakpointIndex` (`none` when ineligible). Dynamic system instructions, attachments, tools, or an uncertain history shape disable this extra marker so the request stays within the four-marker limit. Literal Extra Instructions are stable system content; instructions containing macros keep their dynamic boundary. The first request writes the new history prefix; a later request can reuse it while the provider retains it. This does not guarantee a hit, and a larger hit percentage can also result from sending less total input.

Eligible subscription requests align the SDK and history marker to a one-hour lifetime. `FORCE_PROMPT_CACHING_5M=1` keeps both at five minutes. The query-local override does not modify process settings, and explicit or inherited API-key requests do not receive the additional marker or lifetime override. Pinning one hour also applies if a subscription draws on usage credits, where one-hour cache writes can cost more; use the five-minute override when that tradeoff is unwanted.

## Privacy and contributor contract

Ordinary logs are operational metadata, not a transcript archive. The sanitizer removes credential fields, recognizable keys and tokens, request headers/bodies and media payloads. Full prompts remain explicit debug diagnostics; enabling debug may expose campaign content. Review logs before sharing them. Sanitization cannot recognize every secret someone embeds in arbitrary prose.

Use the shared `logger`; never add ad-hoc files or server `console.*` calls. Wrap major asynchronous stages with `runDiagnosticOperation(context, work)` or call `reportDiagnosticError(originalError, context)` at a boundary that consumes an error. Rethrow the original Error when preserving behavior, and keep its cause when wrapping it. Return the reference with an existing error response; do not replace established machine-readable business codes. Do not log successful response bodies, raw prompts, credentials, or image bytes to diagnose an ordinary failure.

Runnable regression proofs: `node scripts/run-regressions.mjs --filter diagnostic-` after building shared types. Tests use temporary data/log directories, fake providers and standalone HTTP injection; they do not require a live campaign or provider call.
