import assert from "node:assert/strict";
import {
  buildGameContinuityReviewPrompt,
  createGameContinuityRecordId,
  reviewGameContinuityWithRepairs,
  type GameContinuityRecord,
  type GameContinuitySource,
} from "../../packages/server/src/services/game/continuity-review.js";

const sources: GameContinuitySource[] = [
  {
    messageId: "m-contract",
    swipeIndex: 0,
    hash: "hash-contract",
    role: "user",
    content: "Rowan offered Rosamund a two-month contract; candidacy remained undecided.",
  },
  {
    messageId: "m-invitation",
    swipeIndex: 0,
    hash: "hash-invitation",
    role: "assistant",
    content: "The private-audience invitation was sent; no arrival was established.",
  },
  {
    messageId: "m-arrival",
    swipeIndex: 0,
    hash: "hash-arrival",
    role: "assistant",
    content: "Rosamund arrived at Moonrise through Rowan's gate.",
  },
];

const recordFor = (
  text: string,
  subjects: string[],
  conditions: string[],
  evidence: GameContinuityRecord["evidence"],
  batchId = "history-proof",
): GameContinuityRecord => {
  const base = {
    kind: "decision" as const,
    text,
    subjects,
    conditions,
    status: "proposed" as const,
    evidence,
    keys: ["historical"],
  };
  return { ...base, id: createGameContinuityRecordId(batchId, base) };
};

const initialRecords = [
  recordFor(
    "Rowan offered Rosamund a contract.",
    ["Mirah"],
    [],
    [{ messageId: "m-contract", quote: "Rowan offered Rosamund a two-month contract" }],
  ),
  recordFor(
    "Rosamund arrived at Moonrise.",
    ["Rowan", "Rosamund"],
    [],
    [{ messageId: "m-invitation", quote: "private-audience invitation was sent" }],
  ),
];
const initial = {
  records: initialRecords,
  dispositions: [
    { messageId: "m-contract", status: "covered" as const, reason: "contract" },
    { messageId: "m-invitation", status: "covered" as const, reason: "invitation" },
    { messageId: "m-arrival", status: "no_durable_facts" as const, reason: "not selected by defective extraction" },
  ],
};

let reviewCalls = 0;
let repairCalls = 0;
let sawExactSourceAndRecord = false;
const repairedRecords = [
  recordFor(
    "Rowan offered Rosamund a two-month contract; candidacy remained undecided.",
    ["Rowan", "Rosamund"],
    ["two months", "candidacy remained undecided"],
    [{ messageId: "m-contract", quote: "Rowan offered Rosamund a two-month contract; candidacy remained undecided" }],
  ),
  recordFor(
    "The invitation did not establish arrival.",
    ["Rowan", "Rosamund"],
    [],
    [{ messageId: "m-invitation", quote: "private-audience invitation was sent; no arrival was established" }],
  ),
  recordFor(
    "Rosamund arrived at Moonrise through Rowan's gate.",
    ["Rowan", "Rosamund"],
    [],
    [{ messageId: "m-arrival", quote: "Rosamund arrived at Moonrise through Rowan's gate" }],
  ),
];
const cleanDispositions = [
  { messageId: "m-contract", status: "covered" as const, reason: "contract and condition" },
  { messageId: "m-invitation", status: "covered" as const, reason: "explicitly records no arrival" },
  { messageId: "m-arrival", status: "covered" as const, reason: "arrival" },
];

const result = await reviewGameContinuityWithRepairs({
  sources,
  initial,
  batchId: "history-proof",
  completeReview: async (prompt) => {
    reviewCalls += 1;
    assert.match(prompt, /m-contract/u);
    assert.match(prompt, /Rowan offered Rosamund/u);
    assert.match(prompt, /m-invitation/u);
    sawExactSourceAndRecord = true;
    return reviewCalls === 1
      ? {
          findings: [
            {
              kind: "attribution",
              messageId: "m-contract",
              quote: "Rowan offered Rosamund",
              recordIds: [initialRecords[0]!.id],
              detail: "actor must remain Rowan",
            },
            {
              kind: "condition",
              messageId: "m-contract",
              quote: "candidacy remained undecided",
              recordIds: [initialRecords[0]!.id],
              detail: "preserve the undecided condition",
            },
            {
              kind: "unsupported",
              messageId: "m-invitation",
              quote: "no arrival was established",
              recordIds: [initialRecords[1]!.id],
              detail: "invitation is not arrival",
            },
            {
              kind: "omission",
              messageId: "m-arrival",
              quote: "Rosamund arrived at Moonrise",
              recordIds: [],
              detail: "durable arrival omitted",
            },
          ],
          dispositions: initial.dispositions,
        }
      : { findings: [], dispositions: cleanDispositions };
  },
  completeRepair: async (prompt) => {
    repairCalls += 1;
    assert.match(prompt, /REVIEW/u);
    assert.match(prompt, /m-contract/u);
    assert.match(prompt, /m-invitation/u);
    return {
      replace: [
        { recordRef: "r1", records: [{ ...repairedRecords[0], id: "temporary" }] },
        { recordRef: "r2", records: [{ ...repairedRecords[1], id: "temporary" }] },
      ],
      add: [{ ...repairedRecords[2], id: "temporary" }],
      dispositions: cleanDispositions,
    };
  },
});

assert.equal(result.status, "verified");
assert.equal(result.repairAttempts, 1);
assert.equal(reviewCalls, 2);
assert.equal(repairCalls, 1);
assert.equal(sawExactSourceAndRecord, true);
assert.deepEqual(
  result.extraction.records.map((record) => record.subjects[0]),
  ["Rowan", "Rowan", "Rowan"],
);
assert.deepEqual(result.extraction.records[0]!.conditions, ["two months", "candidacy remained undecided"]);

let boundedReviews = 0;
const boundedRecord = recordFor(
  "Rowan offered a contract.",
  ["Rowan"],
  ["two months"],
  [{ messageId: "m-contract", quote: "Rowan offered Rosamund a two-month contract" }],
  "bounded-history-proof",
);
const bounded = await reviewGameContinuityWithRepairs({
  sources: sources.slice(0, 1),
  initial: {
    records: [boundedRecord],
    dispositions: [{ messageId: "m-contract", status: "covered", reason: "contract" }],
  },
  batchId: "bounded-history-proof",
  completeReview: async (prompt) => {
    boundedReviews += 1;
    assert.match(prompt, /m-contract/u);
    return {
      findings: [
        {
          kind: "condition",
          messageId: "m-contract",
          quote: "two-month contract",
          recordIds: [boundedRecord.id],
          detail: "persistent planted issue",
        },
      ],
      dispositions: [{ messageId: "m-contract", status: "covered", reason: "contract" }],
    };
  },
  completeRepair: async () => ({
    replace: [
      {
        recordRef: "r1",
        records: [
          {
            ...recordFor(
              "Rowan offered a contract.",
              ["Rowan"],
              ["two months"],
              [{ messageId: "m-contract", quote: "Rowan offered Rosamund a two-month contract" }],
              "bounded-history-proof",
            ),
            id: "temporary",
          },
        ],
      },
    ],
    add: [],
    dispositions: [
      { messageId: "m-contract", status: "unresolved", reason: `condition remains unresolved ${boundedReviews}` },
    ],
  }),
});
assert.equal(bounded.status, "unresolved");
assert.equal(bounded.repairAttempts, 3);
assert.equal(boundedReviews, 4);

assert.match(
  buildGameContinuityReviewPrompt({ sources, records: repairedRecords }),
  /PRIMARY SOURCES:[\s\S]*m-contract[\s\S]*PROPOSED RECORDS:[\s\S]*Rosamund/u,
);
console.log("game-continuity history review orchestration regression passed");
