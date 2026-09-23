import assert from "node:assert/strict";

// normalizeGameContinuityExtraction used to downgrade a "covered" message that no record cites to "unresolved", and
// reviewGameContinuityWithRepairs refuses to verify while the extraction has an unresolved disposition. The only way
// out was a repair, but buildGameContinuityRepairPrompt passed the review's dispositions as the extraction's, so the
// "CURRENT EXTRACTION DISPOSITIONS" block (shown only when they differ) never rendered: the repairer saw a clean
// review and echoed it, and after three repairs the batch ended "unresolved" with its good records unpublished.
// Fixed twice over: (1) an uncited "covered" beside a cited message now becomes no_durable_facts, so the batch
// verifies without a repair; (2) an extraction that really is unresolved shows the repairer its own dispositions.
const { normalizeGameContinuityExtraction, reviewGameContinuityWithRepairs } =
  await import("../../packages/server/src/services/game/continuity-review.js");

const sources = [
  { messageId: "u1", role: "user", content: "I ask Mira to guard the vault." },
  { messageId: "a1", role: "assistant", content: "Mira swears to guard the vault until spring." },
] as any;
const record = {
  kind: "promise",
  text: "Mira swore to guard the vault until spring.",
  subjects: ["Mira"],
  conditions: ["until spring"],
  status: "accepted",
  evidence: [{ messageId: "a1", quote: "Mira swears to guard the vault until spring." }],
  keys: ["vault"],
  knowledge: { scope: "world", holders: [] },
};
const cleanReview = async () => ({
  findings: [],
  dispositions: [
    { messageId: "u1", status: "covered", reason: "answered" },
    { messageId: "a1", status: "covered", reason: "promise" },
  ],
});

// Part 1: the extractor marks the user's request "covered" (the promise answers it) but only cites the assistant line.
const initial = normalizeGameContinuityExtraction(
  {
    records: [record],
    dispositions: [
      { messageId: "u1", status: "covered", reason: "the request is answered by the promise" },
      { messageId: "a1", status: "covered", reason: "promise" },
    ],
  },
  sources,
  "gcb-uncited",
);
assert.equal(initial.dispositions.find((item) => item.messageId === "u1")!.status, "no_durable_facts");
const direct = await reviewGameContinuityWithRepairs({
  sources,
  initial,
  batchId: "gcb-uncited",
  completeReview: cleanReview,
  completeRepair: async () => {
    throw new Error("a clean review of a fully dispositioned extraction needs no repair");
  },
});
assert.equal(direct.status, "verified", `a clean record must not be lost to an uncited "covered" label (got ${direct.status})`);

// Part 2: the extraction itself leaves u1 unresolved. The reviewer marks everything covered, so only the extraction's
// own dispositions tell the repairer which message is unfinished.
const unresolvedInitial = normalizeGameContinuityExtraction(
  {
    records: [record],
    dispositions: [
      { messageId: "u1", status: "unresolved", reason: "not sure yet" },
      { messageId: "a1", status: "covered", reason: "promise" },
    ],
  },
  sources,
  "gcb-uncited-2",
);
const repairPrompts: string[] = [];
const result = await reviewGameContinuityWithRepairs({
  sources,
  initial: unresolvedInitial,
  batchId: "gcb-uncited-2",
  completeReview: cleanReview,
  // A repairer that does the right thing when it is told u1 is unresolved (it has no durable fact of its own),
  // and otherwise keeps the dispositions it was shown.
  completeRepair: async (prompt) => {
    repairPrompts.push(prompt);
    const toldUnresolved = /CURRENT EXTRACTION DISPOSITIONS[\s\S]*"u1"[^}]*"unresolved"/u.test(prompt);
    return {
      replace: [],
      add: [],
      dispositions: [
        toldUnresolved
          ? { messageId: "u1", status: "no_durable_facts", reason: "a request, no durable fact of its own" }
          : { messageId: "u1", status: "covered", reason: "answered" },
        { messageId: "a1", status: "covered", reason: "promise" },
      ],
    };
  },
});

assert.ok(repairPrompts.length > 0, "the unresolved disposition sends the batch to repair");
assert.match(
  repairPrompts[0]!,
  /CURRENT EXTRACTION DISPOSITIONS/u,
  "the repairer must be shown which message the extractor left unresolved",
);
assert.equal(result.status, "verified", `the repaired batch must verify (got ${result.status})`);
console.log("bughunt-continuity-uncited-covered-repair regression passed");
