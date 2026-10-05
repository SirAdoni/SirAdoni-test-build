import assert from "node:assert/strict";
import { salvageSessionConclusionDraft } from "../../packages/server/src/services/game/session-conclusion-salvage.js";

const complete = {
  summary: {
    summary: "The group reached a safe shelter.",
    resumePoint: "At the shelter entrance.",
    partyDynamics: "Calm.",
    partyState: "Ready.",
    keyDiscoveries: ["The road is blocked."],
    characterMoments: [],
    littleDetails: [],
    npcUpdates: [],
    statsSnapshot: {},
  },
};
const truncated = '{"summary":{"summary":"The group walked through a';
const restarted = truncated + JSON.stringify(complete);

assert.throws(() => JSON.parse(restarted), "the restarted response is not valid JSON as a whole");
const result = salvageSessionConclusionDraft(restarted);
assert.equal((result.draft.summary as { summary: string }).summary, complete.summary.summary);
assert.ok(result.repairs.some((repair) => repair.includes("started the conclusion over")));

const single = salvageSessionConclusionDraft(JSON.stringify(complete));
assert.ok(!single.repairs.some((repair) => repair.includes("started the conclusion over")));
console.log("session-conclusion-restarted-draft regression passed");
