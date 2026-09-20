import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  assertSessionSummaryUnchanged,
  SESSION_SUMMARY_CONFLICT_CODE,
  SessionSummaryConflictError,
} from "../../packages/server/src/services/game/session-summary-write-guard.js";

const summary = {
  sessionNumber: 1,
  summary: "The party reached the observatory.",
  resumePoint: "At the observatory gate.",
  partyDynamics: "Cooperative.",
  partyState: "Ready.",
  keyDiscoveries: ["A sealed door"],
  characterMoments: [],
  littleDetails: [],
  statsSnapshot: { gold: 10 },
  npcUpdates: [],
  nextSessionRequest: null,
  timestamp: "2026-09-13T10:00:00.000Z",
};

assert.doesNotThrow(() => assertSessionSummaryUnchanged(summary, { ...summary }, 1));
assert.doesNotThrow(() =>
  assertSessionSummaryUnchanged(summary, Object.fromEntries(Object.entries(summary).reverse()), 1),
);

const conflict = (current: unknown) =>
  assert.throws(
    () => assertSessionSummaryUnchanged(summary, current, 1),
    (error: unknown) =>
      error instanceof SessionSummaryConflictError &&
      error.code === SESSION_SUMMARY_CONFLICT_CODE &&
      error.statusCode === 409,
  );
conflict({ ...summary, summary: "A manually edited recap." });
conflict(null);

// A delayed provider result must reject at commit time after a concurrent edit.
let current: unknown = structuredClone(summary);
const original = structuredClone(current);
const delayedCommit = async () => {
  await Promise.resolve();
  assertSessionSummaryUnchanged(original, current, 1);
};
const pending = delayedCommit();
current = { ...summary, summary: "Edited while generation was running." };
await assert.rejects(pending, (error: unknown) => error instanceof SessionSummaryConflictError);

const routeSource = await readFile(new URL("../../packages/server/src/routes/game.routes.ts", import.meta.url), "utf8");
assert.equal((routeSource.match(/originalTargetSummary = rawPreviousSummaries\[targetIndex\]/gu) ?? []).length, 2);
assert.equal(
  (
    routeSource.match(
      /assertSessionSummaryUnchanged\(originalTargetSummary, rawFreshSummaries\[targetIndex\], sessionNumber\)/gu,
    ) ?? []
  ).length,
  2,
);
assert.match(
  routeSource,
  /journalRecap: ""[\s\S]*?latestState: null[\s\S]*?currentStoryArc: null[\s\S]*?currentCards: \[\]/u,
);
assert.match(
  routeSource,
  /gamePreviousSessionSummaries: nextSummaries,\s*gameLastSessionSummaryReview: summaryReview,/u,
);
assert.doesNotMatch(
  routeSource,
  /gameStoryArc: appliedConclusion\.updatedStoryArc,[\s\S]{0,400}gamePreviousSessionSummaries: nextSummaries/u,
);
const repairedApplySource = routeSource.slice(
  routeSource.indexOf('app.post("/session/regenerate-conclusion/apply-json"'),
);
assert.doesNotMatch(repairedApplySource, /gameStoryArc: appliedConclusion\.updatedStoryArc/u);
assert.doesNotMatch(repairedApplySource, /gameCharacterCards: appliedConclusion\.updatedCards/u);

console.log("Session summary write guard regression passed");
