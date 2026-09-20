import assert from "node:assert/strict";

// A model can abandon a long conclusion mid-string and write it again in the same response (Session 10 on Fable 5.1:
// one SDK request, no retry). The saved reply then holds a cut-off conclusion followed directly by a complete one,
// glued mid-string ("...common halls{"summary":{...}}"), which is not valid JSON as a whole. Session 10's
// 99,000-character conclusion failed this way and ended as an unreadable 422. The salvage must use the last
// complete attempt instead of reporting that no summary exists.
const { salvageSessionConclusionDraft } = await import(
  "../../packages/server/src/services/game/session-conclusion-salvage.js"
);

const complete = {
  summary: {
    summary: "The party reached the river city and the council greeted them in the rain.",
    resumePoint: "The next morning at the lodging court.",
    partyDynamics: "Calm.",
    partyState: "Rested.",
    keyDiscoveries: ["The storm refills from the east within days."],
    characterMoments: [],
    littleDetails: [],
    npcUpdates: [],
    statsSnapshot: {},
  },
  campaignProgression: { storyArc: "The tour continues.", plotTwists: [], partyArcs: [] },
  nextSessionPlan: "Continue west.",
  characterCards: [],
};
const cutOff = '{\n  "summary": {\n    "summary": "The party reached the river city and the council greeted them in the rain. Gardens between the rings; four bakehouses; common halls';
const glued = cutOff + JSON.stringify(complete);

assert.throws(() => JSON.parse(glued), "the glued reply is not valid JSON as a whole");
const salvaged = salvageSessionConclusionDraft(glued);
const summary = (salvaged.draft as { summary: { summary: string; resumePoint: string } }).summary;
assert.equal(summary.summary, complete.summary.summary, "the complete second attempt is used");
assert.equal(summary.resumePoint, complete.summary.resumePoint);
assert.ok(
  salvaged.repairs.some((repair: string) => repair.includes("started the conclusion over")),
  "the repair is recorded so the log explains what happened",
);

// A normal, single reply is untouched.
const single = salvageSessionConclusionDraft(JSON.stringify(complete));
assert.ok(!single.repairs.some((repair: string) => repair.includes("started the conclusion over")));

console.log("session-conclusion-restarted-draft regression passed");
