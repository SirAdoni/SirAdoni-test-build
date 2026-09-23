import assert from "node:assert/strict";

// Providers without JSON mode (Claude) may wrap the continuity object; only complete objects are accepted.
const { parseContinuityJson } = await import("../../packages/server/src/services/game/continuity-provider.js");

const object = { records: [], dispositions: [{ messageId: "m1", status: "no_durable_facts", reason: "none" }] };
const json = JSON.stringify(object);

assert.deepEqual(parseContinuityJson(json), object, "plain JSON");
assert.deepEqual(parseContinuityJson(`\n  ${json}\n`), object, "surrounding whitespace");
assert.deepEqual(parseContinuityJson("```json\n" + JSON.stringify(object, null, 2) + "\n```"), object, "fenced JSON");
assert.deepEqual(parseContinuityJson("```\n" + json + "\n```"), object, "unlabelled fence");
assert.deepEqual(parseContinuityJson(`Here is the extraction:\n${json}`), object, "leading sentence");

const invalid = (value: string, label: string) =>
  assert.throws(() => parseContinuityJson(value), /CONTINUITY_INVALID_JSON/, label);
invalid('{"records": [], "dispositions": [', "truncated object is not repaired");
invalid("```json\n{\"records\": [}\n```", "malformed fenced object is not repaired");
invalid("[]", "arrays are not a continuity object");
invalid(`${json}\n${json}`, "two objects are ambiguous");
invalid("I could not complete this.", "prose only");
invalid("", "empty");

console.log("continuity JSON envelope regression passed");
