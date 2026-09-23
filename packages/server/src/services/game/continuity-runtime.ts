import {
  CONTINUITY_SOURCE_RETIRED,
  continuityReceiptCovers,
  continuitySourceListsMatch,
  findSourceChangedReceipts,
  planContinuityReanchor,
  reanchorContinuityReceipt,
  retireContinuityReceipt,
} from "./continuity-retirement.js";
import { createHash, randomUUID } from "node:crypto";
import type { DB } from "../../db/connection.js";
import { createChatsStorage } from "../storage/chats.storage.js";
import { createGameStateStorage } from "../storage/game-state.storage.js";
import { createGameContinuityStorage } from "../storage/game-continuity.storage.js";
import {
  buildGameContinuityExtractionPrompt,
  reviewGameContinuityWithRepairs,
  normalizeGameContinuityExtraction,
  withholdFlaggedContinuityRecords,
} from "./continuity-review.js";
import {
  prepareContinuitySources,
  planContinuityTurnBatches,
  planContinuityTurnGroupBatches,
  validateContinuityManifest,
} from "./continuity-sources.js";
import {
  CONTINUITY_PROVIDER_LIMITED,
  completeContinuityStage,
  readContinuityConfig,
  readContinuityStageTelemetry,
  recordContinuityTelemetry,
  type ContinuityStage,
} from "./continuity-provider.js";
import type { GameContinuityTelemetryEntry } from "../storage/game-continuity.storage.js";
import { publishContinuityReceipt } from "./continuity-publication.js";
import { captureContinuityHolderSnapshot, ensureContinuityHolderReferences } from "./continuity-holder-snapshot.js";
import { logger } from "../../lib/logger.js";
import {
  createDiagnostic,
  getDiagnosticContext,
  markDiagnosticReported,
  runWithRootDiagnosticContext,
  wasDiagnosticReported,
} from "../../lib/diagnostics.js";
import { reportDiagnosticError } from "../../lib/diagnostic-operation.js";
import { logEvent } from "../../lib/log-events.js";
import { registerWorkerGauge } from "../../lib/worker-gauges.js";
import type {
  GameContinuityContextSource,
  GameContinuityMetadata,
  GameContinuityReceipt,
  GameContinuitySource,
} from "@marinara-engine/shared";

type Completion = (args: {
  stage: ContinuityStage;
  prompt: string;
  receipt: GameContinuityReceipt;
  signal: AbortSignal;
}) => Promise<unknown>;
export type ContinuityRuntimeOptions = {
  maxDrainMs?: number;
  complete?: Completion;
  onPublished?: (receipt: GameContinuityReceipt) => void | Promise<void>;
  /** Pause after a provider quota/rate limit: first delay, doubling up to max. */
  providerBackoffMs?: { initial: number; max: number };
  /** Consecutive transient provider failures (timeouts, unavailable) across batches before the pump pauses. */
  unresponsiveThreshold?: number;
  /** Total workers (default 2, or CONTINUITY_MAX_CONCURRENT). Historical backfill keeps one slot free for live turns. */
  maxConcurrent?: number;
  /** Historical backfill workers per chat (default 1, or CONTINUITY_BACKFILL_CONCURRENCY). */
  backfillConcurrency?: number;
  /** Accepted turns per historical receipt (default 1, or CONTINUITY_BACKFILL_TURNS_PER_RECEIPT). */
  backfillTurnsPerReceipt?: number;
};
export type ContinuityRuntime = ReturnType<typeof createGameContinuityRuntime>;

const CONTINUITY_TIMEOUT = "CONTINUITY_TIMEOUT";
const CONTINUITY_PROVIDER_UNAVAILABLE = "CONTINUITY_PROVIDER_UNAVAILABLE";
const CONTINUITY_PROVIDER_UNRESPONSIVE = "CONTINUITY_PROVIDER_UNRESPONSIVE";
const CONTINUITY_CONTEXT_OVERFLOW = "CONTINUITY_CONTEXT_OVERFLOW";
const OVERFLOW_MESSAGE = /context|too long|maximum.*tokens|prompt is too long/i;

/** Stable code of a worker error: the provider's `.code` when present, else the leading CONTINUITY_ token. */
function errorCodeOf(error: unknown, message: string): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^CONTINUITY_[A-Z_]+$/.test(code)) return code;
  return /^CONTINUITY_[A-Z_]+/.exec(message)?.[0] ?? "";
}
function isTransientCode(code: string): boolean {
  return (
    code === CONTINUITY_TIMEOUT ||
    code === CONTINUITY_PROVIDER_UNAVAILABLE ||
    code === "CONTINUITY_CONNECTION_UNAVAILABLE"
  );
}
function isContextOverflow(code: string, message: string): boolean {
  return code === CONTINUITY_CONTEXT_OVERFLOW || (!code && OVERFLOW_MESSAGE.test(message));
}
/**
 * The model ran out of output tokens before finishing its JSON (finish reason "length"). Retrying the same batch
 * pays for the same cut-off answer again; a batch of several messages is split like a context overflow instead.
 */
function isOutputTruncated(error: unknown, message: string): boolean {
  let item: unknown = error;
  for (let depth = 0; item && depth < 6; depth += 1) {
    const text = item instanceof Error ? item.message : String(item);
    const detail = (item as { detail?: unknown }).detail;
    if (/FINISH_length/u.test(text) || (typeof detail === "string" && /FINISH_length/u.test(detail))) return true;
    item = (item as { cause?: unknown }).cause;
  }
  return /FINISH_length/u.test(message);
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "string")
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function resumable(status: GameContinuityReceipt["status"]): boolean {
  return status === "queued" || status === "extracting" || status === "reviewing" || status === "repairing";
}

// Resolved when the runtime is created, never at import time: dotenv loads .env after this module is
// first imported, so an import-time read would always miss the configured values. Declared at module
// scope because the worker body below shadows the global `process` with a function of its own.
function envPositiveInt(key: string, fallback: number): number {
  const parsed = Number(process.env[key]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function createGameContinuityRuntime(db: DB, options: ContinuityRuntimeOptions = {}) {
  const chats = createChatsStorage(db);
  const gameStates = createGameStateStorage(db);
  const storage = createGameContinuityStorage(db);
  const pending: Array<{ id: string; chatId: string }> = [];
  // Chats whose continuity has no usable extraction/review connection. Their work waits here instead of pausing
  // every other chat: one misconfigured session must not stop the whole campaign's memory.
  const parked = new Map<string, Array<{ id: string; chatId: string }>>();
  let unparkTimer: ReturnType<typeof setTimeout> | null = null;
  const UNPARK_DELAY_MS = 10 * 60_000;
  const unparkAll = (): void => {
    unparkTimer = null;
    const items = [...parked.values()].flat();
    parked.clear();
    for (const item of items) if (!pending.some((candidate) => candidate.id === item.id)) pending.push(item);
    if (items.length) void pump();
  };
  const park = (item: { id: string; chatId: string }): void => {
    const list = parked.get(item.chatId) ?? [];
    if (!list.length)
      logger.warn(
        { chatId: item.chatId, code: "CONTINUITY_CONNECTION_UNAVAILABLE" },
        "[game-continuity] no extraction/review connection for this chat; its work waits until one is set",
      );
    if (!list.some((candidate) => candidate.id === item.id)) list.push(item);
    parked.set(item.chatId, list);
    if (!unparkTimer && !stopped) {
      unparkTimer = setTimeout(unparkAll, UNPARK_DELAY_MS);
      unparkTimer.unref?.();
    }
  };
  const activeChats = new Map<string, { mode: "shadow" | "active" | "backfill"; count: number }>();
  const activeIds = new Set<string>();
  const controllers = new Set<AbortController>();
  const idleResolvers: Array<() => void> = [];
  let active = 0;
  let pumping = false;
  let stopped = false;
  // ponytail: one pause for the whole runtime rather than per connection; campaigns normally route
  // continuity through one or two connections. Upgrade to per-connection pauses if that changes.
  const backoff = options.providerBackoffMs ?? { initial: 5 * 60_000, max: 60 * 60_000 };
  // Worker budget. Live turns must never queue behind the historical backlog, so backfill is capped
  // one slot below the total. Historical receipts cover disjoint source ranges and are published in
  // manifest order by an explicit step, so running several of one chat at once cannot reorder canon.
  const maxConcurrent = options.maxConcurrent ?? envPositiveInt("CONTINUITY_MAX_CONCURRENT", 2);
  const backfillPerChat = options.backfillConcurrency ?? envPositiveInt("CONTINUITY_BACKFILL_CONCURRENCY", 1);
  // Historical turns per provider round trip. Live play always stays at one turn per receipt; only the
  // archive pays the round-trip tax often enough for grouping to matter.
  const backfillTurnsPerReceipt = Math.max(
    1,
    options.backfillTurnsPerReceipt ?? envPositiveInt("CONTINUITY_BACKFILL_TURNS_PER_RECEIPT", 1),
  );
  const maxBackfillConcurrent = Math.max(1, Math.min(maxConcurrent - 1, maxConcurrent));
  const perChatLimit = (mode: "shadow" | "active" | "backfill"): number =>
    mode === "shadow" ? 2 : mode === "backfill" ? backfillPerChat : 1;
  const backfillActive = (): number => {
    let total = 0;
    for (const entry of activeChats.values()) if (entry.mode === "backfill") total += entry.count;
    return total;
  };
  let providerPausedUntil = 0;
  let providerDelayMs = 0;
  let resumeTimer: ReturnType<typeof setTimeout> | null = null;
  let pauseCode: string | null = null;
  // Breaker episode bookkeeping for the log: when the first pause of an episode started and how many
  // failures were logged at debug while it was paused. The first answered stage closes the episode.
  let pauseStartedAt = 0;
  let suppressedFailures = 0;
  const isPaused = (): boolean => Date.now() < providerPausedUntil;
  const pauseProvider = (code: string, reason: string): void => {
    if (Date.now() < providerPausedUntil) return; // a concurrent worker already started this pause
    providerDelayMs = providerDelayMs ? Math.min(providerDelayMs * 2, backoff.max) : backoff.initial;
    providerPausedUntil = Date.now() + providerDelayMs;
    pauseCode = code;
    if (!pauseStartedAt) {
      pauseStartedAt = Date.now();
      suppressedFailures = 0;
    }
    logger.warn(
      {
        event: "continuity.breaker",
        state: "running",
        errorCode: code,
        delayMs: providerDelayMs,
        consecutiveFailures: transientFailures,
        affectedJobs: pending.length + active,
      },
      "[game-continuity] %s; pausing continuity work for %dms",
      reason,
      providerDelayMs,
    );
  };
  const closeBreakerEpisode = (): void => {
    if (!pauseStartedAt) return;
    logger.info(
      { event: "continuity.breaker", state: "recovered", pausedMs: Date.now() - pauseStartedAt, suppressedFailures },
      "[game-continuity] provider answered again; continuity work resumed",
    );
    pauseStartedAt = 0;
    suppressedFailures = 0;
  };
  const pauseForProviderLimit = (): void =>
    pauseProvider(CONTINUITY_PROVIDER_LIMITED, "provider rate/usage limit reached");
  // Cross-batch breaker: timeouts and unavailable answers are not any batch's fault, so they never
  // spend attempts; after `unresponsiveThreshold` in a row the whole pump pauses like the limit path.
  const unresponsiveThreshold = Math.max(1, Math.floor(options.unresponsiveThreshold ?? 3));
  let transientFailures = 0;
  const transientReceiptIds = new Set<string>();

  const isHistoricalBackfill = (receipt: Pick<GameContinuityReceipt, "config">): boolean =>
    receipt.config.historicalBackfill !== undefined;
  /** The receipt stamped with the chat's current continuity config, keeping the backfill manifest it belongs to. */
  const refrozen = (
    receipt: GameContinuityReceipt,
    config: Awaited<ReturnType<typeof readContinuityConfig>>,
  ): GameContinuityReceipt => ({
    ...receipt,
    configHash: config.hash,
    config: receipt.config.historicalBackfill
      ? { ...config.frozen, historicalBackfill: receipt.config.historicalBackfill }
      : config.frozen,
  });

  const publishActual = async (id: string, allowHistoricalBackfill = false): Promise<GameContinuityReceipt | null> => {
    const before = await storage.get(id);
    const published = await publishContinuityReceipt(db, id, { allowHistoricalBackfill });
    if (before?.status !== "published" && published?.status === "published") {
      // A fresh read of the same text replaces the older one (for example after a context edit), so its
      // memory is not counted twice.
      for (const older of await storage.list(published.chatId)) {
        if (older.id === published.id || older.status !== "published") continue;
        if (!continuityReceiptCovers(published, older)) continue;
        try {
          await retireContinuityReceipt(db, older.id, `Replaced by receipt ${published.id}, which read the same text.`);
        } catch (error) {
          logger.warn({ err: error, jobId: older.id }, "[game-continuity] could not retire replaced receipt");
        }
      }
    }
    if (before?.status !== "published" && published?.status === "published" && options.onPublished) {
      try {
        await options.onPublished(published);
      } catch (error) {
        reportDiagnosticError(
          error,
          { operation: "game.continuity", stage: "published-callback", chatId: published.chatId, jobId: published.id },
          "CONTINUITY_PUBLISHED_CALLBACK_FAILED",
          { event: "continuity.publish", message: "[game-continuity] published callback failed" },
        );
      }
    }
    return published;
  };

  /**
   * Publish a verified receipt under the chat's current config. Publication does not depend on the extraction
   * config, so a receipt verified under an older one is re-frozen first instead of being thrown away as
   * CONTINUITY_CONFIG_CHANGED (which cost a full model re-read of text that was already checked).
   */
  const publishVerified = async (
    receipt: GameContinuityReceipt,
    config: Awaited<ReturnType<typeof readContinuityConfig>>,
  ): Promise<GameContinuityReceipt | null> => {
    const ready =
      config.hash === receipt.configHash
        ? receipt
        : await storage.save({ ...refrozen(receipt, config), updatedAt: new Date().toISOString() });
    return publishActual(ready.id, isHistoricalBackfill(ready));
  };

  const currentManifest = async (receipt: GameContinuityReceipt): Promise<boolean> => {
    const chat = await chats.getById(receipt.chatId);
    if (!chat) return false;
    return validateContinuityManifest(
      prepareContinuitySources(await chats.listMessages(receipt.chatId), objectValue(chat.metadata)),
      receipt.sources,
      receipt.context,
    );
  };
  const checkpoint = async (
    receipt: GameContinuityReceipt,
    status: GameContinuityReceipt["status"],
  ): Promise<GameContinuityReceipt> => {
    if (stopped) throw new Error("CONTINUITY_STOPPED");
    if (status === "verified") await current(receipt);
    const saved = await storage.save({ ...receipt, status, updatedAt: new Date().toISOString() });
    // Terminal states (failed, stale) get their own job.state line from the caller.
    if (status !== "failed" && status !== "stale")
      logEvent("debug", "job.state", {
        jobKind: "continuity",
        state: "progress",
        stage: status,
        jobId: receipt.id,
        chatId: receipt.chatId,
      });
    return saved;
  };
  const enqueuePending = (receipt: GameContinuityReceipt): void => {
    if (
      stopped ||
      !resumable(receipt.status) ||
      pending.some((item) => item.id === receipt.id) ||
      activeIds.has(receipt.id)
    )
      return;
    pending.push({ id: receipt.id, chatId: receipt.chatId });
    logEvent("debug", "job.state", {
      jobKind: "continuity",
      state: "accepted",
      jobId: receipt.id,
      chatId: receipt.chatId,
      backfill: isHistoricalBackfill(receipt),
      triggeredByRequestId: getDiagnosticContext().requestId,
    });
    void pump();
  };
  /**
   * The prompt did not fit the model context. A batch always covers one accepted turn, so the only
   * splittable unit is its source slice list: two halves are re-enqueued under deterministic ids and
   * the original is journaled as replaced (`stale`, `config.splitInto`). A single-slice batch is never
   * split; it becomes `unresolved` so the loop is bounded.
   */
  const splitOverflowReceipt = async (receipt: GameContinuityReceipt): Promise<void> => {
    const overflowError = "The extraction or review prompt exceeded the model context.";
    if (receipt.sources.length < 2) {
      // Every primary message still gets an explicit disposition with a reason; nothing is published
      // from an unresolved receipt, and any earlier extraction stays in the receipt's journal.
      const reason = `${overflowError} The batch covers a single source slice and cannot be split further.`;
      const dispositions = [...new Set(receipt.sources.map((source) => source.messageId))].map((messageId) => ({
        messageId,
        status: "unresolved" as const,
        reason,
      }));
      await storage.save({
        ...receipt,
        status: "unresolved",
        records: [],
        dispositions,
        review: { findings: [], dispositions },
        errorCode: CONTINUITY_CONTEXT_OVERFLOW,
        error: reason,
        updatedAt: new Date().toISOString(),
      });
      return;
    }
    const middle = Math.ceil(receipt.sources.length / 2);
    const prefix = receipt.id.startsWith("gch_") ? "gch_" : "gcb_";
    const now = new Date().toISOString();
    const halves: GameContinuityReceipt[] = [];
    for (const sources of [receipt.sources.slice(0, middle), receipt.sources.slice(middle)]) {
      const sourceHash = hash({ sources, context: receipt.context });
      const half: GameContinuityReceipt = {
        ...receipt,
        id: `${prefix}${hash({ chatId: receipt.chatId, sourceHash, configHash: receipt.configHash }).slice(0, 40)}`,
        sourceHash,
        sources,
        status: "queued",
        attempts: 0,
        repairAttempts: 0,
        records: [],
        dispositions: [],
        review: null,
        entryIds: [],
        errorCode: undefined,
        error: undefined,
        createdAt: now,
        updatedAt: now,
      };
      halves.push((await storage.enqueue(half)).receipt);
    }
    const splitInto = halves.map((half) => half.id);
    await storage.save({
      ...receipt,
      status: "stale",
      errorCode: CONTINUITY_CONTEXT_OVERFLOW,
      error: `${overflowError} Replaced by ${splitInto.join(", ")}.`,
      config: { ...receipt.config, splitInto } as GameContinuityReceipt["config"],
      updatedAt: now,
    });
    logger.info(
      { errorCode: CONTINUITY_CONTEXT_OVERFLOW, jobId: receipt.id, splitInto },
      "[game-continuity] oversized batch split into two halves",
    );
    for (const half of halves) enqueuePending(half);
  };
  const current = async (receipt: GameContinuityReceipt): Promise<void> => {
    const config = await readContinuityConfig(db, receipt.chatId, {
      allowHistoricalBackfill: isHistoricalBackfill(receipt),
    });
    if (config.mode === "off" && !isHistoricalBackfill(receipt)) throw new Error("CONTINUITY_PAUSED");
    if (config.hash !== receipt.configHash) throw new Error("CONTINUITY_CONFIG_CHANGED");
    if (!(await currentManifest(receipt))) throw new Error("CONTINUITY_SOURCE_CHANGED");
  };

  const process = async (id: string, admittedMode: "shadow" | "active" | "backfill"): Promise<boolean> => {
    let receipt: GameContinuityReceipt | null = null;
    let abort: AbortController | null = null;
    let countedAttempt = false;
    const startedAt = Date.now();
    try {
      if (stopped) return false;
      receipt = await storage.get(id);
      if (!receipt || stopped) return false;
      const startsNewAttempt = receipt.status === "queued" || Boolean(receipt.errorCode || receipt.error);
      countedAttempt = startsNewAttempt;
      if (startsNewAttempt && receipt.attempts >= 3) {
        await checkpoint(
          { ...receipt, errorCode: "CONTINUITY_ATTEMPTS_EXCEEDED", error: "The worker reached its retry limit." },
          "failed",
        );
        logger.warn(
          {
            event: "job.state",
            jobKind: "continuity",
            jobId: id,
            chatId: receipt.chatId,
            attempt: receipt.attempts,
            maxAttempts: 3,
            state: "failed",
            outcome: "failed",
            errorCode: "CONTINUITY_ATTEMPTS_EXCEEDED",
            willRetry: false,
          },
          "[game-continuity] batch reached its retry limit",
        );
        return false;
      }
      let initialConfig: Awaited<ReturnType<typeof readContinuityConfig>>;
      try {
        initialConfig = await readContinuityConfig(db, receipt.chatId, {
          allowHistoricalBackfill: isHistoricalBackfill(receipt),
        });
      } catch (error) {
        receipt = await storage.save({
          ...receipt,
          attempts: receipt.attempts + 1,
          updatedAt: new Date().toISOString(),
        });
        throw error;
      }
      if (initialConfig.mode === "off" && !isHistoricalBackfill(receipt)) return false;
      if (startsNewAttempt) {
        receipt = await storage.save({
          ...receipt,
          attempts: receipt.attempts + 1,
          // A new execution supersedes a prior transient failure diagnostic.
          errorCode: undefined,
          error: undefined,
          updatedAt: new Date().toISOString(),
        });
        logEvent("debug", "job.state", {
          jobKind: "continuity",
          state: "running",
          jobId: id,
          chatId: receipt.chatId,
          attempt: receipt.attempts,
          maxAttempts: 3,
        });
      }
      await current(receipt);
      abort = new AbortController();
      controllers.add(abort);
      const complete: Completion =
        options.complete ?? ((args) => completeContinuityStage(db, args.receipt, args.stage, args.prompt, args.signal));
      const call = async (stage: ContinuityStage, prompt: string): Promise<unknown> => {
        if (stopped) throw new Error("CONTINUITY_STOPPED");
        await current(receipt!);
        const answer = await complete({ stage, prompt, receipt: receipt!, signal: abort!.signal });
        await recordContinuityTelemetry(storage, receipt!.id, readContinuityStageTelemetry(answer));
        // Any answered stage proves the provider is responsive again: close the unresponsive breaker.
        transientFailures = 0;
        transientReceiptIds.clear();
        if (pauseCode === CONTINUITY_PROVIDER_UNRESPONSIVE) pauseCode = null;
        closeBreakerEpisode();
        return answer;
      };
      const chat = await chats.getById(receipt.chatId);
      if (!chat) throw new Error("CONTINUITY_CHAT_NOT_FOUND");
      let initial: {
        records: GameContinuityReceipt["records"];
        dispositions: GameContinuityReceipt["dispositions"];
      } | null = null;
      if (receipt.records.length > 0 || receipt.dispositions.length > 0)
        initial = { records: receipt.records, dispositions: receipt.dispositions };
      else {
        receipt = await checkpoint(receipt, "extracting");
        const config = await readContinuityConfig(db, receipt.chatId, {
          allowHistoricalBackfill: isHistoricalBackfill(receipt),
        });
        let extractionFeedback: string | null = null;
        for (let extractionAttempt = 0; extractionAttempt < 2; extractionAttempt += 1) {
          const raw = await call(
            "extract",
            buildGameContinuityExtractionPrompt({
              chatName: chat.name,
              sessionNumber: receipt.sessionNumber,
              sources: receipt.sources,
              context: receipt.context,
              playerCharacter: config.frozen.playerCharacter,
              instructions: config.frozen.extractionInstructions,
              knowledgeHolders: receipt.knowledgeHolders,
              protocolFeedback: extractionFeedback,
            }),
          );
          try {
            initial = normalizeGameContinuityExtraction(
              raw,
              receipt.sources,
              receipt.id,
              receipt.context,
              receipt.knowledgeHolders,
            );
            break;
          } catch (error) {
            if (extractionAttempt === 1) throw error;
            const badReason = (error instanceof Error ? error.message : String(error)).slice(0, 200);
            logger.debug({ stage: "extract", badReason }, "[game-continuity] retrying invalid extraction response");
            extractionFeedback = `${badReason}. Return only the documented enums and source-grounded fields; do not use belief, rumor, private, world, or unknown as record.kind.`;
          }
        }
        if (!initial) throw new Error("CONTINUITY_INVALID: extraction response was empty");
        receipt = await checkpoint(
          { ...receipt, records: initial.records, dispositions: initial.dispositions, review: null },
          "reviewing",
        );
      }
      const config = await readContinuityConfig(db, receipt.chatId, {
        allowHistoricalBackfill: isHistoricalBackfill(receipt),
      });
      const reviewed = await reviewGameContinuityWithRepairs({
        sources: receipt.sources,
        context: receipt.context,
        playerCharacter: config.frozen.playerCharacter,
        initial,
        batchId: receipt.id,
        initialStage: receipt.status === "repairing" ? "repairing" : "reviewing",
        initialReview: receipt.status === "repairing" || receipt.status === "reviewing" ? receipt.review : null,
        initialRepairAttempts: receipt.repairAttempts,
        verifierInstructions: config.frozen.verificationInstructions,
        repairInstructions: config.frozen.extractionInstructions,
        knowledgeHolders: receipt.knowledgeHolders,
        completeReview: (prompt) => call("review", prompt),
        completeRepair: (prompt) => call("repair", prompt),
        checkpoint: async (stage, extraction, review, repairAttempts) => {
          receipt = await checkpoint(
            { ...receipt!, records: extraction.records, dispositions: extraction.dispositions, review, repairAttempts },
            stage,
          );
        },
      });
      if (reviewed.status === "verified") await current(receipt);
      receipt = await checkpoint(
        {
          ...receipt,
          records: reviewed.extraction.records,
          dispositions: reviewed.extraction.dispositions,
          review: reviewed.review,
          repairAttempts: reviewed.repairAttempts,
          // The current review outcome supersedes an earlier failed execution.
          // Its diagnostic log remains available; do not display it as this outcome's error.
          errorCode: undefined,
          error: undefined,
        },
        reviewed.status,
      );
      providerDelayMs = 0; // the provider answered every stage; the next limit starts a fresh backoff
      if (
        reviewed.status === "verified" &&
        admittedMode === "active" &&
        (await readContinuityConfig(db, receipt.chatId)).mode === "active"
      ) {
        await current(receipt);
        receipt = (await publishActual(receipt.id)) ?? receipt;
      }
      logEvent(
        "info",
        "job.state",
        {
          jobKind: "continuity",
          state: "completed",
          outcome: "ok",
          jobId: id,
          chatId: receipt.chatId,
          attempt: receipt.attempts,
          reviewStatus: reviewed.status,
          published: receipt.status === "published",
          repairAttempts: reviewed.repairAttempts,
          elapsedMs: Date.now() - startedAt,
        },
        "[game-continuity] batch completed",
      );
      return false;
    } catch (error) {
      if (stopped) return false;
      const currentReceipt = await storage.get(id);
      if (!currentReceipt || stopped) return false;
      const message = error instanceof Error ? error.message : String(error);
      const code = errorCodeOf(error, message);
      if (message === "CONTINUITY_PAUSED") return false;
      await recordContinuityTelemetry(
        storage,
        id,
        (error as { telemetry?: GameContinuityTelemetryEntry }).telemetry,
      ).catch((telemetryError) => {
        if (!stopped) logger.warn(telemetryError, "[game-continuity] failed to record stage telemetry for %s", id);
      });
      if (isTransientCode(code)) {
        // A stalled or unreachable provider is not the batch's fault: give back the attempt, keep the
        // receipt at its last durable checkpoint, and trip the cross-batch breaker after N in a row.
        transientFailures += 1;
        transientReceiptIds.add(id);
        const pausedBefore = isPaused();
        const tripped = transientFailures >= unresponsiveThreshold;
        if (tripped) pauseProvider(CONTINUITY_PROVIDER_UNRESPONSIVE, "provider stopped answering continuity stages");
        try {
          await storage.save({
            ...currentReceipt,
            attempts: countedAttempt ? Math.max(0, currentReceipt.attempts - 1) : currentReceipt.attempts,
            errorCode: tripped ? CONTINUITY_PROVIDER_UNRESPONSIVE : code,
            error: tripped
              ? "The extraction or review connection stopped answering; continuity work is paused and resumes automatically."
              : "The extraction or review connection did not answer in time; the batch resumes automatically.",
            updatedAt: new Date().toISOString(),
          });
          if (tripped)
            for (const affectedId of transientReceiptIds) {
              if (affectedId === id) continue;
              const affected = await storage.get(affectedId);
              if (affected && resumable(affected.status) && affected.errorCode !== CONTINUITY_PROVIDER_UNRESPONSIVE)
                await storage.save({
                  ...affected,
                  errorCode: CONTINUITY_PROVIDER_UNRESPONSIVE,
                  updatedAt: new Date().toISOString(),
                });
            }
        } catch (checkpointError) {
          if (!stopped) logger.error(checkpointError, "[game-continuity] failed to persist transient failure");
        }
        if (!stopped) {
          // While the breaker holds the pump, each receipt's transient failure is expected: debug only.
          if (pausedBefore) suppressedFailures += 1;
          logger[pausedBefore ? "debug" : "warn"](
            { event: "continuity.stage", outcome: "failed", errorCode: code, jobId: id, transient: true },
            "[game-continuity] transient provider failure",
          );
        }
        return true;
      }
      if (
        isContextOverflow(code, message) ||
        (isOutputTruncated(error, message) && currentReceipt.sources.length > 1)
      ) {
        try {
          await splitOverflowReceipt(currentReceipt);
        } catch (splitError) {
          if (!stopped) logger.error(splitError, "[game-continuity] failed to split oversized receipt %s", id);
        }
        return false;
      }
      if (code === CONTINUITY_PROVIDER_LIMITED) {
        // Quota exhaustion is not the batch's fault: give back the attempt this execution counted and
        // keep the batch resumable with a visible reason, then stop the whole runtime for a while.
        if (isPaused()) suppressedFailures += 1;
        pauseForProviderLimit();
        try {
          await storage.save({
            ...currentReceipt,
            attempts: countedAttempt ? Math.max(0, currentReceipt.attempts - 1) : currentReceipt.attempts,
            errorCode: CONTINUITY_PROVIDER_LIMITED,
            error: "The extraction or review connection hit its rate or usage limit; work resumes automatically.",
            updatedAt: new Date().toISOString(),
          });
        } catch (checkpointError) {
          if (!stopped) logger.error(checkpointError, "[game-continuity] failed to persist provider limit");
        }
        return true;
      }
      const stale =
        message === "CONTINUITY_SOURCE_CHANGED" ||
        message === "CONTINUITY_CONTEXT_CHANGED" ||
        message === "CONTINUITY_CONFIG_CHANGED";
      try {
        await checkpoint(
          {
            ...currentReceipt,
            // Stable code for operators and retry filters; the raw provider or storage text stays in `error`.
            errorCode: code || "CONTINUITY_WORKER_FAILED",
            error: (error as { detail?: string }).detail ?? message,
          },
          stale ? "stale" : currentReceipt.attempts >= 3 ? "failed" : currentReceipt.status,
        );
      } catch (checkpointError) {
        if (!stopped) logger.error(checkpointError, "[game-continuity] failed to persist worker error");
      }
      if (!stopped) {
        const final = !stale && currentReceipt.attempts >= 3;
        const willRetry = !stale && currentReceipt.attempts < 3;
        logger[final ? "error" : "warn"](
          {
            event: "job.state",
            jobKind: "continuity",
            jobId: id,
            chatId: currentReceipt.chatId,
            attempt: currentReceipt.attempts,
            maxAttempts: 3,
            state: final ? "failed" : stale ? "expired" : "progress",
            outcome: final ? "failed" : undefined,
            errorCode: code || "CONTINUITY_WORKER_FAILED",
            errorId: createDiagnostic(error).errorId,
            willRetry,
            elapsedMs: Date.now() - startedAt,
            ...(wasDiagnosticReported(error) ? {} : { err: error }),
          },
          "[game-continuity] batch attempt failed",
        );
        markDiagnosticReported(error);
      }
      return !stale && currentReceipt.attempts < 3;
    } finally {
      if (abort) controllers.delete(abort);
    }
  };

  let retiredConfigChanged = 0;
  let refrozenConfigChanged = 0;
  // Receipts per chat, read once per pump pass for the config-change sibling check.
  const chatReceipts = new Map<string, GameContinuityReceipt[]>();
  // The pump runs in its own root context, so admission lines never carry the requestId or stage of
  // whatever request or worker happened to enqueue the job (resumeTimer re-enters here as well).
  function pump(): Promise<void> {
    return runWithRootDiagnosticContext({ operation: "game.continuity.pump" }, pumpQueue);
  }
  async function pumpQueue(): Promise<void> {
    if (pumping || stopped) return;
    const pausedFor = providerPausedUntil - Date.now();
    if (pausedFor > 0) {
      if (!resumeTimer)
        resumeTimer = setTimeout(() => {
          resumeTimer = null;
          void pump();
        }, pausedFor);
      return;
    }
    pumping = true;
    let currentItem: { id: string; chatId: string } | null = null;
    let retryAfterPause = false;
    // Live turns go first; historical backfill (gch_ receipts) only uses capacity live play leaves free.
    // Array.prototype.sort is stable, so arrival order is kept within each group.
    pending.sort((left, right) => Number(left.id.startsWith("gch_")) - Number(right.id.startsWith("gch_")));
    try {
      while (!stopped && active < maxConcurrent) {
        // Give another chat a slot before admitting a second job for one chat, and keep at least one
        // slot free for live turns while historical backfill is running.
        const liveWaiting = pending.some((candidate) => !candidate.id.startsWith("gch_"));
        const admits = async (candidate: { id: string; chatId: string }): Promise<boolean> => {
          const backfill = candidate.id.startsWith("gch_");
          if (backfill && backfillActive() >= (liveWaiting ? maxBackfillConcurrent : maxConcurrent)) return false;
          const occupied = activeChats.get(candidate.chatId);
          if (!occupied) return true;
          if (backfill) return occupied.mode === "backfill" && occupied.count < perChatLimit("backfill");
          return (
            occupied.mode === "shadow" &&
            occupied.count < perChatLimit("shadow") &&
            (await readContinuityConfig(db, candidate.chatId).catch(() => null))?.mode === "shadow"
          );
        };
        let index = -1;
        for (let candidateIndex = 0; candidateIndex < pending.length; candidateIndex += 1) {
          if (await admits(pending[candidateIndex]!)) {
            index = candidateIndex;
            break;
          }
        }
        if (index < 0) break;
        const item = pending.splice(index, 1)[0]!;
        currentItem = item;
        const queued = await storage.get(item.id);
        if (!queued) {
          currentItem = null;
          continue;
        }
        // A receipt can leave the queue while its id still sits here (cancelled, retired, finished elsewhere).
        // Drop it untouched: rewriting a row that is no longer unfinished would erase why it stopped.
        if (!resumable(queued.status)) {
          currentItem = null;
          continue;
        }
        let queuedConfig: Awaited<ReturnType<typeof readContinuityConfig>>;
        try {
          queuedConfig = await readContinuityConfig(db, item.chatId, {
            allowHistoricalBackfill: isHistoricalBackfill(queued),
          });
        } catch (configError) {
          const configMessage = configError instanceof Error ? configError.message : String(configError);
          if (errorCodeOf(configError, configMessage) === "CONTINUITY_CONNECTION_UNAVAILABLE") {
            park(item);
            currentItem = null;
            continue;
          }
          throw configError;
        }
        if (queuedConfig.hash !== queued.configHash) {
          // A receipt that holds no model result yet (nothing extracted, nothing reviewed) loses nothing by being
          // read under the new configuration, so it is re-frozen and read now. Retiring it used to throw away the
          // queue on every settings tweak and left the turns unread until a manual retry or backfill re-run.
          // It is retired as before when another receipt already reads the same text under the current config
          // (a reconcile or backfill re-run made one), so the text is not read twice.
          if (queued.records.length === 0 && queued.dispositions.length === 0 && queued.review === null) {
            let siblings = chatReceipts.get(item.chatId);
            if (!siblings) {
              siblings = await storage.list(item.chatId);
              chatReceipts.set(item.chatId, siblings);
            }
            const superseded = siblings.some(
              (candidate) =>
                candidate.id !== queued.id &&
                candidate.sourceHash === queued.sourceHash &&
                candidate.configHash === queuedConfig.hash &&
                candidate.status !== "stale" &&
                candidate.status !== "failed",
            );
            if (!superseded) {
              const next = await storage.save({
                ...refrozen(queued, queuedConfig),
                updatedAt: new Date().toISOString(),
              });
              siblings.splice(
                siblings.findIndex((candidate) => candidate.id === next.id),
                1,
                next,
              );
              refrozenConfigChanged += 1;
              pending.unshift(item);
              currentItem = null;
              continue;
            }
          }
          // A contract or settings change retires the whole backlog at once: one quiet write per receipt
          // and a single summary line, never a worker plus a warning for each of hundreds of receipts.
          try {
            await storage.save({
              ...queued,
              status: "stale",
              errorCode: "CONTINUITY_CONFIG_CHANGED",
              error:
                "The continuity configuration changed after this batch was queued; re-run the backfill or retry it to process it under the current configuration.",
              updatedAt: new Date().toISOString(),
            });
            retiredConfigChanged += 1;
          } catch (retireError) {
            if (!stopped)
              logger.error(retireError, "[game-continuity] failed to retire config-changed receipt %s", item.id);
          }
          currentItem = null;
          continue;
        }
        const mode = isHistoricalBackfill(queued) ? "backfill" : queuedConfig.mode;
        if (mode !== "active" && mode !== "shadow" && mode !== "backfill") {
          currentItem = null;
          continue;
        }
        const occupied = activeChats.get(item.chatId);
        if (occupied && (occupied.mode !== mode || occupied.count >= perChatLimit(mode))) {
          pending.push(item);
          currentItem = null;
          break;
        }
        activeChats.set(item.chatId, occupied ? { ...occupied, count: occupied.count + 1 } : { mode, count: 1 });
        activeIds.add(item.id);
        active += 1;
        void runWithRootDiagnosticContext(
          {
            operation: "game.continuity",
            operationId: randomUUID(),
            jobId: item.id,
            chatId: item.chatId,
            attempt: queued.attempts + 1,
          },
          () => process(item.id, mode),
        )
          .catch((error) => {
            logger.error(
              { err: error, event: "job.state", jobKind: "continuity", jobId: item.id, chatId: item.chatId },
              "[game-continuity] worker promise failed for receipt %s",
              item.id,
            );
            return false;
          })
          .then(async (shouldRequeue) => {
            const occupied = activeChats.get(item.chatId);
            if (occupied && occupied.count <= 1) activeChats.delete(item.chatId);
            else if (occupied) activeChats.set(item.chatId, { ...occupied, count: occupied.count - 1 });
            activeIds.delete(item.id);
            active -= 1;
            if (!stopped && shouldRequeue) {
              const receipt = await storage.get(item.id);
              if (receipt && resumable(receipt.status) && receipt.attempts < 3) enqueuePending(receipt);
            }
            if (active === 0 && pending.length === 0) idleResolvers.splice(0).forEach((resolve) => resolve());
            void pump();
          })
          .catch((error) => {
            if (!stopped)
              logger.error(error, "[game-continuity] worker completion handling failed for receipt %s", item.id);
          });
        currentItem = null;
      }
    } catch (error) {
      // Admission reads happen outside process(), so a missing connection can otherwise reject the
      // detached pump promise and terminate the host. Put an item back before pausing the whole queue;
      // the timer below gives configuration recovery a bounded retry without a busy loop.
      if (currentItem) {
        pending.unshift(currentItem);
        currentItem = null;
      }
      const message = error instanceof Error ? error.message : String(error);
      const code = errorCodeOf(error, message);
      if (isTransientCode(code)) {
        const pausedBefore = isPaused();
        pauseProvider(CONTINUITY_PROVIDER_UNAVAILABLE, "continuity connection is unavailable");
        retryAfterPause = true;
        if (pausedBefore) suppressedFailures += 1;
        if (!stopped)
          logger[pausedBefore ? "debug" : "warn"](
            { event: "continuity.breaker", errorCode: code, pending: pending.length },
            "[game-continuity] admission paused; pending work remains queued",
          );
      } else if (!stopped) {
        logger.error(error, "[game-continuity] pump admission failed");
      }
    } finally {
      pumping = false;
      if (retiredConfigChanged > 0) {
        logger.info(
          { retired: retiredConfigChanged },
          "[game-continuity] retired %d queued receipts whose continuity configuration changed; re-run the backfill or retry them to reprocess",
          retiredConfigChanged,
        );
        retiredConfigChanged = 0;
      }
      if (refrozenConfigChanged > 0) {
        logger.info(
          { refrozen: refrozenConfigChanged },
          "[game-continuity] moved %d queued receipts with no model work onto the current continuity configuration",
          refrozenConfigChanged,
        );
        refrozenConfigChanged = 0;
      }
      chatReceipts.clear();
      if (active === 0 && pending.length === 0) idleResolvers.splice(0).forEach((resolve) => resolve());
      if (retryAfterPause && !stopped) void pump();
    }
  }

  /**
   * A row that must not be handed back for this id: a retired receipt, or a stale one (source changed, config
   * changed, swiped away) whose text and config match again. Finding it returned the stale row unchanged, so the
   * turn was never read and a retry did nothing; the caller moves on to the next revival id instead. A split
   * parent is already replaced by its halves, and a receipt a campaign index cancelled is revived by the index.
   */
  function occupiesReceiptId(prior: GameContinuityReceipt | null | undefined): boolean {
    if (!prior) return false;
    if (prior.errorCode === CONTINUITY_SOURCE_RETIRED) return true;
    if (prior.status !== "stale") return false;
    const splitInto = (prior.config as { splitInto?: unknown }).splitInto;
    if (Array.isArray(splitInto) && splitInto.length > 0) return false;
    return !prior.configHash.startsWith("cancelled:");
  }

  async function enqueuePreparedBatches(input: {
    chatId: string;
    sessionNumber?: number;
    assistantMessageId: string;
    config: Awaited<ReturnType<typeof readContinuityConfig>>;
    prepared: GameContinuitySource[];
    existing: GameContinuityReceipt[];
  }): Promise<GameContinuityReceipt[]> {
    const receipts: GameContinuityReceipt[] = [];
    // A committed assistant can be intentionally absent from the prepared
    // source list (for example a hidden derived recap or conclusion).  That
    // is a valid source-exclusion result, not a malformed accepted identity;
    // leave the turn unqueued while keeping the planner's strict ID check for
    // callers that invoke it directly.
    if (!input.prepared.some((message) => message.messageId === input.assistantMessageId)) return receipts;
    const batches = planContinuityTurnBatches(input.prepared, input.assistantMessageId, 8000);
    // Taken only when a batch actually needs a new receipt: reconcile walks every committed turn on each boot and
    // edit, and paying a durable holder write plus a snapshot for turns already published cost thousands of each.
    let holderSnapshot: Awaited<ReturnType<typeof captureContinuityHolderSnapshot>> | null = null;
    for (const batch of batches) {
      const sources = batch.sources as GameContinuitySource[];
      const context = batch.context as GameContinuityContextSource[];
      const sourceHash = hash({ sources, context });
      const now = new Date().toISOString();
      // Only the text a receipt reads decides whether it is still current. A change to the surrounding context
      // alone (the tail of the previous turn) does not justify paying for a fresh read of the same text.
      const published = input.existing.find(
        (candidate) =>
          candidate.status === "published" &&
          (candidate.sourceHash === sourceHash || continuitySourceListsMatch(candidate.sources, sources)),
      );
      if (published) {
        receipts.push(published);
        continue;
      }
      // A receipt re-frozen onto the current config after a settings change keeps its old id, so the id below
      // would miss it and queue the same text twice.
      const inFlight = input.existing.find(
        (candidate) =>
          !isHistoricalBackfill(candidate) &&
          candidate.sourceHash === sourceHash &&
          candidate.configHash === input.config.hash &&
          (resumable(candidate.status) || candidate.status === "verified"),
      );
      if (inFlight) {
        receipts.push(inFlight);
        continue;
      }
      // A retired receipt keeps its id. If the same text comes back (an undone edit, a swipe back), read it
      // again under a new id instead of finding the retired row and leaving the turn with no memory.
      let id = `gcb_${hash({ chatId: input.chatId, sourceHash, configHash: input.config.hash }).slice(0, 40)}`;
      for (let revival = 1; revival <= 20; revival += 1) {
        const prior = input.existing.find((candidate) => candidate.id === id) ?? (await storage.get(id));
        if (!occupiesReceiptId(prior)) break;
        id = `gcb_${hash({ chatId: input.chatId, sourceHash, configHash: input.config.hash, revival }).slice(0, 40)}`;
      }
      if (!holderSnapshot) {
        await ensureContinuityHolderReferences(db, input.chatId);
        holderSnapshot = await captureContinuityHolderSnapshot(db, input.chatId);
      }
      const receipt: GameContinuityReceipt = {
        id,
        chatId: input.chatId,
        sessionNumber: input.sessionNumber ?? 0,
        sourceHash,
        sources,
        context,
        configHash: input.config.hash,
        config: input.config.frozen,
        status: "queued",
        attempts: 0,
        repairAttempts: 0,
        records: [],
        dispositions: [],
        review: null,
        knowledgeHolders: holderSnapshot.holders,
        knowledgeHoldersHash: holderSnapshot.hash,
        entryIds: [],
        createdAt: now,
        updatedAt: now,
      };
      const saved = (await storage.enqueue(receipt)).receipt;
      receipts.push(saved);
      if (!input.existing.some((candidate) => candidate.id === saved.id)) input.existing.push(saved);
    }
    for (const receipt of receipts) if (receipt.status !== "published") enqueuePending(receipt);
    return receipts;
  }

  async function persistPublicationFailure(receipt: GameContinuityReceipt, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const stale =
      message === "CONTINUITY_SOURCE_CHANGED" ||
      message === "CONTINUITY_CONTEXT_CHANGED" ||
      message === "CONTINUITY_CONFIG_CHANGED";
    await storage.save({
      ...receipt,
      status: stale ? "stale" : "failed",
      errorCode: /^CONTINUITY_[A-Z_]+$/.test(message) ? message : "CONTINUITY_PUBLICATION_FAILED",
      error: message,
      updatedAt: new Date().toISOString(),
    });
  }

  const unregisterGauge = registerWorkerGauge("continuity", () => ({
    pending: pending.length,
    active,
    pausedUntil: providerPausedUntil > Date.now() ? providerPausedUntil : null,
  }));

  /** One warn for a whole recovery pass instead of one per receipt or chat whose configuration could not be read. */
  type ConfigFailures = {
    count: number;
    firstErrorCode?: string;
    sampleJobId?: string;
    sampleChatId?: string;
    firstError?: unknown;
  };
  const noteConfigFailure = (
    failures: ConfigFailures,
    error: unknown,
    sample: { jobId?: string; chatId?: string },
  ): void => {
    failures.count += 1;
    if (failures.count > 1) return;
    failures.firstError = error;
    failures.firstErrorCode =
      errorCodeOf(error, error instanceof Error ? error.message : String(error)) || createDiagnostic(error).code;
    failures.sampleJobId = sample.jobId;
    failures.sampleChatId = sample.chatId;
  };

  async function reconcileChat(
    chatId: string,
    reconcileOptions: { changedMessageIds?: Iterable<string> },
    configFailures?: ConfigFailures,
  ): Promise<GameContinuityReceipt[]> {
    if (stopped) return [];
    const chat = await chats.getById(chatId);
    if (!chat || chat.mode !== "game") return [];
    const changedMessageIds = [...(reconcileOptions.changedMessageIds ?? [])];
    if (changedMessageIds.length > 0) {
      // Edits, deletes, hides and swipes take the memory read from the old text back out, whatever the mode.
      try {
        const current = prepareContinuitySources(await chats.listMessages(chatId), objectValue(chat.metadata));
        for (const receipt of findSourceChangedReceipts(await storage.list(chatId), current, changedMessageIds)) {
          // Each receipt on its own: one that cannot be rewritten no longer skips every receipt after it.
          try {
            const reanchoredSources = planContinuityReanchor(receipt, current);
            // Storage refuses a reanchor its history cannot survive (null); that receipt is retired instead.
            if (reanchoredSources && (await reanchorContinuityReceipt(db, receipt.id, reanchoredSources))) continue;
            await retireContinuityReceipt(
              db,
              receipt.id,
              "A message this receipt was read from was edited, deleted, hidden or swiped away.",
            );
          } catch (error) {
            logger.warn(
              { err: error, chatId, jobId: receipt.id },
              "[game-continuity] could not reanchor or retire a receipt for changed messages",
            );
          }
        }
      } catch (error) {
        logger.warn({ err: error, chatId }, "[game-continuity] could not retire receipts for changed messages");
      }
    }
    let config: Awaited<ReturnType<typeof readContinuityConfig>>;
    try {
      config = await readContinuityConfig(db, chatId);
    } catch (error) {
      if (configFailures) noteConfigFailure(configFailures, error, { chatId });
      else
        logger.warn(
          { err: error, event: "continuity.reconcile", outcome: "failed", chatId },
          "[game-continuity] unable to reconcile chat %s",
          chatId,
        );
      return [];
    }
    if (config.mode === "off") return storage.list(chatId);
    const metadata = objectValue(chat.metadata);
    const continuity = objectValue(metadata.gameContinuity);
    const boundary = typeof continuity.activationMessageId === "string" ? continuity.activationMessageId : "";
    if (!boundary && typeof continuity.activationAt !== "string") return storage.list(chatId);
    const messages = await chats.listMessages(chatId);
    const boundaryIndex = boundary ? messages.findIndex((message) => message.id === boundary) : -1;
    const chatMetadata = objectValue(chat.metadata);
    const prepared = prepareContinuitySources(messages, chatMetadata);
    const existing = await storage.list(chatId);
    const activationAt = typeof config.activationAt === "string" ? Date.parse(config.activationAt) : Number.NaN;
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
      const message = messages[messageIndex]!;
      if (message.role !== "assistant") continue;
      if (boundaryIndex >= 0 && messageIndex < boundaryIndex) continue;
      if (boundaryIndex < 0 && Number.isNaN(activationAt)) continue;
      if (boundaryIndex < 0 && !Number.isNaN(activationAt) && Date.parse(String(message.createdAt)) < activationAt)
        continue;
      const snapshot = await gameStates.getByMessage(message.id, message.activeSwipeIndex ?? 0);
      const followedByUser = messageIndex + 1 < messages.length && messages[messageIndex + 1]?.role === "user";
      if ((snapshot as { committed?: unknown } | null)?.committed === 1 || (!snapshot && followedByUser)) {
        await enqueuePreparedBatches({
          chatId,
          assistantMessageId: message.id,
          sessionNumber: Number(metadata.gameSessionNumber ?? 0),
          config,
          prepared,
          existing,
        });
      }
    }
    return storage.list(chatId);
  }

  return {
    async start() {
      if (stopped) return;
      const startedAt = Date.now();
      const counts = {
        scanned: 0,
        published: 0,
        publishFailed: 0,
        markedFailed: 0,
        requeued: 0,
        configUnavailable: 0,
      };
      const configFailures: ConfigFailures = { count: 0 };
      for (let receipt of await storage.list()) {
        if (stopped) return;
        counts.scanned += 1;
        // Batches that ended unresolved before withholding existed get the same final step now: the records the
        // reviewer named stay withheld on the receipt and the rest becomes verified, then continues as usual.
        if (receipt.status === "unresolved" && receipt.repairAttempts >= 3 && receipt.review && !receipt.errorCode) {
          const partial = withholdFlaggedContinuityRecords(
            { records: receipt.records, dispositions: receipt.dispositions },
            receipt.review,
          );
          if (partial) {
            try {
              receipt = await storage.save({
                ...receipt,
                status: "verified",
                records: partial.extraction.records,
                dispositions: partial.extraction.dispositions,
                review: partial.review,
                updatedAt: new Date().toISOString(),
              });
            } catch (error) {
              logger.warn(
                { err: error, jobId: receipt.id, chatId: receipt.chatId },
                "[game-continuity] could not withhold flagged records",
              );
            }
          }
        }
        if (isHistoricalBackfill(receipt) && receipt.status === "verified") continue;
        if (receipt.status === "verified") {
          let config: Awaited<ReturnType<typeof readContinuityConfig>>;
          try {
            config = await readContinuityConfig(db, receipt.chatId);
          } catch (error) {
            noteConfigFailure(configFailures, error, { jobId: receipt.id, chatId: receipt.chatId });
            counts.configUnavailable += 1;
            await persistPublicationFailure(receipt, "CONTINUITY_CONFIG_UNAVAILABLE");
            continue;
          }
          if (config.mode === "active") {
            try {
              const result = await publishVerified(receipt, config);
              if (result?.status === "published") counts.published += 1;
            } catch (error) {
              counts.publishFailed += 1;
              await persistPublicationFailure((await storage.get(receipt.id)) ?? receipt, error);
              logger.error(
                {
                  err: error,
                  event: "continuity.publish",
                  outcome: "failed",
                  jobId: receipt.id,
                  chatId: receipt.chatId,
                },
                "[game-continuity] startup publication failed for receipt %s",
                receipt.id,
              );
            }
          }
        } else if (resumable(receipt.status)) {
          if (receipt.attempts >= 3 && (receipt.errorCode || receipt.error)) {
            await storage.save({
              ...receipt,
              status: "failed",
              errorCode: "CONTINUITY_ATTEMPTS_EXCEEDED",
              error: "The worker reached its retry limit during restart recovery.",
            });
            counts.markedFailed += 1;
          } else {
            enqueuePending(receipt);
            counts.requeued += 1;
          }
        }
      }
      const configUnavailableReceipts = configFailures.count;
      for (const chat of await chats.list()) {
        if (stopped) break;
        if (chat.mode !== "game") continue;
        // One chat with malformed memory must not fail the Engine's boot or leave every later chat unreconciled.
        try {
          await reconcileChat(chat.id, {}, configFailures);
        } catch (error) {
          logger.warn(
            { err: error, event: "continuity.reconcile", outcome: "failed", chatId: chat.id },
            "[game-continuity] startup reconcile failed for chat",
          );
        }
      }
      if (stopped) return;
      if (configFailures.count > 0)
        logger.warn(
          {
            event: "job.state",
            jobKind: "continuity",
            state: "recovered",
            outcome: "failed",
            errorCode: "CONTINUITY_CONFIG_UNAVAILABLE",
            firstErrorCode: configFailures.firstErrorCode,
            sampleJobId: configFailures.sampleJobId,
            sampleChatId: configFailures.sampleChatId,
            count: configFailures.count,
            receipts: configUnavailableReceipts,
            chats: configFailures.count - configUnavailableReceipts,
            err: configFailures.firstError,
          },
          "[game-continuity] continuity configuration could not be read for %d receipts or chats during startup recovery",
          configFailures.count,
        );
      logEvent(
        "info",
        "job.state",
        { jobKind: "continuity", state: "recovered", ...counts, elapsedMs: Date.now() - startedAt },
        "[game-continuity] startup recovery finished",
      );
    },
    async reconcileChat(chatId: string, reconcileOptions: { changedMessageIds?: Iterable<string> } = {}) {
      return reconcileChat(chatId, reconcileOptions);
    },
    async stop() {
      stopped = true;
      unregisterGauge();
      pending.length = 0;
      parked.clear();
      if (unparkTimer) clearTimeout(unparkTimer);
      unparkTimer = null;
      if (resumeTimer) clearTimeout(resumeTimer);
      resumeTimer = null;
      controllers.forEach((controller) => controller.abort());
      if (active === 0) return;
      let drainTimer: ReturnType<typeof setTimeout> | null = null;
      try {
        await Promise.race([
          new Promise<void>((resolve) => idleResolvers.push(resolve)),
          new Promise<void>((resolve) => {
            drainTimer = setTimeout(resolve, options.maxDrainMs ?? 5000);
          }),
        ]);
      } finally {
        if (drainTimer) clearTimeout(drainTimer);
      }
    },
    async enqueueCommittedTurn(input: { chatId: string; sessionNumber?: number; assistantMessageId: string }) {
      if (stopped) return null;
      let config: Awaited<ReturnType<typeof readContinuityConfig>>;
      try {
        config = await readContinuityConfig(db, input.chatId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (errorCodeOf(error, message) !== "CONTINUITY_CONNECTION_UNAVAILABLE") throw error;
        // A missing continuity connection must not fail the player's send. The turn is queued by resumeChat
        // (after the connection is set) or by the startup reconcile.
        logger.warn(
          {
            chatId: input.chatId,
            assistantMessageId: input.assistantMessageId,
            code: "CONTINUITY_CONNECTION_UNAVAILABLE",
          },
          "[game-continuity] turn not queued: no extraction/review connection for this chat",
        );
        return null;
      }
      if (config.mode === "off") return null;
      const chat = await chats.getById(input.chatId);
      if (!chat) return null;
      const messages = await chats.listMessages(input.chatId);
      const accepted = messages.find((message) => message.id === input.assistantMessageId);
      if (!accepted) throw new Error("CONTINUITY_ASSISTANT_NOT_FOUND");
      if (accepted.role !== "assistant") throw new Error("CONTINUITY_ACCEPTED_MESSAGE_NOT_ASSISTANT");
      const prepared = prepareContinuitySources(messages, objectValue(chat.metadata));
      const receipts = await enqueuePreparedBatches({
        chatId: input.chatId,
        assistantMessageId: input.assistantMessageId,
        sessionNumber: input.sessionNumber,
        config,
        prepared,
        existing: await storage.list(input.chatId),
      });
      return receipts[0] ?? null;
    },
    async enqueueHistoricalRange(input: {
      chatId: string;
      backfillId: string;
      fromMessageId: string;
      toMessageId: string;
    }) {
      if (stopped) throw new Error("CONTINUITY_STOPPED");
      const chat = await chats.getById(input.chatId);
      if (!chat || chat.mode !== "game") throw new Error("CONTINUITY_CHAT_NOT_FOUND");
      const config = await readContinuityConfig(db, input.chatId, { allowHistoricalBackfill: true });
      const messages = await chats.listMessages(input.chatId);
      const fromIndex = messages.findIndex((message) => message.id === input.fromMessageId);
      const toIndex = messages.findIndex((message) => message.id === input.toMessageId);
      if (fromIndex < 0 || toIndex < 0 || fromIndex > toIndex) throw new Error("CONTINUITY_INVALID_BACKFILL_RANGE");
      const prepared = prepareContinuitySources(messages, objectValue(chat.metadata));
      const preparedIds = new Set(prepared.map((source) => source.messageId));
      const resolvedAccepted: typeof messages = [];
      for (let messageIndex = fromIndex; messageIndex <= toIndex; messageIndex += 1) {
        const message = messages[messageIndex]!;
        if (message.role !== "assistant") continue;
        if (!preparedIds.has(message.id)) continue;
        const snapshot = await gameStates.getByMessage(message.id, message.activeSwipeIndex ?? 0);
        const followedByUser = messageIndex + 1 < messages.length && messages[messageIndex + 1]?.role === "user";
        if ((snapshot as { committed?: unknown } | null)?.committed === 1 || (!snapshot && followedByUser))
          resolvedAccepted.push(message);
      }
      if (resolvedAccepted.length > 50) throw new Error("CONTINUITY_BACKFILL_TURN_LIMIT");
      const metadata = objectValue(chat.metadata);
      const sessionNumber = Number(metadata.gameSessionNumber ?? 0);
      await ensureContinuityHolderReferences(db, input.chatId);
      const holderSnapshot = await captureContinuityHolderSnapshot(db, input.chatId);
      const existing = await storage.list(input.chatId);
      const receipts: GameContinuityReceipt[] = [];
      const backfillConfig = {
        ...config.frozen,
        historicalBackfill: {
          id: input.backfillId,
          fromMessageId: input.fromMessageId,
          toMessageId: input.toMessageId,
          sessionNumber,
        },
      };
      const groups: Array<(typeof resolvedAccepted)[number][]> = [];
      for (let index = 0; index < resolvedAccepted.length; index += backfillTurnsPerReceipt)
        groups.push(resolvedAccepted.slice(index, index + backfillTurnsPerReceipt));
      for (const group of groups) {
        const batches = planContinuityTurnGroupBatches(
          prepared,
          group.map((message) => message.id),
          8000 * group.length,
        );
        for (const batch of batches) {
          const sources = batch.sources as GameContinuitySource[];
          const context = batch.context as GameContinuityContextSource[];
          const sourceHash = hash({ sources, context });
          const now = new Date().toISOString();
          const alreadyPublished = existing.find(
            (candidate) => candidate.status === "published" && candidate.sourceHash === sourceHash,
          );
          if (alreadyPublished) {
            receipts.push(alreadyPublished);
            continue;
          }
          // Same text already in flight for this backfill under the current config (re-frozen with its old id).
          const inFlight = existing.find(
            (candidate) =>
              candidate.config.historicalBackfill?.id === input.backfillId &&
              candidate.sourceHash === sourceHash &&
              candidate.configHash === config.hash &&
              (resumable(candidate.status) || candidate.status === "verified"),
          );
          if (inFlight) {
            receipts.push(inFlight);
            if (inFlight.status !== "verified") enqueuePending(inFlight);
            continue;
          }
          // Re-running a range over a stale receipt of the same text reads it again under a new id.
          let id = `gch_${hash({ chatId: input.chatId, sourceHash, configHash: config.hash }).slice(0, 40)}`;
          for (let revival = 1; revival <= 20; revival += 1) {
            const prior = existing.find((candidate) => candidate.id === id);
            if (!occupiesReceiptId(prior)) break;
            id = `gch_${hash({ chatId: input.chatId, sourceHash, configHash: config.hash, revival }).slice(0, 40)}`;
          }
          const receipt: GameContinuityReceipt = {
            id,
            chatId: input.chatId,
            sessionNumber,
            sourceHash,
            sources,
            context,
            configHash: config.hash,
            config: backfillConfig,
            status: "queued",
            attempts: 0,
            repairAttempts: 0,
            records: [],
            dispositions: [],
            review: null,
            knowledgeHolders: holderSnapshot.holders,
            knowledgeHoldersHash: holderSnapshot.hash,
            entryIds: [],
            createdAt: now,
            updatedAt: now,
          };
          const saved = (await storage.enqueue(receipt)).receipt;
          receipts.push(saved);
          if (!existing.some((candidate) => candidate.id === saved.id)) existing.push(saved);
          if (saved.status !== "published") enqueuePending(saved);
        }
      }
      return { receipts, acceptedTurns: resolvedAccepted.length, sessionNumber };
    },
    async publishHistoricalBackfill(
      chatId: string,
      backfillId: string,
      receiptIds: string[] = [],
      repairPublished = false,
    ) {
      const explicitReceiptIds = new Set(receiptIds);
      const receipts = (await storage.list(chatId)).filter(
        (receipt) =>
          (receipt.status === "verified" || (repairPublished && receipt.status === "published")) &&
          isHistoricalBackfill(receipt) &&
          (receipt.config.historicalBackfill?.id === backfillId || explicitReceiptIds.has(receipt.id)),
      );
      const published: GameContinuityReceipt[] = [];
      // One receipt that cannot publish (its source was edited, a fact conflicts) must not keep the rest of the
      // manifest unpublished, nor make the campaign index job re-throw on every tick. It records why and stops.
      let failed = 0;
      for (const receipt of receipts) {
        try {
          const result = await publishActual(receipt.id, true);
          if (result) published.push(result);
        } catch (error) {
          failed += 1;
          logger.warn(
            { err: error, chatId, backfillId, receiptId: receipt.id },
            "[game-continuity] historical receipt could not publish",
          );
          try {
            const latest = (await storage.get(receipt.id)) ?? receipt;
            if (latest.status !== "published") await persistPublicationFailure(latest, error);
          } catch (persistError) {
            logger.error(persistError, "[game-continuity] could not record publication failure for %s", receipt.id);
          }
        }
      }
      if (failed > 0)
        logger.warn(
          { chatId, backfillId, published: published.length, failed },
          "[game-continuity] historical backfill published %d receipts; %d could not publish",
          published.length,
          failed,
        );
      return published;
    },
    async list(chatId?: string) {
      return storage.list(chatId);
    },
    get: storage.get,
    async retry(chatId: string, batchId?: string) {
      if (stopped) return null;
      const list = await storage.list(chatId);
      // A stale historical batch belongs to its backfill manifest; rebuilding it from its last assistant turn made
      // a live receipt (or nothing, with live continuity off) that the manifest never tracked.
      const staleHistorical = (item: GameContinuityReceipt) => item.status === "stale" && isHistoricalBackfill(item);
      const target = batchId
        ? list.find((item) => item.id === batchId)
        : list.find((item) => ["failed", "unresolved", "stale"].includes(item.status) && !staleHistorical(item));
      if (!target || target.status === "published") return target ?? null;
      if (resumable(target.status)) throw new Error("CONTINUITY_BUSY");
      if (staleHistorical(target)) throw new Error("CONTINUITY_BACKFILL_RERUN_REQUIRED");
      // A clean, reviewed receipt that only failed to publish (memory write, lorebook, publication step) needs no new
      // model read: put it back to verified and publish it again.
      if (
        target.status === "failed" &&
        target.records.length > 0 &&
        target.review !== null &&
        target.review.findings.length === 0 &&
        /^CONTINUITY_(MEMORY_|PUBLICATION|LOREBOOK)/.test(target.errorCode ?? "")
      ) {
        const verified = await storage.save({
          ...target,
          status: "verified",
          errorCode: undefined,
          error: undefined,
          updatedAt: new Date().toISOString(),
        });
        try {
          const config = await readContinuityConfig(db, chatId, {
            allowHistoricalBackfill: isHistoricalBackfill(verified),
          });
          return (await publishVerified(verified, config)) ?? verified;
        } catch (error) {
          await persistPublicationFailure((await storage.get(verified.id)) ?? verified, error);
          logger.warn({ err: error, receiptId: verified.id }, "[game-continuity] publish-only retry failed");
          return storage.get(verified.id);
        }
      }
      if (target.status === "stale") {
        const assistant = [...target.sources].reverse().find((source) => source.role.startsWith("assistant"));
        return assistant
          ? this.enqueueCommittedTurn({
              chatId,
              assistantMessageId: assistant.messageId,
              sessionNumber: target.sessionNumber,
            })
          : target;
      }
      const next = await storage.save({
        ...target,
        status: "queued",
        attempts: 0,
        repairAttempts: 0,
        records: [],
        dispositions: [],
        review: null,
        error: undefined,
        errorCode: undefined,
      });
      enqueuePending(next);
      return next;
    },
    async resumeChat(chatId: string) {
      if (stopped) return [];
      // A settings change may have supplied the missing connection; the rows are re-read below.
      parked.delete(chatId);
      const receipts = await storage.list(chatId);
      for (const receipt of receipts) {
        if (isHistoricalBackfill(receipt) && receipt.status === "verified") continue;
        if (receipt.status === "verified") {
          let config: Awaited<ReturnType<typeof readContinuityConfig>>;
          try {
            config = await readContinuityConfig(db, chatId);
          } catch (error) {
            await persistPublicationFailure(receipt, "CONTINUITY_CONFIG_UNAVAILABLE");
            logger.error(error, "[game-continuity] resume config resolution failed for receipt %s", receipt.id);
            continue;
          }
          if (config.mode === "active") {
            try {
              await publishVerified(receipt, config);
            } catch (error) {
              await persistPublicationFailure((await storage.get(receipt.id)) ?? receipt, error);
              logger.error(error, "[game-continuity] resume publication failed for receipt %s", receipt.id);
            }
          }
        } else if (resumable(receipt.status) && (receipt.attempts < 3 || (!receipt.errorCode && !receipt.error)))
          enqueuePending(receipt);
      }
      // Turns committed while the connection was missing never became receipts (enqueueCommittedTurn skips them);
      // reconciling queues them now that the connection may be back.
      try {
        return await this.reconcileChat(chatId);
      } catch (error) {
        logger.warn({ err: error, chatId }, "[game-continuity] resume reconcile failed for chat");
        return storage.list(chatId);
      }
    },
    async config(chatId: string): Promise<GameContinuityMetadata> {
      const chat = await chats.getById(chatId);
      const value = objectValue(objectValue(chat?.metadata).gameContinuity);
      return {
        mode: value.mode === "active" || value.mode === "shadow" ? value.mode : "off",
        ...(typeof value.extractorConnectionId === "string"
          ? { extractorConnectionId: value.extractorConnectionId }
          : {}),
        ...(typeof value.verifierConnectionId === "string" ? { verifierConnectionId: value.verifierConnectionId } : {}),
        ...(typeof value.extractionInstructions === "string"
          ? { extractionInstructions: value.extractionInstructions }
          : {}),
        ...(typeof value.verificationInstructions === "string"
          ? { verificationInstructions: value.verificationInstructions }
          : {}),
        ...(typeof value.activationMessageId === "string" ? { activationMessageId: value.activationMessageId } : {}),
        ...(typeof value.activationAt === "string" ? { activationAt: value.activationAt } : {}),
      };
    },
    async isIncrementalActive(chatId: string) {
      return (await readContinuityConfig(db, chatId)).mode === "active";
    },
    /** Runtime-wide breaker state: when the pump is paused, why, and how many transient failures are in a row. */
    health() {
      const pausedUntil = providerPausedUntil > Date.now() ? providerPausedUntil : null;
      return { pausedUntil, pauseCode: pausedUntil ? pauseCode : null, transientFailures };
    },
    publish: publishActual,
  };
}
