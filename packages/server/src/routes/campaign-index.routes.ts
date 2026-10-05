import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createChatsStorage } from "../services/storage/chats.storage.js";
import { createCampaignMemoryStorage } from "../services/storage/campaign-memory.storage.js";
import { resolveCampaignLineage, type CampaignLineageResolution } from "../services/game/campaign-lineage.js";
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
import {
  isCampaignOptInEnabled,
  onFeatureSettingsChange,
  rejectCampaignFeatureWhenDisabled,
  requireCampaignOptIn,
} from "../services/features/campaign-opt-in.js";

import { continuityReceiptCovers } from "../services/game/continuity-retirement.js";
import type { GameContinuityReceipt, GameContinuitySource } from "@marinara-engine/shared";

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
type CoveringReceipt = Pick<GameContinuityReceipt, "status" | "sources">;
type DetailedInventory = Inventory & { preparedSources: GameContinuitySource[] };
type CampaignIndexSteps = { registerOwners: boolean; backfill: boolean; publishVerified: boolean };
type CampaignLineageSnapshot = CampaignLineageResolution & { identity: string };
type CampaignLineageHold = CampaignLineageResolution["holds"][number];
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
  targetChatId?: string;
  lineageIdentity?: string;
  lineageHold?: {
    targetChatId: string;
    reason: "lineage_changed" | "lineage_invalid" | "target_missing";
    holds: CampaignLineageHold[];
    expectedIdentity?: string;
    observedIdentity?: string;
  };
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

/** Automatic repair is limited to concluded, enabled sessions; active or muted chats stay provider-free. */
export function shouldAutoRepairCompletedSession(metadata: unknown) {
  const meta = parseMeta(metadata);
  const continuity = parseMeta(meta.gameContinuity);
  return meta.gameSessionStatus === "concluded" && (continuity.mode === "active" || continuity.mode === "shadow");
}

/** Reopen a completed job when later messages leave one of its sessions uncovered. */
export function reopenCompletedJob(
  job: CampaignIndexJob,
  uncoveredChatIds: readonly string[],
  fingerprints: Readonly<Record<string, string>> = {},
) {
  if (job.status !== "done" || !job.steps.backfill) return false;
  const uncovered = new Set(uncoveredChatIds);
  const firstIndex = job.order.findIndex((chatId) => uncovered.has(chatId));
  if (firstIndex < 0) return false;
  for (const chatId of uncovered) {
    const session = job.sessions[chatId];
    if (!session) continue;
    session.status = "pending";
    session.failed = undefined;
  }
  job.currentIndex = firstIndex;
  job.status = "running";
  job.history.push({
    at: new Date().toISOString(),
    chatId: null,
    event: "coverage_repair",
    detail: {
      sessions: [...uncovered].filter((chatId) => job.order.includes(chatId)),
      fingerprints,
    },
  });
  return true;
}

export function shouldRetryCoverageRepair(job: CampaignIndexJob, chatId: string, fingerprint: string) {
  for (const entry of [...job.history].reverse()) {
    if (entry.event !== "coverage_repair") continue;
    const detail = parseMeta(entry.detail);
    const values = detail.fingerprints;
    const previous =
      values && typeof values === "object" && !Array.isArray(values)
        ? (values as Record<string, unknown>)[chatId]
        : undefined;
    // A different session's repair must not erase this session's retry watermark.
    if (typeof previous === "string") return previous !== fingerprint;
  }
  return true;
}

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

async function campaignLineageSnapshot(
  app: FastifyInstance,
  gameId: string,
  targetChatId: string,
): Promise<CampaignLineageSnapshot> {
  const chats = createChatsStorage(app.db);
  const rows = (await chats.list()).filter((chat) => chat.mode === "game" && gameIdOf(chat) === gameId);
  const lineageChats = await Promise.all(
    rows.map(async (chat) => ({
      id: chat.id,
      mode: chat.mode,
      groupId: chat.groupId,
      metadata: parseMeta(chat.metadata),
      messageIds: (await chats.listMessages(chat.id)).map((message) => message.id),
    })),
  );
  const resolution = resolveCampaignLineage(gameId, targetChatId, lineageChats);
  const relevantIds = new Set([
    targetChatId,
    ...resolution.sessions.flatMap((session) => session.branchPathChatIds),
    ...resolution.edges.flatMap((edge) => [edge.childChatId, edge.parentChatId]),
    ...resolution.holds.map((hold) => hold.chatId),
  ]);
  const lineageMetadata = [...relevantIds].sort().map((chatId) => {
    const chat = lineageChats.find((candidate) => candidate.id === chatId);
    if (!chat) return { chatId, missing: true };
    const meta = chat.metadata;
    return {
      chatId,
      gameId: meta.gameId,
      gameSessionNumber: meta.gameSessionNumber,
      gameSessionParentChatId: meta.gameSessionParentChatId,
      branchParentChatId: meta.branchParentChatId,
      branchParentMessageId: meta.branchParentMessageId,
      branchMessageId: meta.branchMessageId,
      branchLineageVersion: meta.branchLineageVersion,
      branchCopyMode: meta.branchCopyMode,
      branchCopiedMessageCount: meta.branchCopiedMessageCount,
    };
  });
  const identity = createHash("sha256").update(JSON.stringify({ resolution, lineageMetadata })).digest("hex");
  return { ...resolution, identity };
}

function campaignLineageMatches(job: CampaignIndexJob, lineage: CampaignLineageSnapshot) {
  const selected = new Set(job.order);
  const lineageOrder = lineage.sessions.map((session) => session.chatId);
  return (
    lineage.status === "ready" &&
    job.lineageIdentity === lineage.identity &&
    selected.has(job.targetChatId ?? "") &&
    selected.size === job.order.length &&
    JSON.stringify(job.order) === JSON.stringify(lineageOrder.filter((chatId) => selected.has(chatId)))
  );
}

function holdJobOnLineageChange(
  job: CampaignIndexJob,
  lineage: CampaignLineageSnapshot,
  note: (chatId: string | null, event: string, detail?: unknown) => void,
) {
  const targetChatId = job.targetChatId ?? lineage.selectedChatId;
  const holds = lineage.holds.length
    ? lineage.holds
    : [{ chatId: targetChatId, edge: "target" as const, reason: "campaign lineage changed after the job was planned" }];
  job.status = "paused";
  job.lineageHold = {
    targetChatId,
    reason: lineage.status === "held" ? "lineage_invalid" : "lineage_changed",
    holds,
    expectedIdentity: job.lineageIdentity,
    observedIdentity: lineage.identity,
  };
  note(targetChatId, "lineage_held", job.lineageHold);
}

/** Only accepted prepared assistant sources close an indexable turn; excluded recap sources stay excluded. */
export function coverage(inventory: DetailedInventory, receipts: CoveringReceipt[]) {
  const prepared = inventory.preparedSources;
  const acceptedIds = inventory.acceptedAssistantIds ? new Set(inventory.acceptedAssistantIds) : null;
  const accepted = (index: number) =>
    prepared[index]!.role.startsWith("assistant") &&
    (acceptedIds
      ? acceptedIds.has(prepared[index]!.messageId)
      : (prepared[index + 1]?.role.startsWith("user") ?? false));
  let lastAccepted = -1;
  for (let index = 0; index < prepared.length; index += 1) if (accepted(index)) lastAccepted = index;
  const covering = {
    sources: receipts.filter((receipt) => COVERING_STATUSES.has(receipt.status)).flatMap((receipt) => receipt.sources),
  };
  const covered = new Set(
    prepared
      .filter((source) => continuityReceiptCovers(covering, { sources: [source] }))
      .map((source) => source.messageId),
  );
  const uncovered: UncoveredSource[] = prepared
    .slice(0, lastAccepted + 1)
    .map((source, index) => ({ ...source, turn: accepted(index) }))
    .filter((source) => !covered.has(source.messageId));
  return {
    uncoveredMessages: uncovered.length,
    estimatedTurns: uncovered.filter((source) => source.turn).length,
    range: rangeOf(uncovered),
    segments: splitByTurns(uncovered, MAX_TURNS_PER_MANIFEST),
    // Bind the retry watermark to the source version and range, not merely its stable message id.
    fingerprint: createHash("sha256")
      .update(
        JSON.stringify(
          prepared
            .slice(0, lastAccepted + 1)
            .filter((source) => !covered.has(source.messageId))
            .map((source) => ({
              messageId: source.messageId,
              role: source.role,
              hash: source.hash,
              swipeIndex: source.swipeIndex,
              start: source.start ?? 0,
              end: source.end ?? (source.start ?? 0) + [...source.content].length,
            })),
        ),
      )
      .digest("hex"),
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
 * Enqueue one segment; if accepted history changes after inventory and exceeds the
 * runtime turn limit, halve by turns and retry.
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
  backfillId?: string,
) {
  const range = rangeOf(segment);
  if (!range) return;
  try {
    const started = await startHistoricalBackfill(app, chatId, range, backfillId);
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
  const inventory = (await readContinuityInventory(app, chat.id, {
    includePreparedSources: true,
  })) as DetailedInventory;
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
            manifest.rangeValid &&
            manifest.coverageGaps === 0 &&
            manifest.missingReceipts === 0 &&
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

/**
 * The job of a game, wherever it is stored. A job lives on the first chat of the run's own scope, which is not
 * the game's first chat when a run named only some sessions (or a chat without a session number sorts first),
 * so reading `chats[0]` lost it: the scheduler never advanced it and the 409 guard let a second job start.
 * The most recently updated job wins, which is always the live one.
 */
function readGameJob(chats: readonly ChatRow[]): CampaignIndexJob | null {
  let best: CampaignIndexJob | null = null;
  for (const chat of chats) {
    const job = readJob(chat);
    if (job && (!best || String(job.updatedAt) > String(best.updatedAt))) best = job;
  }
  return best;
}

function gameSummary(
  gameId: string,
  chats: ChatDescription[],
  job: CampaignIndexJob | null,
  lineage?: Omit<CampaignLineageSnapshot, "selectedChatId" | "gameId"> & { targetChatId: string },
) {
  return {
    gameId,
    ...(lineage ? { lineage } : {}),
    promptDismissedAt: chats.map((chat) => chat.promptDismissedAt).find((value): value is string => !!value) ?? null,
    continuityConfigured: chats.every((chat) => chat.continuityConfigured),
    needsIndexing: chats.some((chat) => chat.ownersRegistered === false || chat.uncoveredMessages > 0),
    pending: job?.status === "running" || chats.some((chat) => chat.manifests.some((manifest) => manifest.pending)),
    job,
    chats,
  };
}

async function registerOwners(app: FastifyInstance, chatId: string) {
  requireCampaignOptIn("campaignIndex");
  requireCampaignOptIn("campaignMemory");

  try {
    const source = await collectCampaignMemoryLegacySource(app.db, chatId);
    const plan = await planCampaignMemoryLegacyImport(app.db, source);
    requireCampaignOptIn("campaignIndex");
    requireCampaignOptIn("campaignMemory");

    if (plan.manifest.counts.planned === 0) return { chatId, status: "skipped" as const };
    requireCampaignOptIn("campaignIndex");
    requireCampaignOptIn("campaignMemory");

    const applied = await applyCampaignMemoryLegacyImport(app.db, plan, () => {
      requireCampaignOptIn("campaignIndex");
      requireCampaignOptIn("campaignMemory");
    });
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
  const inventory = (await readContinuityInventory(app, chatId, {
    includePreparedSources: true,
  })) as DetailedInventory | null;
  // A session deleted while the job ran has nothing left to index; asserting it crashed every later advance.
  if (!inventory)
    return { status: "skipped", reason: "chat_missing", backfillIds: [], acceptedTurns: 0, skippedSegments: 0 };
  const cover = coverage(inventory, await app.gameContinuity.list(chatId));
  if (!cover.range)
    return { status: "skipped", reason: "nothing_to_index", backfillIds: [], acceptedTurns: 0, skippedSegments: 0 };
  const liveManifests = inventory.manifests
    .map(manifestSummary)
    .filter((manifest) => manifest.live && manifest.rangeValid);
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
    if (existing && existing.coverageGaps === 0 && existing.missingReceipts === 0) {
      skippedSegments += 1;
      out.backfillIds.push(existing.id);
      continue;
    }
    // Extend the same manifest when only part of its range was reserved; do not strand the missing slice.
    await enqueueSegment(app, chatId, segment, out, existing?.id);
  }
  const enqueued = out.backfillIds.length > skippedSegments;
  return {
    // Any failed segment pauses the job: reporting "enqueued" moved past the session and left that range unindexed.
    status: out.failed.length ? "failed" : enqueued ? "enqueued" : "skipped",
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
  const inventory = await readContinuityInventory(app, chatId);
  if (!inventory) return 0;
  let published = 0;
  for (const manifest of inventory.manifests) {
    if (!manifestSummary(manifest).publishable) continue;
    published += (await app.gameContinuity.publishHistoricalBackfill(chatId, manifest.id, manifest.receiptIds)).length;
  }
  return published;
}

/** Serialize only job claims/writes, never provider work: cancellation must remain responsive. */
const jobWrites = new WeakMap<FastifyInstance, Map<string, Promise<void>>>();
async function withJobWrite<T>(app: FastifyInstance, gameId: string, work: () => Promise<T>): Promise<T> {
  let queues = jobWrites.get(app);
  if (!queues) jobWrites.set(app, (queues = new Map()));
  const previous = queues.get(gameId) ?? Promise.resolve();
  const result = previous.then(work);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  queues.set(gameId, settled);
  try {
    return await result;
  } finally {
    if (queues.get(gameId) === settled) queues.delete(gameId);
  }
}

/** Resolve across all anchors, including runs scoped to a different first session. */
async function storedJob(app: FastifyInstance, job: CampaignIndexJob) {
  return readGameJob((await listGames(app, { gameId: job.gameId }))?.[0]?.chats ?? []);
}

/** Compare and write under the game gate and the storage metadata queue. */
async function persistJob(app: FastifyInstance, job: CampaignIndexJob, expected?: CampaignIndexJob | null) {
  return withJobWrite(app, job.gameId, async () => {
    requireCampaignOptIn("campaignIndex");
    // A cancelled advance can still be returning newly enqueued receipts for retirement.
    // Refuse a replacement claim until that cleanup finishes; never lock provider work.
    if (expected !== undefined && job.status === "running" && advancing.has(job.gameId)) return false;
    const current = await storedJob(app, job);
    const matches =
      expected === undefined
        ? current?.jobId === job.jobId && current.status === "running"
        : expected === null
          ? current === null
          : current?.jobId === expected.jobId &&
            current.status === expected.status &&
            current.updatedAt === expected.updatedAt;
    if (!matches) return false;
    const chats = createChatsStorage(app.db);
    const anchor = await chats.getById(job.order[0]!);
    if (!anchor) return false;
    const anchorJob = readJob(anchor);
    let written = false;
    // A strictly increasing stamp prevents same-millisecond ties between different anchors.
    job.updatedAt = new Date(Math.max(Date.now(), Date.parse(current?.updatedAt ?? "") + 1 || 0)).toISOString();
    await chats.patchMetadata(anchor.id, (metadata) => {
      if (!isCampaignOptInEnabled("campaignIndex")) return {};
      const latest = metadata.campaignIndexJob as CampaignIndexJob | undefined;
      if (
        latest?.jobId !== anchorJob?.jobId ||
        latest?.updatedAt !== anchorJob?.updatedAt ||
        latest?.status !== anchorJob?.status
      )
        return {};
      written = true;
      return { campaignIndexJob: job };
    });
    if (written) await app.db.transaction(async () => undefined, { durable: true });
    return written;
  });
}

const advancing = new Set<string>();

/**
 * Move a job forward as far as the runtime allows: enqueue the current session's
 * chunks, wait (return) while any of its manifests is still being processed, publish
 * verified manifests when requested, then step to the next session. Sessions with
 * nothing to index still wait for their existing manifests before the job moves on.
 */
async function advanceJob(app: FastifyInstance, job: CampaignIndexJob) {
  if (!isCampaignOptInEnabled("campaignIndex")) return job;
  if (advancing.has(job.gameId)) return job;
  advancing.add(job.gameId);
  const note = (chatId: string | null, event: string, detail?: unknown) =>
    job.history.push({ at: new Date().toISOString(), chatId, event, ...(detail === undefined ? {} : { detail }) });
  try {
    while (job.status === "running") {
      if (!isCampaignOptInEnabled("campaignIndex")) return job;
      if (job.steps.registerOwners && !isCampaignOptInEnabled("campaignMemory")) return job;
      if (job.steps.backfill && !isCampaignOptInEnabled("gameContinuity")) return job;
      if (
        job.steps.publishVerified &&
        (!isCampaignOptInEnabled("gameContinuity") || !isCampaignOptInEnabled("campaignMemory"))
      )
        return job;
      // Recheck before the first enqueue too: a claimed run may already have been cancelled/replaced.
      const current = await storedJob(app, job);
      if (!isCampaignOptInEnabled("campaignIndex")) return job;
      if (current?.jobId !== job.jobId || current.status !== "running") break;
      if (!job.targetChatId || !job.lineageIdentity) {
        job.status = "paused";
        job.lineageHold = {
          targetChatId: job.targetChatId ?? "",
          reason: "target_missing",
          holds: [{ chatId: job.targetChatId ?? "", edge: "target", reason: "job has no pinned campaign target" }],
        };
        note(job.targetChatId ?? null, "lineage_held", job.lineageHold);
        break;
      }
      const beforeWorkLineage = await campaignLineageSnapshot(app, job.gameId, job.targetChatId);
      if (!isCampaignOptInEnabled("campaignIndex")) return job;
      if (!campaignLineageMatches(job, beforeWorkLineage)) {
        holdJobOnLineageChange(job, beforeWorkLineage, note);
        break;
      }
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
        if (
          !isCampaignOptInEnabled("campaignIndex") ||
          (job.steps.backfill && !isCampaignOptInEnabled("gameContinuity"))
        )
          return job;
        // Keep manifests recorded before a pause, so a later cancel still reaches their receipts.
        const previousIds = session.backfillIds ?? [];
        Object.assign(session, progress);
        session.backfillIds = [...new Set([...previousIds, ...progress.backfillIds])];
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
        if (!isCampaignOptInEnabled("campaignIndex")) return job;
        if (job.steps.publishVerified) {
          if (!isCampaignOptInEnabled("gameContinuity") || !isCampaignOptInEnabled("campaignMemory")) return job;
          const beforePublishLineage = await campaignLineageSnapshot(app, job.gameId, job.targetChatId);
          if (
            !isCampaignOptInEnabled("campaignIndex") ||
            !isCampaignOptInEnabled("gameContinuity") ||
            !isCampaignOptInEnabled("campaignMemory")
          )
            return job;
          if (!campaignLineageMatches(job, beforePublishLineage)) {
            holdJobOnLineageChange(job, beforePublishLineage, note);
            break;
          }
          session.published = (session.published ?? 0) + (await publishChat(app, chatId));
          if (
            !isCampaignOptInEnabled("campaignIndex") ||
            !isCampaignOptInEnabled("gameContinuity") ||
            !isCampaignOptInEnabled("campaignMemory")
          )
            return job;
          session.status = "published";
        } else session.status = "terminal";
        note(chatId, session.status, { published: session.published ?? 0 });
      }
      job.currentIndex += 1;
    }
    // Conditional persistence cannot overwrite a cancellation or a newer job on another anchor.
    if (!(await persistJob(app, job))) {
      const stored = await storedJob(app, job);
      if (stored?.jobId === job.jobId && stored.status === "cancelled") {
        await cancelJob(app, job, true);
      }
      return stored ?? job;
    }
  } catch (error) {
    logger.error({ err: error, gameId: job.gameId, jobId: job.jobId }, "Campaign index job advance failed");
  } finally {
    advancing.delete(job.gameId);
  }
  return job;
}

/** Advance every persisted running job once; the scheduler calls this every 30 seconds. */
export async function tickCampaignIndexJobs(app: FastifyInstance) {
  if (!isCampaignOptInEnabled("campaignIndex")) return;

  const games = (await listGames(app, {})) ?? [];
  const chats = createChatsStorage(app.db);
  for (const game of games) {
    const job = readGameJob(game.chats);
    if (job?.status === "done") {
      const uncoveredChatIds: string[] = [];
      const fingerprints: Record<string, string> = {};
      for (const chatId of job.order) {
        const chat = await chats.getById(chatId);
        if (!chat || !shouldAutoRepairCompletedSession(chat.metadata)) continue;
        const inventory = (await readContinuityInventory(app, chatId, {
          includePreparedSources: true,
        })) as DetailedInventory | null;
        if (!inventory) continue;
        const current = coverage(inventory, await app.gameContinuity.list(chatId));
        if (current.range && shouldRetryCoverageRepair(job, chatId, current.fingerprint)) {
          uncoveredChatIds.push(chatId);
          fingerprints[chatId] = current.fingerprint;
        }
      }
      const expected = structuredClone(job);
      if (reopenCompletedJob(job, uncoveredChatIds, fingerprints)) {
        // Persist the retry bound before any provider work can be accepted. A crash must not restart it forever.
        if (!(await persistJob(app, job, expected))) continue;
      }
    }
    if (job?.status === "running") await advanceJob(app, job);
  }
}

async function cancelJob(
  app: FastifyInstance,
  job: CampaignIndexJob,
  cleanupOnly = false,
): Promise<{ job: CampaignIndexJob; retired: number; removedManifests: string[] }> {
  if (job.steps.backfill) requireCampaignOptIn("gameContinuity");
  const storage = createGameContinuityStorage(app.db);
  const chats = createChatsStorage(app.db);
  let retired = 0;
  const removedManifests: string[] = [];
  const expected = structuredClone(job);
  job.status = "cancelled";
  job.history.push({ at: new Date().toISOString(), chatId: null, event: "cancelled" });
  // Publish the cancellation before any awaited receipt cleanup, so advances stop immediately.
  if (!cleanupOnly && !(await persistJob(app, job, expected))) {
    const current = await storedJob(app, job);
    // An advance may have saved progress while cancellation waited for the queue.
    if (current?.jobId === job.jobId && (current.status === "running" || current.status === "paused"))
      return cancelJob(app, current);
    return { job: current ?? job, retired, removedManifests };
  }
  for (const chatId of job.order) {
    if (job.steps.backfill) requireCampaignOptIn("gameContinuity");
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
      if (job.steps.backfill) requireCampaignOptIn("gameContinuity");
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
    if (job.steps.backfill) requireCampaignOptIn("gameContinuity");
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
  await app.db.transaction(async () => undefined, { durable: true });
  return { job, retired, removedManifests };
}

export async function campaignIndexRoutes(app: FastifyInstance) {
  app.addHook("preHandler", async (_request, reply) => {
    if (rejectCampaignFeatureWhenDisabled(reply, "campaignIndex")) return reply;
  });

  const describeGames = async (
    scope: { gameId?: string; chatId?: string; chatIds?: string[] },
    options: { owners: boolean; totals: boolean },
  ) => {
    const games = await listGames(app, scope);
    if (!games) return null;
    const described = [];
    for (const game of games) {
      const lineage = scope.chatId ? await campaignLineageSnapshot(app, game.gameId, scope.chatId) : null;
      const selectedChatIds = lineage
        ? new Set([scope.chatId!, ...lineage.sessions.map((session) => session.chatId)])
        : null;
      const selectedChats = selectedChatIds ? game.chats.filter((chat) => selectedChatIds.has(chat.id)) : game.chats;
      const chats = [];
      for (const chat of selectedChats) {
        chats.push(await describeChat(app, chat, options));
        // Each session's owner preview is seconds of synchronous work; yield so the rest of the Engine
        // (avatars, status polls, the chat itself) keeps answering instead of freezing for the whole plan.
        await yieldToEventLoop();
      }
      const whole = scope.chatIds
        ? ((await listGames(app, { gameId: game.gameId }))?.[0]?.chats ?? game.chats)
        : game.chats;
      const lineageView = lineage
        ? {
            targetChatId: scope.chatId!,
            identity: lineage.identity,
            status: lineage.status,
            sessions: lineage.sessions,
            edges: lineage.edges,
            holds: lineage.holds,
          }
        : undefined;
      described.push(gameSummary(game.gameId, chats, readGameJob(whole), lineageView));
    }
    return described;
  };

  let timer: ReturnType<typeof setInterval> | null = null;
  const syncScheduler = () => {
    if (isCampaignOptInEnabled("campaignIndex")) {
      if (timer) return;
      timer = setInterval(() => {
        tickCampaignIndexJobs(app).catch((error) =>
          logger.error({ err: error }, "Campaign index scheduler tick failed"),
        );
      }, SCHEDULER_INTERVAL_MS);
      timer.unref();
      return;
    }
    if (timer) clearInterval(timer);
    timer = null;
  };
  const stopFeatureSettingsListener = onFeatureSettingsChange(syncScheduler);
  syncScheduler();
  app.addHook("onClose", async () => {
    stopFeatureSettingsListener();
    if (timer) clearInterval(timer);
  });

  app.get("/campaign-index/plan", async (request, reply) => {
    const parsed = scopeSchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "Invalid campaign index scope" });
    const games = await describeGames(parsed.data, {
      owners: isCampaignOptInEnabled("campaignMemory"),
      totals: false,
    });
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
    if (steps.registerOwners && !isCampaignOptInEnabled("campaignMemory")) {
      rejectCampaignFeatureWhenDisabled(reply, "campaignMemory");
      return reply;
    }
    if ((steps.backfill || steps.publishVerified) && !isCampaignOptInEnabled("gameContinuity")) {
      rejectCampaignFeatureWhenDisabled(reply, "gameContinuity");
      return reply;
    }
    if (steps.publishVerified && !isCampaignOptInEnabled("campaignMemory")) {
      rejectCampaignFeatureWhenDisabled(reply, "campaignMemory");
      return reply;
    }
    if (!scope.chatId)
      return reply.status(400).send({
        error: {
          code: "CAMPAIGN_INDEX_TARGET_REQUIRED",
          message: "Choose a chat to identify the campaign branch to index",
        },
      });
    const games = await listGames(app, scope);
    if (!games) return reply.status(404).send({ error: "Game not found" });
    const lineages = new Map<string, { lineage: CampaignLineageSnapshot; order: string[] }>();
    for (const game of games) {
      const lineage = await campaignLineageSnapshot(app, game.gameId, scope.chatId);
      if (lineage.status !== "ready")
        return reply.status(409).send({
          error: {
            code: "CAMPAIGN_LINEAGE_HELD",
            message: "Campaign history links for this selection could not be verified",
            lineage: {
              targetChatId: scope.chatId,
              identity: lineage.identity,
              status: lineage.status,
              sessions: lineage.sessions,
              edges: lineage.edges,
              holds: lineage.holds,
            },
          },
        });
      let order = lineage.sessions.map((session) => session.chatId);
      if (scope.chatIds) {
        const wanted = new Set(scope.chatIds);
        if (scope.chatIds.some((chatId) => !order.includes(chatId)) || !wanted.has(scope.chatId))
          return reply
            .status(400)
            .send({ error: "Requested sessions must be on the selected chat's campaign lineage" });
        order = order.filter((chatId) => wanted.has(chatId));
      }
      lineages.set(game.gameId, { lineage, order });
    }
    // A run may name only some sessions, but the game's job can be stored on any of its chats.
    const wholeGame = async (game: (typeof games)[number]) =>
      (await listGames(app, { gameId: game.gameId }))?.[0]?.chats ?? game.chats;
    for (const game of games) {
      const job = readGameJob(await wholeGame(game));
      if (job?.status === "running")
        return reply.status(409).send({
          error: { code: "CAMPAIGN_INDEX_RUNNING", message: "Indexing is already running", jobId: job.jobId },
        });
      const selectedLineage = lineages.get(game.gameId)!;
      if (
        job?.status === "paused" &&
        (job.targetChatId !== scope.chatId ||
          job.lineageIdentity !== selectedLineage.lineage.identity ||
          JSON.stringify(job.order) !== JSON.stringify(selectedLineage.order))
      )
        return reply.status(409).send({
          error: {
            code: job.targetChatId === scope.chatId ? "CAMPAIGN_LINEAGE_CHANGED" : "CAMPAIGN_INDEX_PAUSED",
            message:
              "The paused job belongs to a different or changed campaign lineage; cancel it before starting another selection",
            jobId: job.jobId,
          },
        });
    }
    const jobs = [];
    for (const game of games) {
      const selectedLineage = lineages.get(game.gameId)!;
      const owners = [];
      if (steps.registerOwners)
        for (const chatId of selectedLineage.order) {
          requireCampaignOptIn("campaignIndex");
          requireCampaignOptIn("campaignMemory");
          owners.push(await registerOwners(app, chatId));
          requireCampaignOptIn("campaignIndex");
          if (!isCampaignOptInEnabled("campaignMemory")) {
            rejectCampaignFeatureWhenDisabled(reply, "campaignMemory");
            return reply;
          }
          await yieldToEventLoop();
        }
      if (!isCampaignOptInEnabled("campaignIndex")) {
        rejectCampaignFeatureWhenDisabled(reply, "campaignIndex");
        return reply;
      }
      const previous = readGameJob(await wholeGame(game));
      if (!isCampaignOptInEnabled("campaignIndex")) {
        rejectCampaignFeatureWhenDisabled(reply, "campaignIndex");
        return reply;
      }
      const now = new Date().toISOString();
      const job: CampaignIndexJob =
        previous?.status === "paused"
          ? { ...previous, steps, status: "running", lineageHold: undefined }
          : {
              jobId: `campaign-index-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
              gameId: game.gameId,
              targetChatId: scope.chatId,
              lineageIdentity: selectedLineage.lineage.identity,
              order: selectedLineage.order,
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
      // Claim before enqueueing; a racing run/cancel must never be overwritten after provider work.
      if (previous?.status === "running" || !(await persistJob(app, job, previous)))
        return reply
          .status(409)
          .send({ error: { code: "CAMPAIGN_INDEX_RUNNING", message: "Indexing changed while starting" } });
      if (!isCampaignOptInEnabled("campaignIndex")) {
        rejectCampaignFeatureWhenDisabled(reply, "campaignIndex");
        return reply;
      }
      jobs.push({ gameId: game.gameId, owners, job: await advanceJob(app, job) });
    }
    return { jobs };
  });

  app.post("/campaign-index/cancel", async (request, reply) => {
    const parsed = cancelSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "Invalid campaign index cancel request" });
    const games = await listGames(app, { gameId: parsed.data.gameId });
    const job = games ? readGameJob(games[0]?.chats ?? []) : null;
    if (!job || (job.status !== "running" && job.status !== "paused"))
      return reply.status(404).send({ error: "No running campaign index job" });
    if (job.steps.backfill && !isCampaignOptInEnabled("gameContinuity")) {
      rejectCampaignFeatureWhenDisabled(reply, "gameContinuity");
      return reply;
    }
    const result = await cancelJob(app, job);
    if (result.job.jobId !== job.jobId || result.job.status !== "cancelled")
      return reply.status(409).send({ error: "Campaign index job changed before cancellation" });
    return result;
  });
}
