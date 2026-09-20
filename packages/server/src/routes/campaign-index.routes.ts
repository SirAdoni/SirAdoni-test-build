import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createChatsStorage } from "../services/storage/chats.storage.js";
import { createCampaignMemoryStorage } from "../services/storage/campaign-memory.storage.js";
import { readContinuityConfig } from "../services/game/continuity-provider.js";
import {
  applyCampaignMemoryLegacyImport,
  collectCampaignMemoryLegacySource,
  planCampaignMemoryLegacyImport,
} from "../services/game/campaign-memory-import.js";
import { createGameContinuityStorage } from "../services/storage/game-continuity.storage.js";
import {
  backfillRecords,
  readContinuityInventory,
  startHistoricalBackfill,
} from "./game-continuity-backfill.routes.js";
import { logger } from "../lib/logger.js";

/**
 * Guided first-run indexing: registers legacy owners, then a persisted per-game job
 * walks the sessions in session order, enqueuing one session's historical
 * continuity chunks only after the previous session is terminal (and published when
 * requested). Long-running extraction stays with the continuity runtime; a
 * lightweight scheduler here only advances jobs every 30 seconds.
 */

const scopeSchema = z
  .object({ gameId: z.string().trim().min(1).optional(), chatId: z.string().trim().min(1).optional() })
  .strict();
const runSchema = z
  .object({
    gameId: z.string().trim().min(1).optional(),
    chatId: z.string().trim().min(1).optional(),
    chatIds: z.array(z.string().trim().min(1)).max(500).optional(),
    steps: z.object({ registerOwners: z.boolean(), backfill: z.boolean(), publishVerified: z.boolean() }).strict(),
  })
  .strict();
const cancelSchema = z.object({ gameId: z.string().trim().min(1) }).strict();

type ChatRow = Awaited<ReturnType<ReturnType<typeof createChatsStorage>["getById"]>> & object;
type Inventory = NonNullable<Awaited<ReturnType<typeof readContinuityInventory>>>;
const PENDING_STATUSES = new Set(["queued", "extracting", "reviewing", "repairing"]);
/** Receipts that still index their sources; stale and failed receipts (e.g. config retirements) do not. */
const COVERING_STATUSES = new Set([...PENDING_STATUSES, "verified", "published", "unresolved"]);
/** Below the backfill route's hard limit of 50 accepted turns per manifest. */
const MAX_TURNS_PER_MANIFEST = 45;
const TURN_LIMIT_CODE = "CONTINUITY_BACKFILL_TURN_LIMIT";
/** Receipts the worker will not touch again; a session advances only when all its manifests are terminal. */
const TERMINAL_STATUSES = new Set(["verified", "published", "unresolved", "failed", "stale"]);
const CANCELLED_CODE = "CONTINUITY_INDEX_CANCELLED";
/** Prefix stamped on a cancelled receipt's frozen config hash; the pump retires it instead of running it. */
const CANCELLED_PREFIX = "cancelled:";
const SCHEDULER_INTERVAL_MS = 30_000;
type CoveringReceipt = { status: string; sources: Array<{ messageId: string }> };
type CampaignIndexSteps = { registerOwners: boolean; backfill: boolean; publishVerified: boolean };
type SessionProgress = {
  status: "pending" | "enqueued" | "terminal" | "published" | "skipped" | "failed";
  reason?: string;
  backfillIds: string[];
  acceptedTurns: number;
  skippedSegments: number;
  failed?: Array<{ range: { fromMessageId: string; toMessageId: string }; error: string }>;
  prunedManifests?: string[];
  published?: number;
};
type CampaignIndexJob = {
  jobId: string;
  gameId: string;
  order: string[];
  currentIndex: number;
  steps: CampaignIndexSteps;
  startedAt: string;
  updatedAt: string;
  status: "running" | "paused" | "done" | "cancelled";
  sessions: Record<string, SessionProgress>;
  history: Array<{ at: string; chatId: string | null; event: string; detail?: unknown }>;
};
type UncoveredSource = { messageId: string; role: string; turn: boolean };

function parseMeta(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown, fallback: string): string {
  const message = errorMessage(error);
  return /^[A-Z_]+(?=:|$)/.test(message) ? (message.split(":", 1)[0] ?? fallback) : fallback;
}

function gameIdOf(chat: ChatRow): string {
  const meta = parseMeta(chat.metadata);
  return (typeof meta.gameId === "string" ? meta.gameId.trim() : "") || chat.groupId?.trim() || chat.id;
}

function sessionNumberOf(chat: ChatRow): number | null {
  const value = parseMeta(chat.metadata).gameSessionNumber;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function promptDismissedAt(chat: ChatRow): string | null {
  const prompt = parseMeta(chat.metadata).campaignIndexPrompt;
  const value = prompt && typeof prompt === "object" ? (prompt as Record<string, unknown>).dismissedAt : null;
  return typeof value === "string" ? value : null;
}

/** Game chats grouped by game, each group ordered by session number then creation time. */
async function listGames(app: FastifyInstance, scope: { gameId?: string; chatId?: string; chatIds?: string[] }) {
  const chats = createChatsStorage(app.db);
  const all = (await chats.list()).filter((chat) => chat.mode === "game");
  let gameId = scope.gameId;
  if (!gameId && scope.chatId) {
    const chat = all.find((row) => row.id === scope.chatId);
    if (!chat) return null;
    gameId = gameIdOf(chat);
  }
  const wanted = scope.chatIds ? new Set(scope.chatIds) : null;
  const groups = new Map<string, ChatRow[]>();
  for (const chat of all) {
    const id = gameIdOf(chat);
    if (gameId && id !== gameId) continue;
    if (wanted && !wanted.has(chat.id)) continue;
    groups.set(id, [...(groups.get(id) ?? []), chat]);
  }
  if ((gameId || wanted) && groups.size === 0) return null;
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, rows]) => ({
      gameId: id,
      chats: rows.sort(
        (left, right) =>
          (sessionNumberOf(left) ?? 0) - (sessionNumberOf(right) ?? 0) ||
          String(left.createdAt).localeCompare(String(right.createdAt)),
      ),
    }));
}

/**
 * Indexable history ends at the last assistant turn a player answered; the live tail
 * (an unanswered assistant message and trailing user input) belongs to incremental
 * continuity, so it never counts as uncovered.
 * ponytail: mirrors the runtime's "followed by user" acceptance from prepared sources only;
 * committed snapshots are ignored, so the estimate can undercount by the final turn.
 */
function coverage(inventory: Inventory, receipts: CoveringReceipt[]) {
  const prepared = inventory.prepared;
  const accepted = (index: number) =>
    prepared[index]!.role.startsWith("assistant") && (prepared[index + 1]?.role.startsWith("user") ?? false);
  let lastAccepted = -1;
  for (let index = 0; index < prepared.length; index += 1) if (accepted(index)) lastAccepted = index;
  const covered = new Set<string>();
  for (const receipt of receipts) {
    if (!COVERING_STATUSES.has(receipt.status)) continue;
    for (const source of receipt.sources) covered.add(source.messageId);
  }
  const uncovered: UncoveredSource[] = prepared
    .slice(0, lastAccepted + 1)
    .map((source, index) => ({ ...source, turn: accepted(index) }))
    .filter((source) => !covered.has(source.messageId));
  return {
    uncoveredMessages: uncovered.length,
    estimatedTurns: uncovered.filter((source) => source.turn).length,
    range: rangeOf(uncovered),
    segments: splitByTurns(uncovered, MAX_TURNS_PER_MANIFEST),
  };
}

function rangeOf(sources: UncoveredSource[]) {
  const first = sources[0];
  const last = sources[sources.length - 1];
  return first && last ? { fromMessageId: first.messageId, toMessageId: last.messageId } : null;
}

/** Consecutive sub-ranges holding at most `maxTurns` accepted turns each; a turnless tail joins the last segment. */
function splitByTurns(sources: UncoveredSource[], maxTurns: number): UncoveredSource[][] {
  const segments: UncoveredSource[][] = [];
  let current: UncoveredSource[] = [];
  let turns = 0;
  for (const source of sources) {
    current.push(source);
    if (!source.turn) continue;
    turns += 1;
    if (turns >= maxTurns) {
      segments.push(current);
      current = [];
      turns = 0;
    }
  }
  if (current.length) {
    if (turns === 0 && segments.length) segments[segments.length - 1]!.push(...current);
    else segments.push(current);
  }
  return segments;
}

/**
 * Enqueue one segment; when the runtime still counts more accepted turns than the
 * route allows (committed snapshots the estimate cannot see), halve by turns and retry.
 */
async function enqueueSegment(
  app: FastifyInstance,
  chatId: string,
  segment: UncoveredSource[],
  out: {
    backfillIds: string[];
    acceptedTurns: number;
    failed: Array<{ range: NonNullable<ReturnType<typeof rangeOf>>; error: string }>;
  },
) {
  const range = rangeOf(segment);
  if (!range) return;
  try {
    const started = await startHistoricalBackfill(app, chatId, range);
    out.backfillIds.push(started.backfillId);
    out.acceptedTurns += started.acceptedTurns;
  } catch (error) {
    const code = errorCode(error, "CONTINUITY_BACKFILL_FAILED");
    const turns = segment.filter((source) => source.turn).length;
    if (code === TURN_LIMIT_CODE && turns > 1) {
      const halves = splitByTurns(segment, Math.ceil(turns / 2));
      for (const half of halves) await enqueueSegment(app, chatId, half, out);
      return;
    }
    logger.warn({ err: error, chatId, range, code }, "Campaign index backfill enqueue failed");
    out.failed.push({ range, error: code });
  }
}

export function manifestSummary(manifest: Inventory["manifests"][number]) {
  const total = manifest.receiptIds.length;
  const verified = manifest.countsByStatus.verified ?? 0;
  const covering = Object.entries(manifest.countsByStatus).reduce(
    (sum, [status, count]) => sum + (COVERING_STATUSES.has(status) ? count : 0),
    0,
  );
  return {
    live: covering > 0,
    covering,
    id: manifest.id,
    fromMessageId: manifest.fromMessageId,
    toMessageId: manifest.toMessageId,
    sessionNumber: manifest.sessionNumber,
    rangeValid: manifest.rangeValid,
    receipts: total,
    missingReceipts: manifest.missingReceiptIds.length,
    countsByStatus: manifest.countsByStatus,
    countsByErrorCode: manifest.countsByErrorCode,
    coverageGaps: manifest.coverageGaps.length,
    published: manifest.countsByStatus.published ?? 0,
    // A finished manifest publishes the batches that verified. One batch left unresolved or failed used to hold
    // back every verified batch beside it, while the job still reported the session as published.
    publishable:
      total > 0 &&
      manifest.missingReceiptIds.length === 0 &&
      verified > 0 &&
      !Object.entries(manifest.countsByStatus).some(([status, count]) => PENDING_STATUSES.has(status) && count > 0),
    pending: Object.entries(manifest.countsByStatus).some(
      ([status, count]) => PENDING_STATUSES.has(status) && count > 0,
    ),
  };
}

async function continuityConfigured(app: FastifyInstance, chatId: string) {
  try {
    await readContinuityConfig(app.db, chatId, { allowHistoricalBackfill: true });
    return true;
  } catch {
    return false;
  }
}

/** Let pending requests run between heavy per-session steps; this route runs on the Engine's only thread. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function ownersPlanned(app: FastifyInstance, chatId: string) {
  try {
    const source = await collectCampaignMemoryLegacySource(app.db, chatId);
    const plan = await planCampaignMemoryLegacyImport(app.db, source);
    return { planned: plan.manifest.counts.planned, held: plan.manifest.counts.held, error: null };
  } catch (error) {
    logger.warn({ err: error, chatId }, "Campaign index owner preview failed");
    return { planned: null, held: null, error: errorCode(error, "CAMPAIGN_MEMORY_IMPORT_FAILED") };
  }
}

async function describeChat(app: FastifyInstance, chat: ChatRow, options: { owners: boolean; totals: boolean }) {
  const inventory = (await readContinuityInventory(app, chat.id))!;
  const receipts = await app.gameContinuity.list(chat.id);
  const cover = coverage(inventory, receipts);
  const manifests = inventory.manifests.map(manifestSummary);
  const owners = options.owners ? await ownersPlanned(app, chat.id) : null;
  const memory = createCampaignMemoryStorage(app.db);
  const totals = options.totals
    ? {
        entities: (await memory.listEntities({ chatId: chat.id })).length,
        facts: (await memory.listFacts({ chatId: chat.id })).length,
      }
    : null;
  const pendingReceipts = receipts.filter((receipt) => PENDING_STATUSES.has(receipt.status)).length;
  return {
    chatId: chat.id,
    name: chat.name,
    sessionNumber: sessionNumberOf(chat),
    messageCounts: inventory.messageCounts,
    preparedMessages: inventory.prepared.length,
    excludedMessages: inventory.excluded.length,
    ownersRegistered: owners ? (owners.planned === null ? null : owners.planned === 0) : null,
    ownersPlanned: owners?.planned ?? null,
    ownersHeld: owners?.held ?? null,
    ownersError: owners?.error ?? null,
    receiptCounts: inventory.receiptCounts,
    published: receipts.filter((receipt) => receipt.status === "published").length,
    manifests,
    uncoveredMessages: cover.uncoveredMessages,
    range: cover.range,
    rangeCovered: cover.range
      ? manifests.some(
          (manifest) =>
            manifest.live &&
            manifest.fromMessageId === cover.range!.fromMessageId &&
            manifest.toMessageId === cover.range!.toMessageId,
        )
      : false,
    estimate: { turns: cover.estimatedTurns, receipts: cover.estimatedTurns + pendingReceipts },
    continuityConfigured: await continuityConfigured(app, chat.id),
    totals,
    promptDismissedAt: promptDismissedAt(chat),
  };
}

type ChatDescription = Awaited<ReturnType<typeof describeChat>>;

function readJob(chat: ChatRow | undefined): CampaignIndexJob | null {
  const job = chat ? parseMeta(chat.metadata).campaignIndexJob : null;
  return job && typeof job === "object" && typeof (job as CampaignIndexJob).jobId === "string"
    ? (job as CampaignIndexJob)
    : null;
}

function gameSummary(gameId: string, chats: ChatDescription[], job: CampaignIndexJob | null) {
  return {
    gameId,
    promptDismissedAt: chats.map((chat) => chat.promptDismissedAt).find((value): value is string => !!value) ?? null,
    continuityConfigured: chats.every((chat) => chat.continuityConfigured),
    needsIndexing: chats.some((chat) => chat.ownersRegistered === false || chat.uncoveredMessages > 0),
    pending: job?.status === "running" || chats.some((chat) => chat.manifests.some((manifest) => manifest.pending)),
    job,
    chats,
  };
}

async function registerOwners(app: FastifyInstance, chatId: string) {
  try {
    const source = await collectCampaignMemoryLegacySource(app.db, chatId);
    const plan = await planCampaignMemoryLegacyImport(app.db, source);
    if (plan.manifest.counts.planned === 0) return { chatId, status: "skipped" as const };
    const applied = await applyCampaignMemoryLegacyImport(app.db, plan);
    return {
      chatId,
      status: "registered" as const,
      created: applied.manifest.counts.created,
      replayed: applied.manifest.counts.replayed,
    };
  } catch (error) {
    logger.warn({ err: error, chatId }, "Campaign index owner registration failed");
    return { chatId, status: "failed" as const, error: errorCode(error, "CAMPAIGN_MEMORY_IMPORT_FAILED") };
  }
}

/**
 * Restore receipts a cancelled job retired so the pump will run them again: the frozen
 * config hash is put back and the receipt returns to the queue. Their manifests are
 * re-enqueued by the caller, which is what hands them to the runtime.
 */
async function reviveCancelledReceipts(app: FastifyInstance, chatId: string) {
  const storage = createGameContinuityStorage(app.db);
  let revived = 0;
  for (const receipt of await storage.list(chatId)) {
    // The cancelled prefix is only ever written by cancelJob, so it alone identifies a cancelled receipt. Keying
    // on the error code too missed receipts whose code was later overwritten, stranding them as stale forever.
    if (!receipt.configHash.startsWith(CANCELLED_PREFIX)) continue;
    await storage.save({
      ...receipt,
      status: "queued",
      attempts: 0,
      repairAttempts: 0,
      records: [],
      dispositions: [],
      review: null,
      configHash: receipt.configHash.slice(CANCELLED_PREFIX.length),
      errorCode: undefined,
      error: undefined,
      updatedAt: new Date().toISOString(),
    });
    revived += 1;
  }
  return revived;
}

/**
 * Drop manifests that hold no live receipt: empty ones, ones a cancellation trimmed, and
 * ones whose receipts were all retired. Their ranges are uncovered, so keeping the record
 * would strand that range as "indexed" forever and pile up dead entries.
 */
async function pruneDeadManifests(app: FastifyInstance, chatId: string) {
  const statusById = new Map(
    (await createGameContinuityStorage(app.db).list(chatId)).map((receipt) => [receipt.id, receipt.status]),
  );
  const live = (record: Record<string, unknown>) =>
    (Array.isArray(record.receiptIds) ? record.receiptIds : []).some((id) =>
      COVERING_STATUSES.has(statusById.get(String(id)) ?? ""),
    );
  const removed: string[] = [];
  await createChatsStorage(app.db).patchMetadata(chatId, (metadata) => {
    const remaining = backfillRecords(metadata).filter((record) => {
      if (live(record)) return true;
      removed.push(String(record.id));
      return false;
    });
    return { gameContinuityBackfills: remaining };
  });
  if (removed.length) await app.db.transaction(async () => undefined, { durable: true });
  return removed;
}

/** Enqueue every uncovered chunk of one chat; sub-ranges already held by a live manifest are reused. */
async function enqueueChat(app: FastifyInstance, chatId: string): Promise<SessionProgress> {
  const inventory = (await readContinuityInventory(app, chatId))!;
  const cover = coverage(inventory, await app.gameContinuity.list(chatId));
  if (!cover.range)
    return { status: "skipped", reason: "nothing_to_index", backfillIds: [], acceptedTurns: 0, skippedSegments: 0 };
  const liveManifests = inventory.manifests.map(manifestSummary).filter((manifest) => manifest.live);
  const prunedManifests = await pruneDeadManifests(app, chatId);
  // Coverage is read before this: a cancelled receipt counts as uncovered, and reviving it
  // here lets the re-enqueued manifest hand the same receipt back to the runtime.
  await reviveCancelledReceipts(app, chatId);
  const out = { backfillIds: [] as string[], acceptedTurns: 0, failed: [] as NonNullable<SessionProgress["failed"]> };
  let skippedSegments = 0;
  for (const segment of cover.segments) {
    const range = rangeOf(segment)!;
    const existing = liveManifests.find(
      (manifest) => manifest.fromMessageId === range.fromMessageId && manifest.toMessageId === range.toMessageId,
    );
    if (existing) {
      skippedSegments += 1;
      out.backfillIds.push(existing.id);
      continue;
    }
    await enqueueSegment(app, chatId, segment, out);
  }
  const enqueued = out.backfillIds.length > skippedSegments;
  return {
    status: enqueued ? "enqueued" : out.failed.length ? "failed" : "skipped",
    ...(!enqueued && !out.failed.length ? { reason: "manifest_exists" } : {}),
    backfillIds: out.backfillIds,
    acceptedTurns: out.acceptedTurns,
    skippedSegments,
    ...(prunedManifests.length ? { prunedManifests } : {}),
    ...(out.failed.length ? { failed: out.failed } : {}),
  };
}

/** Every manifest of the chat has only terminal receipts (missing receipts count as terminal). */
async function chatTerminal(app: FastifyInstance, chatId: string) {
  const inventory = await readContinuityInventory(app, chatId);
  return (
    !inventory ||
    inventory.manifests.every((manifest) =>
      Object.entries(manifest.countsByStatus).every(([status, count]) => count === 0 || TERMINAL_STATUSES.has(status)),
    )
  );
}

async function publishChat(app: FastifyInstance, chatId: string) {
  const inventory = (await readContinuityInventory(app, chatId))!;
  let published = 0;
  for (const manifest of inventory.manifests) {
    if (!manifestSummary(manifest).publishable) continue;
    published += (await app.gameContinuity.publishHistoricalBackfill(chatId, manifest.id, manifest.receiptIds)).length;
  }
  return published;
}

async function persistJob(app: FastifyInstance, job: CampaignIndexJob) {
  job.updatedAt = new Date().toISOString();
  await createChatsStorage(app.db).patchMetadata(job.order[0]!, { campaignIndexJob: job });
  await app.db.transaction(async () => undefined, { durable: true });
}

const advancing = new Set<string>();

/**
 * Move a job forward as far as the runtime allows: enqueue the current session's
 * chunks, wait (return) while any of its manifests is still being processed, publish
 * verified manifests when requested, then step to the next session. Sessions with
 * nothing to index still wait for their existing manifests before the job moves on.
 */
async function advanceJob(app: FastifyInstance, job: CampaignIndexJob) {
  if (advancing.has(job.gameId)) return job;
  advancing.add(job.gameId);
  const note = (chatId: string | null, event: string, detail?: unknown) =>
    job.history.push({ at: new Date().toISOString(), chatId, event, ...(detail === undefined ? {} : { detail }) });
  try {
    while (job.status === "running") {
      const chatId = job.order[job.currentIndex];
      if (!chatId) {
        job.status = "done";
        note(null, "done");
        break;
      }
      const session = (job.sessions[chatId] ??= {
        status: "pending",
        backfillIds: [],
        acceptedTurns: 0,
        skippedSegments: 0,
      });
      let status: SessionProgress["status"] = session.status;
      if (status === "pending") {
        const progress = job.steps.backfill
          ? await enqueueChat(app, chatId)
          : {
              status: "skipped" as const,
              reason: "not_requested",
              backfillIds: [],
              acceptedTurns: 0,
              skippedSegments: 0,
            };
        Object.assign(session, progress);
        status = progress.status;
        note(chatId, status, { acceptedTurns: session.acceptedTurns, backfillIds: session.backfillIds });
        if (status === "failed") {
          job.status = "paused";
          note(chatId, "paused", session.failed);
          break;
        }
      }
      if (status === "enqueued" || status === "skipped") {
        if (!(await chatTerminal(app, chatId))) break;
        if (job.steps.publishVerified) {
          session.published = (session.published ?? 0) + (await publishChat(app, chatId));
          session.status = "published";
        } else session.status = "terminal";
        note(chatId, session.status, { published: session.published ?? 0 });
      }
      job.currentIndex += 1;
    }
    await persistJob(app, job);
  } catch (error) {
    logger.error({ err: error, gameId: job.gameId, jobId: job.jobId }, "Campaign index job advance failed");
  } finally {
    advancing.delete(job.gameId);
  }
  return job;
}

/** Advance every persisted running job once; the scheduler calls this every 30 seconds. */
export async function tickCampaignIndexJobs(app: FastifyInstance) {
  const games = (await listGames(app, {})) ?? [];
  for (const game of games) {
    const job = readJob(game.chats[0]);
    if (job?.status === "running") await advanceJob(app, job);
  }
}

async function cancelJob(app: FastifyInstance, job: CampaignIndexJob) {
  const storage = createGameContinuityStorage(app.db);
  const chats = createChatsStorage(app.db);
  let retired = 0;
  const removedManifests: string[] = [];
  job.status = "cancelled";
  job.history.push({ at: new Date().toISOString(), chatId: null, event: "cancelled" });
  for (const chatId of job.order) {
    const manifestIds = new Set(job.sessions[chatId]?.backfillIds ?? []);
    if (!manifestIds.size) continue;
    const receiptIds = new Set(
      backfillRecords(parseMeta((await chats.getById(chatId))?.metadata))
        .filter((record) => manifestIds.has(String(record.id)))
        .flatMap((record) => (Array.isArray(record.receiptIds) ? record.receiptIds : []))
        .filter((id): id is string => typeof id === "string"),
    );
    const receipts = await storage.list(chatId);
    for (const receipt of receipts) {
      if (!receiptIds.has(receipt.id) || receipt.status !== "queued") continue;
      // ponytail: the runtime keeps its own in-memory queue; a foreign configHash makes the pump retire
      // this receipt quietly (stale, CONTINUITY_CONFIG_CHANGED) instead of extracting it. Upgrade path:
      // a runtime `dequeue(receiptId)` that drops pending items.
      await storage.save({
        ...receipt,
        status: "stale",
        configHash: `${CANCELLED_PREFIX}${receipt.configHash}`,
        errorCode: CANCELLED_CODE,
        error: "Campaign indexing was cancelled before this batch started.",
        updatedAt: new Date().toISOString(),
      });
      retired += 1;
    }
    const statusById = new Map((await storage.list(chatId)).map((receipt) => [receipt.id, receipt.status]));
    await chats.patchMetadata(chatId, (metadata) => {
      const records = backfillRecords(metadata);
      const remaining = records.filter((record) => {
        if (!manifestIds.has(String(record.id))) return true;
        const ids = Array.isArray(record.receiptIds) ? record.receiptIds : [];
        const live = ids.some((id) => COVERING_STATUSES.has(statusById.get(String(id)) ?? ""));
        if (!live) removedManifests.push(String(record.id));
        return live;
      });
      return { gameContinuityBackfills: remaining };
    });
  }
  await persistJob(app, job);
  return { job, retired, removedManifests };
}

export async function campaignIndexRoutes(app: FastifyInstance) {
  const describeGames = async (
    scope: { gameId?: string; chatId?: string; chatIds?: string[] },
    options: { owners: boolean; totals: boolean },
  ) => {
    const games = await listGames(app, scope);
    if (!games) return null;
    const described = [];
    for (const game of games) {
      const chats = [];
      for (const chat of game.chats) {
        chats.push(await describeChat(app, chat, options));
        // Each session's owner preview is seconds of synchronous work; yield so the rest of the Engine
        // (avatars, status polls, the chat itself) keeps answering instead of freezing for the whole plan.
        await yieldToEventLoop();
      }
      described.push(gameSummary(game.gameId, chats, readJob(game.chats[0])));
    }
    return described;
  };

  const timer = setInterval(() => {
    tickCampaignIndexJobs(app).catch((error) => logger.error({ err: error }, "Campaign index scheduler tick failed"));
  }, SCHEDULER_INTERVAL_MS);
  timer.unref();
  app.addHook("onClose", async () => clearInterval(timer));

  app.get("/campaign-index/plan", async (request, reply) => {
    const parsed = scopeSchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "Invalid campaign index scope" });
    const games = await describeGames(parsed.data, { owners: true, totals: false });
    if (!games) return reply.status(404).send({ error: "Game not found" });
    return { games };
  });

  app.get("/campaign-index/status", async (request, reply) => {
    const parsed = scopeSchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "Invalid campaign index scope" });
    const games = await describeGames(parsed.data, { owners: false, totals: true });
    if (!games) return reply.status(404).send({ error: "Game not found" });
    return { games };
  });

  app.post("/campaign-index/run", async (request, reply) => {
    const parsed = runSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "Invalid campaign index run request" });
    const { steps, ...scope } = parsed.data;
    const games = await listGames(app, scope);
    if (!games) return reply.status(404).send({ error: "Game not found" });
    for (const game of games) {
      const job = readJob(game.chats[0]);
      if (job?.status === "running")
        return reply.status(409).send({
          error: { code: "CAMPAIGN_INDEX_RUNNING", message: "Indexing is already running", jobId: job.jobId },
        });
    }
    const jobs = [];
    for (const game of games) {
      const owners = [];
      if (steps.registerOwners)
        for (const chat of game.chats) {
          owners.push(await registerOwners(app, chat.id));
          await yieldToEventLoop();
        }
      const previous = readJob(game.chats[0]);
      const now = new Date().toISOString();
      const job: CampaignIndexJob =
        previous?.status === "paused"
          ? { ...previous, steps, status: "running" }
          : {
              jobId: `campaign-index-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
              gameId: game.gameId,
              order: game.chats.map((chat) => chat.id),
              currentIndex: 0,
              steps,
              startedAt: now,
              updatedAt: now,
              status: "running",
              sessions: {},
              history: [{ at: now, chatId: null, event: "started" }],
            };
      if (previous?.status === "paused") {
        for (const session of Object.values(job.sessions))
          if (session.status === "failed") Object.assign(session, { status: "pending", failed: undefined });
        job.history.push({ at: now, chatId: null, event: "resumed" });
      }
      jobs.push({ gameId: game.gameId, owners, job: await advanceJob(app, job) });
    }
    return { jobs };
  });

  app.post("/campaign-index/cancel", async (request, reply) => {
    const parsed = cancelSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "Invalid campaign index cancel request" });
    const games = await listGames(app, { gameId: parsed.data.gameId });
    const job = games ? readJob(games[0]?.chats[0]) : null;
    if (!job || (job.status !== "running" && job.status !== "paused"))
      return reply.status(404).send({ error: "No running campaign index job" });
    return cancelJob(app, job);
  });
}
