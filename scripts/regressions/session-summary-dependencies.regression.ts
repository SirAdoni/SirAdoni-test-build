import assert from "node:assert/strict";
import { buildSessionSummaryRefreshDescriptor, hashSessionSummaryValue } from "../../packages/server/src/services/game/session-summary-dependencies.js";

const messages = [
  { id: "u1", role: "user", content: "I open the sealed gate.", activeSwipeIndex: 0 },
  { id: "a1", role: "assistant", content: "The gate opens onto the moonlit quay.", activeSwipeIndex: 0 },
];
const summary = {
  sessionNumber: 1,
  summary: "The party opened the sealed gate.",
  resumePoint: "On the moonlit quay.",
  partyDynamics: "Together.",
  partyState: "Standing at the quay.",
  keyDiscoveries: ["The gate leads to the quay."],
  characterMoments: [],
  littleDetails: [],
  statsSnapshot: {},
  npcUpdates: [],
  nextSessionRequest: null,
  timestamp: "2026-09-13T00:00:00.000Z",
};

const descriptor = buildSessionSummaryRefreshDescriptor({
  messages,
  metadata: {},
  sessionNumber: 1,
  summary,
  continuityRequired: true,
  continuityReceiptIds: ["receipt-b", "receipt-a", "receipt-a"],
  now: "2026-09-13T00:00:00.000Z",
});

assert.equal(descriptor.version, 1);
assert.equal(descriptor.status, "provisional");
assert.deepEqual(descriptor.dependencies.continuityReceiptIds, ["receipt-a", "receipt-b"]);
assert.equal(descriptor.expectedSummaryHash, hashSessionSummaryValue(summary));
assert.equal(descriptor.sourceRange.messages.length, 2);
assert.notEqual(
  descriptor.sourceRange.sourceHash,
  buildSessionSummaryRefreshDescriptor({
    messages: [{ ...messages[1], content: "The gate opens onto a dark quay." }, messages[0]],
    metadata: {},
    sessionNumber: 1,
    summary,
  }).sourceRange.sourceHash,
);
assert.notEqual(descriptor.expectedSummaryHash, hashSessionSummaryValue({ ...summary, summary: "User edit." }));

process.stdout.write("Session summary dependency descriptor regression passed.\n");
