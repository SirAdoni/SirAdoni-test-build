// The review prompt asks for an itemised per-record worksheet (recordChecks) before findings, so the reviewer
// compares source qualifiers against each record's conditions array instead of re-reading prose holistically.
// The worksheet is advisory: the review contract is unchanged and the validator must ignore the extra field.
import assert from "node:assert/strict";
import {
  buildGameContinuityReviewPrompt,
  createGameContinuityRecordId,
  normalizeGameContinuityReview,
  validateGameContinuityReview,
} from "../../packages/server/src/services/game/continuity-review.js";
import type { GameContinuityRecord, GameContinuitySource } from "@marinara-engine/shared";

const sources: GameContinuitySource[] = [
  {
    messageId: "m1",
    swipeIndex: 0,
    hash: "h1",
    role: "user",
    content: "Edmund offered a two-month contract if she completes the survey first.",
  },
];
const base = {
  kind: "decision" as const,
  text: "Edmund offered a two-month contract.",
  subjects: ["Edmund"],
  conditions: [] as string[],
  status: "proposed" as const,
  evidence: [{ messageId: "m1", quote: "Edmund offered a two-month contract" }],
  keys: ["contract"],
};
const record: GameContinuityRecord = { ...base, id: createGameContinuityRecordId("batch", base) };

const prompt = buildGameContinuityReviewPrompt({ sources, records: [record] });
// The worksheet is requested, ordered before findings, and every field the reviewer must fill is named.
for (const fragment of [
  "Before writing any finding, fill in recordChecks",
  "sourceActors",
  "sourceQualifiers",
  "recordSubjects",
  "recordConditions",
  "missingQualifiers",
  "actorMismatch",
  "compare each source qualifier against both the record text and recordConditions",
  "A qualifier preserved in the record prose does not need to be duplicated in conditions",
  "every remaining missingQualifiers entry is a condition finding",
  'every actorMismatch other than "none" is an attribution finding',
])
  assert.ok(prompt.includes(fragment), `review prompt is missing: ${fragment}`);
assert.ok(
  prompt.indexOf('"recordChecks"') < prompt.indexOf('"findings"'),
  "recordChecks must precede findings in the output schema so the worksheet is written first",
);
const schemaExample = prompt
  .slice(prompt.lastIndexOf("Schema: ") + "Schema: ".length)
  .split(" Allowed enum values:")[0]!;
const parsed = JSON.parse(schemaExample) as Record<string, unknown>;
assert.ok(Array.isArray(parsed.recordChecks) && Array.isArray(parsed.findings) && Array.isArray(parsed.dispositions));

// Contract unchanged: the extra worksheet field (and any stray per-finding field) is dropped, not rejected.
const raw = {
  recordChecks: [
    {
      recordRef: "r1",
      sourceActors: ["Edmund"],
      sourceQualifiers: ["if she completes the survey first"],
      recordSubjects: ["Edmund"],
      recordConditions: [],
      missingQualifiers: ["if she completes the survey first"],
      actorMismatch: "none",
    },
  ],
  findings: [
    {
      kind: "condition",
      messageId: "m1",
      quote: "if she completes the survey first",
      recordIds: ["r1"],
      detail: "the record's conditions array omits the survey prerequisite",
      confidence: "high",
    },
  ],
  dispositions: [{ messageId: "m1", status: "covered", reason: "offer recorded" }],
};
const normalized = normalizeGameContinuityReview(raw, sources, [record]);
assert.equal(normalized.findings.length, 1);
assert.deepEqual(normalized.findings[0]!.recordIds, [record.id]);
assert.deepEqual(Object.keys(normalized).sort(), ["dispositions", "findings"]);
assert.deepEqual(Object.keys(normalized.findings[0]!).sort(), ["detail", "kind", "messageId", "quote", "recordIds"]);
assert.doesNotThrow(() => validateGameContinuityReview(normalized, sources, [record]));
// A worksheet with no findings still validates as a clean review.
assert.equal(normalizeGameContinuityReview({ ...raw, findings: [] }, sources, [record]).findings.length, 0);

// Normalization must preserve the reviewer's semantic finding even when its quote appears in record prose under a
// different clause; only the reviewer prompt decides whether the qualifier's meaning is actually retained.
const retainedBase = {
  ...base,
  text: "Edmund did not offer a two-month contract if she completes the survey first.",
  evidence: [{ messageId: "m1", quote: "Edmund offered a two-month contract if she completes the survey first." }],
};
const retainedRecord: GameContinuityRecord = {
  ...retainedBase,
  id: createGameContinuityRecordId("retained", retainedBase),
};
const retainedReview = normalizeGameContinuityReview(
  {
    ...raw,
    findings: [{ ...raw.findings[0], quote: "if she completes the survey first", recordIds: ["r1"] }],
  },
  sources,
  [retainedRecord],
);
assert.equal(retainedReview.findings.length, 1, "semantic condition findings must not be discarded by normalization");
assert.equal(retainedReview.findings[0]!.quote, "if she completes the survey first");

// The same source qualifier is still flagged when it is absent from both prose and conditions.
const missingReview = normalizeGameContinuityReview(raw, sources, [record]);
assert.equal(missingReview.findings.length, 1, "a genuinely omitted qualifier remains reviewable");

console.log("continuity-review-record-checks regression passed");
