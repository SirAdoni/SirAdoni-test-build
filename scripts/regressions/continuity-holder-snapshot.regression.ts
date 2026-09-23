import assert from "node:assert/strict";
import {
  buildGameContinuityExtractionPrompt,
  buildGameContinuityReviewPrompt,
  normalizeGameContinuityExtraction,
  validateGameContinuityExtraction,
} from "../../packages/server/src/services/game/continuity-review.js";
const source = [
  { messageId: "m1", swipeIndex: 0, hash: "h", role: "assistant", content: "Mira knows the gate is open." },
];
const holder = [
  { entityId: "char-1", kind: "character" as const, store: "characters" as const, recordId: "record-1", name: "Mira" },
];
const raw = {
  records: [
    {
      kind: "event",
      text: "The gate is open.",
      subjects: ["gate"],
      conditions: [],
      status: "asserted",
      knowledge: { scope: "private", holders: ["Mira"], holderRefs: ["char-1"] },
      evidence: [{ messageId: "m1", quote: "Mira knows the gate is open." }],
      keys: ["gate"],
    },
  ],
  dispositions: [{ messageId: "m1", status: "covered", reason: "recorded" }],
};
const extraction = normalizeGameContinuityExtraction(raw, source, "holder-batch", [], holder);
const legacyExtractionArgs = { chatName: "Holder", sessionNumber: 1, sources: source };
const legacyExtractionPrompt = buildGameContinuityExtractionPrompt(legacyExtractionArgs);
assert.equal(
  buildGameContinuityExtractionPrompt({ ...legacyExtractionArgs, knowledgeHolders: [] }),
  legacyExtractionPrompt,
);
assert.deepEqual(legacyExtractionArgs, { chatName: "Holder", sessionNumber: 1, sources: source });
const mappedExtractionArgs = { ...legacyExtractionArgs, knowledgeHolders: holder };
const mappedExtractionPrompt = buildGameContinuityExtractionPrompt(mappedExtractionArgs);
assert.equal(buildGameContinuityExtractionPrompt(mappedExtractionArgs), mappedExtractionPrompt);
assert.deepEqual(mappedExtractionArgs, { ...legacyExtractionArgs, knowledgeHolders: holder });
assert.match(mappedExtractionPrompt, /char-1/u);
assert.match(
  buildGameContinuityReviewPrompt({ sources: source, records: extraction.records, knowledgeHolders: holder }),
  /Mira/u,
);
const legacyReviewPrompt = buildGameContinuityReviewPrompt({ sources: source, records: extraction.records });
assert.equal(
  buildGameContinuityReviewPrompt({ sources: source, records: extraction.records, knowledgeHolders: [] }),
  legacyReviewPrompt,
);
assert.deepEqual(extraction.records[0]!.knowledge!.holderRefs, ["char-1"]);
assert.throws(
  () =>
    normalizeGameContinuityExtraction(
      {
        ...raw,
        records: [{ ...raw.records[0], knowledge: { ...raw.records[0]!.knowledge, holderRefs: ["unknown"] } }],
      },
      source,
      "holder-batch",
      [],
      holder,
    ),
  /unknown entity/,
);
assert.throws(
  () =>
    normalizeGameContinuityExtraction(
      { ...raw, records: [{ ...raw.records[0], knowledge: { ...raw.records[0]!.knowledge, holders: ["Other"] } }] },
      source,
      "holder-batch",
      [],
      holder,
    ),
  /explicitly listed/,
);
assert.throws(
  () =>
    normalizeGameContinuityExtraction(
      {
        ...raw,
        records: [{ ...raw.records[0], knowledge: { scope: "unknown", holders: ["Mira"], holderRefs: ["char-1"] } }],
      },
      source,
      "holder-batch",
      [],
      holder,
    ),
  /unknown scope/,
);
const legacy = normalizeGameContinuityExtraction(
  { ...raw, records: [{ ...raw.records[0], knowledge: { scope: "private", holders: ["Unregistered"] } }] },
  source,
  "holder-batch",
);
assert.deepEqual(legacy.records[0]!.knowledge!.holders, ["Unregistered"]);
console.log("continuity holder snapshot regression passed");
