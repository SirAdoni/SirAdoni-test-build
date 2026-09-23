// ──────────────────────────────────────────────
// Generation job tracking (opt-in, "Track generation jobs" setting)
//
// The generation-jobs store (generation-jobs.ts) already runs media jobs
// detached from the HTTP response and keeps their result JSON on disk. This
// module layers an opt-in index on top of it:
//
//   store.run()  ──observer──▶  GenerationJobTracker  ──▶  generation_job_records
//                                     │
//                                     └──▶  structured "job.state" / "job.progress" logs
//
// With the setting off the observer returns before doing anything, so the
// store, its routes and the client behave exactly as before and nothing new is
// written. Every log line and every trail entry is built by buildJobLogEvent
// from a fixed allow-list of ids, codes and timings: prompts, message text,
// provider error messages, API keys and connection details never reach them.
//
// See docs/development/generation-jobs.md for states, recovery and retention.
// ──────────────────────────────────────────────
import type { FastifyInstance } from "fastify";
import type { DB } from "../../db/connection.js";
import { logger } from "../../lib/logger.js";
import { createAppSettingsStorage } from "../storage/app-settings.storage.js";
import {
  createGenerationJobRecordsStorage,
  type GenerationJobRecordRow,
} from "../storage/generation-job-records.storage.js";
import { getGenerationJobs, type GenerationJobLifecycleEvent, type GenerationJobsStore } from "./generation-jobs.js";

export const GENERATION_JOB_TRACKING_SETTINGS_KEY = "generationJobTracking";

export type GenerationJobMediaKind = "image" | "sprite" | "video";

/**
 * The media jobs that already run through the generation-jobs store, by the store's kind string. Text jobs
 * (game party turns, NPC backfill, sheet regeneration) stay untracked; see the docs page for what is not
 * covered (TTS, Illustrator agent images, Game asset generation).
 */
export const GENERATION_JOB_MEDIA_KINDS: Readonly<Record<string, GenerationJobMediaKind>> = {
  "scene-background": "image",
  "character-avatar-draft": "image",
  "character-sheet-draft": "image",
  "gallery-image": "image",
  "gallery-selfie": "image",
  "gallery-scene-video": "video",
  "sprite-sheet": "sprite",
  "sprite-animated-expressions": "sprite",
};

export function mediaKindFor(sourceKind: string): GenerationJobMediaKind | null {
  return Object.hasOwn(GENERATION_JOB_MEDIA_KINDS, sourceKind) ? GENERATION_JOB_MEDIA_KINDS[sourceKind]! : null;
}

export type TrackedJobStatus = "accepted" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
export type JobLogState =
  | "accepted"
  | "running"
  | "progress"
  | "completed"
  | "failed"
  | "cancelled"
  | "recovered"
  | "expired";
export type JobOutcome = "ok" | "failed" | "cancelled" | "skipped";
export type JobLogStage =
  | "accept"
  | "work"
  | "heartbeat"
  | "settle"
  | "server-restart"
  | "client-reattach"
  | "retention";

/** One structured lifecycle event: the exact object logged and stored in the record's trail. */
export interface GenerationJobLogEvent {
  event: "job.state" | "job.progress";
  state: JobLogState;
  at: string;
  operation: "generation.job";
  operationId: string;
  jobId: string;
  chatId: string | null;
  kind: GenerationJobMediaKind;
  sourceKind: string;
  stage: JobLogStage;
  elapsedMs?: number;
  errorCode?: string;
  errorId?: string;
  outcome?: JobOutcome;
}

export const TRACKING_LIMITS = {
  /** Finished records older than this are removed. */
  retentionMs: 7 * 24 * 60 * 60 * 1000,
  /** At most this many finished records are kept, newest first. */
  maxRecords: 300,
  /** Trail entries per record; the first entry (accepted) is always kept. */
  maxTrail: 40,
  /** Heartbeat "job.progress" cadence while a job runs. */
  progressIntervalMs: 30_000,
  /** Retention pass cadence (also runs at startup and when the setting turns on). */
  sweepIntervalMs: 60 * 60 * 1000,
} as const;

const TERMINAL: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "interrupted"]);
const ERROR_CODE_RE = /^ME_[A-Z0-9_]{1,40}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_PATH_RE = /^\/(?:api|uploads|assets)\/[A-Za-z0-9._~%/-]{1,400}$/;

export function isTerminalStatus(status: string): boolean {
  return TERMINAL.has(status);
}

/**
 * Builds a log event from an allow-list. Anything not in the signature is dropped; an error code that does
 * not look like a stable ME_* code is replaced so a provider message can never ride along in it.
 */
export function buildJobLogEvent(input: {
  state: JobLogState;
  jobId: string;
  chatId: string | null;
  kind: GenerationJobMediaKind;
  sourceKind: string;
  stage: JobLogStage;
  at: string;
  elapsedMs?: number;
  errorCode?: string | null;
  errorId?: string | null;
  outcome?: JobOutcome;
}): GenerationJobLogEvent {
  const event: GenerationJobLogEvent = {
    event: input.state === "progress" ? "job.progress" : "job.state",
    state: input.state,
    at: input.at,
    operation: "generation.job",
    operationId: input.jobId,
    jobId: input.jobId,
    chatId: input.chatId,
    kind: input.kind,
    sourceKind: mediaKindFor(input.sourceKind) ? input.sourceKind : "unknown",
    stage: input.stage,
  };
  if (typeof input.elapsedMs === "number" && Number.isFinite(input.elapsedMs))
    event.elapsedMs = Math.max(0, Math.round(input.elapsedMs));
  if (input.errorCode) event.errorCode = ERROR_CODE_RE.test(input.errorCode) ? input.errorCode : "ME_INTERNAL";
  if (input.errorId && UUID_RE.test(input.errorId)) event.errorId = input.errorId;
  if (input.outcome) event.outcome = input.outcome;
  return event;
}

/** Appends to a trail, coalescing consecutive progress ticks and capping the length (first entry kept). */
export function appendTrail(
  trail: readonly GenerationJobLogEvent[],
  event: GenerationJobLogEvent,
  max: number = TRACKING_LIMITS.maxTrail,
): GenerationJobLogEvent[] {
  const next = [...trail];
  if (event.state === "progress" && next.at(-1)?.state === "progress") next[next.length - 1] = event;
  else next.push(event);
  if (next.length > max) next.splice(1, next.length - max);
  return next;
}

export function parseTrail(value: string | null | undefined): GenerationJobLogEvent[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as GenerationJobLogEvent[]) : [];
  } catch {
    return [];
  }
}

/**
 * A reference to the finished output: the first same-origin asset path in the result (a saved gallery image,
 * sprite or video), otherwise the store's own result route. Data URLs and remote URLs are never stored.
 */
export function findResultRef(jobId: string, value: unknown): string {
  let found: string | null = null;
  const visit = (node: unknown, depth: number) => {
    if (found || depth > 6 || node === null || node === undefined) return;
    if (typeof node === "string") {
      if (SAFE_PATH_RE.test(node) && !node.includes("..")) found = node;
      return;
    }
    if (typeof node !== "object") return;
    const values = Array.isArray(node)
      ? node.slice(0, 50)
      : Object.values(node as Record<string, unknown>).slice(0, 50);
    for (const child of values) visit(child, depth + 1);
  };
  visit(value, 0);
  return found ?? `/api/generation-jobs/${jobId}/result`;
}

/**
 * Retention: finished records older than retentionMs go, then the oldest finished records beyond maxRecords.
 * Records that are not finished are never selected; stale "running" rows are reconciled first, not expired.
 */
export function selectExpiredRecords(
  rows: readonly Pick<GenerationJobRecordRow, "id" | "status" | "createdAt" | "updatedAt">[],
  nowMs: number,
  limits: { retentionMs: number; maxRecords: number } = TRACKING_LIMITS,
): string[] {
  const finished = rows
    .filter((row) => isTerminalStatus(row.status))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const expired: string[] = [];
  finished.forEach((row, index) => {
    const updated = Date.parse(row.updatedAt);
    const tooOld = Number.isFinite(updated) && nowMs - updated > limits.retentionMs;
    if (tooOld || index >= limits.maxRecords) expired.push(row.id);
  });
  return expired;
}

function logStateFor(status: TrackedJobStatus): { state: JobLogState; outcome?: JobOutcome } {
  if (status === "completed") return { state: "completed", outcome: "ok" };
  if (status === "cancelled") return { state: "cancelled", outcome: "cancelled" };
  if (status === "failed" || status === "interrupted") return { state: "failed", outcome: "failed" };
  return { state: status };
}

function outcomeFor(status: string): JobOutcome {
  return status === "completed" ? "ok" : status === "cancelled" ? "cancelled" : "failed";
}

export interface GenerationJobRecord {
  id: string;
  kind: GenerationJobMediaKind;
  sourceKind: string;
  label: string;
  chatId: string | null;
  status: TrackedJobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  elapsedMs: number | null;
  errorCode: string | null;
  errorId: string | null;
  resultRef: string | null;
  seenAt: string | null;
  /** True while this server process still owns the job, so the existing cancel route can stop it. */
  cancellable: boolean;
  trail?: GenerationJobLogEvent[];
}

export interface GenerationJobTrackerOptions {
  now?: () => number;
  retentionMs?: number;
  maxRecords?: number;
  progressIntervalMs?: number;
  sweepIntervalMs?: number;
}

type LiveJob = {
  row: GenerationJobRecordRow;
  trail: GenerationJobLogEvent[];
  startedMs: number;
  heartbeat?: ReturnType<typeof setInterval>;
};

export class GenerationJobTracker {
  private enabled = false;
  private closed = false;
  private readonly live = new Map<string, LiveJob>();
  private queue: Promise<void> = Promise.resolve();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private readonly settings;
  private readonly records;
  private readonly now: () => number;
  private readonly limits: Required<Omit<GenerationJobTrackerOptions, "now">>;

  constructor(
    db: DB,
    private readonly store: GenerationJobsStore,
    options: GenerationJobTrackerOptions = {},
  ) {
    this.settings = createAppSettingsStorage(db);
    this.records = createGenerationJobRecordsStorage(db);
    this.now = options.now ?? Date.now;
    this.limits = {
      retentionMs: options.retentionMs ?? TRACKING_LIMITS.retentionMs,
      maxRecords: options.maxRecords ?? TRACKING_LIMITS.maxRecords,
      progressIntervalMs: options.progressIntervalMs ?? TRACKING_LIMITS.progressIntervalMs,
      sweepIntervalMs: options.sweepIntervalMs ?? TRACKING_LIMITS.sweepIntervalMs,
    };
  }

  /** Reads the setting (a read only), hooks the store, and reconciles and prunes when tracking is on. */
  async init(): Promise<void> {
    try {
      this.enabled = (await this.settings.get(GENERATION_JOB_TRACKING_SETTINGS_KEY)) === "true";
    } catch (error) {
      logger.warn({ err: error }, "Unable to read the generation job tracking setting");
      this.enabled = false;
    }
    this.store.setObserver((event) => this.observe(event));
    if (this.enabled) {
      await this.reconcile();
      await this.sweep();
    }
    this.syncSweepTimer();
  }

  /** The retention timer exists only while tracking is on, so the "off" state has no timers at all. */
  private syncSweepTimer(): void {
    if (this.enabled && !this.closed && !this.sweepTimer) {
      // Unref'd so an idle retention timer never keeps the process alive; sweep() never throws.
      this.sweepTimer = setInterval(() => void this.sweep(), this.limits.sweepIntervalMs);
      this.sweepTimer.unref?.();
    } else if ((!this.enabled || this.closed) && this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.settings.set(GENERATION_JOB_TRACKING_SETTINGS_KEY, enabled ? "true" : "false");
    const wasEnabled = this.enabled;
    this.enabled = enabled;
    this.syncSweepTimer();
    if (enabled && !wasEnabled) {
      await this.reconcile();
      await this.sweep();
    }
  }

  private iso(ms = this.now()): string {
    return new Date(ms).toISOString();
  }

  /**
   * Adds the event to the job's trail and, unless the job store already wrote this transition's
   * `job.state` line (accepted, running, settled), logs it. One line per
   * transition: the store's line is the canonical one, the trail keeps the tracker's copy.
   */
  private emit(
    job: LiveJob | null,
    row: GenerationJobRecordRow,
    event: GenerationJobLogEvent,
    { log = true }: { log?: boolean } = {},
  ): GenerationJobLogEvent[] {
    if (log) {
      const level = event.state === "failed" ? "warn" : "info";
      logger[level](
        { ...event },
        event.event === "job.progress" ? "Generation job progress" : "Generation job %s",
        event.state,
      );
    }
    const trail = appendTrail(job ? job.trail : parseTrail(row.trail), event);
    if (job) job.trail = trail;
    return trail;
  }

  private event(
    row: GenerationJobRecordRow,
    state: JobLogState,
    stage: JobLogStage,
    extra: Partial<GenerationJobLogEvent> = {},
  ) {
    return buildJobLogEvent({
      state,
      stage,
      jobId: row.id,
      chatId: row.chatId ?? null,
      kind: row.kind as GenerationJobMediaKind,
      sourceKind: row.sourceKind,
      at: this.iso(),
      elapsedMs: extra.elapsedMs,
      errorCode: extra.errorCode,
      errorId: extra.errorId,
      outcome: extra.outcome,
    });
  }

  /** Serialized, failure-safe write: a storage error is logged and never reaches the generation. */
  private write(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(task).catch((error) => {
      logger.warn({ err: error }, "Unable to save a generation job record");
    });
    return this.queue;
  }

  /**
   * Only the first write inserts. Later writes update in place, so a record removed while its job still runs
   * (its chat was deleted, or the admin cleared chats) is not brought back by a heartbeat or the final state.
   */
  private persist(job: LiveJob, insert = false): void {
    const row = { ...job.row, trail: JSON.stringify(job.trail) };
    job.row = row;
    void this.write(() => {
      if (insert) return this.records.upsert(row);
      const { id, ...patch } = row;
      return this.records.update(id, patch);
    });
  }

  /** Store observer. Synchronous and cheap; returns immediately while tracking is off. */
  observe(event: GenerationJobLifecycleEvent): void {
    const { metadata } = event;
    if (event.type === "accepted") {
      if (!this.enabled || this.closed) return;
      const kind = mediaKindFor(metadata.kind);
      if (!kind) return;
      const at = this.iso();
      const job: LiveJob = {
        row: {
          id: metadata.id,
          kind,
          sourceKind: metadata.kind,
          label: metadata.label,
          chatId: metadata.chatId,
          status: "accepted",
          createdAt: metadata.createdAt,
          updatedAt: at,
          startedAt: null,
          finishedAt: null,
          elapsedMs: null,
          errorCode: null,
          errorId: null,
          resultRef: null,
          seenAt: null,
          trail: "[]",
        },
        trail: [],
        startedMs: this.now(),
      };
      this.live.set(metadata.id, job);
      this.emit(job, job.row, this.event(job.row, "accepted", "accept"), { log: false });
      this.persist(job, true);
      return;
    }
    const job = this.live.get(metadata.id);
    if (!job) return;
    if (event.type === "running") {
      const at = this.iso();
      job.row = { ...job.row, status: "running", startedAt: at, updatedAt: at };
      this.emit(job, job.row, this.event(job.row, "running", "work"), { log: false });
      this.persist(job);
      job.heartbeat = setInterval(() => this.heartbeat(metadata.id), this.limits.progressIntervalMs);
      job.heartbeat.unref?.();
      return;
    }
    if (event.type !== "settled") return;
    if (job.heartbeat) clearInterval(job.heartbeat);
    this.live.delete(metadata.id);
    const status = (isTerminalStatus(metadata.status) ? metadata.status : "failed") as TrackedJobStatus;
    const errorCode =
      status === "interrupted"
        ? "ME_INTERRUPTED"
        : status === "completed"
          ? null
          : (metadata.errorCode ?? "ME_INTERNAL");
    const at = this.iso();
    job.row = {
      ...job.row,
      status,
      updatedAt: at,
      finishedAt: at,
      elapsedMs: Math.max(0, Math.round(event.elapsedMs)),
      errorCode,
      errorId: status === "completed" ? null : (metadata.errorId ?? null),
      resultRef: status === "completed" ? findResultRef(metadata.id, event.result) : null,
    };
    const { state, outcome } = logStateFor(status);
    this.emit(
      job,
      job.row,
      this.event(job.row, state, "settle", {
        elapsedMs: job.row.elapsedMs ?? undefined,
        errorCode: errorCode ?? undefined,
        errorId: job.row.errorId ?? undefined,
        outcome,
      }),
      { log: false },
    );
    this.persist(job);
  }

  private heartbeat(id: string): void {
    const job = this.live.get(id);
    if (!job || this.closed) return;
    const elapsedMs = this.now() - job.startedMs;
    job.row = { ...job.row, updatedAt: this.iso() };
    this.emit(job, job.row, this.event(job.row, "progress", "heartbeat", { elapsedMs }));
    this.persist(job);
  }

  /**
   * After a restart (or when tracking turns back on) any record still "accepted" or "running" that this process
   * does not own lost its worker. Nothing is re-run: the provider call is not idempotent and its inputs are not
   * kept. The store's own metadata decides the outcome; if it never finished, the record becomes "interrupted".
   */
  async reconcile(): Promise<number> {
    let reconciled = 0;
    try {
      const rows = await this.records.list();
      for (const row of rows) {
        if (isTerminalStatus(row.status) || this.live.has(row.id) || this.store.isLive(row.id)) continue;
        const metadata = await this.store.get(row.id).catch(() => null);
        const storeStatus = metadata?.status;
        const status: TrackedJobStatus =
          storeStatus === "completed" || storeStatus === "failed" || storeStatus === "cancelled"
            ? storeStatus
            : "interrupted";
        const at = this.iso();
        const next: GenerationJobRecordRow = {
          ...row,
          status,
          updatedAt: at,
          finishedAt: row.finishedAt ?? at,
          errorCode:
            status === "completed"
              ? null
              : status === "interrupted"
                ? "ME_INTERRUPTED"
                : (metadata?.errorCode ?? "ME_INTERNAL"),
          errorId: status === "completed" ? null : (metadata?.errorId ?? null),
          resultRef:
            status === "completed" && metadata?.resultAvailable ? `/api/generation-jobs/${row.id}/result` : null,
        };
        const trail = this.emit(
          null,
          row,
          this.event(next, "recovered", "server-restart", {
            errorCode: next.errorCode ?? undefined,
            outcome: outcomeFor(status),
          }),
        );
        await this.records.upsert({ ...next, trail: JSON.stringify(trail) });
        reconciled++;
      }
    } catch (error) {
      logger.warn({ err: error }, "Unable to reconcile generation job records");
    }
    return reconciled;
  }

  /** Retention pass. Never throws; does nothing while tracking is off. */
  async sweep(): Promise<number> {
    if (!this.enabled || this.closed) return 0;
    try {
      const rows = (await this.records.list()).filter((row) => !this.live.has(row.id));
      const expired = new Set(selectExpiredRecords(rows, this.now(), this.limits));
      if (expired.size === 0) return 0;
      for (const row of rows) {
        if (!expired.has(row.id)) continue;
        this.emit(null, row, this.event(row, "expired", "retention", { outcome: "skipped" }));
      }
      await this.records.remove([...expired]);
      return expired.size;
    } catch (error) {
      logger.warn({ err: error }, "Unable to prune generation job records");
      return 0;
    }
  }

  private toRecord(row: GenerationJobRecordRow, includeTrail: boolean): GenerationJobRecord {
    const live = this.live.get(row.id);
    const source = live?.row ?? row;
    const record: GenerationJobRecord = {
      id: source.id,
      kind: source.kind as GenerationJobMediaKind,
      sourceKind: source.sourceKind,
      label: source.label,
      chatId: source.chatId ?? null,
      status: source.status as TrackedJobStatus,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
      startedAt: source.startedAt ?? null,
      finishedAt: source.finishedAt ?? null,
      elapsedMs: live ? this.now() - live.startedMs : (source.elapsedMs ?? null),
      errorCode: source.errorCode ?? null,
      errorId: source.errorId ?? null,
      resultRef: source.resultRef ?? null,
      seenAt: source.seenAt ?? null,
      cancellable: !isTerminalStatus(source.status) && this.store.isLive(source.id),
    };
    if (includeTrail) record.trail = live ? live.trail : parseTrail(row.trail);
    return record;
  }

  async list(options: { chatId?: string; limit?: number } = {}): Promise<GenerationJobRecord[]> {
    await this.queue;
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 200);
    return (await this.records.list())
      .filter((row) => !options.chatId || row.chatId === options.chatId)
      .slice(0, limit)
      .map((row) => this.toRecord(row, false));
  }

  async get(id: string): Promise<GenerationJobRecord | null> {
    await this.queue;
    const row = await this.records.get(id);
    return row ? this.toRecord(row, true) : null;
  }

  /**
   * Stamps finished jobs a client has accounted for so they are not announced twice. With recovered=true the
   * client re-attached after a reload or reconnect and surfaced them to the user: that is logged as
   * "recovered" (stage client-reattach). With recovered=false the user watched them finish; nothing is logged.
   */
  async markSeen(ids: readonly string[], recovered = true): Promise<number> {
    await this.queue;
    let updated = 0;
    for (const id of new Set(ids)) {
      const row = await this.records.get(id);
      if (!row || row.seenAt || !isTerminalStatus(row.status)) continue;
      const trail = recovered
        ? this.emit(
            null,
            row,
            this.event(row, "recovered", "client-reattach", {
              errorCode: row.errorCode ?? undefined,
              outcome: outcomeFor(row.status),
            }),
          )
        : parseTrail(row.trail);
      await this.records.update(id, { seenAt: this.iso(), trail: JSON.stringify(trail) });
      updated++;
    }
    return updated;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.syncSweepTimer();
    for (const job of this.live.values()) if (job.heartbeat) clearInterval(job.heartbeat);
    await this.queue;
  }
}

const trackers = new WeakMap<object, Promise<GenerationJobTracker>>();

/** One tracker per server, bound to that server's generation-jobs store. */
export function getGenerationJobTracker(
  app: FastifyInstance,
  options: GenerationJobTrackerOptions = {},
): Promise<GenerationJobTracker> {
  const key = app.server as object;
  let tracker = trackers.get(key);
  if (!tracker) {
    tracker = (async () => {
      const instance = new GenerationJobTracker(app.db, getGenerationJobs(app), options);
      await instance.init();
      app.addHook("onClose", async () => instance.close());
      return instance;
    })();
    trackers.set(key, tracker);
  }
  return tracker;
}
