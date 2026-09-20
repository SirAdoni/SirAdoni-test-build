import assert from "node:assert/strict";
import type { GameContinuityReview } from "@marinara-engine/shared";
import {
  applyTargetedContinuityRepair,
  buildTargetedContinuityRepairPrompt,
} from "../../packages/server/src/services/game/continuity-repair-patch.js";
import { normalizeGameContinuityExtraction } from "../../packages/server/src/services/game/continuity-review.js";

const batchId = "targeted-repair-regression";
const sources = [
  { messageId: "m1", swipeIndex: 0, hash: "h1", role: "assistant", content: "The lantern is lit." },
  { messageId: "m2", swipeIndex: 0, hash: "h2", role: "assistant", content: "Mira promised to return." },
];
const rawRecords = [
  {
    kind: "event",
    text: "The lantern is lit.",
    subjects: ["lantern"],
    conditions: [],
    status: "asserted",
    knowledge: { scope: "world", holders: [] },
    evidence: [{ messageId: "m1", quote: "The lantern is lit." }],
    keys: ["lantern"],
  },
  {
    kind: "promise",
    text: "Mira promised to return.",
    subjects: ["Mira"],
    conditions: [],
    status: "proposed",
    knowledge: { scope: "world", holders: [] },
    evidence: [{ messageId: "m2", quote: "Mira promised to return." }],
    keys: ["Mira"],
  },
];
const extraction = normalizeGameContinuityExtraction(
  {
    records: rawRecords,
    dispositions: [
      { messageId: "m1", status: "covered", reason: "recorded" },
      { messageId: "m2", status: "covered", reason: "recorded" },
    ],
  },
  sources,
  batchId,
);
const review: GameContinuityReview = {
  findings: [
    {
      kind: "attribution",
      messageId: "m1",
      quote: "The lantern is lit.",
      recordIds: [extraction.records[0]!.id],
      detail: "Split the objective event from the actor attribution.",
    },
  ],
  dispositions: extraction.dispositions,
};
const args = { extraction, review, sources, batchId };
const replacementRecord = (text: string, kind: "event" | "learning") => ({
  kind,
  text,
  subjects: ["lantern"],
  conditions: [],
  status: "asserted",
  knowledge: { scope: "world", holders: [] },
  evidence: [{ messageId: "m1", quote: "The lantern is lit." }],
  keys: ["lantern"],
});
const patch = {
  replace: [
    {
      recordRef: "r1",
      records: [
        replacementRecord("The lantern is lit.", "event"),
        {
          ...replacementRecord("Mira intends to use the lantern as a signal.", "learning"),
          status: "proposed",
          knowledge: { scope: "private", holders: ["Mira"] },
        },
      ],
    },
  ],
  add: [],
  dispositions: extraction.dispositions,
};
const repaired = applyTargetedContinuityRepair(patch, args);
assert.equal(repaired.records.length, 3);
assert.equal(repaired.records[0]!.status, "asserted");
assert.equal(repaired.records[1]!.status, "proposed");
assert.deepEqual(repaired.records[1]!.knowledge, { scope: "private", holders: ["Mira"] });
assert.deepEqual(repaired.records[2], extraction.records[1]);
const repairPrompt = buildTargetedContinuityRepairPrompt(args);
assert.equal(repairPrompt.includes('"recordRef":"r1"'), true);
assert.match(repairPrompt, /different statuses[\s\S]*split it into independently evidenced/u);
assert.match(repairPrompt, /REVIEW[\s\S]*"recordIds":\["r1"\]/u);
assert.deepEqual(applyTargetedContinuityRepair(patch, args), repaired);

const cleanupArgs = {
  ...args,
  review: {
    findings: [
      {
        kind: "unsupported" as const,
        messageId: "m1",
        quote: "The lantern is lit.",
        recordIds: [extraction.records[0]!.id],
        detail: "unsupported synthesis",
      },
      {
        kind: "knowledge" as const,
        messageId: "m1",
        quote: "The lantern is lit.",
        recordIds: [extraction.records[0]!.id],
        detail: "holder grant belongs to synthesis",
      },
    ],
    dispositions: [
      { messageId: "m1", status: "no_durable_facts" as const, reason: "underlying synthesis removed" },
      extraction.dispositions[1]!,
    ],
  },
};
const cleaned = applyTargetedContinuityRepair(
  { replace: [{ recordRef: "r1", records: [] }], add: [], dispositions: cleanupArgs.review.dispositions },
  cleanupArgs,
);
assert.deepEqual(cleaned.records, [extraction.records[1]]);
assert.deepEqual(cleaned.records[0], extraction.records[1]);
const knowledgeOnly = { ...cleanupArgs, review: { ...cleanupArgs.review, findings: [cleanupArgs.review.findings[1]] } };
assert.throws(
  () =>
    applyTargetedContinuityRepair(
      { replace: [{ recordRef: "r1", records: [] }], add: [], dispositions: cleanupArgs.review.dispositions },
      knowledgeOnly,
    ),
  /requires unsupported or contradiction/,
);
const mixedCondition = {
  ...cleanupArgs,
  review: {
    ...cleanupArgs.review,
    findings: [
      ...cleanupArgs.review.findings,
      {
        kind: "condition" as const,
        messageId: "m1",
        quote: "The lantern is lit.",
        recordIds: [extraction.records[0]!.id],
        detail: "preserve condition",
      },
    ],
  },
};
assert.throws(
  () =>
    applyTargetedContinuityRepair(
      { replace: [{ recordRef: "r1", records: [] }], add: [], dispositions: cleanupArgs.review.dispositions },
      mixedCondition,
    ),
  /cannot discard supported finding kinds/,
);

assert.throws(
  () => applyTargetedContinuityRepair({ ...patch, replace: [{ ...patch.replace[0]!, recordRef: "r9" }] }, args),
  /unknown replacement/,
);
assert.throws(
  () => applyTargetedContinuityRepair({ ...patch, replace: [{ ...patch.replace[0]!, extra: true }] }, args),
  /exactly recordRef and records/,
);
assert.throws(
  () => applyTargetedContinuityRepair({ ...patch, replace: [patch.replace[0]!, patch.replace[0]!] }, args),
  /duplicate replacement/,
);
assert.throws(() => applyTargetedContinuityRepair({ ...patch, replace: [] }, args), /no replacement operation/);
assert.throws(
  () =>
    applyTargetedContinuityRepair(
      {
        ...patch,
        replace: [
          {
            recordRef: "r1",
            records: [
              { ...replacementRecord("Invented", "event"), evidence: [{ messageId: "m1", quote: "not in source" }] },
            ],
          },
        ],
      },
      args,
    ),
  /quote is not present/,
);

const omissionReview: GameContinuityReview = {
  findings: [
    { kind: "omission", messageId: "m1", quote: "The lantern is lit.", recordIds: [], detail: "Missing event." },
  ],
  dispositions: extraction.dispositions,
};
const omissionArgs = { ...args, review: omissionReview };
const added = applyTargetedContinuityRepair(
  {
    replace: [],
    add: [replacementRecord("The lantern is a signal.", "learning")],
    dispositions: extraction.dispositions,
  },
  omissionArgs,
);
assert.equal(added.records.length, 3);
assert.throws(
  () =>
    applyTargetedContinuityRepair(
      {
        replace: [],
        add: [],
        dispositions: extraction.dispositions,
      },
      omissionArgs,
    ),
  /added record/,
);

console.log("continuity-repair-patch regression passed");
