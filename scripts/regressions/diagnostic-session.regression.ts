import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createDiagnostic } from "../../packages/server/src/lib/diagnostics.js";
import {
  reviewSessionSummary,
  runSessionDiagnosticStage,
  SessionSummaryReviewError,
} from "../../packages/server/src/services/game/session-summary-review.js";

const routeSource = await readFile(new URL("../../packages/server/src/routes/game.routes.ts", import.meta.url), "utf8");
for (const operation of ["game.session.conclude", "game.session.regenerate-conclusion"]) {
  assert.match(routeSource, new RegExp(`${operation.replaceAll(".", "\\.")}.*runSessionDiagnosticStage`, "s"));
}

const context = (stage: string) => ({
  requestId: "regression-request",
  operationId: "regression-operation",
  operation: "game.session.conclude",
  stage,
  chatId: "empty-campaign-chat",
  provider: "fixture-provider",
  model: "fixture-model",
});
let providerFailure: unknown;
try {
  await runSessionDiagnosticStage(context("generation"), async () => {
    throw new Error("provider fixture failed");
  });
} catch (error) {
  providerFailure = error;
}
assert.match(String((providerFailure as Error).message), /provider fixture failed/);
const providerReference = createDiagnostic(providerFailure, context("generation"));
assert.equal(createDiagnostic(providerFailure, context("http")).errorId, providerReference.errorId);

const transcript = "[user] Edmund: Continue.\n\n[assistant] The gate opens.";
const draft = {
  summary: "The gate opens.",
  resumePoint: "At the gate.",
  partyDynamics: "",
  partyState: "",
  keyDiscoveries: [],
  characterMoments: [],
  littleDetails: [],
  npcUpdates: [],
  statsSnapshot: {},
};
let reviewFailure: SessionSummaryReviewError | undefined;
try {
  await runSessionDiagnosticStage(context("factual_review"), () =>
    reviewSessionSummary({
      messages: [{ role: "user", content: transcript }],
      transcript,
      draft,
      complete: async () => {
        throw new Error("review fixture failed");
      },
    }).catch((error) => {
      throw new SessionSummaryReviewError(error);
    }),
  );
} catch (error) {
  reviewFailure = error as SessionSummaryReviewError;
}
assert(reviewFailure);
assert.equal((reviewFailure.cause as Error).message, "review fixture failed");
const reviewReference = createDiagnostic(reviewFailure, context("factual_review"));
assert.equal(reviewReference.stage, "factual_review");
assert.equal(createDiagnostic(reviewFailure, context("persistence")).errorId, reviewReference.errorId);

await assert.rejects(
  runSessionDiagnosticStage(context("persistence"), async () => {
    throw new Error("save fixture failed");
  }),
  /save fixture failed/,
);

process.stdout.write(
  "Diagnostic session regression passed: production route wiring, provider/review/save failures, preserved causes, and stable outer diagnostic references.\n",
);
