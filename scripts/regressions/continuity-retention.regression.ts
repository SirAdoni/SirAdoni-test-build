import assert from "node:assert/strict";
import type {
  GameContinuityContextSource,
  GameContinuityExtraction,
  GameContinuityReceipt,
  GameContinuityRecord,
  GameContinuitySource,
} from "@marinara-engine/shared";
import {
  isRecoverableReplacementReceipt,
  explicitlyCorrectedContinuityClaims,
  continuityRecordFingerprint,
  replacementContainsAllRecords,
  retainPublishedContinuityRecords,
} from "../../packages/server/src/services/game/continuity-retention.js";

const source: GameContinuitySource = {
  messageId: "m1",
  swipeIndex: 0,
  hash: "h1",
  role: "assistant",
  content: "Mara promised to return the key tomorrow.",
};
const context: GameContinuityContextSource = {
  messageId: "context-1",
  swipeIndex: 0,
  hash: "context-h1",
  role: "assistant",
  content: "The old context mentions a key.",
};
const record: GameContinuityRecord = {
  id: "old-record",
  kind: "promise",
  text: "Mara promised to return the key tomorrow.",
  subjects: ["Mara"],
  conditions: [],
  status: "asserted",
  evidence: [{ messageId: "m1", quote: "Mara promised to return the key tomorrow." }],
  keys: ["key"],
};
const staleContextRecord: GameContinuityRecord = {
  ...record,
  id: "stale-context-record",
  text: "The old context mentions a key.",
  evidence: [{ messageId: "context-1", quote: "The old context mentions a key." }],
};
const prior: GameContinuityReceipt = {
  id: "old-receipt",
  chatId: "chat",
  sessionNumber: 2,
  sourceHash: "source-h1",
  sources: [source],
  context: [context],
  configHash: "config",
  config: {},
  status: "published",
  attempts: 1,
  repairAttempts: 0,
  records: [record, staleContextRecord],
  dispositions: [{ messageId: "m1", status: "covered", reason: "old" }],
  review: { findings: [], dispositions: [{ messageId: "m1", status: "covered", reason: "old" }] },
  entryIds: ["entry"],
  createdAt: "2026-09-26T00:00:00.000Z",
  updatedAt: "2026-09-26T00:00:00.000Z",
};
const empty: GameContinuityExtraction = {
  records: [],
  dispositions: [{ messageId: "m1", status: "no_durable_facts", reason: "model omitted it" }],
};
const retained = retainPublishedContinuityRecords(empty, [prior], [source], [context], new Set(), "new-receipt");
assert.equal(retained.records.length, 1, "same-source omission retains only currently evidenced claims");
assert.notEqual(
  retained.records[0]!.id,
  record.id,
  "retained claims receive the new receipt's deterministic record id",
);
assert.equal(retained.dispositions[0]!.status, "covered", "retained evidence updates source disposition");

const secondSlice: GameContinuitySource = {
  ...source,
  hash: "h2",
  content: "A second slice carries the exact retained evidence.",
};
const splitSliceRecord: GameContinuityRecord = {
  ...record,
  id: "split-slice-record",
  text: "A second slice carries the exact retained evidence.",
  evidence: [{ messageId: "m1", quote: "exact retained evidence" }],
};
const splitSlicePrior = {
  ...prior,
  sources: [source, secondSlice],
  records: [splitSliceRecord],
};
assert.equal(
  retainPublishedContinuityRecords(empty, [splitSlicePrior], [source, secondSlice], [], new Set(), "split").records
    .length,
  1,
  "a later exact-identity slice can supply the quote when an earlier slice shares its message id",
);

const duplicate = retainPublishedContinuityRecords(
  { records: [record], dispositions: [{ messageId: "m1", status: "covered", reason: "new" }] },
  [prior],
  [source],
  [],
);
assert.equal(duplicate.records.length, 1, "exact records collapse across re-reads");
assert.equal(
  retainPublishedContinuityRecords(empty, [prior], [source], [], new Set(["old-receipt\u0000old-record"])).records
    .length,
  0,
  "manual or user-authored prior facts are not reintroduced for review",
);

const replacement = { ...prior, id: "new-receipt", records: [record, staleContextRecord] };
assert.equal(replacementContainsAllRecords(replacement, prior), true);
assert.equal(
  replacementContainsAllRecords({ ...replacement, records: [] }, prior),
  false,
  "a correction or omission keeps the prior receipt for reviewer disposition",
);
assert.equal(
  replacementContainsAllRecords(
    {
      ...replacement,
      records: [],
      review: {
        findings: [],
        dispositions: [],
        withheld: {
          records: [record, staleContextRecord],
          findings: [
            { kind: "contradiction", messageId: "m1", quote: "Mara", recordIds: [record.id], detail: "corrected" },
            {
              kind: "contradiction",
              messageId: "m1",
              quote: "Mara",
              recordIds: [staleContextRecord.id],
              detail: "corrected",
            },
          ],
        },
      },
    },
    prior,
  ),
  true,
  "an explicitly withheld prior claim permits retirement after reviewer disposition",
);
const correctionHistory = [
  {
    status: "reviewing" as const,
    attempts: 1,
    repairAttempts: 0,
    updatedAt: "1",
    records: [record],
    dispositions: [],
    review: {
      findings: [
        { kind: "contradiction" as const, messageId: "m1", quote: "Mara", recordIds: [record.id], detail: "wrong" },
      ],
      dispositions: [],
    },
  },
  {
    status: "repairing" as const,
    attempts: 1,
    repairAttempts: 1,
    updatedAt: "2",
    records: [record],
    dispositions: [],
    review: {
      findings: [
        { kind: "contradiction" as const, messageId: "m1", quote: "Mara", recordIds: [record.id], detail: "wrong" },
      ],
      dispositions: [],
    },
  },
  {
    status: "reviewing" as const,
    attempts: 1,
    repairAttempts: 1,
    updatedAt: "3",
    records: [],
    dispositions: [],
    review: { findings: [], dispositions: [] },
  },
  {
    status: "published" as const,
    attempts: 1,
    repairAttempts: 1,
    updatedAt: "4",
    records: [],
    dispositions: [],
    review: { findings: [], dispositions: [] },
  },
];
const corrected = explicitlyCorrectedContinuityClaims(correctionHistory);
assert.equal(
  corrected.has(continuityRecordFingerprint(record)),
  true,
  "a flagged claim removed by repair is a correction",
);
assert.equal(
  replacementContainsAllRecords({ ...replacement, records: [] }, { ...prior, records: [record] }, corrected),
  true,
  "successful explicit correction permits the old receipt to retire",
);
const silentOmission = structuredClone(correctionHistory);
silentOmission[0]!.review = { findings: [], dispositions: [] };
silentOmission[1]!.review = { findings: [], dispositions: [] };
assert.equal(
  explicitlyCorrectedContinuityClaims(silentOmission).size,
  0,
  "a later omission without an explicit finding never resolves the old claim",
);
const failedCorrection = structuredClone(correctionHistory);
failedCorrection[3]!.status = "unresolved";
assert.equal(
  explicitlyCorrectedContinuityClaims(failedCorrection).size,
  0,
  "a correction from an unpublished review lineage is not durable",
);
const priorAttemptFinding = structuredClone(correctionHistory);
priorAttemptFinding[0]!.attempts = 1;
priorAttemptFinding[1]!.attempts = 1;
priorAttemptFinding[2]!.attempts = 1;
priorAttemptFinding[3]!.attempts = 1;
priorAttemptFinding[1]!.status = "failed";
priorAttemptFinding[2]!.attempts = 2;
priorAttemptFinding[2]!.records = [record];
priorAttemptFinding[2]!.review = { findings: [], dispositions: [] };
priorAttemptFinding[3]!.attempts = 2;
assert.equal(
  explicitlyCorrectedContinuityClaims(priorAttemptFinding).size,
  0,
  "a finding from an earlier failed retry epoch cannot resolve a later omission",
);
assert.equal(
  isRecoverableReplacementReceipt({
    status: "stale",
    errorCode: "CONTINUITY_SOURCE_RETIRED",
    error: "Replaced by receipt new-receipt, which read the same text.",
  }),
  true,
  "same-text replacement journal is recoverable for reviewer disposition",
);
assert.equal(
  isRecoverableReplacementReceipt({
    status: "stale",
    errorCode: "CONTINUITY_SOURCE_RETIRED",
    error: "A message this receipt was read from was edited, deleted, hidden or swiped away.",
  }),
  false,
  "source-change retirement is never recovered",
);

console.log("continuity-retention regression passed");
