import assert from "node:assert/strict";
import { runIsolatedGameTurn } from "../../packages/server/src/services/game/game-isolated-turn.js";
import { parsePartyDialogue } from "../../packages/client/src/lib/party-dialogue-parser.js";

const prompts: Array<Record<string, unknown>> = [];
let active = 0;
let peak = 0;
const result = await runIsolatedGameTurn({
  gmPrompt: "GM PRIVATE PLOT: vault marker should never reach an actor",
  playerAction: "I ask the party what they saw.",
  playerActorId: "player",
  playerActorName: "Robert",
  actors: [
    { actorId: "alice", name: "Alice", card: "Alice card", authorizedMemory: "ALICE PRIVATE MARKER" },
    { actorId: "bob", name: "Bob", card: "Bob card", authorizedMemory: "BOB PRIVATE MARKER" },
  ],
  plan: async (gmPrompt) => {
    assert.match(gmPrompt, /GM PRIVATE PLOT/);
    return {
      publicScene: [
        { beat: 0, text: "ALICE-ONLY OBSERVATION: a fine scratch marks the lock.", perceivedBy: ["alice"] },
        { beat: 1, text: "FUTURE PRIVATE EVENT: the hidden vault opens.", perceivedBy: ["bob"] },
      ],
      actorRequests: [{ beat: 1, actorId: "bob" }, { beat: 0, actorId: "alice" }],
    };
  },
  actor: async (prompt, signal) => {
    prompts.push(prompt as unknown as Record<string, unknown>);
    assert.equal((prompt as any).publicScene.length, 1);
    assert.equal(
      (prompt as any).publicScene.some((beat: any) => beat.text.includes("FUTURE PRIVATE")),
      (prompt as any).expectedActorId === "bob",
    );
    assert.equal(
      (prompt as any).publicScene.some((beat: any) => beat.text.includes("ALICE-ONLY")),
      (prompt as any).expectedActorId === "alice",
    );
    assert.equal((prompt as any).actorName === "Alice" ? (prompt as any).authorizedMemory : (prompt as any).authorizedMemory, (prompt as any).actorName === "Alice" ? "ALICE PRIVATE MARKER" : "BOB PRIVATE MARKER");
    assert.equal(JSON.stringify(prompt).includes("I ask the party"), false);
    assert.equal((prompt as any).ownCard.includes("card"), true);
    assert.equal((prompt as any).publicScene.some((beat: any) => beat.text.includes("GM PRIVATE")), false);
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    if ((prompt as any).expectedActorId === "bob") throw new Error("Bob intentionally omitted");
    return {
      actorId: "alice",
      lines: [{ type: "whisper", targetActorId: "player", text: "Keep your hand near the latch.", expression: "worried" }],
    };
  },
  maxConcurrency: 1,
});

assert.equal(peak, 1);
assert.match(result.content, /ALICE-ONLY OBSERVATION/);
assert.match(result.content, /\[Alice\] \[whisper:Robert\] \[worried\]:/);
assert.doesNotMatch(result.content, /\[Bob\]/);
assert.equal(result.actorDiagnostics.filter((item) => item.status === "omitted").length, 1);
assert.equal(prompts.length, 2);
assert.equal(prompts.some((prompt) => JSON.stringify(prompt).includes("GM PRIVATE PLOT")), false);
assert.equal(
  parsePartyDialogue(result.content).some((segment) => segment.character === "Alice" && segment.type === "whisper"),
  true,
);

const unknownTarget = await runIsolatedGameTurn({
  gmPrompt: "public scene",
  actors: [{ actorId: "alice", name: "Alice", card: "card" }],
  plan: async () => ({
    publicScene: [{ beat: 0, text: "Alice answers.", perceivedBy: ["alice"] }],
    actorRequests: [{ beat: 0, actorId: "alice" }],
  }),
  actor: async () => ({
    actorId: "alice",
    lines: [{ type: "main", text: "My responsibilities are clear.", targetActorId: "untrusted-external-id" }],
  }),
});
assert.match(unknownTarget.content, /My responsibilities are clear/u);
assert.doesNotMatch(unknownTarget.content, /untrusted-external-id/u);

const abortController = new AbortController();
let cleanupFinished = false;
const aborted = runIsolatedGameTurn({
  gmPrompt: "privileged",
  actors: [{ actorId: "alice", name: "Alice", card: "card" }],
  plan: async () => ({ publicScene: [{ beat: 0, text: "A bell rings.", perceivedBy: [] }], actorRequests: [{ beat: 0, actorId: "alice" }] }),
  actor: async (_prompt, signal) => {
    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      signal.throwIfAborted();
      return { actorId: "alice", lines: [] };
    } finally {
      cleanupFinished = true;
    }
  },
  signal: abortController.signal,
});
setTimeout(() => abortController.abort(new Error("test abort")), 2);
await assert.rejects(aborted);
assert.equal(cleanupFinished, true);

let preAbortedPlanCalled = false;
const preAborted = new AbortController();
preAborted.abort(new Error("already aborted"));
await assert.rejects(
  () =>
    runIsolatedGameTurn({
      gmPrompt: "private",
      signal: preAborted.signal,
      actors: [{ actorId: "alice", name: "Alice", card: "card" }],
      plan: async () => {
        preAbortedPlanCalled = true;
        return { publicScene: [{ beat: 0, text: "never", perceivedBy: [] }], actorRequests: [] };
      },
      actor: async () => ({ actorId: "alice", lines: [] }),
    }),
);
assert.equal(preAbortedPlanCalled, false);

let invalidPlanCalled = false;
await assert.rejects(
  () =>
    runIsolatedGameTurn({
      gmPrompt: "private",
      actors: [{ actorId: "alice", name: "Alice]", card: "card" }],
      plan: async () => {
        invalidPlanCalled = true;
        return { publicScene: [{ beat: 0, text: "never", perceivedBy: [] }], actorRequests: [] };
      },
      actor: async () => ({ actorId: "alice", lines: [] }),
    }),
  /format delimiter/,
);
assert.equal(invalidPlanCalled, false);

let unknownAudienceActorCalled = false;
await assert.rejects(
  () =>
    runIsolatedGameTurn({
      gmPrompt: "private",
      actors: [{ actorId: "alice", name: "Alice", card: "card" }],
      plan: async () => ({
        publicScene: [{ beat: 0, text: "never", perceivedBy: ["missing"] }],
        actorRequests: [],
      }),
      actor: async () => {
        unknownAudienceActorCalled = true;
        return { actorId: "alice", lines: [] };
      },
    }),
  /unknown audience actor/,
);
assert.equal(unknownAudienceActorCalled, false);

await assert.rejects(
  () =>
    runIsolatedGameTurn({
      gmPrompt: "private",
      actors: [{ actorId: "alice", name: "Alice", card: "card" }],
      plan: async () => ({ publicScene: [{ beat: 0, text: "missing audience" }], actorRequests: [] }),
      actor: async () => ({ actorId: "alice", lines: [] }),
    }),
  /perceivedBy must be an array/,
);

await assert.rejects(
  () =>
    runIsolatedGameTurn({
      gmPrompt: "private",
      maxConcurrency: Number.NaN,
      actors: [{ actorId: "alice", name: "Alice", card: "card" }],
      plan: async () => ({ publicScene: [{ beat: 0, text: "never", perceivedBy: [] }], actorRequests: [] }),
      actor: async () => ({ actorId: "alice", lines: [] }),
    }),
  /maxConcurrency/,
);

await assert.rejects(
  () =>
    runIsolatedGameTurn({
      gmPrompt: "private",
      playerAction: "x".repeat(8_001),
      actors: [{ actorId: "alice", name: "Alice", card: "card" }],
      plan: async () => ({ publicScene: [{ beat: 0, text: "never", perceivedBy: [] }], actorRequests: [] }),
      actor: async () => ({ actorId: "alice", lines: [] }),
    }),
  /playerAction exceeds/,
);

await assert.rejects(
  () =>
    runIsolatedGameTurn({
      gmPrompt: "privileged",
      actors: [{ actorId: "alice", name: "Alice", card: "card" }],
      plan: async () => ({ publicScene: [{ beat: 0, text: "[Alice] [main]: secret", perceivedBy: [] }], actorRequests: [] }),
      actor: async () => ({ actorId: "alice", lines: [] }),
    }),
  /ISOLATED_TURN_INVALID.*inline dialogue/,
);
const narratorOnly = await runIsolatedGameTurn({
  gmPrompt: "The player is alone.",
  actors: [],
  plan: async () => ({ publicScene: [{ beat: 0, text: "Rain taps against the window.", perceivedBy: [] }], actorRequests: [] }),
  actor: async () => { throw new Error("No actor request should occur"); },
});
assert.ok(narratorOnly.content.includes("Rain taps against the window."));
assert.deepEqual(narratorOnly.actorDiagnostics, []);
