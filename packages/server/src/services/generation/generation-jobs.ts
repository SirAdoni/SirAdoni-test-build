import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { DATA_DIR } from "../../utils/data-dir.js";
import { logger } from "../../lib/logger.js";
import type { DiagnosticReference } from "@marinara-engine/shared";
import { reportDiagnosticError } from "../../lib/diagnostic-operation.js";
import {
  createDiagnostic,
  getDiagnosticContext,
  markDiagnosticReported,
  runWithRootDiagnosticContext,
} from "../../lib/diagnostics.js";
import { logEvent, type EventFields, type JobKind, type JobState } from "../../lib/log-events.js";
import { registerWorkerGauge } from "../../lib/worker-gauges.js";
import { getRuntimeMemorySnapshot } from "../../utils/runtime-memory.js";

export type GenerationJobStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";
export interface GenerationJobMetadata {
  id: string;
  kind: string;
  label: string;
  chatId: string | null;
  status: GenerationJobStatus;
  createdAt: string;
  updatedAt: string;
  error: string | null;
  /** Additive correlation fields; absent in metadata written by older versions. */
  errorCode?: string;
  errorId?: string;
  requestId?: string;
  resultAvailable: boolean;
}
export interface GenerationJobRunOptions {
  /** Optional caller-owned id for idempotent scheduling and immediate status responses. */
  id?: string;
  kind: string;
  label: string;
  chatId?: string;
  timeoutMs: number;
}
export interface GenerationJobs {
  run<T>(options: GenerationJobRunOptions, work: (signal: AbortSignal) => Promise<T>): Promise<T>;
  list(chatId?: string): Promise<GenerationJobMetadata[]>;
  get(id: string): Promise<GenerationJobMetadata | null>;
  result(id: string): Promise<unknown>;
  cancel(id: string): Promise<boolean>;
}
/**
 * Lifecycle seam for opt-in job tracking (generation-job-tracker.ts). "accepted" and "running" fire once the
 * job is persisted and its work starts; "settled" fires once per job with its final status. Observers run
 * synchronously inside run() and must never throw or block; the store guards the call anyway.
 */
export type GenerationJobLifecycleEvent =
  | { type: "accepted" | "running"; metadata: Readonly<GenerationJobMetadata> }
  | { type: "settled"; metadata: Readonly<GenerationJobMetadata>; elapsedMs: number; result?: unknown };
export type GenerationJobObserver = (event: GenerationJobLifecycleEvent) => void;
export interface GenerationJobsOptions {
  dataDir?: string;
  /** Maximum time close waits for provider work to settle after aborting it. */
  shutdownWaitMs?: number;
}

/** Newest terminal jobs whose metadata is kept on disk; well above list()'s 50 so per-chat lists stay intact. */
const MAX_RETAINED_JOBS = 200;
/** Newest terminal jobs whose (possibly multi-MB) result file is kept; matches list()'s visible window. */
const MAX_RETAINED_RESULTS = 50;
/** Results and metadata touched more recently than this are never pruned, so fresh results stay recoverable. */
const PRUNE_MIN_AGE_MS = 24 * 60 * 60 * 1000;
/** Stray temp or orphaned result files older than this are treated as leftovers. */
const STRAY_FILE_MIN_AGE_MS = 10 * 60 * 1000;
/** Minimum gap between retention passes triggered by finished jobs. */
const PRUNE_INTERVAL_MS = 10 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const stores = new WeakMap<object, GenerationJobsStore>();

function validId(id: string): boolean {
  return UUID_RE.test(id);
}
function validMetadata(value: unknown, id: string): value is GenerationJobMetadata {
  const item = value as Partial<GenerationJobMetadata>;
  return (
    !!item &&
    item.id === id &&
    validId(id) &&
    typeof item.kind === "string" &&
    typeof item.label === "string" &&
    (item.chatId === null || typeof item.chatId === "string") &&
    ["running", "completed", "failed", "cancelled", "interrupted"].includes(item.status ?? "") &&
    typeof item.createdAt === "string" &&
    typeof item.updatedAt === "string" &&
    (item.error === null || typeof item.error === "string") &&
    (item.errorCode === undefined || typeof item.errorCode === "string") &&
    (item.errorId === undefined || typeof item.errorId === "string") &&
    (item.requestId === undefined || typeof item.requestId === "string") &&
    typeof item.resultAvailable === "boolean"
  );
}
/** A job result above this size logs warn `job.result.large`. */
const LARGE_RESULT_BYTES = 32 * 1024 * 1024;
const TERMINAL_JOB_STATES = new Set<JobState>(["completed", "failed", "cancelled", "expired"]);

/**
 * Maps a stored job kind (gallery-image, sprite-sheet, tts...) to the shared
 * JobKind vocabulary used on `job.state` lines. Unknown kinds return undefined
 * and are logged only as `jobKind`.
 */
export function mediaKindOf(kind: string): JobKind | undefined {
  if (kind === "gallery-scene-video" || kind === "sprite-animated-expressions") return "video";
  if (kind === "sprite-sheet") return "sprite";
  if (kind === "gallery-image" || kind === "gallery-selfie" || kind === "scene-background") return "image";
  if (kind.startsWith("character-")) return "image";
  if (kind === "illustrator") return "illustration";
  if (kind === "tts") return "tts";
  return undefined;
}

function memoryFields(): { memory: { heapUsedMiB: number; rssMiB: number } } {
  const { heapUsedMiB, rssMiB } = getRuntimeMemorySnapshot();
  return { memory: { heapUsedMiB, rssMiB } };
}

type JobStateExtra = EventFields & {
  timeoutMs?: number;
  resultBytes?: number;
  reason?: string;
  diagnostic?: DiagnosticReference;
};

/**
 * Writes one `job.state` line for a job. Info for accepted, running, completed,
 * cancelled and recovered; warn for failed and expired. Terminal states add a
 * small memory snapshot. elapsedMs counts from the job's createdAt.
 */
export function logJobState(metadata: GenerationJobMetadata, state: JobState, extra: JobStateExtra = {}): void {
  const createdAt = Date.parse(metadata.createdAt);
  const kind = mediaKindOf(metadata.kind);
  logEvent(
    state === "failed" || state === "expired" ? "warn" : "info",
    "job.state",
    {
      state,
      jobId: metadata.id,
      ...(kind ? { kind } : {}),
      jobKind: metadata.kind,
      ...(metadata.chatId ? { chatId: metadata.chatId } : {}),
      ...(Number.isFinite(createdAt) ? { elapsedMs: Math.max(0, Date.now() - createdAt) } : {}),
      ...(TERMINAL_JOB_STATES.has(state) ? memoryFields() : {}),
      ...extra,
    },
    `Generation job ${state}`,
  );
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export class GenerationJobsStore implements GenerationJobs {
  private root: string;
  private readonly shutdownWaitMs: number;
  private readonly jobs = new Map<
    string,
    {
      metadata: GenerationJobMetadata;
      controller: AbortController;
      timer?: ReturnType<typeof setTimeout>;
      settled: boolean;
      settledPromise: Promise<void>;
      resolveSettled: () => void;
      workSettledPromise: Promise<void>;
      resolveWorkSettled: () => void;
      workSettled: boolean;
      /** The cancel or shutdown status write, so the "settled" observer event fires after it is saved. */
      statusWrite?: Promise<void>;
    }
  >();
  private closing = false;
  private ready: Promise<void>;
  private pruning: Promise<void> | null = null;
  private pruneAgain = false;
  private lastPruneAt = 0;
  private readonly unregisterGauge: () => void;
  private observer: GenerationJobObserver | null = null;

  constructor(app?: FastifyInstance, options: GenerationJobsOptions = {}) {
    // Tests may provide a complete isolated job directory.
    this.root = resolve(options.dataDir ?? join(DATA_DIR, "generation-jobs"));
    this.shutdownWaitMs = Math.max(0, options.shutdownWaitMs ?? 3_500);
    this.unregisterGauge = registerWorkerGauge("mediaJobs", () => this.gauge());
    this.ready = this.initialize();
    if (app) app.addHook("onClose", async () => this.close());
  }

  /** Cheap sample for runtime.memory lines: how many jobs run and how old the oldest is. */
  private gauge(): Record<string, unknown> {
    let running = 0;
    let oldest = Number.POSITIVE_INFINITY;
    for (const record of this.jobs.values()) {
      if (record.metadata.status !== "running") continue;
      running++;
      const createdAt = Date.parse(record.metadata.createdAt);
      if (Number.isFinite(createdAt)) oldest = Math.min(oldest, createdAt);
    }
    return {
      running,
      tracked: this.jobs.size,
      oldestMs: running > 0 && Number.isFinite(oldest) ? Date.now() - oldest : 0,
    };
  }

  private async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const entries = await readdir(this.root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.endsWith(".result.json")) continue;
      const id = entry.name.slice(0, -5);
      if (!validId(id)) continue;
      try {
        const metadata = JSON.parse(await readFile(join(this.root, entry.name), "utf8")) as GenerationJobMetadata;
        if (!validMetadata(metadata, id)) continue;
        if (metadata.status === "running") {
          metadata.status = "interrupted";
          metadata.updatedAt = new Date().toISOString();
          metadata.error = "Generation was interrupted by server restart";
          const reference = createDiagnostic(
            new Error(metadata.error),
            {
              operation: "generation.job",
              operationId: metadata.id,
              stage: "recovery",
              jobId: metadata.id,
              chatId: metadata.chatId ?? undefined,
            },
            "ME_CANCELLED",
          );
          metadata.errorCode = reference.code;
          metadata.errorId = reference.errorId;
          if (reference.requestId) metadata.requestId = reference.requestId;
          try {
            await this.persistMetadata(metadata);
          } catch (error) {
            logger.error(
              { event: "job.state", state: "failed", stage: "recovery", jobId: metadata.id, err: error },
              "Unable to persist interrupted generation job",
            );
            continue;
          }
          logJobState(metadata, "recovered", {
            outcome: "cancelled",
            errorCode: reference.code,
            errorId: reference.errorId,
            reason: "restart",
          });
        }
      } catch (error) {
        logger.warn({ err: error, file: entry.name }, "Unable to recover generation job metadata");
      }
    }
    try {
      await this.prune();
    } catch (error) {
      logger.warn({ err: error }, "Unable to prune generation jobs");
    }
  }

  /** Throttled fire-and-forget retention pass; overlapping requests collapse into one follow-up run. */
  private schedulePrune(): void {
    if (this.closing) return;
    if (Date.now() - this.lastPruneAt < PRUNE_INTERVAL_MS) return;
    if (this.pruning) {
      this.pruneAgain = true;
      return;
    }
    this.pruning = (async () => {
      do {
        this.pruneAgain = false;
        try {
          await this.prune();
        } catch (error) {
          logger.warn({ err: error }, "Unable to prune generation jobs");
        }
      } while (this.pruneAgain && !this.closing);
    })().finally(() => {
      this.pruning = null;
    });
  }

  /**
   * Bounds disk use: drops metadata and results of old terminal jobs beyond MAX_RETAINED_JOBS, strips result
   * files beyond MAX_RETAINED_RESULTS, and removes stray temp files and orphaned results. Running jobs, jobs
   * still tracked in memory and anything updated within PRUNE_MIN_AGE_MS are never touched.
   */
  private async prune(): Promise<void> {
    this.lastPruneAt = Date.now();
    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch (error: any) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    const now = Date.now();
    const metadataIds = new Set<string>();
    const resultIds = new Set<string>();
    const all: GenerationJobMetadata[] = [];
    const strays: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name.endsWith(".tmp")) {
        strays.push(entry.name);
        continue;
      }
      if (entry.name.endsWith(".result.json")) {
        resultIds.add(entry.name.slice(0, -".result.json".length));
        continue;
      }
      if (!entry.name.endsWith(".json")) continue;
      const id = entry.name.slice(0, -5);
      if (!validId(id)) continue;
      metadataIds.add(id);
      // Live jobs are never pruned; skipping their files also avoids holding a read handle while
      // atomicWrite renames over them, which fails with EPERM on Windows.
      if (this.jobs.has(id)) continue;
      try {
        const item = JSON.parse(await readFile(join(this.root, entry.name), "utf8"));
        if (validMetadata(item, id)) all.push(item);
      } catch {
        /* unreadable metadata is left alone */
      }
    }
    const removeFile = async (name: string) => {
      try {
        await unlink(join(this.root, name));
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
      }
    };
    const isOld = async (name: string) => {
      try {
        return now - (await stat(join(this.root, name))).mtimeMs > STRAY_FILE_MIN_AGE_MS;
      } catch {
        return false;
      }
    };
    for (const name of strays) {
      if (await isOld(name)) await removeFile(name);
    }
    for (const id of resultIds) {
      if (validId(id) && !metadataIds.has(id) && !this.jobs.has(id) && (await isOld(`${id}.result.json`))) {
        await removeFile(`${id}.result.json`);
      }
    }
    all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (let index = 0; index < all.length; index++) {
      const metadata = all[index]!;
      if (index < MAX_RETAINED_RESULTS) continue;
      if (metadata.status === "running" || this.jobs.has(metadata.id)) continue;
      const updatedAt = Date.parse(metadata.updatedAt);
      if (Number.isFinite(updatedAt) && now - updatedAt < PRUNE_MIN_AGE_MS) continue;
      if (index >= MAX_RETAINED_JOBS) {
        await removeFile(`${metadata.id}.result.json`);
        await removeFile(`${metadata.id}.json`);
        // An interrupted job nobody collected is dropped here; finished jobs age out silently.
        if (metadata.status === "interrupted") logJobState(metadata, "expired", { reason: "pruned" });
      } else if (resultIds.has(metadata.id) || metadata.resultAvailable) {
        await removeFile(`${metadata.id}.result.json`);
        if (metadata.resultAvailable) {
          metadata.resultAvailable = false;
          await this.persistMetadata(metadata);
        }
      }
    }
  }

  /** Installs (or with null removes) the single lifecycle observer. */
  setObserver(observer: GenerationJobObserver | null): void {
    this.observer = observer;
  }
  /** Whether a job is still owned by this process (running, or settling after cancel/shutdown). */
  isLive(id: string): boolean {
    return this.jobs.has(id);
  }
  private notify(event: GenerationJobLifecycleEvent): void {
    try {
      this.observer?.(event);
    } catch (error) {
      logger.warn({ err: error, jobId: event.metadata.id }, "Generation job observer failed");
    }
  }

  private async persistMetadata(metadata: GenerationJobMetadata): Promise<void> {
    await this.atomicWrite(join(this.root, `${metadata.id}.json`), JSON.stringify(metadata, null, 2));
  }
  private async atomicWrite(path: string, value: string): Promise<void> {
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, value, "utf8");
      await rename(temp, path);
    } catch (error) {
      try {
        await unlink(temp);
      } catch {
        /* best effort cleanup */
      }
      throw error;
    }
  }
  private async readMetadata(id: string): Promise<GenerationJobMetadata | null> {
    if (!validId(id)) return null;
    try {
      const value = JSON.parse(await readFile(join(this.root, `${id}.json`), "utf8"));
      return validMetadata(value, id) ? value : null;
    } catch (error: any) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }
  private async update(
    record: {
      metadata: GenerationJobMetadata;
      controller: AbortController;
      timer?: ReturnType<typeof setTimeout>;
      settled: boolean;
    },
    status: GenerationJobStatus,
    error: string | null,
    resultAvailable = record.metadata.resultAvailable,
  ): Promise<void> {
    record.metadata.status = status;
    record.metadata.error = error;
    record.metadata.resultAvailable = resultAvailable;
    record.metadata.updatedAt = new Date().toISOString();
    await this.persistMetadata(record.metadata);
  }

  /** Stores the failure's correlation fields on the metadata without logging; the job.state line logs it. */
  private recordFailure(
    metadata: GenerationJobMetadata,
    error: unknown,
    stage: string,
    code?: string,
  ): DiagnosticReference {
    const reference = createDiagnostic(
      error,
      {
        operation: "generation.job",
        operationId: metadata.id,
        stage,
        jobId: metadata.id,
        chatId: metadata.chatId ?? undefined,
      },
      code,
    );
    metadata.errorCode = reference.code;
    metadata.errorId = reference.errorId;
    if (reference.requestId) metadata.requestId = reference.requestId;
    return reference;
  }

  async run<T>(options: GenerationJobRunOptions, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    await this.ready;
    if (this.closing) throw abortError("Generation job store is closing");
    const id = options.id ?? randomUUID();
    const now = new Date().toISOString();
    const metadata: GenerationJobMetadata = {
      id,
      kind: options.kind,
      label: options.label,
      chatId: options.chatId ?? null,
      status: "running",
      createdAt: now,
      updatedAt: now,
      error: null,
      resultAvailable: false,
    };
    let resolveSettled!: () => void;
    const settledPromise = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    let resolveWorkSettled!: () => void;
    let workSettledRecord: { settled: boolean; workSettled: boolean } | undefined;
    const workSettledPromise = new Promise<void>((resolve) => {
      resolveWorkSettled = () => {
        if (workSettledRecord) {
          workSettledRecord.workSettled = true;
          if (workSettledRecord.settled) this.jobs.delete(id);
        }
        resolve();
      };
    });
    const record = {
      metadata,
      controller: new AbortController(),
      settled: false,
      settledPromise,
      resolveSettled,
      workSettledPromise,
      resolveWorkSettled,
      workSettled: false,
    } as {
      metadata: GenerationJobMetadata;
      controller: AbortController;
      timer?: ReturnType<typeof setTimeout>;
      settled: boolean;
      settledPromise: Promise<void>;
      resolveSettled: () => void;
      workSettledPromise: Promise<void>;
      resolveWorkSettled: () => void;
      workSettled: boolean;
      statusWrite?: Promise<void>;
    };
    workSettledRecord = record;
    this.jobs.set(id, record);
    const startedAt = Date.now();
    const timeout = Math.max(1, options.timeoutMs);
    const requestId = getDiagnosticContext().requestId;
    logJobState(metadata, "accepted", { timeoutMs: timeout, ...(requestId ? { requestId } : {}) });
    try {
      await this.persistMetadata(metadata);
    } catch (error) {
      const reference = this.recordFailure(metadata, error, "persist-start", "ME_STORAGE");
      // Persistence failures are the one job failure logged at error.
      reportDiagnosticError(
        error,
        { operation: "generation.job", stage: "persist-start", jobId: id, chatId: metadata.chatId ?? undefined },
        "ME_STORAGE",
        {
          event: "job.state",
          level: "error",
          message: "Unable to persist generation job start",
          fields: { state: "failed", outcome: "failed", jobKind: options.kind, errorId: reference.errorId },
        },
      );
      this.jobs.delete(id);
      throw error;
    }
    if (this.closing) {
      await this.update(record, "interrupted", "Generation was interrupted by server shutdown", false);
      this.jobs.delete(id);
      logJobState(metadata, "cancelled", { outcome: "cancelled", reason: "shutdown", timeoutMs: timeout });
      throw abortError("Generation job store is closing");
    }
    if (record.controller.signal.aborted || record.metadata.status !== "running") {
      await this.persistMetadata(record.metadata);
      this.jobs.delete(id);
      throw abortError(record.metadata.error ?? "Generation job cancelled");
    }
    this.notify({ type: "accepted", metadata });
    logJobState(metadata, "running", { timeoutMs: timeout });
    let timeoutTriggered = false;
    const abortPromise = new Promise<never>((_, reject) => {
      record.controller.signal.addEventListener(
        "abort",
        () =>
          reject(
            abortError(
              record.metadata.error ?? (timeoutTriggered ? "Generation job timed out" : "Generation job cancelled"),
            ),
          ),
        { once: true },
      );
    });
    abortPromise.catch(() => undefined);
    record.timer = setTimeout(() => {
      timeoutTriggered = true;
      record.controller.abort();
    }, timeout);
    // A root context: the job outlives the request that scheduled it, so it must not carry its requestId or stage.
    const workPromise = Promise.resolve().then(() =>
      runWithRootDiagnosticContext(
        {
          // Kept as "generation.job" (not `job.${kind}`): diagnostic-generation.regression.ts pins it.
          // The kind is on every job.state line as kind and jobKind.
          operation: "generation.job",
          operationId: id,
          stage: "work",
          jobId: id,
          chatId: metadata.chatId ?? undefined,
        },
        () => work(record.controller.signal),
      ),
    );
    workPromise.catch(() => undefined);
    workPromise.then(record.resolveWorkSettled, record.resolveWorkSettled);
    this.notify({ type: "running", metadata });
    let completedValue: unknown;
    const promise = (async () => {
      try {
        const value = await Promise.race([workPromise, abortPromise]);
        if (record.metadata.status !== "running" || record.controller.signal.aborted)
          throw abortError(record.metadata.error ?? "Generation job cancelled");
        const serialized = value === undefined ? "null" : JSON.stringify(value);
        if (serialized === undefined) throw new Error("Generation result is not JSON serializable");
        const resultBytes = Buffer.byteLength(serialized);
        if (resultBytes > LARGE_RESULT_BYTES) {
          logEvent("warn", "job.result.large", {
            jobId: id,
            jobKind: options.kind,
            resultBytes,
            limitBytes: LARGE_RESULT_BYTES,
            ...memoryFields(),
          });
        }
        await this.atomicWrite(join(this.root, `${id}.result.json`), serialized);
        if (record.metadata.status !== "running" || record.controller.signal.aborted)
          throw abortError(record.metadata.error ?? "Generation job cancelled");
        await this.update(record, "completed", null, true);
        completedValue = value;
        logJobState(metadata, "completed", { outcome: "ok", timeoutMs: timeout, resultBytes });
        return value;
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        if (record.metadata.status === "running") {
          const cancelled = !timeoutTriggered && record.controller.signal.aborted;
          const reference = this.recordFailure(
            record.metadata,
            failure,
            timeoutTriggered ? "timeout" : cancelled ? "cancelled" : "failed",
            timeoutTriggered ? "ME_TIMEOUT" : cancelled ? "ME_CANCELLED" : undefined,
          );
          await this.update(record, cancelled ? "cancelled" : "failed", failure.message, false);
          // The one line for this failure: it carries err, so outer layers only log a pointer.
          logJobState(metadata, cancelled ? "cancelled" : "failed", {
            outcome: cancelled ? "cancelled" : "failed",
            errorCode: timeoutTriggered ? "ME_TIMEOUT" : reference.code,
            errorId: reference.errorId,
            diagnostic: reference,
            timeoutMs: timeout,
            ...(cancelled ? {} : { err: failure }),
          });
          markDiagnosticReported(failure);
        }
        throw failure;
      } finally {
        record.settled = true;
        if (record.timer) clearTimeout(record.timer);
        if (record.workSettled) this.jobs.delete(id);
        record.resolveSettled();
        const elapsedMs = Date.now() - startedAt;
        const notifySettled = () =>
          this.notify({ type: "settled", metadata: record.metadata, elapsedMs, result: completedValue });
        // A cancel or shutdown aborts first and saves its status after; announce the outcome once it is saved.
        if (record.statusWrite) void record.statusWrite.then(notifySettled, notifySettled);
        else notifySettled();
        this.schedulePrune();
      }
    })();
    return promise;
  }

  async list(chatId?: string): Promise<GenerationJobMetadata[]> {
    await this.ready;
    const entries = await readdir(this.root, { withFileTypes: true });
    const all: GenerationJobMetadata[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.endsWith(".result.json")) continue;
      const id = entry.name.slice(0, -5);
      if (!validId(id)) continue;
      try {
        const item = JSON.parse(await readFile(join(this.root, entry.name), "utf8"));
        if (validMetadata(item, id) && (!chatId || item.chatId === chatId)) all.push(item);
      } catch (error) {
        logger.warn({ err: error, file: entry.name }, "Unable to read generation job metadata");
      }
    }
    return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50);
  }
  async get(id: string): Promise<GenerationJobMetadata | null> {
    await this.ready;
    return this.readMetadata(id);
  }
  async result(id: string): Promise<unknown> {
    await this.ready;
    if (!validId(id)) throw new Error("Invalid generation job id");
    const metadata = await this.get(id);
    if (!metadata || metadata.status !== "completed" || !metadata.resultAvailable) {
      const error = new Error("Generation result not available");
      (error as any).code = "ENOENT";
      throw error;
    }
    return JSON.parse(await readFile(join(this.root, `${id}.result.json`), "utf8"));
  }
  async cancel(id: string): Promise<boolean> {
    await this.ready;
    const record = this.jobs.get(id);
    if (!record || record.metadata.status !== "running") return false;
    record.metadata.status = "cancelled";
    record.metadata.error = "Generation job cancelled";
    const reference = this.recordFailure(
      record.metadata,
      abortError(record.metadata.error),
      "cancelled",
      "ME_CANCELLED",
    );
    const statusWrite = this.update(record, "cancelled", "Generation job cancelled", false);
    record.statusWrite = statusWrite;
    record.controller.abort();
    await statusWrite;
    logJobState(record.metadata, "cancelled", {
      outcome: "cancelled",
      errorCode: reference.code,
      errorId: reference.errorId,
      reason: "user",
    });
    return true;
  }
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.unregisterGauge();
    await this.ready;
    if (this.pruning) await this.pruning;
    const records = [...this.jobs.values()];
    for (const record of records) {
      if (record.metadata.status === "running") {
        record.controller.abort();
        try {
          const reference = this.recordFailure(
            record.metadata,
            abortError("Generation was interrupted by server shutdown"),
            "interrupted",
            "ME_CANCELLED",
          );
          record.statusWrite = this.update(
            record,
            "interrupted",
            "Generation was interrupted by server shutdown",
            false,
          );
          await record.statusWrite;
          logJobState(record.metadata, "cancelled", {
            outcome: "cancelled",
            errorCode: reference.code,
            errorId: reference.errorId,
            reason: "shutdown",
          });
        } catch (error) {
          logger.error({ err: error, id: record.metadata.id }, "Unable to persist interrupted generation job");
        }
      }
    }
    if (records.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(records.flatMap((record) => [record.settledPromise, record.workSettledPromise])),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.shutdownWaitMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    const unsettled = records.filter((record) => !record.settled || !record.workSettled);
    if (unsettled.length > 0) {
      logger.warn(
        { count: unsettled.length, waitMs: this.shutdownWaitMs },
        "Generation jobs did not settle before shutdown wait expired",
      );
    }
  }
  get dataDir(): string {
    return this.root;
  }
}

export function getGenerationJobs(app: FastifyInstance, options: GenerationJobsOptions = {}): GenerationJobsStore {
  const key = app.server as object;
  let store = stores.get(key);
  if (!store) {
    store = new GenerationJobsStore(app, options);
    stores.set(key, store);
  }
  return store;
}

export function createGenerationJobs(options: GenerationJobsOptions | string = {}): GenerationJobsStore {
  return new GenerationJobsStore(undefined, typeof options === "string" ? { dataDir: options } : options);
}
