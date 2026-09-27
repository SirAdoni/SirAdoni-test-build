import assert from "node:assert/strict";

const { coverage, reopenCompletedJob, shouldAutoRepairCompletedSession, shouldRetryCoverageRepair } =
  await import("../../packages/server/src/routes/campaign-index.routes.js");

const assistant = {
  messageId: "long-assistant",
  swipeIndex: 0,
  hash: "whole-message-hash",
  role: "assistant",
  content: "0123456789",
  start: 0,
  end: 10,
};
const user = { ...assistant, messageId: "user", role: "user", content: "next", end: 4, hash: "user-hash" };
const inventory = {
  prepared: [
    { messageId: assistant.messageId, role: assistant.role },
    { messageId: user.messageId, role: user.role },
  ],
  preparedSources: [assistant, user],
  manifests: [],
} as never;
const receipt = (...sources: Array<typeof assistant>) => ({ status: "verified", sources });
assert.equal(coverage(inventory, [receipt(assistant, user)]).uncoveredMessages, 0, "complete sources cover the turn");
assert.equal(
  coverage(inventory, [receipt({ ...assistant, end: 5, content: "01234" }, user)]).uncoveredMessages,
  1,
  "a partial long-message slice leaves the full source uncovered",
);
assert.equal(
  coverage(inventory, [receipt({ ...assistant, hash: "changed" }, user)]).uncoveredMessages,
  1,
  "a changed source hash leaves the old receipt uncovered",
);
assert.equal(
  coverage(inventory, [
    receipt({ ...assistant, end: 5, content: "01234" }),
    receipt({ ...assistant, start: 5, content: "56789" }, user),
  ]).uncoveredMessages,
  0,
  "adjacent slices across receipts jointly cover a source",
);
assert.notEqual(
  coverage(inventory, []).fingerprint,
  coverage({ ...inventory, preparedSources: [{ ...assistant, hash: "edited-version" }, user] } as never, [])
    .fingerprint,
  "edited source versions get a new bounded repair opportunity",
);

assert.equal(
  shouldAutoRepairCompletedSession({ gameSessionStatus: "concluded", gameContinuity: { mode: "active" } }),
  true,
  "completed enabled sessions may be repaired",
);
assert.equal(
  shouldAutoRepairCompletedSession({ gameSessionStatus: "active", gameContinuity: { mode: "active" } }),
  false,
  "active sessions do not trigger background repair",
);
assert.equal(
  shouldAutoRepairCompletedSession({ gameSessionStatus: "concluded", gameContinuity: { mode: "off" } }),
  false,
  "muted sessions do not trigger provider work",
);
assert.equal(shouldAutoRepairCompletedSession({ gameSessionStatus: "concluded" }), false, "absent mode defaults off");

const job = {
  jobId: "campaign-index-repair",
  gameId: "repair-game",
  order: ["session-1", "session-2"],
  currentIndex: 2,
  steps: { registerOwners: false, backfill: true, publishVerified: false },
  startedAt: "2026-09-24T09:43:49.461Z",
  updatedAt: "2026-09-24T10:01:32.552Z",
  status: "done" as const,
  sessions: {
    "session-1": { status: "terminal" as const, backfillIds: ["old-manifest"], acceptedTurns: 7, skippedSegments: 0 },
    "session-2": { status: "terminal" as const, backfillIds: [], acceptedTurns: 0, skippedSegments: 0 },
  },
  history: [],
};

assert.equal(reopenCompletedJob(job, ["session-1"]), true, "later uncovered history reopens a completed job");
assert.equal(job.status, "running");
assert.equal(job.currentIndex, 0);
assert.equal(job.sessions["session-1"].status, "pending");
assert.deepEqual(job.sessions["session-1"].backfillIds, ["old-manifest"], "existing manifests remain reusable");
assert.equal(job.history.at(-1)?.event, "coverage_repair");
assert.equal(shouldRetryCoverageRepair(job, "session-1", "same-fingerprint"), true, "a new fingerprint may retry");
job.history.push({
  at: new Date().toISOString(),
  chatId: null,
  event: "coverage_repair",
  detail: { fingerprints: { "session-1": "failed-fingerprint" } },
});
job.status = "done";
assert.equal(
  shouldRetryCoverageRepair(job, "session-1", "failed-fingerprint"),
  false,
  "a failed batch fingerprint is not retried on the next tick",
);
assert.equal(
  shouldRetryCoverageRepair(job, "session-1", "failed-fingerprint"),
  false,
  "repeated ticks remain idle for the same failed coverage",
);
job.history.push({
  at: new Date().toISOString(),
  chatId: null,
  event: "coverage_repair",
  detail: { fingerprints: { "session-2": "other-fingerprint" } },
});
assert.equal(
  shouldRetryCoverageRepair(job, "session-1", "failed-fingerprint"),
  false,
  "another session repair cannot erase the first session watermark",
);

job.status = "running";
assert.equal(reopenCompletedJob(job, ["session-1"]), false, "a running job is not reopened twice");

job.status = "done";
job.steps.backfill = false;
assert.equal(reopenCompletedJob(job, ["session-1"]), false, "owner-only jobs do not trigger historical backfill");

console.log("campaign-index-coverage-repair regression passed");
