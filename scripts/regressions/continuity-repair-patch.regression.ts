import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { GameContinuityReview } from "@marinara-engine/shared";
import {
  applyTargetedContinuityRepair,
  buildTargetedContinuityRepairPrompt,
} from "../../packages/server/src/services/game/continuity-repair-patch.js";
import { normalizeGameContinuityExtraction } from "../../packages/server/src/services/game/continuity-review.js";

const batchId = "targeted-repair-regression";
const source = (messageId: string, content: string) => ({
  messageId,
  swipeIndex: 0,
  hash: createHash("sha256").update(content).digest("hex"),
  role: "assistant",
  content,
});
const sources = [source("m1", "The lantern is lit."), source("m2", "Mira promised to return.")];
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
assert.throws(
  () =>
    applyTargetedContinuityRepair(
      {
        replace: [{ recordRef: "r1", records: [{ ...rawRecords[1]!, keys: ["different-indexing-key"] }] }],
        add: [],
        dispositions: extraction.dispositions,
      },
      args,
    ),
  /duplicate an unaffected record/u,
  "a replacement cannot duplicate an unaffected record by changing only indexing keys",
);
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
assert.match(
  buildTargetedContinuityRepairPrompt(omissionArgs),
  /For EACH omission finding[\s\S]*Distinct omitted source messages each need their own source-backed addition/u,
);
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
  /empty-target omission for m1 requires an added record with primary evidence for that message/u,
);
assert.throws(
  () =>
    applyTargetedContinuityRepair(
      {
        replace: [{ recordRef: "r1", records: [replacementRecord("A lantern marks the path.", "learning")] }],
        add: [],
        dispositions: extraction.dispositions,
      },
      {
        ...omissionArgs,
        review: {
          ...omissionReview,
          findings: [
            ...omissionReview.findings,
            {
              kind: "attribution",
              messageId: "m1",
              quote: "The lantern is lit.",
              recordIds: [extraction.records[0]!.id],
              detail: "separate reviewed replacement target",
            },
          ],
        },
      },
    ),
  /empty-target omission for m1 requires an added record with primary evidence for that message/u,
  "a replacement citing the omitted source does not satisfy the add-record contract",
);

// Separate primary messages preserve delivery, untouched food, and a distinct no-intake-since-arrival qualifier.
const foodDelivery = "At noon I delivered a sealed meal to the station.\nAt dusk, the meal was still untouched.";
const noIntake = "Since arriving at the station this morning, I have eaten nothing.";
const omissionSources = [source("food-delivery", foodDelivery), source("no-intake", noIntake)];
const foodRecord = (messageId: string, quote: string, text: string, kind: "event" | "learning" = "event") => ({
  kind,
  text,
  subjects: ["meal"],
  conditions: [],
  status: "asserted",
  knowledge: { scope: "world", holders: [] },
  evidence: [{ messageId, quote }],
  keys: ["meal"],
});
const omissionExtraction = normalizeGameContinuityExtraction(
  {
    records: [
      foodRecord(
        "food-delivery",
        "I delivered a sealed meal to the station.",
        "A sealed meal was delivered to the station.",
      ),
    ],
    dispositions: [
      { messageId: "food-delivery", status: "covered", reason: "delivery recorded" },
      { messageId: "no-intake", status: "unresolved", reason: "missing intake detail" },
    ],
  },
  omissionSources,
  batchId,
);
const multiOmissionArgs = {
  extraction: omissionExtraction,
  review: {
    findings: [
      {
        kind: "omission" as const,
        messageId: "food-delivery",
        quote: "the meal was still untouched",
        recordIds: [],
        detail: "Preserve that the delivered meal remained untouched.",
      },
      {
        kind: "omission" as const,
        messageId: "no-intake",
        quote: "Since arriving at the station this morning, I have eaten nothing.",
        recordIds: [],
        detail: "Preserve the separate no-intake-since-arrival qualifier.",
      },
    ],
    dispositions: omissionExtraction.dispositions,
  },
  sources: omissionSources,
  batchId,
};
const foodAdditions = [
  foodRecord(
    "food-delivery",
    "At noon I delivered a sealed meal to the station.\nAt dusk, the meal was still untouched.",
    "The sealed meal delivered to the station remained untouched at dusk.",
  ),
  foodRecord(
    "no-intake",
    "Since arriving at the station this morning, I have eaten nothing.",
    "No food has been eaten since arriving at the station this morning.",
    "learning",
  ),
];
const foodPatch = { replace: [], add: foodAdditions, dispositions: omissionExtraction.dispositions };
const foodRepaired = applyTargetedContinuityRepair(foodPatch, multiOmissionArgs);
assert.equal(foodRepaired.records.length, 3);
assert.match(foodRepaired.records[1]!.text, /remained untouched/u);
assert.match(foodRepaired.records[2]!.text, /since arriving/u);
assert.deepEqual(foodRepaired.records[1]!.evidence, foodAdditions[0]!.evidence);
assert.deepEqual(foodRepaired.records[2]!.evidence, foodAdditions[1]!.evidence);
assert.throws(
  () => applyTargetedContinuityRepair({ ...foodPatch, add: foodAdditions.slice(0, 1) }, multiOmissionArgs),
  /empty-target omission for no-intake requires an added record with primary evidence/u,
  "one addition cannot satisfy a distinct omitted source",
);
assert.throws(
  () =>
    applyTargetedContinuityRepair(
      {
        ...foodPatch,
        add: foodAdditions.map((record) => ({
          ...record,
          evidence: [{ messageId: "food-delivery", quote: "At noon I delivered a sealed meal to the station." }],
        })),
      },
      multiOmissionArgs,
    ),
  /empty-target omission for no-intake requires an added record with primary evidence/u,
  "a valid quote from the wrong primary source cannot satisfy an omission",
);
assert.throws(
  () =>
    applyTargetedContinuityRepair(
      { replace: [], add: [], dispositions: omissionExtraction.dispositions },
      multiOmissionArgs,
    ),
  /empty-target omission for food-delivery requires an added record with primary evidence/u,
  "no-op patches cannot pass multiple omissions",
);
assert.match(
  buildTargetedContinuityRepairPrompt(multiOmissionArgs),
  /preserve every material source qualifier[\s\S]*Distinct omitted source messages/u,
);

// The extractor left m2 unresolved; the reviewer found nothing and marked it covered. The repair may add the
// missing record for m2, and the prompt shows which messages the extractor left unfinished.
const unfinished = {
  records: [extraction.records[0]!],
  dispositions: [
    { messageId: "m1", status: "covered" as const, reason: "recorded" },
    { messageId: "m2", status: "unresolved" as const, reason: "needs a closer read" },
  ],
};
const unfinishedArgs = {
  ...args,
  extraction: unfinished,
  review: { findings: [], dispositions: extraction.dispositions },
};
const completedRepair = applyTargetedContinuityRepair(
  {
    replace: [],
    add: [{ ...rawRecords[1]! }],
    dispositions: extraction.dispositions,
  },
  unfinishedArgs,
);
assert.equal(completedRepair.records.length, 2, "the extractor's unresolved message can receive an added record");
assert.match(
  buildTargetedContinuityRepairPrompt(unfinishedArgs),
  /CURRENT EXTRACTION DISPOSITIONS[^]*needs a closer read/u,
);
assert.doesNotMatch(buildTargetedContinuityRepairPrompt(args), /CURRENT EXTRACTION DISPOSITIONS/u);

console.log("continuity-repair-patch regression passed");
