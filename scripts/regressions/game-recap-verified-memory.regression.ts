import assert from "node:assert/strict";

// The "Previously on" recap used to rest on the latest session summary alone, so a summary that misnamed someone or
// forgot who holds an item passed its mistake into the next session's opening. The recap now also reads the verified
// campaign memory as a fact check, and still works when no memory is available.
const { buildRecapPrompt } = await import("../../packages/server/src/services/game/session.service.js");

const summary = {
  sessionNumber: 4,
  summary: "Mira handed the silver key to Quenby at the bridge.",
  resumePoint: "At the bridge at dusk.",
  partyDynamics: "Wary",
  partyState: "Tired",
  keyDiscoveries: ["The vault is flooded"],
} as any;

const withMemory = buildRecapPrompt([summary], null, "sfw", "[fact f1 S3] Quenby, holds: the silver key");
assert.match(withMemory, /Verified campaign memory/u);
assert.match(withMemory, /\[fact f1 S3\] Quenby, holds: the silver key/u);
assert.ok(
  withMemory.indexOf("Verified campaign memory") < withMemory.indexOf("Use enough compact paragraphs"),
  "the memory sits before the closing instructions",
);

for (const empty of [undefined, null, "   "]) {
  const plain = buildRecapPrompt([summary], null, "sfw", empty);
  assert.doesNotMatch(plain, /Verified campaign memory/u, "no memory section without memory");
}
console.log("game-recap-verified-memory regression passed");
