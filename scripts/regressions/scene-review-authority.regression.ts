import assert from "node:assert/strict";
import {
  reviewSessionSummary,
  SessionSummaryReviewError,
} from "../../packages/server/src/services/game/session-summary-review.js";

const transcript = "[user] The archivist said the west door was sealed.";
const draft = {
  summary: "The west door is open.",
  resumePoint: "",
  partyDynamics: "",
  partyState: "",
  keyDiscoveries: [],
  characterMoments: [],
  littleDetails: [],
  npcUpdates: [],
  statsSnapshot: {},
};

const reviewed = await reviewSessionSummary({
  messages: [{ role: "user", content: transcript }],
  transcript,
  draft,
  relatedContinuity: {
    sceneContinuityEvidence: {
      partyArc: "The west door is open.",
      unaffectedPlan: "Ask the archivist about the eastern stairs.",
    },
  },
  complete: async () =>
    JSON.stringify({
      corrections: [
        {
          path: ["relatedContinuity", "sceneContinuityEvidence", "partyArc"],
          before: "The west door is open.",
          after: "The west door was sealed.",
          reason: "The source says the door was sealed.",
          quote: "The archivist said the west door was sealed.",
        },
      ],
      additions: [],
      decisionChecks: [],
    }),
});

assert.equal(
  (reviewed.relatedContinuity?.sceneContinuityEvidence as Record<string, unknown>).partyArc,
  "The west door was sealed.",
  "the review can correct related scene continuity using exact transcript evidence",
);
assert.equal(
  (reviewed.relatedContinuity?.sceneContinuityEvidence as Record<string, unknown>).unaffectedPlan,
  "Ask the archivist about the eastern stairs.",
  "unrelated continuity remains unchanged",
);
assert.equal(
  reviewed.relatedCorrections.length,
  1,
  "the scene review exposes its continuity correction for source audit",
);

await assert.rejects(
  () =>
    reviewSessionSummary({
      messages: [{ role: "user", content: transcript }],
      transcript,
      draft,
      relatedContinuity: {
        sceneContinuityEvidence: { partyArc: "The west door is open." },
      },
      complete: async () =>
        JSON.stringify({
          corrections: [
            {
              path: ["relatedContinuity", "sceneContinuityEvidence", "partyArc"],
              before: "The west door is open.",
              after: "The west door was sealed.",
              reason: "Unsupported without the source sentence.",
              quote: "The west door was sealed without witnesses.",
            },
          ],
          additions: [],
          decisionChecks: [],
        }),
    }),
  (error) => error instanceof SessionSummaryReviewError && /not in the transcript/.test(error.message),
  "a continuity correction with an invented quote is rejected before save",
);
