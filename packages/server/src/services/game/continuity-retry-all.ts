import type { GameContinuityReceipt } from "@marinara-engine/shared";
import { continuityReceiptCovers } from "./continuity-retirement.js";

/**
 * "Retry all" in the Game Memory panel: one plan for every failed, stale or parked continuity batch of a chat.
 *
 * The plan is pure so the dry run the confirmation shows and the run that follows classify batches the same way.
 * Each action maps onto an existing per-batch path; nothing here sends a request or books the hourly cap:
 * - `publish`: failed only at publication (memory write, lorebook, publication step) after a clean review.
 *   The runtime's publish-only retry re-publishes it with no model call.
 * - `requeue`: failed or unresolved; a fresh read through the continuity queue.
 * - `release`: waiting but parked by a rejected key or a missing connection; the retry releases the chat's
 *   parked work instead of waiting for the unpark timer.
 * - `reread`: stale live batch; the runtime queues a fresh read of its last assistant turn.
 * - `backfill`: stale historical batch; re-planned once per backfill manifest, as its own panel does.
 * Everything except `publish` becomes queued work whose stage calls book the background call cap when they run.
 */

export type ContinuityRetryAllAction = "publish" | "requeue" | "release" | "reread" | "backfill";

export interface ContinuityRetryAllEntry {
  id: string;
  action: ContinuityRetryAllAction;
  /** Set for `backfill`: the manifest the batch is re-planned under. */
  backfillId?: string;
}

export interface ContinuityRetryAllSkip {
  id: string;
  /** `superseded`: a newer published batch already read every message; `split`: replaced by its halves. */
  reason: "superseded" | "split";
  supersededBy?: string;
}

export interface ContinuityRetryAllPlan {
  entries: ContinuityRetryAllEntry[];
  skipped: ContinuityRetryAllSkip[];
  counts: {
    /** Batches the run acts on (model and publish-only). */
    batches: number;
    /** Batches that need a model read. */
    modelBatches: number;
    /** Batches that only publish again, with no model call. */
    publishOnly: number;
    superseded: number;
    split: number;
  };
  /** Rough paid calls on the continuity connection: a read and a check per model batch, before any repair. */
  estimatedModelCalls: number;
}

/** Calls one batch costs at best: an extraction read and a review. Repairs add more, so this is a floor. */
export const CONTINUITY_RETRY_ALL_CALLS_PER_BATCH = 2;

const PARK_REASONS = new Set(["CONTINUITY_PROVIDER_AUTH", "CONTINUITY_CONNECTION_UNAVAILABLE"]);
const WAITING = new Set<GameContinuityReceipt["status"]>(["queued", "extracting", "reviewing", "repairing"]);

/** A waiting batch whose last error parked its chat (rejected key, missing connection). */
export function isContinuityParkReason(errorCode: string | undefined): boolean {
  return PARK_REASONS.has(errorCode ?? "");
}

/**
 * A clean, reviewed receipt that only failed to publish needs no new model read: the runtime puts it back to
 * verified and publishes it again. Shared by the per-batch Retry and Retry all so both classify it the same way.
 */
export function isContinuityPublishOnlyRetry(
  receipt: Pick<GameContinuityReceipt, "status" | "records" | "review" | "errorCode">,
): boolean {
  return (
    receipt.status === "failed" &&
    receipt.records.length > 0 &&
    receipt.review !== null &&
    receipt.review.findings.length === 0 &&
    /^CONTINUITY_(MEMORY_|PUBLICATION|LOREBOOK)/.test(receipt.errorCode ?? "")
  );
}

function isNewer(candidate: GameContinuityReceipt, than: GameContinuityReceipt): boolean {
  return Date.parse(candidate.createdAt) > Date.parse(than.createdAt);
}

export function planContinuityRetryAll(receipts: GameContinuityReceipt[]): ContinuityRetryAllPlan {
  const published = receipts
    .filter((receipt) => receipt.status === "published")
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  const entries: ContinuityRetryAllEntry[] = [];
  const skipped: ContinuityRetryAllSkip[] = [];

  for (const receipt of receipts) {
    const retryable = receipt.status === "failed" || receipt.status === "unresolved" || receipt.status === "stale";
    const parked = WAITING.has(receipt.status) && isContinuityParkReason(receipt.errorCode);
    if (!retryable && !parked) continue;

    if (receipt.status === "stale") {
      const splitInto = (receipt.config as { splitInto?: unknown }).splitInto;
      if (Array.isArray(splitInto) && splitInto.length > 0) {
        skipped.push({ id: receipt.id, reason: "split" });
        continue;
      }
    }
    // Text a newer published batch already read (for example a CONTINUITY_CONFIG_CHANGED copy whose turns were
    // queued again and published) would cost a paid read for memory that is already there.
    if (retryable) {
      const cover = published.find(
        (candidate) =>
          candidate.id !== receipt.id && isNewer(candidate, receipt) && continuityReceiptCovers(candidate, receipt),
      );
      if (cover) {
        skipped.push({ id: receipt.id, reason: "superseded", supersededBy: cover.id });
        continue;
      }
    }

    if (parked) entries.push({ id: receipt.id, action: "release" });
    else if (isContinuityPublishOnlyRetry(receipt)) entries.push({ id: receipt.id, action: "publish" });
    else if (receipt.status === "stale" && receipt.config.historicalBackfill)
      entries.push({ id: receipt.id, action: "backfill", backfillId: receipt.config.historicalBackfill.id });
    else if (receipt.status === "stale") entries.push({ id: receipt.id, action: "reread" });
    else entries.push({ id: receipt.id, action: "requeue" });
  }

  const publishOnly = entries.filter((entry) => entry.action === "publish").length;
  const modelBatches = entries.length - publishOnly;
  return {
    entries,
    skipped,
    counts: {
      batches: entries.length,
      modelBatches,
      publishOnly,
      superseded: skipped.filter((skip) => skip.reason === "superseded").length,
      split: skipped.filter((skip) => skip.reason === "split").length,
    },
    estimatedModelCalls: modelBatches * CONTINUITY_RETRY_ALL_CALLS_PER_BATCH,
  };
}
