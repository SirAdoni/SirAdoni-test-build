import assert from "node:assert/strict";
import {
  planContinuityTurnBatches,
  prepareContinuitySources,
  validateContinuityManifest,
} from "../../packages/server/src/services/game/continuity-sources.js";

const messages = [
  {
    id: "old-assistant",
    role: "assistant",
    content: "Prior scene." + "x".repeat(100_000),
    activeSwipeIndex: 0,
    extra: null,
  },
  { id: "hidden", role: "assistant", content: "Do not include.", extra: { hiddenFromAI: true } },
  {
    id: "derived",
    role: "assistant",
    content: "Generated recap.",
    extra: { continuitySource: "derived_session_recap" },
  },
  { id: "system", role: "system", content: "System bookkeeping.", extra: null },
  { id: "edited", role: "assistant", content: "Old answer.\n\nKeep this answer.", activeSwipeIndex: 2, extra: null },
  {
    id: "prior-ooc-user",
    role: "user",
    content: "[To the GM] Earlier correction: the gate is open. " + "x".repeat(100_000),
    extra: null,
  },
  { id: "assistant-ooc", role: "assistant", content: "Understood; the correction is accepted.", extra: null },
  { id: "user-one", role: "user", content: "First user decision.", extra: null },
  { id: "user-ooc", role: "user", content: "[To the GM] Current correction: the gate is open.", extra: null },
  { id: "user-two", role: "user", content: "Second user decision " + "😀".repeat(220), extra: null },
  { id: "accepted", role: "assistant", content: "The accepted narration.", extra: null },
  { id: "conclusion", role: "assistant", content: "**Session 4 Concluded**\nA generated conclusion.", extra: null },
];

const prepared = prepareContinuitySources(messages, {
  "segmentEdit:edited:0": "Edited answer.",
});
assert.equal(
  prepared.some((source) => source.messageId === "hidden"),
  false,
);
assert.equal(
  prepared.some((source) => source.messageId === "derived"),
  false,
);
assert.equal(
  prepared.some((source) => source.messageId === "system"),
  false,
);
assert.equal(
  prepared.some((source) => source.messageId === "conclusion"),
  false,
);
assert.equal(prepared.find((source) => source.messageId === "edited")?.content, "Edited answer.\n\nKeep this answer.");
assert.equal(prepared.find((source) => source.messageId === "user-ooc")?.role, "user OOC correction");
assert.equal(prepared.find((source) => source.messageId === "assistant-ooc")?.role, "assistant OOC acknowledgement");
assert.equal(prepared.find((source) => source.messageId === "edited")?.swipeIndex, 2);

// Accepted messages that are deliberately excluded from continuity remain
// absent from the prepared source list. The enqueue boundary must treat these
// as a no-op, while direct planner calls still reject a genuinely unknown ID.
const excludedAccepted = prepareContinuitySources(
  [
    { id: "excluded-accepted", role: "assistant", content: "Derived recap.", extra: { hiddenFromAI: true } },
    { id: "follow-up", role: "user", content: "Continue.", extra: null },
  ],
  {},
);
assert.equal(excludedAccepted.some((source) => source.messageId === "excluded-accepted"), false);
assert.throws(
  () => planContinuityTurnBatches(excludedAccepted, "excluded-accepted"),
  /CONTINUITY_ASSISTANT_NOT_FOUND/,
);
assert.throws(
  () => planContinuityTurnBatches(prepared, "missing-assistant"),
  /CONTINUITY_ASSISTANT_NOT_FOUND/,
);

const batches = planContinuityTurnBatches(prepared, "accepted", 256);
assert.ok(batches.length > 1, "long Unicode input must split into multiple batches");
const primary = batches.flatMap((batch) => batch.sources);
assert.deepEqual(
  [...new Set(primary.map((source) => source.messageId))],
  ["user-one", "user-ooc", "user-two", "accepted"],
  "all user/OOC messages since the preceding assistant acknowledgement must remain primary",
);
for (const source of prepared.filter((candidate) => primary.some((item) => item.messageId === candidate.messageId))) {
  const refs = primary
    .filter((item) => item.messageId === source.messageId)
    .sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  assert.equal(refs[0]?.start, 0);
  assert.equal(refs.at(-1)?.end, Array.from(source.content).length);
  assert.equal(refs.map((item) => item.content).join(""), source.content);
}
assert.ok(
  batches.every(
    (batch) =>
      batch.context.reduce((total, item) => total + Array.from(item.content).length, 0) <= 2000 &&
      batch.context.every((item) => item.content.length > 0),
  ),
  "context must stay within the 2,000-code-point budget and omit empty slices",
);
assert.ok(
  batches.some((batch) => batch.context.some((item) => item.messageId === "assistant-ooc")),
  "the prior accepted OOC acknowledgement is context, not primary evidence for the next turn",
);
assert.ok(
  batches
    .slice(1)
    .some((batch) =>
      batch.context.some((item) => item.messageId === "user-two" && (item.end ?? 0) - (item.start ?? 0) <= 2000),
    ),
  "split primary messages receive bounded neighboring overlap context",
);
assert.ok(batches.every((batch) => batch.sources.every((source) => (source.end ?? 0) >= (source.start ?? 0))));

assert.equal(validateContinuityManifest(prepared, batches[0]!.sources, batches[0]!.context), true);
const staleOutsideSlice = prepared.map((source) =>
  source.messageId === "user-one"
    ? { ...source, content: source.content + " changed outside the selected slice" }
    : source,
);
assert.equal(validateContinuityManifest(staleOutsideSlice, batches[0]!.sources, batches[0]!.context), false);
const staleSwipe = prepared.map((source) => (source.messageId === "accepted" ? { ...source, swipeIndex: 99 } : source));
assert.equal(validateContinuityManifest(staleSwipe, batches.at(-1)!.sources, batches.at(-1)!.context), false);

console.log("continuity source preparation and batching regression passed");
