import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createChatsStorage } from "../services/storage/chats.storage.js";
import { prepareContinuitySourcesWithExclusions } from "../services/game/continuity-sources.js";
import { logger } from "../lib/logger.js";
import { backgroundCallBudgetSnapshot } from "../services/generation/background-call-budget.js";
import { planContinuityRetryAll } from "../services/game/continuity-retry-all.js";
import { continuityReceiptCovers } from "../services/game/continuity-retirement.js";
import { rejectCampaignFeatureWhenDisabled, requireCampaignOptIn } from "../services/features/campaign-opt-in.js";

import { and, desc, eq, inArray } from "../db/file-query.js";
import { gameStateSnapshots } from "../db/schema/index.js";

const rangeSchema = z.object({
  fromMessageId: z.string().trim().min(1),
  toMessageId: z.string().trim().min(1),
});
const publishSchema = z.object({ confirm: z.literal(true), repairPublished: z.boolean().optional() });
const RETRYABLE_STATUSES = ["failed", "unresolved", "stale"] as const;
const COVERING_RECEIPT_STATUSES = new Set([
  "queued",
  "extracting",
  "reviewing",
  "repairing",
  "verified",
  "published",
  "unresolved",
]);
// Retry all: `dryRun` returns the plan the confirmation shows; `confirm` runs it. Exactly one is required.
const retryAllSchema = z.union([
  z.object({ dryRun: z.literal(true) }).strict(),
  z.object({ confirm: z.literal(true) }).strict(),
]);
/** Chats whose Retry all is enqueueing right now; a second press waits for the first instead of doubling it. */
const retryAllRunning = new Set<string>();
const retrySchema = z.object({
  statuses: z.array(z.enum(RETRYABLE_STATUSES)).min(1).optional(),
  errorCode: z.string().trim().min(1).optional(),
  limit: z.number().int().positive().optional(),
});

function backfillId(chatId: string, fromMessageId: string, toMessageId: string): string {
  return `historical-continuity-${createHash("sha256")
    .update(`${chatId}\u0000${fromMessageId}\u0000${toMessageId}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  const message = errorMessage(error);
  return message.startsWith("CONTINUITY_")
    ? (message.split(":", 1)[0] ?? "CONTINUITY_BACKFILL_FAILED")
    : "CONTINUITY_BACKFILL_FAILED";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Stable digest of a manifest's frozen range; identical input always yields the same hex. */
function rangeHash(chatId: string, fromMessageId: string, toMessageId: string): string {
  return createHash("sha256").update(`${chatId}\u0000${fromMessageId}\u0000${toMessageId}`).digest("hex");
}

/** Stable digest of the whole persisted manifest (range + sorted receipt ids + session). */
function manifestHash(chatId: string, manifest: Record<string, unknown>): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        chatId,
        id: manifest.id,
        fromMessageId: manifest.fromMessageId,
        toMessageId: manifest.toMessageId,
        sessionNumber: manifest.sessionNumber ?? null,
        receiptIds: [...stringList(manifest.receiptIds)].sort(),
      }),
    )
    .digest("hex");
}

export function backfillRecords(metadata: unknown): Array<Record<string, unknown>> {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  const records = (metadata as Record<string, unknown>).gameContinuityBackfills;
  return Array.isArray(records)
    ? records.filter(
        (record): record is Record<string, unknown> => !!record && typeof record === "object" && !Array.isArray(record),
      )
    : [];
}

/** Enqueue one historical range and persist its manifest; shared by the backfill route and campaign indexing. */
export async function startHistoricalBackfill(
  app: FastifyInstance,
  chatId: string,
  range: { fromMessageId: string; toMessageId: string },
  id = backfillId(chatId, range.fromMessageId, range.toMessageId),
) {
  requireCampaignOptIn("gameContinuity");

  const result = await app.gameContinuity.enqueueHistoricalRange({ chatId, backfillId: id, ...range });
  requireCampaignOptIn("gameContinuity");
  const chats = createChatsStorage(app.db);
  await chats.patchMetadata(chatId, (metadata) => {
    const records = backfillRecords(metadata);
    const existing = records.find((record) => record.id === id);
    if (existing) {
      const previousIds = Array.isArray(existing.receiptIds)
        ? existing.receiptIds.filter((receiptId): receiptId is string => typeof receiptId === "string")
        : [];
      existing.receiptIds = [...new Set([...previousIds, ...result.receipts.map((receipt) => receipt.id)])];
      return { gameContinuityBackfills: records };
    }
    return {
      gameContinuityBackfills: [
        ...records,
        {
          id,
          fromMessageId: range.fromMessageId,
          toMessageId: range.toMessageId,
          receiptIds: result.receipts.map((receipt) => receipt.id),
          sessionNumber: result.sessionNumber,
        },
      ],
    };
  });
  await app.db.transaction(async () => undefined, { durable: true });
  return {
    backfillId: id,
    acceptedTurns: result.acceptedTurns,
    sessionNumber: result.sessionNumber,
    receipts: result.receipts,
  };
}

/** Message counts, prepared/excluded sources and frozen manifests with coverage; null when the chat is missing. */
export async function readContinuityInventory(
  app: FastifyInstance,
  chatId: string,
  options: { includePreparedSources?: boolean } = {},
) {
  const chats = createChatsStorage(app.db);
  const chat = await chats.getById(chatId);
  if (!chat) return null;
  const metadata = JSON.parse(chat.metadata || "{}") as unknown;
  const messages = await chats.listMessages(chatId);
  const messageCounts: Record<string, number> = {};
  for (const message of messages) messageCounts[message.role] = (messageCounts[message.role] ?? 0) + 1;
  const { prepared, excluded } = prepareContinuitySourcesWithExclusions(
    messages,
    metadata && typeof metadata === "object" && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : {},
  );
  let acceptedAssistantIds: string[] | undefined;
  if (options.includePreparedSources) {
    const preparedIds = new Set(prepared.map((source) => source.messageId));
    const rawMessageIndex = new Map(messages.map((message, index) => [message.id, index]));
    // Historical backfill deliberately spans the requested history regardless of live activation/mode.
    const acceptedEligible =
      chat.mode === "game"
        ? messages.filter((message) => message.role === "assistant" && preparedIds.has(message.id))
        : [];
    const snapshotRows =
      acceptedEligible.length > 0
        ? await app.db
            .select({
              messageId: gameStateSnapshots.messageId,
              swipeIndex: gameStateSnapshots.swipeIndex,
              committed: gameStateSnapshots.committed,
            })
            .from(gameStateSnapshots)
            .where(
              and(
                eq(gameStateSnapshots.chatId, chatId),
                inArray(
                  gameStateSnapshots.messageId,
                  acceptedEligible.map((message) => message.id),
                ),
              ),
            )
            .orderBy(desc(gameStateSnapshots.createdAt))
        : [];
    const latestCommitted = new Map<string, number>();
    for (const row of snapshotRows) {
      const key = `${row.messageId}:${row.swipeIndex}`;
      if (!latestCommitted.has(key)) latestCommitted.set(key, row.committed);
    }
    acceptedAssistantIds = acceptedEligible
      .filter((message) => {
        const committed = latestCommitted.get(`${message.id}:${message.activeSwipeIndex ?? 0}`);
        const messageIndex = rawMessageIndex.get(message.id) ?? -1;
        return committed === 1 || (committed === undefined && messages[messageIndex + 1]?.role === "user");
      })
      .map((message) => message.id);
  }
  const receipts = await app.gameContinuity.list(chatId);
  const receiptById = new Map(receipts.map((receipt) => [receipt.id, receipt]));
  const receiptCounts: Record<string, number> = {};
  for (const receipt of receipts) receiptCounts[receipt.status] = (receiptCounts[receipt.status] ?? 0) + 1;
  const messageIndex = new Map(messages.map((message, index) => [message.id, index]));
  const manifests = backfillRecords(metadata).map((manifest) => {
    const id = typeof manifest.id === "string" ? manifest.id : "";
    const fromMessageId = typeof manifest.fromMessageId === "string" ? manifest.fromMessageId : "";
    const toMessageId = typeof manifest.toMessageId === "string" ? manifest.toMessageId : "";
    const receiptIds = stringList(manifest.receiptIds);
    const countsByStatus: Record<string, number> = {};
    const countsByErrorCode: Record<string, number> = {};
    const missingReceiptIds: string[] = [];
    const coveringReceipts: Array<Pick<(typeof receipts)[number], "sources">> = [];
    for (const receiptId of receiptIds) {
      const receipt = receiptById.get(receiptId);
      if (!receipt) {
        missingReceiptIds.push(receiptId);
        continue;
      }
      countsByStatus[receipt.status] = (countsByStatus[receipt.status] ?? 0) + 1;
      if (receipt.errorCode) countsByErrorCode[receipt.errorCode] = (countsByErrorCode[receipt.errorCode] ?? 0) + 1;
      if (!COVERING_RECEIPT_STATUSES.has(receipt.status)) continue;
      coveringReceipts.push(receipt);
    }
    const fromIndex = messageIndex.get(fromMessageId) ?? -1;
    const toIndex = messageIndex.get(toMessageId) ?? -1;
    const rangeValid = fromIndex >= 0 && toIndex >= 0 && fromIndex <= toIndex;
    const preparedInRange = rangeValid
      ? prepared.filter((source) => {
          const index = messageIndex.get(source.messageId) ?? -1;
          return index >= fromIndex && index <= toIndex;
        })
      : [];
    return {
      id,
      fromMessageId,
      toMessageId,
      sessionNumber: typeof manifest.sessionNumber === "number" ? manifest.sessionNumber : null,
      rangeValid,
      rangeHash: rangeHash(chatId, fromMessageId, toMessageId),
      manifestHash: manifestHash(chatId, manifest),
      receiptIds,
      missingReceiptIds,
      countsByStatus,
      countsByErrorCode,
      preparedInRange: preparedInRange.length,
      coverageGaps: preparedInRange
        .filter(
          (source) =>
            !continuityReceiptCovers(
              { sources: coveringReceipts.flatMap((receipt) => receipt.sources) },
              { sources: [source] },
            ),
        )
        .map((source) => source.messageId),
    };
  });
  return {
    chatId,
    messageCounts,
    prepared: prepared.map((source) => ({ messageId: source.messageId, role: source.role })),
    ...(options.includePreparedSources ? { preparedSources: prepared } : {}),
    ...(acceptedAssistantIds ? { acceptedAssistantIds } : {}),
    excluded,
    receiptCounts,
    manifests,
  };
}

export async function gameContinuityBackfillRoutes(app: FastifyInstance) {
  app.addHook("preHandler", async (_request, reply) => {
    if (rejectCampaignFeatureWhenDisabled(reply, "gameContinuity")) return reply;
  });

  app.post<{ Params: { chatId: string } }>("/:chatId/continuity/backfill", async (request, reply) => {
    const parsed = rangeSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "Invalid historical continuity range" });
    try {
      return await startHistoricalBackfill(app, request.params.chatId, parsed.data);
    } catch (error) {
      const code = errorCode(error);
      if (code === "CONTINUITY_BACKFILL_FAILED") {
        logger.error({ err: error, chatId: request.params.chatId }, "Historical continuity backfill start failed");
        return reply.status(500).send({ error: { code, message: "Historical continuity backfill failed" } });
      }
      logger.warn({ err: error, chatId: request.params.chatId, code }, "Historical continuity backfill start rejected");
      return reply
        .status(400)
        .send({ error: { code, message: "Historical continuity backfill request was rejected" } });
    }
  });

  app.get<{ Params: { chatId: string } }>("/:chatId/continuity/inventory", async (request, reply) => {
    const inventory = await readContinuityInventory(app, request.params.chatId);
    if (!inventory) return reply.status(404).send({ error: "Chat not found" });
    return inventory;
  });

  app.post<{ Params: { chatId: string; backfillId: string } }>(
    "/:chatId/continuity/backfill/:backfillId/retry",
    async (request, reply) => {
      const parsed = retrySchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.status(400).send({ error: "Invalid historical continuity retry filter" });
      const chat = await createChatsStorage(app.db).getById(request.params.chatId);
      if (!chat) return reply.status(404).send({ error: "Chat not found" });
      const manifest = backfillRecords(JSON.parse(chat.metadata || "{}")).find(
        (record) => record.id === request.params.backfillId,
      );
      if (!manifest) return reply.status(404).send({ error: "Historical backfill not found" });
      const statuses = new Set<string>(parsed.data.statuses ?? RETRYABLE_STATUSES);
      const limit = parsed.data.limit ?? Number.POSITIVE_INFINITY;
      const receiptById = new Map(
        (await app.gameContinuity.list(request.params.chatId)).map((receipt) => [receipt.id, receipt]),
      );
      const retried: string[] = [];
      const skipped: Array<{ id: string; reason: string }> = [];
      const stale: string[] = [];
      for (const receiptId of stringList(manifest.receiptIds)) {
        const receipt = receiptById.get(receiptId);
        if (!receipt) skipped.push({ id: receiptId, reason: "missing" });
        else if (!statuses.has(receipt.status)) skipped.push({ id: receiptId, reason: `status:${receipt.status}` });
        else if (parsed.data.errorCode && receipt.errorCode !== parsed.data.errorCode)
          skipped.push({ id: receiptId, reason: `errorCode:${receipt.errorCode ?? "none"}` });
        else if (retried.length + stale.length >= limit) skipped.push({ id: receiptId, reason: "limit" });
        else if (receipt.status === "stale") {
          // A split parent is already replaced by its halves; never read it again.
          const splitInto = (receipt.config as { splitInto?: unknown }).splitInto;
          if (Array.isArray(splitInto) && splitInto.length > 0) skipped.push({ id: receiptId, reason: "split" });
          else stale.push(receiptId);
        } else {
          try {
            const result = await app.gameContinuity.retry(request.params.chatId, receiptId);
            if (result) retried.push(receiptId);
            else skipped.push({ id: receiptId, reason: "runtime_stopped" });
          } catch (error) {
            const code = errorCode(error);
            logger.warn(
              { err: error, chatId: request.params.chatId, backfillId: request.params.backfillId, receiptId, code },
              "Historical continuity receipt retry skipped",
            );
            skipped.push({ id: receiptId, reason: code });
          }
        }
      }
      // Stale batches are re-planned under the backfill's own config, once for the whole range. The runtime's
      // retry rebuilt them as live receipts the manifest never tracked (or nothing, with live continuity off).
      // The new receipts join this manifest, so coverage and the explicit publish step both see them.
      const requeued: string[] = [];
      if (stale.length) {
        try {
          const before = new Set(stringList(manifest.receiptIds));
          const rerun = await startHistoricalBackfill(
            app,
            request.params.chatId,
            {
              fromMessageId: String(manifest.fromMessageId),
              toMessageId: String(manifest.toMessageId),
            },
            request.params.backfillId,
          );
          for (const receipt of rerun.receipts) if (!before.has(receipt.id)) requeued.push(receipt.id);
          retried.push(...stale);
        } catch (error) {
          const code = errorCode(error);
          logger.warn(
            { err: error, chatId: request.params.chatId, backfillId: request.params.backfillId, code },
            "Historical continuity stale receipts could not be re-run",
          );
          for (const receiptId of stale) skipped.push({ id: receiptId, reason: code });
        }
      }
      return { backfillId: request.params.backfillId, retried, requeued, skipped };
    },
  );

  app.get<{ Params: { chatId: string; backfillId: string } }>(
    "/:chatId/continuity/backfill/:backfillId",
    async (request, reply) => {
      const chat = await createChatsStorage(app.db).getById(request.params.chatId);
      if (!chat) return reply.status(404).send({ error: "Chat not found" });
      const manifest = backfillRecords(JSON.parse(chat.metadata || "{}")).find(
        (record) => record.id === request.params.backfillId,
      );
      if (!manifest) return reply.status(404).send({ error: "Historical backfill not found" });
      const receiptIds = Array.isArray(manifest?.receiptIds)
        ? new Set(manifest.receiptIds.filter((id): id is string => typeof id === "string"))
        : new Set<string>();
      const receipts = (await app.gameContinuity.list(request.params.chatId)).filter((receipt) =>
        receiptIds.has(receipt.id),
      );
      const counts: Record<string, number> = {};
      for (const receipt of receipts) counts[receipt.status] = (counts[receipt.status] ?? 0) + 1;
      return {
        backfillId: request.params.backfillId,
        manifest,
        receipts: receipts.map((receipt) => ({
          id: receipt.id,
          status: receipt.status,
          sourceHash: receipt.sourceHash,
          entryIds: receipt.entryIds,
          attempts: receipt.attempts,
          errorCode: receipt.errorCode ?? null,
          error: receipt.error ?? null,
        })),
        counts,
      };
    },
  );

  app.post<{ Params: { chatId: string; backfillId: string } }>(
    "/:chatId/continuity/backfill/:backfillId/publish",
    async (request, reply) => {
      const parsed = publishSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.status(400).send({ error: "Explicit publish confirmation is required" });
      const chat = await createChatsStorage(app.db).getById(request.params.chatId);
      if (!chat) return reply.status(404).send({ error: "Chat not found" });
      const manifest = backfillRecords(JSON.parse(chat.metadata || "{}")).find(
        (record) => record.id === request.params.backfillId,
      );
      if (!manifest) return reply.status(404).send({ error: "Historical backfill not found" });
      const receiptIds = Array.isArray(manifest.receiptIds)
        ? manifest.receiptIds.filter((id): id is string => typeof id === "string")
        : [];
      try {
        const published = await app.gameContinuity.publishHistoricalBackfill(
          request.params.chatId,
          request.params.backfillId,
          receiptIds,
          parsed.data.repairPublished === true,
        );
        return { backfillId: request.params.backfillId, published };
      } catch (error) {
        const code = errorCode(error);
        if (code === "CONTINUITY_BACKFILL_FAILED") {
          logger.error(
            { err: error, chatId: request.params.chatId, backfillId: request.params.backfillId },
            "Historical continuity backfill publish failed",
          );
          return reply.status(500).send({ error: { code, message: "Historical continuity publication failed" } });
        }
        logger.warn(
          { err: error, chatId: request.params.chatId, backfillId: request.params.backfillId, code },
          "Historical continuity backfill publish rejected",
        );
        return reply.status(400).send({ error: { code, message: "Historical continuity publication was rejected" } });
      }
    },
  );

  /**
   * Retry every failed, stale or parked continuity batch of a chat in one action (Game Memory panel "Retry all").
   * Each batch goes through the same path as its own Retry: `gameContinuity.retry` for single batches (publish-only
   * for clean receipts that failed at publication, a queued fresh read otherwise) and one historical re-plan per
   * backfill manifest for stale historical batches. Nothing is called inline: model work is queued, and the queue
   * runs it at its normal concurrency and books every stage call against the background call cap, pausing when the
   * hour is spent. Batches a newer published batch already covers are skipped as superseded.
   */
  app.post<{ Params: { chatId: string } }>("/:chatId/continuity/retry-all", async (request, reply) => {
    const parsed = retryAllSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "Send { dryRun: true } or { confirm: true }" });
    const { chatId } = request.params;
    const chat = await createChatsStorage(app.db).getById(chatId);
    if (!chat) return reply.status(404).send({ error: "Chat not found" });
    if (chat.mode !== "game") return reply.status(400).send({ error: "Continuity requires a Game chat" });
    const plan = planContinuityRetryAll(await app.gameContinuity.list(chatId));
    const { used, limit } = backgroundCallBudgetSnapshot();
    const summary = {
      counts: plan.counts,
      estimatedModelCalls: plan.estimatedModelCalls,
      budget: { used, limit },
    };
    if ("dryRun" in parsed.data) return { dryRun: true, ...summary };
    if (retryAllRunning.has(chatId))
      return reply
        .status(409)
        .send({ code: "CONTINUITY_RETRY_ALL_RUNNING", error: "Retry all is already running for this game." });
    retryAllRunning.add(chatId);
    try {
      const retried: string[] = [];
      const published: string[] = [];
      const requeued: string[] = [];
      const skipped: Array<{ id: string; reason: string }> = plan.skipped.map(({ id, reason }) => ({ id, reason }));
      const backfills = new Map<string, string[]>();
      // One at a time: each call only books queue work (or publishes a checked receipt), so the queue, not this
      // loop, decides how many model calls run at once.
      for (const entry of plan.entries) {
        if (entry.action === "backfill") {
          backfills.set(entry.backfillId!, [...(backfills.get(entry.backfillId!) ?? []), entry.id]);
          continue;
        }
        try {
          const result = await app.gameContinuity.retry(chatId, entry.id);
          if (!result) skipped.push({ id: entry.id, reason: "runtime_stopped" });
          else if (entry.action !== "publish") retried.push(entry.id);
          else if (result.status === "published") published.push(entry.id);
          else skipped.push({ id: entry.id, reason: result.errorCode ?? "CONTINUITY_PUBLICATION_FAILED" });
        } catch (error) {
          const code = errorCode(error);
          logger.warn({ err: error, chatId, receiptId: entry.id, code }, "Continuity retry all skipped a batch");
          skipped.push({ id: entry.id, reason: code });
        }
      }
      if (backfills.size) {
        const manifests = backfillRecords(
          JSON.parse((await createChatsStorage(app.db).getById(chatId))?.metadata || "{}"),
        );
        for (const [id, receiptIds] of backfills) {
          const manifest = manifests.find((record) => record.id === id);
          if (!manifest) {
            for (const receiptId of receiptIds) skipped.push({ id: receiptId, reason: "backfill_missing" });
            continue;
          }
          try {
            const before = new Set(stringList(manifest.receiptIds));
            const rerun = await startHistoricalBackfill(
              app,
              chatId,
              { fromMessageId: String(manifest.fromMessageId), toMessageId: String(manifest.toMessageId) },
              id,
            );
            for (const receipt of rerun.receipts) if (!before.has(receipt.id)) requeued.push(receipt.id);
            retried.push(...receiptIds);
          } catch (error) {
            const code = errorCode(error);
            logger.warn(
              { err: error, chatId, backfillId: id, code },
              "Continuity retry all could not re-run a backfill",
            );
            for (const receiptId of receiptIds) skipped.push({ id: receiptId, reason: code });
          }
        }
      }
      return { ...summary, retried, published, requeued, skipped };
    } finally {
      retryAllRunning.delete(chatId);
    }
  });
}
