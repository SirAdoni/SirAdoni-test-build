#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_BASE_URL = "http://127.0.0.1:7860/api";
const DEFAULT_INTERVAL_MS = 45_000;
const REQUEST_TIMEOUT_MS = 30_000;
const CHECKPOINT_RENAME_RETRIES = 5;
const CHECKPOINT_RENAME_DELAY_MS = 50;

function usage() {
  return `Historical campaign continuity backfill (API-only, resumable)

Usage:
  node scripts/backfill-campaign-history.mjs --start --plan PATH --state PATH [options]
  node scripts/backfill-campaign-history.mjs --watch --state PATH [options]
  node scripts/backfill-campaign-history.mjs --retry-failed [ERROR_CODE] --state PATH [options]

Options:
  --start                 Start every plan range not already in state, then checkpoint IDs.
  --watch                 Watch checkpointed backfills until all are terminal.
  --publish-reviewed      With --watch, publish only backfills whose every receipt is verified.
  --retry-failed [CODE]   Requeue failed/unresolved/stale receipts of incomplete checkpointed
                          backfills (optionally only those with errorCode CODE), then run --watch.
  --plan PATH             JSON plan (required with --start).
  --state PATH            JSON checkpoint file (required).
  --base-url URL          API root (default: ${DEFAULT_BASE_URL}).
  --interval MS           Watch interval (default: ${DEFAULT_INTERVAL_MS}).
  --help                  Show this help.

The CLI never sends transcripts or provider settings and never writes the database directly.
Unexpected API errors abort with a checkpointed error. Failed, unresolved, and stale jobs are
terminal and are reported as incomplete. Publication requires --publish-reviewed explicitly.
`;
}

function parseArgs(argv) {
  const options = { baseUrl: DEFAULT_BASE_URL, interval: DEFAULT_INTERVAL_MS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--start") options.start = true;
    else if (arg === "--watch") options.watch = true;
    else if (arg === "--publish-reviewed") options.publishReviewed = true;
    else if (arg === "--retry-failed") {
      options.retryFailed = true;
      if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) options.retryErrorCode = argv[++i];
    }
    else if (arg === "--plan") options.plan = argv[++i];
    else if (arg === "--state") options.state = argv[++i];
    else if (arg === "--base-url") options.baseUrl = argv[++i];
    else if (arg === "--interval") options.interval = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.help && [options.start, options.watch, options.retryFailed].filter(Boolean).length !== 1)
    throw new Error("Choose exactly one of --start, --watch, or --retry-failed");
  if (!options.help && !options.state) throw new Error("--state is required");
  if (options.start && !options.plan) throw new Error("--plan is required with --start");
  if (!Number.isFinite(options.interval) || options.interval < 1)
    throw new Error("--interval must be a positive number");
  if (options.publishReviewed && !options.watch) throw new Error("--publish-reviewed requires --watch");
  return options;
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" && fallback !== undefined) return fallback;
    throw new Error(`Cannot read JSON ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isTransientCheckpointRenameError(error) {
  return ["EACCES", "EBUSY", "EPERM"].includes(error?.code);
}

async function renameCheckpointWithRetry(source, destination, {
  renameFn = rename,
  retries = CHECKPOINT_RENAME_RETRIES,
  delayMs = CHECKPOINT_RENAME_DELAY_MS,
} = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameFn(source, destination);
      return;
    } catch (error) {
      if (!isTransientCheckpointRenameError(error) || attempt >= retries) throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs * 2 ** attempt));
    }
  }
}

async function saveJson(path, value, renameOptions) {
  await mkdir(dirname(resolve(path)), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await renameCheckpointWithRetry(temporary, path, renameOptions);
}

async function saveAbortCheckpoint(path, state) {
  try {
    await saveJson(path, state);
  } catch (checkpointError) {
    console.warn(
      `Could not persist abort checkpoint ${path}: ${checkpointError instanceof Error ? checkpointError.message : String(checkpointError)}`,
    );
  }
}

function validatePlan(plan) {
  if (!plan || !Array.isArray(plan.chats)) throw new Error("Plan must contain chats[]");
  return plan.chats.flatMap((chat) => {
    if (!chat || typeof chat.chatId !== "string" || !Array.isArray(chat.ranges))
      throw new Error("Each chat needs chatId and ranges[]");
    return chat.ranges.map((range) => {
      if (!range || typeof range.fromMessageId !== "string" || typeof range.toMessageId !== "string") {
        throw new Error(`Invalid range for chat ${chat.chatId}`);
      }
      return {
        chatId: chat.chatId,
        name: chat.name ?? chat.chatId,
        previousContinuity: chat.previousContinuity ?? null,
        fromMessageId: range.fromMessageId,
        toMessageId: range.toMessageId,
      };
    });
  });
}

function endpoint(baseUrl, chatId, suffix = "") {
  return `${baseUrl.replace(/\/$/u, "")}/game/${encodeURIComponent(chatId)}/continuity/backfill${suffix}`;
}

async function request(url, init = {}, { readRetry = false } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: { "content-type": "application/json", ...(init.headers ?? {}) },
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(
          `HTTP ${response.status}: ${typeof body?.error === "string" ? body.error : "API request failed"}`,
        );
      return body;
    } catch (error) {
      const timeout = error?.name === "AbortError";
      if (readRetry && timeout && attempt === 0) continue;
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      clearTimeout(timer);
    }
  }
}

function jobKey(job) {
  return `${job.chatId}\u0000${job.fromMessageId}\u0000${job.toMessageId}`;
}
function now() {
  return new Date().toISOString();
}

async function start(options) {
  const plan = validatePlan(await readJson(options.plan));
  const state = await readJson(options.state, { version: 1, jobs: [], updatedAt: now() });
  if (!Array.isArray(state.jobs)) throw new Error("State must contain jobs[]");
  const known = new Map(state.jobs.map((job) => [jobKey(job), job]));
  for (const planned of plan) {
    const key = jobKey(planned);
    if (known.get(key)?.backfillId) continue;
    let started;
    try {
      started = await request(endpoint(options.baseUrl, planned.chatId), {
        method: "POST",
        body: JSON.stringify({ fromMessageId: planned.fromMessageId, toMessageId: planned.toMessageId }),
      });
    } catch (error) {
      state.aborted = true;
      state.error = error instanceof Error ? error.message : String(error);
      state.updatedAt = now();
      await saveAbortCheckpoint(options.state, state);
      throw new Error(`Start aborted: ${state.error}`);
    }
    if (typeof started.backfillId !== "string")
      throw new Error(`Start response missing backfillId for ${planned.chatId}`);
    const job = {
      ...planned,
      backfillId: started.backfillId,
      acceptedTurns: started.acceptedTurns ?? null,
      receiptIds: Array.isArray(started.receipts)
        ? started.receipts.map((receipt) => receipt.id).filter((id) => typeof id === "string")
        : [],
      status: "started",
      startedAt: now(),
    };
    known.set(key, job);
    state.jobs = [...known.values()];
    state.updatedAt = now();
    await saveJson(options.state, state);
    console.log(`started ${planned.chatId} ${planned.fromMessageId}..${planned.toMessageId} (${started.backfillId})`);
  }
  delete state.aborted;
  delete state.error;
  state.updatedAt = now();
  await saveJson(options.state, state);
  console.log(`start checkpointed ${state.jobs.length} range(s)`);
}

function summary(job) {
  const counts = job.counts ?? {};
  return `${job.chatId}/${job.backfillId}: ${JSON.stringify(counts)}${job.lastError ? ` error=${job.lastError}` : ""}`;
}
function publishLog(job) {
  console.log(`publish requested ${job.chatId}/${job.backfillId}`);
}

async function watch(options) {
  const state = await readJson(options.state);
  if (
    !Array.isArray(state.jobs) ||
    state.jobs.some((job) => typeof job.chatId !== "string" || typeof job.backfillId !== "string")
  )
    throw new Error("State contains no valid checkpointed jobs");
  let pending = state.jobs.length;
  const recheckedIncomplete = new Set();
  while (pending > 0) {
    pending = 0;
    for (const job of state.jobs) {
      if (job.status === "complete" || (job.status === "verified" && !options.publishReviewed)) continue;
      if (["failed", "unresolved", "stale"].includes(job.status)) {
        if (recheckedIncomplete.has(job.backfillId)) continue;
        recheckedIncomplete.add(job.backfillId);
      }
      try {
        const result = await request(
          endpoint(options.baseUrl, job.chatId, `/${encodeURIComponent(job.backfillId)}`),
          {},
          { readRetry: true },
        );
        if (!result || !Array.isArray(result.receipts) || !result.counts || typeof result.counts !== "object")
          throw new Error("Invalid backfill status response");
        job.counts = result.counts ?? {};
        job.receiptIds = result.receipts.map((receipt) => receipt.id).filter((id) => typeof id === "string");
        if (job.acceptedTurns === 0 && result.receipts.length === 0) job.status = "complete";
        const statuses = result.receipts.map((receipt) => receipt.status);
        let publicationRequested = false;
        const unknown = statuses.some(
          (status) =>
            ![
              "verified",
              "published",
              "failed",
              "unresolved",
              "queued",
              "running",
              "pending",
              "extracting",
              "reviewing",
              "repairing",
            ].includes(status),
        );
        if (options.publishReviewed && statuses.includes("verified")) {
          publicationRequested = true;
          const requestedVerifiedIds = new Set(
            result.receipts.filter((receipt) => receipt.status === "verified").map((receipt) => receipt.id),
          );
          await request(endpoint(options.baseUrl, job.chatId, `/${encodeURIComponent(job.backfillId)}/publish`), {
            method: "POST",
            body: JSON.stringify({ confirm: true }),
          });
          const refreshed = await request(
            endpoint(options.baseUrl, job.chatId, `/${encodeURIComponent(job.backfillId)}`),
            {},
            { readRetry: true },
          );
          if (
            !refreshed ||
            !Array.isArray(refreshed.receipts) ||
            !refreshed.counts ||
            typeof refreshed.counts !== "object"
          )
            throw new Error("Invalid backfill status response after publication");
          job.counts = refreshed.counts;
          job.receiptIds = refreshed.receipts.map((receipt) => receipt.id).filter((id) => typeof id === "string");
          statuses.splice(0, statuses.length, ...refreshed.receipts.map((receipt) => receipt.status));
          publishLog(job);
          if (
            refreshed.receipts.some((receipt) => receipt.status === "verified" && requestedVerifiedIds.has(receipt.id))
          )
            throw new Error("Publication completed without publishing every verified receipt");
        }
        const stillActive = statuses.some((status) =>
          ["queued", "running", "pending", "extracting", "reviewing", "repairing"].includes(status),
        );
        if (stillActive || (publicationRequested && statuses.includes("verified"))) {
          job.status = "running";
          pending += 1;
        } else if (statuses.length === 0 && job.acceptedTurns !== 0) job.status = "stale";
        else if (
          statuses.some((status) => !["verified", "published", "failed", "unresolved"].includes(status)) ||
          unknown
        )
          job.status = "stale";
        else if (statuses.some((status) => status === "failed")) job.status = "failed";
        else if (statuses.some((status) => status === "unresolved")) job.status = "unresolved";
        else if (statuses.every((status) => status === "published")) job.status = "complete";
        else job.status = "verified";
        job.lastCheckedAt = now();
        console.log(summary(job));
        delete state.aborted;
        delete state.error;
      } catch (error) {
        state.aborted = true;
        state.error = error instanceof Error ? error.message : String(error);
        state.updatedAt = now();
        await saveAbortCheckpoint(options.state, state);
        throw new Error(`Watch aborted: ${state.error}`);
      }
      state.updatedAt = now();
      await saveJson(options.state, state);
    }
    if (pending > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, options.interval));
  }
  const incomplete = state.jobs.filter((job) => ["failed", "unresolved", "stale"].includes(job.status));
  console.log(`watch complete: ${state.jobs.length - incomplete.length} passed, ${incomplete.length} incomplete`);
  if (incomplete.length) {
    for (const job of incomplete) console.log(`incomplete ${summary(job)}`);
    process.exitCode = 1;
  }
}

async function retryFailed(options) {
  const state = await readJson(options.state);
  if (
    !Array.isArray(state.jobs) ||
    state.jobs.some((job) => typeof job.chatId !== "string" || typeof job.backfillId !== "string")
  )
    throw new Error("State contains no valid checkpointed jobs");
  let requeued = 0;
  for (const job of state.jobs) {
    if (!["failed", "unresolved", "stale"].includes(job.status)) continue;
    try {
      const result = await request(endpoint(options.baseUrl, job.chatId, `/${encodeURIComponent(job.backfillId)}/retry`), {
        method: "POST",
        body: JSON.stringify(options.retryErrorCode ? { errorCode: options.retryErrorCode } : {}),
      });
      if (!result || !Array.isArray(result.retried) || !Array.isArray(result.skipped))
        throw new Error("Invalid backfill retry response");
      requeued += result.retried.length;
      if (result.retried.length > 0) {
        job.status = "running";
        job.retriedAt = now();
      }
      console.log(
        `retry ${job.chatId}/${job.backfillId}: retried=${result.retried.length} skipped=${result.skipped.length}`,
      );
      delete state.aborted;
      delete state.error;
    } catch (error) {
      state.aborted = true;
      state.error = error instanceof Error ? error.message : String(error);
      state.updatedAt = now();
      await saveAbortCheckpoint(options.state, state);
      throw new Error(`Retry aborted: ${state.error}`);
    }
    state.updatedAt = now();
    await saveJson(options.state, state);
  }
  console.log(`retry complete: ${requeued} receipt(s) requeued; run --watch to follow them`);
}

export { saveJson };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) process.stdout.write(usage());
    else if (options.start) await start(options);
    else if (options.retryFailed) await retryFailed(options);
    else await watch(options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
