import assert from "node:assert/strict";
import { reviewSessionSummary } from "../../packages/server/src/services/game/session-summary-review.js";

const transcript = "[user] We reached the shelter before dawn.";
const messages = [{ role: "user" as const, content: `Session transcript:\n${transcript}` }];
const draft = {
  summary: "The group reached a shelter after sunrise.",
  resumePoint: "At the shelter.",
  partyDynamics: "Cooperative.",
  partyState: "Rested.",
  keyDiscoveries: [],
  characterMoments: [],
  littleDetails: [],
  npcUpdates: [],
  statsSnapshot: {},
};

let calls = 0;
const reviewed = await reviewSessionSummary({
  messages,
  transcript,
  draft,
  complete: async (request) => {
    calls += 1;
    assert.match(request.at(-1)?.content ?? "", /FACTUAL REVIEW PHASE/);
    return JSON.stringify({
      corrections: [
        {
          path: ["summary", "summary"],
          before: "after sunrise",
          after: "before dawn",
          reason: "The transcript places the arrival before dawn.",
          quote: "We reached the shelter before dawn.",
        },
      ],
      additions: [],
      decisionChecks: [],
    });
  },
});
assert.equal(calls, 1, "the injected completion callback is the only provider boundary");
assert.equal(reviewed.summary.summary, "The group reached a shelter before dawn.");

await assert.rejects(
  reviewSessionSummary({
    messages,
    transcript,
    draft,
    complete: async () =>
      JSON.stringify({
        corrections: [
          {
            path: ["summary", "summary"],
            before: "after sunrise",
            after: "before dawn",
            reason: "unsupported evidence",
            quote: "The group reached the mountain at midnight.",
          },
        ],
        additions: [],
        decisionChecks: [],
      }),
  }),
  /not in the transcript/,
);

await assert.rejects(
  reviewSessionSummary({
    messages,
    transcript,
    draft,
    complete: async () =>
      JSON.stringify({
        corrections: [
          {
            path: ["relatedContinuity", "partyArcs", 0],
            before: "unreviewed",
            after: "changed",
            reason: "outside the SessionSummary review scope",
            quote: "We reached the shelter before dawn.",
          },
        ],
        additions: [],
        decisionChecks: [],
      }),
  }),
  /Invalid review target root/u,
);
console.log("session-summary-review regression passed");
