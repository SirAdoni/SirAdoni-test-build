import assert from "node:assert/strict";
import type { GameContinuityReceipt, GameContinuitySource } from "@marinara-engine/shared";
import {
  CONTINUITY_RETRY_ALL_CALLS_PER_BATCH,
  isContinuityPublishOnlyRetry,
  planContinuityRetryAll,
} from "../../packages/server/src/services/game/continuity-retry-all.js";
import { continuityReceiptCovers } from "../../packages/server/src/services/game/continuity-retirement.js";

// Retry all in the Game Memory panel plans every failed, stale or parked batch of one game: publish-only receipts
// cost no model call, superseded copies are skipped, split parents are never re-read, and the estimate counts
// only the batches that need a read.

let clock = Date.parse("2026-01-01T00:00:00.000Z");
function source(messageId: string, hash = `hash-${messageId}`): GameContinuitySource {
  return { messageId, swipeIndex: 0, hash, role: "assistant", content: messageId };
}
function receipt(id: string, patch: Partial<GameContinuityReceipt> = {}): GameContinuityReceipt {
  clock += 60_000;
  const at = new Date(clock).toISOString();
  return {
    id,
    chatId: "game-a",
    sessionNumber: 1,
    sourceHash: `source-${id}`,
    sources: [source(`msg-${id}`)],
    context: [],
    configHash: "config-1",
    config: {},
    status: "failed",
    attempts: 3,
    repairAttempts: 0,
    records: [],
    dispositions: [],
    review: null,
    entryIds: [],
    createdAt: at,
    updatedAt: at,
    ...patch,
  };
}
const cleanReview = { findings: [], dispositions: [] };
const someRecord = { id: "record-1" } as unknown as GameContinuityReceipt["records"][number];

// Published at publication step only: clean review, records, publication error code.
const publishOnly = receipt("publish-only", {
  records: [someRecord],
  review: cleanReview,
  errorCode: "CONTINUITY_MEMORY_WRITE_FAILED",
});
const lorebookOnly = receipt("lorebook-only", {
  records: [someRecord],
  review: cleanReview,
  errorCode: "CONTINUITY_LOREBOOK_FAILED",
});
// Same error code but the reviewer flagged something: it needs a fresh read, not a re-publish.
const flagged = receipt("flagged", {
  records: [someRecord],
  review: {
    findings: [{ kind: "omission", messageId: "msg-flagged", quote: "", recordIds: [], detail: "missing" }],
    dispositions: [],
  },
  errorCode: "CONTINUITY_PUBLICATION_FAILED",
});
const providerFailure = receipt("provider-failure", { errorCode: "CONTINUITY_INVALID_OUTPUT" });
const unresolved = receipt("unresolved", { status: "unresolved", repairAttempts: 3, review: cleanReview });
const parked = receipt("parked", { status: "queued", attempts: 1, errorCode: "CONTINUITY_PROVIDER_AUTH" });
const waitingOwnError = receipt("waiting-own-error", { status: "queued", errorCode: "CONTINUITY_TIMEOUT" });
// A config-changed copy of two turns; a newer grouped read of those turns (and one more) was published since.
const supersededStale = receipt("superseded-stale", {
  status: "stale",
  errorCode: "CONTINUITY_CONFIG_CHANGED",
  sources: [source("turn-1"), source("turn-2")],
});
const supersededFailed = receipt("superseded-failed", { sources: [source("turn-3")] });
const newerPublished = receipt("newer-published", {
  status: "published",
  sources: [source("turn-1"), source("turn-2"), source("turn-3")],
});
// Covered only by an OLDER published batch: still retried, because nothing newer read it.
const olderPublished = receipt("older-published", { status: "published", sources: [source("turn-9")] });
const staleAfterOlder = receipt("stale-after-older", {
  status: "stale",
  errorCode: "CONTINUITY_SOURCE_CHANGED",
  sources: [source("turn-9")],
});
// An edited message: the published read has the old hash, so it does not cover the new text.
const staleEdited = receipt("stale-edited", {
  status: "stale",
  errorCode: "CONTINUITY_SOURCE_CHANGED",
  sources: [source("turn-4", "hash-edited")],
});
const newerPublishedOldHash = receipt("newer-published-old-hash", {
  status: "published",
  sources: [source("turn-4", "hash-original")],
});
const splitParent = receipt("split-parent", {
  status: "stale",
  errorCode: "CONTINUITY_CONTEXT_OVERFLOW",
  config: { splitInto: ["half-a", "half-b"] } as GameContinuityReceipt["config"],
});
const staleHistorical = receipt("stale-historical", {
  status: "stale",
  errorCode: "CONTINUITY_CONFIG_CHANGED",
  config: {
    historicalBackfill: { id: "backfill-test-keep", fromMessageId: "m-1", toMessageId: "m-9", sessionNumber: 1 },
  },
});
const verified = receipt("verified", { status: "verified" });

assert.equal(isContinuityPublishOnlyRetry(publishOnly), true);
assert.equal(isContinuityPublishOnlyRetry(lorebookOnly), true);
assert.equal(isContinuityPublishOnlyRetry(flagged), false, "a flagged review needs a new read");
assert.equal(isContinuityPublishOnlyRetry(providerFailure), false, "no records means nothing to publish");
assert.equal(
  isContinuityPublishOnlyRetry({ ...publishOnly, status: "unresolved" }),
  false,
  "only failed receipts publish again",
);

const plan = planContinuityRetryAll([
  publishOnly,
  lorebookOnly,
  flagged,
  providerFailure,
  unresolved,
  parked,
  waitingOwnError,
  supersededStale,
  supersededFailed,
  newerPublished,
  olderPublished,
  staleAfterOlder,
  staleEdited,
  newerPublishedOldHash,
  splitParent,
  staleHistorical,
  verified,
]);
const actionOf = Object.fromEntries(plan.entries.map((entry) => [entry.id, entry.action]));

assert.deepEqual(actionOf, {
  "publish-only": "publish",
  "lorebook-only": "publish",
  flagged: "requeue",
  "provider-failure": "requeue",
  unresolved: "requeue",
  parked: "release",
  "stale-after-older": "reread",
  "stale-edited": "reread",
  "stale-historical": "backfill",
});
assert.equal(plan.entries.find((entry) => entry.id === "stale-historical")?.backfillId, "backfill-test-keep");
assert.equal(actionOf["waiting-own-error"], undefined, "a batch waiting out its own retry delay is left alone");
assert.equal(actionOf.verified, undefined);
assert.equal(actionOf["newer-published"], undefined);

assert.deepEqual(
  plan.skipped.map((item) => [item.id, item.reason, item.supersededBy ?? null]),
  [
    ["superseded-stale", "superseded", "newer-published"],
    ["superseded-failed", "superseded", "newer-published"],
    ["split-parent", "split", null],
  ],
);
assert.deepEqual(plan.counts, { batches: 9, modelBatches: 7, publishOnly: 2, superseded: 2, split: 1 });
assert.equal(plan.estimatedModelCalls, 7 * CONTINUITY_RETRY_ALL_CALLS_PER_BATCH);
assert.equal(
  continuityReceiptCovers(newerPublished, {
    ...supersededFailed,
    sources: [{ ...source("turn-3"), content: undefined } as unknown as GameContinuitySource],
  }),
  false,
  "malformed legacy source text never counts as covered",
);

// Nothing to do: an all-published game plans an empty run with no calls.
const empty = planContinuityRetryAll([newerPublished, verified]);
assert.deepEqual(empty.counts, { batches: 0, modelBatches: 0, publishOnly: 0, superseded: 0, split: 0 });
assert.equal(empty.estimatedModelCalls, 0);

// Publish-only work alone costs no model call.
const publishOnlyPlan = planContinuityRetryAll([publishOnly, lorebookOnly]);
assert.equal(publishOnlyPlan.counts.publishOnly, 2);
assert.equal(publishOnlyPlan.estimatedModelCalls, 0);

console.log("continuity retry-all plan regression passed");
