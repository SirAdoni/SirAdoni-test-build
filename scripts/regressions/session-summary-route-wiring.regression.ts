import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../../packages/server/src/routes/game.routes.ts", import.meta.url), "utf8");
const reviewCalls = source.match(/reviewSessionConclusionDraft\(\{/gu) ?? [];
const writeGuards =
  source.match(
    /assertSessionSummaryUnchanged\(originalTargetSummary, rawFreshSummaries\[targetIndex\], sessionNumber\)/gu,
  ) ?? [];
const repairedApplyCalls = source.match(/parseSessionConclusionForApply\(rawJson\)/gu) ?? [];
const repairedReviewCalls = source.match(/reviewRepairedSessionConclusion\(\{/gu) ?? [];

assert.equal(reviewCalls.length, 3, "initial, regenerated, and repaired conclusions use factual review");
assert.equal(writeGuards.length, 2, "regeneration and repaired regeneration guard both save paths");
assert.equal(repairedApplyCalls.length, 2, "both conclusion repair endpoints use salvage parsing");
assert.equal(repairedReviewCalls.length, 2, "both conclusion repair endpoints repeat factual review before save");
assert.match(source, /salvageGeneratedSessionConclusion\(\s*conclusionExtraction\.content,\s*result\.finishReason,/u);
assert.match(
  source,
  /if \(err instanceof SessionSummaryReviewError \|\| isSessionConclusionIncompleteError\(err\)\) throw err/u,
);
assert.match(source, /summaryFingerprint: sessionSummaryFingerprint\(originalTargetSummary\)/u);
assert.match(source, /assertSessionSummaryFingerprint\(summaryFingerprint, originalTargetSummary, sessionNumber\)/u);
assert.match(
  source,
  /async function reviewSessionConclusionDraft\([\s\S]*?if \(!isFeatureEnabled\("recapFactualReview"\)\) return \{ draft: args\.draft, reviewApplied: false \}/u,
);
assert.match(
  source,
  /async function reviewRepairedSessionConclusion\([\s\S]*?if \(!isFeatureEnabled\("recapFactualReview"\)\) return \{ draft: args\.draft, reviewApplied: false \}/u,
);
assert.match(source, /if \(!isFeatureEnabled\("recapFactualReview"\)\) \{[\s\S]*?reviewSkippedBeforeDispatch = true/u);
assert.equal(
  (source.match(/factualReviewApplied && !isFeatureEnabled\("recapFactualReview"\)/gu) ?? []).length,
  4,
  "each write callback rechecks late opt-out after any awaited metadata/fingerprint reads",
);
assert.match(source, /SessionSummaryReviewError \|\| isSessionConclusionIncompleteError/u);
assert.match(source, /const fullMessages = conclusionMessages;[\s\S]*?fullMessages,/u);
console.log("session-summary route wiring regression passed");
