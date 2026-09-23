import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { DATA_DIR } from "../../utils/data-dir.js";
import { logger } from "../../lib/logger.js";
import { reportDiagnosticError } from "../../lib/diagnostic-operation.js";
import { getDiagnosticContext, withDiagnosticContext } from "../../lib/diagnostics.js";

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
    }
  >();
  private closing = false;
  private ready: Promise<void>;
  private pruning: Promise<void> | null = null;
  private pruneAgain = false;
  private lastPruneAt = 0;

  constructor(app?: FastifyInstance, options: GenerationJobsOptions = {}) {
    // Tests may provide a complete isolated job directory.
    this.root = resolve(options.dataDir ?? join(DATA_DIR, "generation-jobs"));
    this.shutdownWaitMs = Math.max(0, options.shutdownWaitMs ?? 3_500);
    this.ready = this.initialize();
    if (app) app.addHook("onClose", async () => this.close());
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
          const reference = reportDiagnosticError(
            new Error(metadata.error),
            {
              ...getDiagnosticContext(),
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
          await this.persistMetadata(metadata);
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
      } else if (resultIds.has(metadata.id) || metadata.resultAvailable) {
        await removeFile(`${metadata.id}.result.json`);
        if (metadata.resultAvailable) {
          metadata.resultAvailable = false;
          await this.persistMetadata(metadata);
        }
      }
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

  private recordFailure(metadata: GenerationJobMetadata, error: unknown, stage: string, code?: string): void {
    const reference = reportDiagnosticError(
      error,
      {
        ...getDiagnosticContext(),
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
    };
    workSettledRecord = record;
    this.jobs.set(id, record);
    const startedAt = Date.now();
    logger.info(
      {
        operation: "generation.job",
        operationId: id,
        stage: "start",
        jobId: id,
        kind: options.kind,
        chatId: metadata.chatId,
      },
      "Generation job started",
    );
    try {
      await this.persistMetadata(metadata);
    } catch (error) {
      this.recordFailure(metadata, error, "persist-start", "ME_STORAGE");
      this.jobs.delete(id);
      throw error;
    }
    if (this.closing) {
      await this.update(record, "interrupted", "Generation was interrupted by server shutdown", false);
      this.jobs.delete(id);
      throw abortError("Generation job store is closing");
    }
    if (record.controller.signal.aborted || record.metadata.status !== "running") {
      await this.persistMetadata(record.metadata);
      this.jobs.delete(id);
      throw abortError(record.metadata.error ?? "Generation job cancelled");
    }
    const timeout = Math.max(1, options.timeoutMs);
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
    const workPromise = Promise.resolve().then(() =>
      withDiagnosticContext(
        {
          ...getDiagnosticContext(),
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
    const promise = (async () => {
      try {
        const value = await Promise.race([workPromise, abortPromise]);
        if (record.metadata.status !== "running" || record.controller.signal.aborted)
          throw abortError(record.metadata.error ?? "Generation job cancelled");
        const serialized = value === undefined ? "null" : JSON.stringify(value);
        if (serialized === undefined) throw new Error("Generation result is not JSON serializable");
        await this.atomicWrite(join(this.root, `${id}.result.json`), serialized);
        if (record.metadata.status !== "running" || record.controller.signal.aborted)
          throw abortError(record.metadata.error ?? "Generation job cancelled");
        await this.update(record, "completed", null, true);
        logger.info(
          {
            operation: "generation.job",
            operationId: id,
            stage: "success",
            jobId: id,
            kind: options.kind,
            chatId: metadata.chatId,
            elapsedMs: Date.now() - startedAt,
          },
          "Generation job completed",
        );
        return value;
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        if (record.metadata.status === "running") {
          this.recordFailure(
            record.metadata,
            failure,
            timeoutTriggered ? "timeout" : record.controller.signal.aborted ? "cancelled" : "failed",
            timeoutTriggered ? "ME_TIMEOUT" : record.controller.signal.aborted ? "ME_CANCELLED" : undefined,
          );
          await this.update(
            record,
            timeoutTriggered ? "failed" : record.controller.signal.aborted ? "cancelled" : "failed",
            failure.message,
            false,
          );
          logger.warn(
            {
              operation: "generation.job",
              operationId: id,
              stage: timeoutTriggered ? "timeout" : record.controller.signal.aborted ? "cancelled" : "failure",
              jobId: id,
              kind: options.kind,
              chatId: metadata.chatId,
              elapsedMs: Date.now() - startedAt,
            },
            "Generation job failed",
          );
        }
        throw failure;
      } finally {
        record.settled = true;
        if (record.timer) clearTimeout(record.timer);
        if (record.workSettled) this.jobs.delete(id);
        record.resolveSettled();
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
    this.recordFailure(record.metadata, abortError(record.metadata.error), "cancelled", "ME_CANCELLED");
    record.controller.abort();
    await this.update(record, "cancelled", "Generation job cancelled", false);
    return true;
  }
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    await this.ready;
    if (this.pruning) await this.pruning;
    const records = [...this.jobs.values()];
    for (const record of records) {
      if (record.metadata.status === "running") {
        record.controller.abort();
        try {
          this.recordFailure(
            record.metadata,
            abortError("Generation was interrupted by server shutdown"),
            "interrupted",
            "ME_CANCELLED",
          );
          await this.update(record, "interrupted", "Generation was interrupted by server shutdown", false);
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
