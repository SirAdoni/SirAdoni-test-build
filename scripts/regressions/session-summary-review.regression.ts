import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewSessionSummary } from "../../packages/server/src/services/game/session-summary-review.js";
import { buildSessionConclusionPrompt } from "../../packages/server/src/services/game/gm-prompts.js";
import type { ChatMessage } from "../../packages/server/src/services/llm/base-provider.js";
const disposableDataDir = mkdtempSync(join(tmpdir(), "marinara-session-review-fit-"));
process.env.DATA_DIR = disposableDataDir;
const { fitSessionConclusionMessages } = await import("../../packages/server/src/routes/game.routes.js");
const transcript =
  "[user] Edmund: I want you to learn through experience.\n\n[assistant] Gwenllian: I cannot issue an order quickly enough. Hilde: That is the lesson. Jadwiga: Create distance or use the choker.\n\n[user OOC correction] Preserve who made the decision.";
const messages: ChatMessage[] = [
  {
    role: "system",
    content: buildSessionConclusionPrompt({ includeCharacterCards: false, gameSpecialInstructions: null }),
  },
  { role: "user", content: transcript },
];
assert.match(messages[0].content, /Phase exception.*FACTUAL REVIEW PHASE/);
const draft = {
  summary: "Quenby chose her learning method. Edmund and Jadwiga enjoyed a fight.",
  resumePoint: "At the gate.",
  partyDynamics: "",
  partyState: "Rested.",
  keyDiscoveries: [],
  characterMoments: [],
  littleDetails: [],
  npcUpdates: [],
  statsSnapshot: { day: 16 },
};
const oversizedTranscript = Array.from({ length: 180 }, (_, index) =>
  `[assistant] Session event ${index}: the party records a distinct factual continuity detail.`,
).join("\n\n");
const fittedConclusion = fitSessionConclusionMessages({
  sessionNumber: 3,
  language: "English",
  rating: "sfw",
  gameSpecialInstructions: null,
  journalRecap: "A bounded recap of the session.",
  transcriptText: oversizedTranscript,
  transcriptMessageCount: 180,
  latestState: null,
  currentStoryArc: null,
  currentPlotTwists: [],
  currentPartyArcs: [],
  currentMorale: 50,
  currentCards: [],
  playerCharacterNames: [],
  playerCharacterCanon: null,
  currentCampaignPlan: {},
  currentNpcs: [],
  nextSessionRequest: null,
  continuityPromptContext: "",
  modelAccessPolicy: {
    suppressModelParameters: true,
    connectionMaxContext: 1200,
    effectiveMaxContext: 1200,
  },
  maxTokens: 200,
});
assert.equal(fittedConclusion.transcriptTruncated, true);
assert.equal(fittedConclusion.fullMessages.filter((message) => message.content.includes(oversizedTranscript)).length, 1);
assert.equal(fittedConclusion.messages.some((message) => message.content.includes(oversizedTranscript)), false);
await reviewSessionSummary({
  messages: fittedConclusion.fullMessages,
  transcript: oversizedTranscript,
  draft: { ...draft, summary: "The party traveled onward." },
  complete: async (request) => {
    assert.equal(request.filter((message) => message.content.includes(oversizedTranscript)).length, 1);
    return JSON.stringify({ corrections: [], additions: [], decisionChecks: [] });
  },
});
const relatedContinuity = {
  campaignProgression: { partyArcs: [{ name: "Quenby", arc: "Quenby chose her learning method." }] },
  characterCards: [{ name: "Jadwiga", strengths: ["Experienced"] }],
};
const original = structuredClone({ draft, relatedContinuity });
const attribution = {
  path: ["summary", "summary"],
  before: "Quenby chose her learning method.",
  after: "Edmund chose Quenby's learning method.",
  reason: "Decision ownership",
  quote: "Edmund: I want you to learn through experience.",
};
const reaction = {
  path: ["summary", "keyDiscoveries"],
  value: "Gwenllian could not give orders fast enough. Jadwiga instructed them to create distance or use the choker.",
  reason: "Restore the witnessed lesson",
  quote:
    "Gwenllian: I cannot issue an order quickly enough. Hilde: That is the lesson. Jadwiga: Create distance or use the choker.",
};
const reviewed = {
  decisionChecks: [{ id: 0, quote: attribution.quote }],
  corrections: [
    attribution,
    { ...attribution, path: ["relatedContinuity", "campaignProgression", "partyArcs", 0, "arc"] },
  ],
  additions: [reaction],
};
const run = (value: unknown) =>
  reviewSessionSummary({
    messages,
    transcript,
    draft,
    relatedContinuity,
    complete: async (request) => {
      assert.deepEqual(request.slice(0, messages.length), messages);
      assert.equal(request.filter((message) => message.content.includes(transcript)).length, 1);
      return JSON.stringify({ decisionChecks: reviewed.decisionChecks, ...(value as object) });
    },
  });
const result = await run(reviewed);
assert.equal(result.summary.summary, "Edmund chose Quenby's learning method. Edmund and Jadwiga enjoyed a fight.");
assert.deepEqual(result.summary.keyDiscoveries, [reaction.value]);
assert.equal(
  (result.relatedContinuity.campaignProgression as typeof relatedContinuity.campaignProgression).partyArcs[0].arc,
  "Edmund chose Quenby's learning method.",
);
assert.deepEqual(result.relatedContinuity.characterCards, relatedContinuity.characterCards);
assert.deepEqual({ draft, relatedContinuity }, original, "Source objects are never mutated");
await assert.rejects(
  run({ ...reviewed, corrections: [{ ...attribution, quote: "Invented statement" }] }),
  /not in the transcript/,
);
await assert.rejects(run({ ...reviewed, corrections: [{ ...attribution, before: "Missing target" }] }), /exactly once/);
await assert.rejects(
  run({ ...reviewed, corrections: [{ ...attribution, path: ["summary", "__proto__"] }] }),
  /nonexistent/,
);
await assert.rejects(
  run({
    ...reviewed,
    corrections: [{ ...attribution, path: ["relatedContinuity", "campaignProgression", "partyArcs", "length"] }],
  }),
  /nonexistent/,
);
await assert.rejects(
  run({ ...reviewed, additions: [{ ...reaction, path: ["relatedContinuity", "characterCards"] }] }),
  /fact list/,
);
await assert.rejects(run({ ...reviewed, corrections: [{ ...attribution, quote: "  " }] }), /./);
await assert.rejects(
  reviewSessionSummary({
    messages: [{ role: "user", content: "middle omitted" }],
    transcript,
    draft,
    complete: async () => {
      throw Error("Must not call provider");
    },
  }),
  /full session transcript/,
);
assert.deepEqual((await run({ corrections: [], additions: [] })).summary, draft);
let attempts = 0;
const retried = await reviewSessionSummary({
  messages,
  transcript,
  draft,
  relatedContinuity,
  complete: async () => {
    attempts++;
    return attempts === 1 ? ' {"corrections":[' : JSON.stringify(reviewed);
  },
});
assert.equal(attempts, 2);
assert.equal(retried.summary.summary, result.summary.summary);
let targetAttempts = 0;
await reviewSessionSummary({
  messages,
  transcript,
  draft,
  complete: async (request) => {
    targetAttempts++;
    if (targetAttempts === 1) {
      assert.match(request.at(-1)!.content, /PLAYER-TURN SOURCE INDEX/);
      assert.match(request.at(-1)!.content, /Edmund: I want you to learn through experience/);
      const index = request.at(-1)!.content.split("FACTUAL REVIEW PHASE")[0];
      assert.match(index, /\[user OOC correction\] Preserve who made the decision/);
      assert.ok(!index.includes("Gwenllian:"), "The index separates direct player input from GM narration");
      return JSON.stringify({
        decisionChecks: reviewed.decisionChecks,
        corrections: [{ ...attribution, before: "A paraphrased target", quote: "A fabricated source quote" }],
        additions: [],
      });
    }
    assert.ok(request.at(-1)!.content.includes(JSON.stringify(draft.summary)));
    assert.ok(request.at(-1)!.content.includes(JSON.stringify(attribution.path)));
    assert.ok(
      request.at(-1)!.content.includes("A fabricated source quote"),
      "Return evidence and target errors together",
    );
    return JSON.stringify({ decisionChecks: reviewed.decisionChecks, corrections: [attribution], additions: [] });
  },
});
assert.equal(targetAttempts, 2);
await assert.rejects(run({ ...reviewed, decisionChecks: [] }), /decision audit is incomplete/);
await assert.rejects(
  run({ ...reviewed, decisionChecks: [{ id: 0, quote: "Invented decision" }] }),
  /not in the transcript/,
);
let failures = 0;
await assert.rejects(
  reviewSessionSummary({
    messages,
    transcript,
    draft,
    complete: async () => {
      failures++;
      return '{"corrections":[';
    },
  }),
  /cut off/,
);
assert.equal(failures, 2);
const quoteSource = "[assistant] She says, and I would rather that room be the Regent's.";
let quoteAttempts = 0;
await reviewSessionSummary({
  transcript: quoteSource,
  messages: [{ role: "user", content: quoteSource }],
  draft: { ...draft, summary: "She preferred the garden." },
  complete: async (repairMessages) => {
    quoteAttempts++;
    if (quoteAttempts === 2) {
      assert.match(repairMessages.at(-1)!.content, /Nearby SOURCE excerpt/);
      assert(repairMessages.at(-1)!.content.includes("and I would rather"));
    }
    return JSON.stringify({
      corrections: [
        {
          path: ["summary", "summary"],
          before: "garden",
          after: "Regent's room",
          reason: "Preserve the stated preference.",
          quote:
            quoteAttempts === 1
              ? "but I would rather that room be the Regent's."
              : "and I would rather that room be the Regent's.",
        },
      ],
      additions: [],
      decisionChecks: [],
    });
  },
});
assert.equal(quoteAttempts, 2, "Paraphrased evidence must be repaired, not accepted");
const literal = await run({ corrections: [{ ...attribution, after: "Edmund said $& literally." }], additions: [] });
assert.ok(literal.summary.summary.startsWith("Edmund said $& literally."));
process.stdout.write(
  "Session summary review regression passed: attribution, consequences, linked arcs, literal edits, complete evidence, preserved prefix, and bounded retries.\n",
);
rmSync(disposableDataDir, { recursive: true, force: true });
