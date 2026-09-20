import assert from "node:assert/strict";
import {
  buildSharedPartyContinuityEvidence,
  buildSessionContinuityEvidenceBlock,
  buildSessionReviewRelatedContinuity,
  buildSessionContinuitySourceScope,
  sliceSessionMessagesThroughBoundary,
} from "../../packages/server/src/routes/game.routes.js";
import {
  formatSceneContinuityEvidenceAid,
  selectSceneContinuityRecords,
} from "../../packages/server/src/services/game/scene-timeline.service.js";
import { selectContinuityRecordsForAudience } from "../../packages/server/src/services/game/continuity-knowledge.js";

const messages = [
  { id: "system-1", role: "system", content: "hidden setup" },
  { id: "source-1", role: "user", content: "The party enters the observatory." },
  { id: "source-2", role: "assistant", content: "The observatory doors open." },
  {
    id: "summary-1",
    role: "narrator",
    content: "**Session 1 Concluded**\nEarlier recap.",
    extra: JSON.stringify({ hiddenFromAI: true }),
  },
  { id: "later-1", role: "user", content: "A later session begins." },
];

const scope = buildSessionContinuitySourceScope(messages);
assert.deepEqual(scope.allowedSourceMessageIds, ["source-1", "source-2", "later-1"]);
assert.equal(scope.throughMessageId, "later-1");
assert(!scope.allowedSourceMessageIds.includes("system-1"));
assert(!scope.allowedSourceMessageIds.includes("summary-1"));

const historicalMessages = sliceSessionMessagesThroughBoundary(messages, "summary-1");
const historicalScope = buildSessionContinuitySourceScope(historicalMessages);
assert.deepEqual(historicalScope.allowedSourceMessageIds, ["source-1", "source-2"]);
assert.equal(historicalScope.throughMessageId, "source-2");
assert.throws(() => sliceSessionMessagesThroughBoundary(messages, "missing-boundary"), /boundary not found/);

const evidence = "<game_continuity_context>CONTINUITY_SUMMARY pending=1 unresolved=1</game_continuity_context>";
assert(buildSessionContinuityEvidenceBlock(evidence).some((line) => line.includes(evidence)));
assert.equal(buildSessionReviewRelatedContinuity({ summary: "draft" }, evidence).continuityEvidence, evidence);

const sceneRecords = [
  {
    receiptId: "r1",
    sessionNumber: 1,
    sourceOrder: 0,
    id: "scene-fact",
    kind: "learning" as const,
    text: "A learned fact.",
    subjects: ["A"],
    conditions: ["while present"],
    status: "accepted" as const,
    evidence: [{ messageId: "source-1", quote: "The party enters the observatory." }],
    keys: [],
    knowledge: { scope: "world" as const, holders: ["A", "B"] },
  },
  {
    receiptId: "r2",
    sessionNumber: 1,
    sourceOrder: 1,
    id: "neighbor-fact",
    kind: "event" as const,
    text: "Neighboring scene fact.",
    subjects: ["B"],
    conditions: [],
    status: "accepted" as const,
    evidence: [{ messageId: "later-1", quote: "A later session begins." }],
    keys: [],
    knowledge: { scope: "private" as const, holders: ["B"] },
  },
];
const unknownRecord = {
  ...sceneRecords[0],
  id: "unknown-fact",
  knowledge: { scope: "unknown" as const, holders: ["A", "B"] },
};
assert.deepEqual(selectSceneContinuityRecords(sceneRecords, ["source-1"]), [sceneRecords[0]]);
assert.deepEqual(selectContinuityRecordsForAudience(sceneRecords, { kind: "character", name: "A" }), [sceneRecords[0]]);
assert.deepEqual(selectContinuityRecordsForAudience(sceneRecords, { kind: "character", name: "B" }), sceneRecords);
assert.deepEqual(selectContinuityRecordsForAudience([unknownRecord], { kind: "character", name: "A" }), []);
assert(buildSharedPartyContinuityEvidence(sceneRecords, ["A", "B"]).includes("A learned fact."));
assert(
  !buildSharedPartyContinuityEvidence(
    [{ ...sceneRecords[1], knowledge: { scope: "private" as const, holders: ["A"] } }, sceneRecords[0]],
    ["A", "B"],
  ).includes("Neighboring scene fact."),
);
assert(
  buildSharedPartyContinuityEvidence([{ ...sceneRecords[0], text: "x".repeat(9000) }], ["A", "B"], 600).includes(
    "omitted=",
  ),
);
const selectedSceneRecords = selectSceneContinuityRecords(sceneRecords, ["source-1"]);
assert(formatSceneContinuityEvidenceAid(selectedSceneRecords, 6000).includes("scene-fact"));
assert(!formatSceneContinuityEvidenceAid(selectedSceneRecords, 6000).includes("neighbor-fact"));
const oversized = { ...sceneRecords[0], id: "oversized", text: "x".repeat(7000) };
assert(formatSceneContinuityEvidenceAid([oversized, sceneRecords[0]], 6000).includes("omitted=1"));

console.log("game-continuity-summary regression passed");
