import assert from "node:assert/strict";

// Two model slips used to fail a whole continuity batch after every retry (Sessions 11 and 12 of the real
// campaign): a blank or {"text": ...}-wrapped item in record.conditions or record.keys ("record.conditions must be
// an array of strings"), and a message marked "covered" that no record cites. Blank items are dropped, wrapped text
// is unwrapped, and an uncited "covered" message stays unresolved so it is read again instead of counted as done.
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
assert.equal(lenient.dispositions.find((item) => item.messageId === "m1")!.status, "covered");
const m2 = lenient.dispositions.find((item) => item.messageId === "m2")!;
assert.equal(m2.status, "unresolved", "a covered message without a citing record stays unresolved");
assert.match(m2.reason, /no record cites it/u);

// Genuinely malformed lists are still rejected.
assert.throws(
  () =>
    normalizeGameContinuityExtraction(
      { records: [record([42], [])], dispositions: [{ messageId: "m1", status: "covered", reason: "x" }, { messageId: "m2", status: "no_durable_facts", reason: "x" }] },
      sources,
      "gcb-leniency",
    ),
  /record\.conditions must be an array of strings/u,
);
console.log("continuity-extraction-leniency regression passed");
