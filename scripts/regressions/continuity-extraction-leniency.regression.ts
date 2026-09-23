import assert from "node:assert/strict";

// Two model slips used to fail a whole continuity batch after every retry (Sessions 11 and 12 of the real
// campaign): a blank or {"text": ...}-wrapped item in record.conditions or record.keys ("record.conditions must be
// an array of strings"), and a message marked "covered" that no record cites. Blank items are dropped and wrapped
// text is unwrapped. An uncited "covered" message becomes no_durable_facts when other primary messages are cited (it
// used to become unresolved, which no repair could clear, so the batch ended unresolved and its good records were
// never published); it stays unresolved only when no record cites any primary message.
const { normalizeGameContinuityExtraction } = await import("../../packages/server/src/services/game/continuity-review.js");

const sources = [
  { messageId: "m1", role: "assistant", content: "Mira swears to guard the vault until spring." },
  { messageId: "m2", role: "assistant", content: "Rain falls on the harbour." },
] as any;
const record = (conditions: unknown, keys: unknown) => ({
  id: "temporary",
  kind: "promise",
  text: "Mira swore to guard the vault until spring.",
  subjects: ["Mira"],
  conditions,
  status: "accepted",
  evidence: [{ messageId: "m1", quote: "Mira swears to guard the vault until spring." }],
  keys,
});

const lenient = normalizeGameContinuityExtraction(
  {
    records: [record(["", { text: "until spring" }, "   "], ["vault", "", { key: "Mira" }])],
    dispositions: [
      { messageId: "m1", status: "covered", reason: "promise" },
      { messageId: "m2", status: "covered", reason: "weather" },
    ],
  },
  sources,
  "gcb-leniency",
);
assert.deepEqual(lenient.records[0]!.conditions, ["until spring"], "blank conditions dropped, wrapped text unwrapped");
assert.deepEqual(lenient.records[0]!.keys, ["vault", "Mira"]);

// Other shapes seen from models: null, a number, a nested object, a map of named conditions.
const shapes = normalizeGameContinuityExtraction(
  {
    records: [record({ first: { condition: { description: "until spring" } }, second: 3 }, null)],
    dispositions: [
      { messageId: "m1", status: "covered", reason: "promise" },
      { messageId: "m2", status: "no_durable_facts", reason: "weather" },
    ],
  },
  sources,
  "gcb-leniency-shapes",
);
assert.deepEqual(shapes.records[0]!.conditions, ["until spring", "3"]);
assert.deepEqual(shapes.records[0]!.keys, [], "a missing list is empty");
assert.equal(lenient.dispositions.find((item) => item.messageId === "m1")!.status, "covered");
const m2 = lenient.dispositions.find((item) => item.messageId === "m2")!;
assert.equal(m2.status, "no_durable_facts", "an uncited covered message beside a cited one has no durable fact");
assert.match(m2.reason, /no record cites it/u);

// With no record at all, a "covered" label is unexplained and the message stays unresolved.
const empty = normalizeGameContinuityExtraction(
  {
    records: [],
    dispositions: [
      { messageId: "m1", status: "covered", reason: "promise" },
      { messageId: "m2", status: "no_durable_facts", reason: "weather" },
    ],
  },
  sources,
  "gcb-leniency-empty",
);
const emptyM1 = empty.dispositions.find((item) => item.messageId === "m1")!;
assert.equal(emptyM1.status, "unresolved", "a covered message in an extraction with no records stays unresolved");
assert.match(emptyM1.reason, /no record cites it/u);

// Genuinely malformed lists are still rejected.
assert.throws(
  () =>
    normalizeGameContinuityExtraction(
      { records: [record([{}], [])], dispositions: [{ messageId: "m1", status: "covered", reason: "x" }, { messageId: "m2", status: "no_durable_facts", reason: "x" }] },
      sources,
      "gcb-leniency",
    ),
  /record\.conditions must be an array of strings/u,
);
// Quote drift: curly quotes and doubled spaces are repaired to the exact source text; a quote that is not in the
// source drops only its record; a missing disposition is filled in instead of failing the batch.
const { normalizeGameContinuityReview, locateContinuityQuote } = await import(
  "../../packages/server/src/services/game/continuity-review.js"
);
const drifted = [
  { messageId: "m1", role: "assistant", content: "Mira says \u201cI\u2019ll guard the vault\u201d  until spring." },
  { messageId: "m2", role: "assistant", content: "Rain falls on the harbour." },
] as any;
assert.equal(locateContinuityQuote("\"I'll guard the vault\" until spring", drifted[0].content), "\u201cI\u2019ll guard the vault\u201d  until spring");
assert.equal(locateContinuityQuote("She burned the vault", drifted[0].content), null);
const salvaged = normalizeGameContinuityExtraction(
  {
    records: [
      { ...record([], ["vault"]), evidence: [{ messageId: "m1", quote: "\"I'll guard the vault\" until spring" }] },
      { ...record([], ["fire"]), text: "Mira burned the vault.", evidence: [{ messageId: "m1", quote: "She burned the vault" }] },
    ],
    dispositions: [{ messageId: "m1", status: "covered", reason: "promise" }],
  },
  drifted,
  "gcb-leniency-quotes",
);
assert.equal(salvaged.records.length, 1, "the record with an invented quote is dropped, the good one survives");
assert.equal(salvaged.records[0]!.evidence[0]!.quote, "\u201cI\u2019ll guard the vault\u201d  until spring");
assert.equal(salvaged.dispositions.find((item) => item.messageId === "m2")!.status, "no_durable_facts");

const review = normalizeGameContinuityReview(
  {
    findings: [
      { kind: "omission", messageId: "m1", quote: "Mira says \"I'll guard", recordIds: [], detail: "drifted but real" },
      { kind: "omission", messageId: "m2", quote: "Snow covers the hills", recordIds: [], detail: "not in the source" },
    ],
    dispositions: [{ messageId: "m1", status: "covered", reason: "promise" }],
  },
  drifted,
  salvaged.records,
);
assert.equal(review.findings.length, 1, "a finding whose quote is not in the source is dropped, not fatal");
assert.equal(review.findings[0]!.quote, "Mira says \u201cI\u2019ll guard");
assert.equal(review.dispositions.length, 2, "the missing review disposition is filled in");
console.log("continuity-extraction-leniency regression passed");
