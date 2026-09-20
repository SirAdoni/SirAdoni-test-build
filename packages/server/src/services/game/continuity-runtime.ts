import {
  CONTINUITY_SOURCE_RETIRED,
  continuityReceiptCovers,
  continuitySourceListsMatch,
  findSourceChangedReceipts,
  planContinuityReanchor,
  reanchorContinuityReceipt,
  retireContinuityReceipt,
} from "./continuity-retirement.js";
import { createHash } from "node:crypto";
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
import { createDiagnostic } from "../../lib/diagnostics.js";
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
  const pauseProvider = (code: string, reason: string): void => {
    if (Date.now() < providerPausedUntil) return; // a concurrent worker already started this pause
    providerDelayMs = providerDelayMs ? Math.min(providerDelayMs * 2, backoff.max) : backoff.initial;
    providerPausedUntil = Date.now() + providerDelayMs;
    pauseCode = code;
    logger.warn(
      { code, delayMs: providerDelayMs },
      "[game-continuity] %s; pausing continuity work for %dms",
      reason,
      providerDelayMs,
    );
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
          logger.warn({ err: error, receiptId: older.id }, "[game-continuity] could not retire replaced receipt");
        }
      }
    }
    if (before?.status !== "published" && published?.status === "published" && options.onPublished) {
      try {
        await options.onPublished(published);
      } catch (error) {
        createDiagnostic(
          error,
          { operation: "game.continuity", stage: "published-callback", chatId: published.chatId },
          "CONTINUITY_PUBLISHED_CALLBACK_FAILED",
        );
        logger.error(
          { err: error, code: "CONTINUITY_PUBLISHED_CALLBACK_FAILED", receiptId: published.id },
          "[game-continuity] published callback failed",
        );
      }
    }
    return published;
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
    return storage.save({ ...receipt, status, updatedAt: new Date().toISOString() });
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
      { code: CONTINUITY_CONTEXT_OVERFLOW, receiptId: receipt.id, splitInto },
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
        if (!stopped) logger.warn({ code, receiptId: id }, "[game-continuity] transient provider failure");
        return true;
      }
      if (isContextOverflow(code, message)) {
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
      if (!stopped) logger.warn(error, "[game-continuity] worker stage failed for receipt %s", id);
      return !stale && currentReceipt.attempts < 3;
    } finally {
      if (abort) controllers.delete(abort);
    }
  };

  let retiredConfigChanged = 0;
  async function pump(): Promise<void> {
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
            (await readContinuityConfig(db, candidate.chatId)).mode === "shadow"
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
        const queuedConfig = await readContinuityConfig(db, item.chatId, {
          allowHistoricalBackfill: isHistoricalBackfill(queued),
        });
        if (queuedConfig.hash !== queued.configHash) {
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
        void process(item.id, mode)
          .catch((error) => {
            logger.error(error, "[game-continuity] worker promise failed for receipt %s", item.id);
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
        pauseProvider(CONTINUITY_PROVIDER_UNAVAILABLE, "continuity connection is unavailable");
        retryAfterPause = true;
        if (!stopped) logger.warn({ code }, "[game-continuity] admission paused; pending work remains queued");
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
      if (active === 0 && pending.length === 0) idleResolvers.splice(0).forEach((resolve) => resolve());
      if (retryAfterPause && !stopped) void pump();
    }
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
    await ensureContinuityHolderReferences(db, input.chatId);
    const holderSnapshot = await captureContinuityHolderSnapshot(db, input.chatId);
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
      // A retired receipt keeps its id. If the same text comes back (an undone edit, a swipe back), read it
      // again under a new id instead of finding the retired row and leaving the turn with no memory.
      let id = `gcb_${hash({ chatId: input.chatId, sourceHash, configHash: input.config.hash }).slice(0, 40)}`;
      for (let revival = 1; revival <= 20; revival += 1) {
        const prior = input.existing.find((candidate) => candidate.id === id) ?? (await storage.get(id));
        if (!prior || prior.errorCode !== CONTINUITY_SOURCE_RETIRED) break;
        id = `gcb_${hash({ chatId: input.chatId, sourceHash, configHash: input.config.hash, revival }).slice(0, 40)}`;
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

  return {
    async start() {
      if (stopped) return;
      for (let receipt of await storage.list()) {
        if (stopped) return;
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
                { err: error, receiptId: receipt.id },
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
            logger.warn(error, "[game-continuity] unable to resolve receipt config %s", receipt.id);
            await persistPublicationFailure(receipt, "CONTINUITY_CONFIG_UNAVAILABLE");
            continue;
          }
          if (config.mode === "active" && config.hash === receipt.configHash) {
            try {
              await publishActual(receipt.id);
            } catch (error) {
              await persistPublicationFailure(receipt, error);
              logger.error(error, "[game-continuity] startup publication failed for receipt %s", receipt.id);
            }
          } else if (config.mode === "active" && config.hash !== receipt.configHash) {
            await storage.save({
              ...receipt,
              status: "stale",
              errorCode: "CONTINUITY_CONFIG_CHANGED",
              error: "Configuration changed after verification.",
            });
          }
        } else if (resumable(receipt.status)) {
          if (receipt.attempts >= 3 && (receipt.errorCode || receipt.error))
            await storage.save({
              ...receipt,
              status: "failed",
              errorCode: "CONTINUITY_ATTEMPTS_EXCEEDED",
              error: "The worker reached its retry limit during restart recovery.",
            });
          else enqueuePending(receipt);
        }
      }
      for (const chat of await chats.list()) if (!stopped && chat.mode === "game") await this.reconcileChat(chat.id);
    },
    async reconcileChat(chatId: string, reconcileOptions: { changedMessageIds?: Iterable<string> } = {}) {
      if (stopped) return [];
      const chat = await chats.getById(chatId);
      if (!chat || chat.mode !== "game") return [];
      const changedMessageIds = [...(reconcileOptions.changedMessageIds ?? [])];
      if (changedMessageIds.length > 0) {
        // Edits, deletes, hides and swipes take the memory read from the old text back out, whatever the mode.
        try {
          const current = prepareContinuitySources(await chats.listMessages(chatId), objectValue(chat.metadata));
          for (const receipt of findSourceChangedReceipts(await storage.list(chatId), current, changedMessageIds)) {
            const reanchoredSources = planContinuityReanchor(receipt, current);
            if (reanchoredSources) {
              await reanchorContinuityReceipt(db, receipt.id, reanchoredSources);
              continue;
            }
            await retireContinuityReceipt(
              db,
              receipt.id,
              "A message this receipt was read from was edited, deleted, hidden or swiped away.",
            );
          }
        } catch (error) {
          logger.warn({ err: error, chatId }, "[game-continuity] could not retire receipts for changed messages");
        }
      }
      let config: Awaited<ReturnType<typeof readContinuityConfig>>;
      try {
        config = await readContinuityConfig(db, chatId);
      } catch (error) {
        logger.warn(error, "[game-continuity] unable to reconcile chat %s", chatId);
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
      for (const message of messages.filter((candidate) => candidate.role === "assistant")) {
        const messageIndex = messages.indexOf(message);
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
    },
    async stop() {
      stopped = true;
      pending.length = 0;
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
      const config = await readContinuityConfig(db, input.chatId);
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
      for (const message of messages) {
        const messageIndex = messages.indexOf(message);
        if (messageIndex < fromIndex || messageIndex > toIndex || message.role !== "assistant") continue;
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
          const receipt: GameContinuityReceipt = {
            id: `gch_${hash({ chatId: input.chatId, sourceHash, configHash: config.hash }).slice(0, 40)}`,
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
      for (const receipt of receipts) {
        const result = await publishActual(receipt.id, true);
        if (result) published.push(result);
      }
      return published;
    },
    async list(chatId?: string) {
      return storage.list(chatId);
    },
    get: storage.get,
    async retry(chatId: string, batchId?: string) {
      if (stopped) return null;
      const list = await storage.list(chatId);
      const target = batchId
        ? list.find((item) => item.id === batchId)
        : list.find((item) => ["failed", "unresolved", "stale"].includes(item.status));
      if (!target || target.status === "published") return target ?? null;
      if (resumable(target.status)) throw new Error("CONTINUITY_BUSY");
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
          if (config.mode === "active" && config.hash === receipt.configHash) {
            try {
              await publishActual(receipt.id);
            } catch (error) {
              await persistPublicationFailure(receipt, error);
              logger.error(error, "[game-continuity] resume publication failed for receipt %s", receipt.id);
            }
          }
        } else if (resumable(receipt.status) && (receipt.attempts < 3 || (!receipt.errorCode && !receipt.error)))
          enqueuePending(receipt);
      }
      return storage.list(chatId);
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
