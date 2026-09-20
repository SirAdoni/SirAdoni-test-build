import assert from "node:assert/strict";

// The campaign index publishes a session manifest by manifest. A manifest used to be publishable only when every
// batch in it had verified, so one batch the reviewer left unresolved held back every verified batch beside it,
// while the job still reported the session as published (Session 1 published 4 of 11 verified batches, Session 2
// 9 of 29). A finished manifest now publishes whatever verified; a manifest still being processed never does.
const { manifestSummary } = await import("../../packages/server/src/routes/campaign-index.routes.js");

const manifest = (countsByStatus: Record<string, number>, missing: string[] = []) => ({
  id: "historical-continuity-x",
  fromMessageId: "a",
  toMessageId: "b",
  sessionNumber: 1,
  rangeValid: true,
  receiptIds: Array.from({ length: Object.values(countsByStatus).reduce((a, b) => a + b, 0) }, (_, i) => `gch_${i}`),
  missingReceiptIds: missing,
  countsByStatus,
  countsByErrorCode: {},
  coverageGaps: [],
});

assert.equal(manifestSummary(manifest({ verified: 3 }) as never).publishable, true, "all verified publishes");
assert.equal(
  manifestSummary(manifest({ verified: 7, unresolved: 3 }) as never).publishable,
  true,
  "a finished manifest publishes its verified batches despite unresolved ones",
);
assert.equal(
  manifestSummary(manifest({ verified: 7, failed: 1, published: 2 }) as never).publishable,
  true,
  "failed and already-published batches do not block the rest",
);
assert.equal(
  manifestSummary(manifest({ verified: 7, reviewing: 1 }) as never).publishable,
  false,
  "a manifest still being processed waits",
);
assert.equal(manifestSummary(manifest({ unresolved: 2 }) as never).publishable, false, "nothing verified, nothing to publish");
assert.equal(
  manifestSummary(manifest({ verified: 2 }, ["gch_missing"]) as never).publishable,
  false,
  "a manifest with missing receipts is not trusted",
);

console.log("campaign-index-partial-publish regression passed");
