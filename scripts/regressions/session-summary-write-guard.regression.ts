import assert from "node:assert/strict";
import {
  assertSessionSummaryFingerprint,
  assertSessionSummaryUnchanged,
  SESSION_SUMMARY_CONFLICT_CODE,
  SessionSummaryConflictError,
  sessionSummaryFingerprint,
} from "../../packages/server/src/services/game/session-summary-write-guard.js";

const original = {
  sessionNumber: 1,
  summary: "The group reached a safe shelter.",
  statsSnapshot: { supplies: 3 },
};

assert.doesNotThrow(() => assertSessionSummaryUnchanged(original, { ...original }, 1));
assert.throws(
  () => assertSessionSummaryUnchanged(original, { ...original, summary: "A revised recap." }, 1),
  (error: unknown) =>
    error instanceof SessionSummaryConflictError &&
    error.code === SESSION_SUMMARY_CONFLICT_CODE &&
    error.statusCode === 409,
);
assert.throws(() => assertSessionSummaryUnchanged(original, null, 1), SessionSummaryConflictError);
const fingerprint = sessionSummaryFingerprint(original);
assert.doesNotThrow(() => assertSessionSummaryFingerprint(fingerprint, original, 1));
assert.throws(
  () => assertSessionSummaryFingerprint(fingerprint, { ...original, summary: "A revised recap." }, 1),
  SessionSummaryConflictError,
);
assert.throws(() => assertSessionSummaryFingerprint(undefined, original, 1), SessionSummaryConflictError);
console.log("session-summary-write-guard regression passed");
