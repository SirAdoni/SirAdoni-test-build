import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";

export const SESSION_SUMMARY_CONFLICT_CODE = "SESSION_SUMMARY_CONFLICT";

export class SessionSummaryConflictError extends Error {
  readonly code = SESSION_SUMMARY_CONFLICT_CODE;
  readonly statusCode = 409;

  constructor(sessionNumber: number) {
    super(`Session ${sessionNumber} summary changed while it was being regenerated.`);
    this.name = "SessionSummaryConflictError";
  }
}

export function sessionSummaryFingerprint(summary: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(summary ?? null))
    .digest("hex");
}

export function assertSessionSummaryFingerprint(
  expectedFingerprint: string | undefined,
  currentSummary: unknown,
  sessionNumber: number,
): void {
  if (!expectedFingerprint || expectedFingerprint !== sessionSummaryFingerprint(currentSummary)) {
    throw new SessionSummaryConflictError(sessionNumber);
  }
}

export function assertSessionSummaryUnchanged(
  originalSummary: unknown,
  currentSummary: unknown,
  sessionNumber: number,
): void {
  if (!isDeepStrictEqual(originalSummary ?? null, currentSummary ?? null)) {
    throw new SessionSummaryConflictError(sessionNumber);
  }
}
