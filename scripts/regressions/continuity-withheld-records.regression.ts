import assert from "node:assert/strict";
import {
  createGameContinuityRecordId,
  reviewGameContinuityWithRepairs,
  validateGameContinuityReceipt,
  withholdFlaggedContinuityRecords,
} from "../../packages/server/src/services/game/continuity-review.js";
import type { GameContinuityRecord, GameContinuitySource } from "@marinara-engine/shared";

// Grouped archive batches carry 30 to 60 records. The stricter reviewer found one to five real problems in most of
// them (a dropped hedge, an overstated holder list), repair could not clear every one, and the whole batch stayed
// unresolved, so about 95% sound memory was never published. After the last repair attempt the records a finding
// names are now withheld with the findings, omissions are kept on the receipt without blocking, and the rest
// publishes with a clean review of exactly what is published. Anything that cannot be isolated stays unresolved.
const sources: GameContinuitySource[] = [
  { messageId: "m1", swipeIndex: 0, hash: "h1", role: "user", content: "Robert offers the well-right. Maybelle says it must wait for the clause." },
  { messageId: "m2", swipeIndex: 0, hash: "h2", role: "assistant", content: "Audrey signs the register. Kasimira says, in her experience, soft men never reach for the latch." },
];
const make = (text: string, messageId: string, quote: string): GameContinuityRecord => {
  const base = {
    kind: "decision" as const,
    text,
    subjects: ["Robert"],
    conditions: [],
    status: "completed" as const,
    evidence: [{ messageId, quote }],
    keys: [],
  };
  return { ...base, id: createGameContinuityRecordId("gch_test", base) };
};
const sound = make("Audrey signed the register.", "m2", "Audrey signs the register.");
const flagged = make("Kasimira said soft men never reach for the latch.", "m2", "soft men never reach for the latch");
const offer = make("Robert offered the well-right.", "m1", "Robert offers the well-right.");
const extraction = {
  records: [sound, flagged, offer],
  dispositions: [
    { messageId: "m1", status: "covered" as const, reason: "offer" },
    { messageId: "m2", status: "covered" as const, reason: "register and remark" },
  ],
};
const conditionFinding = {
  kind: "condition" as const,
  messageId: "m2",
  quote: "in her experience",
  recordIds: [flagged.id],
  detail: "The record drops Kasimira's hedge.",
};
const offerFinding = {
  kind: "condition" as const,
  messageId: "m1",
  quote: "it must wait for the clause",
  recordIds: [offer.id],
  detail: "Maybelle's restriction is missing.",
};
const omission = {
  kind: "omission" as const,
  messageId: "m2",
  quote: "Audrey signs the register.",
  recordIds: [],
  detail: "The register number is not recorded.",
};

const partial = withholdFlaggedContinuityRecords(extraction, {
  findings: [conditionFinding, offerFinding, omission],
  dispositions: extraction.dispositions,
});
assert.ok(partial, "a batch whose problems name specific records publishes the rest");
assert.deepEqual(partial.extraction.records.map((record) => record.id), [sound.id], "only unflagged records remain");
assert.deepEqual(partial.review.findings, [], "the published set carries a clean review");
assert.deepEqual(
  partial.review.withheld?.records.map((record) => record.id).sort(),
  [flagged.id, offer.id].sort(),
  "flagged records are kept on the receipt, not dropped",
);
assert.equal(partial.review.withheld?.findings.length, 3, "every finding, omissions included, is kept");
const m1 = partial.extraction.dispositions.find((item) => item.messageId === "m1")!;
assert.equal(m1.status, "no_durable_facts", "a message whose only record was withheld publishes nothing");
assert.match(m1.reason, /Withheld after review/u);

// The result is a valid verified receipt, and the withheld trail survives validation.
const receiptBase = {
  id: "gch_test",
  chatId: "chat",
  sessionNumber: 1,
  sourceHash: "source",
  sources,
  context: [],
  configHash: "config",
  config: {},
  attempts: 1,
  repairAttempts: 3,
  entryIds: [],
  createdAt: "2026-09-16T00:00:00.000Z",
  updatedAt: "2026-09-16T00:00:00.000Z",
};
const verified = validateGameContinuityReceipt({
  ...receiptBase,
  status: "verified",
  records: partial.extraction.records,
  dispositions: partial.extraction.dispositions,
  review: partial.review,
});
assert.equal(verified.review?.withheld?.records.length, 2);
assert.throws(
  () =>
    validateGameContinuityReceipt({
      ...receiptBase,
      status: "verified",
      records: [sound, flagged],
      dispositions: partial.extraction.dispositions,
      review: {
        findings: [],
        dispositions: partial.extraction.dispositions,
        withheld: { records: [], findings: [conditionFinding] },
      },
    }),
  /cannot flag a record that was published/u,
  "a withheld finding may never point at a record that was published",
);

// What must stay unresolved.
assert.equal(
  withholdFlaggedContinuityRecords(extraction, { findings: [omission], dispositions: extraction.dispositions }),
  null,
  "omissions alone leave nothing to isolate",
);
assert.equal(
  withholdFlaggedContinuityRecords(extraction, {
    findings: [conditionFinding, { ...omission, kind: "contradiction" as const }],
    dispositions: extraction.dispositions,
  }),
  null,
  "a non-omission finding that names no record cannot be isolated",
);
assert.equal(
  withholdFlaggedContinuityRecords(
    { ...extraction, records: [flagged] },
    { findings: [conditionFinding], dispositions: extraction.dispositions },
  ),
  null,
  "a batch whose every record is flagged publishes nothing",
);
assert.equal(
  withholdFlaggedContinuityRecords(
    {
      ...extraction,
      dispositions: [
        { messageId: "m1", status: "unresolved" as const, reason: "extractor could not cover" },
        extraction.dispositions[1]!,
      ],
    },
    { findings: [conditionFinding], dispositions: extraction.dispositions },
  ),
  null,
  "coverage the extractor left unresolved is not a flagged record",
);

// End to end: repairs exhausted, the loop publishes the unflagged records instead of the whole batch staying out.
const looped = await reviewGameContinuityWithRepairs({
  sources,
  initial: extraction,
  batchId: "gch_test",
  initialRepairAttempts: 3,
  completeReview: async () => ({
    findings: [
      { ...conditionFinding, recordIds: ["r2"] },
      { ...omission, recordIds: [] },
    ],
    dispositions: extraction.dispositions,
  }),
  completeRepair: async () => {
    throw new Error("repair must stay bounded");
  },
});
assert.equal(looped.status, "verified");
assert.deepEqual(looped.extraction.records.map((record) => record.id).sort(), [sound.id, offer.id].sort());

console.log("continuity-withheld-records regression passed");
