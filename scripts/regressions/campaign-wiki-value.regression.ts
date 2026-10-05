import assert from "node:assert/strict";
import { wikiValueRecord, wikiValueSummary } from "../../packages/client/src/lib/campaign-wiki-value";

assert.equal(wikiValueSummary({ text: "Elowen was here", status: "unresolved" }), "Elowen was here");
assert.equal(wikiValueSummary('{"text":"Parsed text","status":"proposed"}'), "Parsed text");
assert.equal(wikiValueSummary("plain text"), "plain text");
assert.equal(wikiValueSummary(["one", "two"]), "one, two");
assert.match(wikiValueSummary({ subject: "Elowen", receiptId: "r-1" }), /subject: Elowen/);
assert.equal(wikiValueRecord('{"text":"Parsed text"}')?.text, "Parsed text");
assert.equal(wikiValueRecord("malformed"), null);
assert.equal(wikiValueSummary('{"text":broken}'), '{"text":broken}');
assert.equal(wikiValueSummary(false), "false");
assert.equal(wikiValueSummary(0), "0");
const original = {
  text: "Elowen was to hand over the maps",
  status: "unresolved",
  receiptId: "receipt-1",
  evidence: [{ quote: "Not yet", sourceHash: "hash-1" }],
};
assert.equal(wikiValueSummary(original), original.text);
assert.deepEqual(wikiValueRecord(JSON.stringify(original)), original, "inspection retains evidence and status");
let nested: unknown = "end";
for (let i = 0; i < 10; i++) nested = { child: nested };
assert.ok(wikiValueSummary(nested).length < 100, "deep records have a bounded summary");
console.info("campaign-wiki-value regression passed");
