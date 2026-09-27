import assert from "node:assert/strict";
import { runIsolatedGameTurn } from "../../packages/server/src/services/game/game-isolated-turn.js";
import { parsePartyDialogue } from "../../packages/client/src/lib/party-dialogue-parser.js";
import { extractAssistantSpatialDirective } from "../../packages/server/src/services/spatial-context/state-resolution.js";

const prompts: Array<Record<string, unknown>> = [];
let active = 0;
let peak = 0;
const result = await runIsolatedGameTurn({
  gmPrompt: "GM PRIVATE PLOT: vault marker should never reach an actor",
  playerAction: "I ask the party what they saw.",
  playerActorId: "player",
  playerActorName: "Edmund",
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
      actorRequests: [
        { beat: 1, actorId: "bob" },
        { beat: 0, actorId: "alice" },
      ],
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
    assert.equal(
      (prompt as any).actorName === "Alice" ? (prompt as any).authorizedMemory : (prompt as any).authorizedMemory,
      (prompt as any).actorName === "Alice" ? "ALICE PRIVATE MARKER" : "BOB PRIVATE MARKER",
    );
    assert.equal(JSON.stringify(prompt).includes("I ask the party"), false);
    assert.equal((prompt as any).ownCard.includes("card"), true);
    assert.equal(
      (prompt as any).publicScene.some((beat: any) => beat.text.includes("GM PRIVATE")),
      false,
    );
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    if ((prompt as any).expectedActorId === "bob") throw new Error("Bob intentionally omitted");
    return {
      actorId: "alice",
      lines: [
        { type: "whisper", targetActorId: "player", text: "Keep your hand near the latch.", expression: "worried" },
      ],
    };
  },
  maxConcurrency: 1,
});

assert.equal(peak, 1);
assert.match(result.content, /ALICE-ONLY OBSERVATION/);
assert.match(result.content, /\[Alice\] \[whisper:Edmund\] \[worried\]:/);
assert.doesNotMatch(result.content, /\[Bob\]/);
assert.equal(result.actorDiagnostics.filter((item) => item.status === "omitted").length, 1);
assert.equal(prompts.length, 2);
assert.equal(
  prompts.some((prompt) => JSON.stringify(prompt).includes("GM PRIVATE PLOT")),
  false,
);
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
  plan: async () => ({
    publicScene: [{ beat: 0, text: "A bell rings.", perceivedBy: [] }],
    actorRequests: [{ beat: 0, actorId: "alice" }],
  }),
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
await assert.rejects(() =>
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
      plan: async () => ({
        publicScene: [{ beat: 0, text: "[Alice] [main]: secret", perceivedBy: [] }],
        actorRequests: [],
      }),
      actor: async () => ({ actorId: "alice", lines: [] }),
    }),
  /ISOLATED_TURN_INVALID.*inline dialogue/,
);
const narratorOnly = await runIsolatedGameTurn({
  gmPrompt: "The player is alone.",
  actors: [],
  plan: async () => ({
    publicScene: [{ beat: 0, text: "Rain taps against the window.", perceivedBy: [] }],
    actorRequests: [],
  }),
  actor: async () => {
    throw new Error("No actor request should occur");
  },
});
assert.ok(narratorOnly.content.includes("Rain taps against the window."));
assert.deepEqual(narratorOnly.actorDiagnostics, []);

let resolvedContextCalls = 0;
const oversizedTrustedRoster = await runIsolatedGameTurn({
  gmPrompt: "known campaign roster",
  actors: Array.from({ length: 100 }, (_, index) => ({
    actorId: `actor-${index}`,
    name: `Actor ${index}`,
    card: index === 99 ? "x".repeat(20_001) : `card ${index}`,
    initiallyPresent: index === 0,
  })),
  plan: async () => ({
    publicScene: [{ beat: 0, text: "The host waits.", perceivedBy: ["actor-0"] }],
    actorRequests: [{ beat: 0, actorId: "actor-0" }],
  }),
  actor: async (prompt) => ({ actorId: prompt.expectedActorId, lines: [] }),
  resolveActorContext: async (actorId) => {
    resolvedContextCalls++;
    assert.equal(actorId, "actor-0");
    return { card: "resolved actor card", authorizedMemory: "resolved memory" };
  },
});
assert.deepEqual(
  oversizedTrustedRoster.actorDiagnostics.map((item) => item.actorId),
  ["actor-0"],
);
assert.equal(resolvedContextCalls, 1);

let oversizedResolvedActorCalled = false;
const oversizedResolvedActor = await runIsolatedGameTurn({
  gmPrompt: "selected context bound",
  actors: [{ actorId: "selected", name: "Selected", card: "catalog placeholder" }],
  plan: async () => ({
    publicScene: [{ beat: 0, text: "A quiet room.", perceivedBy: [] }],
    actorRequests: [{ beat: 0, actorId: "selected" }],
  }),
  resolveActorContext: async () => ({ card: "x".repeat(20_001) }),
  actor: async (prompt) => {
    oversizedResolvedActorCalled = true;
    return { actorId: prompt.expectedActorId, lines: [] };
  },
});
assert.equal(oversizedResolvedActorCalled, false);
assert.equal(oversizedResolvedActor.actorDiagnostics[0]?.status, "omitted");
assert.match(oversizedResolvedActor.actorDiagnostics[0]?.reason ?? "", /exceeds 20000/);

const unusedDuplicateName = await runIsolatedGameTurn({
  gmPrompt: "one duplicate selected",
  actors: [
    { actorId: "selected", name: "Same Name", card: "selected" },
    { actorId: "unused", name: "Same Name", card: "unused" },
  ],
  plan: async () => ({
    publicScene: [{ beat: 0, text: "A quiet room.", perceivedBy: [] }],
    actorRequests: [{ beat: 0, actorId: "selected" }],
  }),
  actor: async (prompt) => ({ actorId: prompt.expectedActorId, lines: [] }),
});
assert.deepEqual(
  unusedDuplicateName.actorDiagnostics.map((item) => item.actorId),
  ["selected"],
);

await assert.rejects(
  () =>
    runIsolatedGameTurn({
      gmPrompt: "two duplicates selected",
      actors: [
        { actorId: "first", name: "Same Name", card: "first" },
        { actorId: "second", name: "Same Name", card: "second" },
      ],
      plan: async () => ({
        publicScene: [{ beat: 0, text: "A quiet room.", perceivedBy: [] }],
        actorRequests: [
          { beat: 0, actorId: "first" },
          { beat: 0, actorId: "second" },
        ],
      }),
      actor: async (prompt) => ({ actorId: prompt.expectedActorId, lines: [] }),
    }),
  /duplicate selected actor name/,
);

const recurringActorPrompts: any[] = [];
const recurringActor = await runIsolatedGameTurn({
  gmPrompt: "recurring speaker",
  actors: [{ actorId: "recurring", name: "Recurring", card: "card" }],
  plan: async () => ({
    publicScene: [
      { beat: 0, text: "First beat.", perceivedBy: [] },
      { beat: 1, text: "Second beat.", perceivedBy: [] },
      { beat: 2, text: "Third beat.", perceivedBy: [] },
    ],
    actorRequests: [
      { beat: 0, actorId: "recurring" },
      { beat: 1, actorId: "recurring" },
      { beat: 2, actorId: "recurring" },
    ],
  }),
  actor: async (prompt) => {
    recurringActorPrompts.push(prompt);
    const callNumber = recurringActorPrompts.length;
    return {
      actorId: "recurring",
      lines: [
        { type: "main", text: `recurring-${callNumber}` },
        ...(callNumber === 1
          ? [
              { type: "thought", text: "my private thought" },
              { type: "whisper", targetActorId: "someone-else", text: "my private whisper" },
            ]
          : []),
      ],
    };
  },
});
assert.equal(recurringActor.actorDiagnostics.length, 3);
assert.deepEqual(
  recurringActorPrompts[1]?.priorActorLines[0]?.lines.map((line: any) => line.text),
  ["recurring-1", "my private thought", "my private whisper"],
);
assert.match(recurringActor.content, /First beat\.[\s\S]*recurring-1[\s\S]*Second beat\.[\s\S]*recurring-2/u);

let sameBeatRecurringCalls = 0;
const sameBeatRecurring = await runIsolatedGameTurn({
  gmPrompt: "same beat recurring speaker",
  actors: [{ actorId: "same", name: "Same", card: "card" }],
  plan: async () => ({
    publicScene: [{ beat: 0, text: "Same beat.", perceivedBy: [] }],
    actorRequests: [
      { beat: 0, actorId: "same" },
      { beat: 0, actorId: "same" },
    ],
  }),
  actor: async (_prompt, _signal) => {
    const index = sameBeatRecurringCalls++;
    return { actorId: "same", lines: [{ type: "main", text: `same-${index}` }] };
  },
});
assert.match(sameBeatRecurring.content, /same-0[\s\S]*same-1/u);

const capPlan = await runIsolatedGameTurn({
  gmPrompt: "request cap",
  actors: [{ actorId: "cap", name: "Cap", card: "card" }],
  plan: async () => ({
    publicScene: [{ beat: 0, text: "Bounded.", perceivedBy: [] }],
    actorRequests: Array.from({ length: 12 }, () => ({ beat: 0, actorId: "cap" })),
  }),
  actor: async (prompt) => ({ actorId: prompt.expectedActorId, lines: [] }),
});
assert.equal(capPlan.actorDiagnostics.length, 12);

const overCapPlan = () =>
  runIsolatedGameTurn({
    gmPrompt: "request cap exceeded",
    actors: [{ actorId: "cap", name: "Cap", card: "card" }],
    plan: async () => ({
      publicScene: [{ beat: 0, text: "Bounded.", perceivedBy: [] }],
      actorRequests: Array.from({ length: 13 }, () => ({ beat: 0, actorId: "cap" })),
    }),
    actor: async (prompt) => ({ actorId: prompt.expectedActorId, lines: [] }),
  });
await assert.rejects(overCapPlan, /invalid actorRequests count/);

await assert.rejects(
  () =>
    runIsolatedGameTurn({
      gmPrompt: "trusted roster limit",
      actors: Array.from({ length: 257 }, (_, index) => ({
        actorId: `actor-${index}`,
        name: `Actor ${index}`,
        card: `card ${index}`,
      })),
      plan: async () => ({ publicScene: [{ beat: 0, text: "never", perceivedBy: [] }], actorRequests: [] }),
      actor: async () => ({ actorId: "actor-0", lines: [] }),
    }),
  /trusted actor roster is too large/,
);

const isolatedArrivalPrompts = new Map<string, any>();
const isolatedArrival = await runIsolatedGameTurn({
  gmPrompt: "host summons a guest",
  playerActorId: "player",
  actors: [
    { actorId: "host", name: "Host", card: "host card" },
    { actorId: "guest", name: "Guest", card: "guest card", initiallyPresent: false },
  ],
  plan: async () => ({
    publicScene: [
      { beat: 0, text: "HOST PRIVATE REQUEST", perceivedBy: ["host"] },
      { beat: 1, text: "PLAYER SAYS THIS IN CONTEXT", perceivedBy: ["host"], contextOnly: true },
      { beat: 2, text: "The guest arrives at the door.", perceivedBy: ["guest"], arrivingActorIds: ["guest"] },
      { beat: 3, text: "The host greets the guest.", perceivedBy: ["host", "guest"] },
    ],
    actorRequests: [
      { beat: 1, actorId: "host" },
      { beat: 3, actorId: "guest" },
    ],
  }),
  actor: async (prompt) => {
    isolatedArrivalPrompts.set(prompt.expectedActorId, prompt);
    return { actorId: prompt.expectedActorId, lines: [] };
  },
});
assert.doesNotMatch(isolatedArrival.content, /PLAYER SAYS THIS IN CONTEXT/u);
assert.match(isolatedArrival.content, /The guest arrives at the door/u);
assert.ok(isolatedArrivalPrompts.get("host").publicScene.some((beat: any) => beat.contextOnly));
assert.ok(isolatedArrivalPrompts.get("guest").publicScene.some((beat: any) => beat.text.includes("The guest arrives")));
assert.equal(
  isolatedArrivalPrompts.get("guest").publicScene.some((beat: any) => beat.text.includes("HOST PRIVATE REQUEST")),
  false,
);
assert.equal(
  isolatedArrivalPrompts.get("guest").publicScene.some((beat: any) => beat.text.includes("PLAYER SAYS THIS")),
  false,
);

await assert.rejects(
  () =>
    runIsolatedGameTurn({
      gmPrompt: "offscreen audience",
      actors: [{ actorId: "guest", name: "Guest", card: "card", initiallyPresent: false }],
      plan: async () => ({
        publicScene: [{ beat: 0, text: "unseen", perceivedBy: ["guest"] }],
        actorRequests: [{ beat: 0, actorId: "guest" }],
      }),
      actor: async () => ({ actorId: "guest", lines: [] }),
    }),
  /nonpresent audience actor/,
);

const spatialDirective = await runIsolatedGameTurn({
  gmPrompt: "explicit player arrival",
  actors: [{ actorId: "alice", name: "Alice", card: "card" }],
  plan: async () => ({
    publicScene: [{ beat: 0, text: "The player reaches the square.", perceivedBy: ["alice"] }],
    actorRequests: [{ beat: 0, actorId: "alice" }],
    spatialDirective: { type: "move", destinationId: "mudway-square" },
  }),
  actor: async () => ({ actorId: "alice", lines: [{ type: "main", text: "Welcome to the square." }] }),
});
assert.deepEqual(spatialDirective.plan.spatialDirective, { type: "move", destinationId: "mudway-square" });
assert.match(spatialDirective.content, /Welcome to the square\./u);
assert.match(spatialDirective.content, /^\[spatial_move: destination_id=mudway-square\]$/mu);
assert.doesNotMatch(spatialDirective.content, /\[Alice\] \[main\].*spatial_move/u);
assert.deepEqual(extractAssistantSpatialDirective(spatialDirective.content).directive, {
  type: "move",
  destinationId: "mudway-square",
});
assert.doesNotMatch(extractAssistantSpatialDirective(spatialDirective.content).cleanContent, /spatial_move/u);

await assert.rejects(
  () =>
    runIsolatedGameTurn({
      gmPrompt: "untrusted destination",
      actors: [{ actorId: "alice", name: "Alice", card: "card" }],
      plan: async () => ({
        publicScene: [{ beat: 0, text: "A public scene.", perceivedBy: [] }],
        actorRequests: [],
        spatialDirective: { type: "move", destinationId: "[known-place]" },
      }),
      actor: async () => ({ actorId: "alice", lines: [] }),
    }),
  /invalid location ID/,
);

const legacyPlan = await runIsolatedGameTurn({
  gmPrompt: "legacy plan",
  actors: [],
  plan: async () => ({
    publicScene: [{ beat: 0, text: "No movement metadata.", perceivedBy: [] }],
    actorRequests: [],
  }),
  actor: async () => ({ actorId: "unused", lines: [] }),
});
assert.equal(legacyPlan.plan.spatialDirective, undefined);
assert.doesNotMatch(legacyPlan.content, /spatial_move/u);
await assert.rejects(
  () =>
    runIsolatedGameTurn({
      gmPrompt: "offscreen request",
      actors: [{ actorId: "guest", name: "Guest", card: "card", initiallyPresent: false }],
      plan: async () => ({
        publicScene: [
          { beat: 0, text: "narration", perceivedBy: [] },
          { beat: 1, text: "arrival", perceivedBy: ["guest"], arrivingActorIds: ["guest"] },
        ],
        actorRequests: [{ beat: 0, actorId: "guest" }],
      }),
      actor: async () => ({ actorId: "guest", lines: [] }),
    }),
  /before arrival/,
);
await assert.rejects(
  () =>
    runIsolatedGameTurn({
      gmPrompt: "invalid arrival",
      actors: [{ actorId: "guest", name: "Guest", card: "card", initiallyPresent: false }],
      plan: async () => ({
        publicScene: [
          { beat: 0, text: "hidden arrival", perceivedBy: ["guest"], contextOnly: true, arrivingActorIds: ["guest"] },
        ],
        actorRequests: [],
      }),
      actor: async () => ({ actorId: "guest", lines: [] }),
    }),
  /arrival cannot be context-only/,
);
await assert.rejects(
  () =>
    runIsolatedGameTurn({
      gmPrompt: "unknown arrival",
      actors: [{ actorId: "host", name: "Host", card: "card" }],
      plan: async () => ({
        publicScene: [{ beat: 0, text: "arrival", perceivedBy: [], arrivingActorIds: ["missing"] }],
        actorRequests: [],
      }),
      actor: async () => ({ actorId: "host", lines: [] }),
    }),
  /unknown arrival actor/,
);

// Candidate eligibility must not allow addressing an absent person privately.
for (const arrivesAt of [undefined, 1]) {
  const whispers = await runIsolatedGameTurn({
    gmPrompt: "host speaks before any guest arrival",
    actors: [
      { actorId: "host", name: "Host", card: "host" },
      { actorId: "guest", name: "Guest", card: "guest", initiallyPresent: false },
    ],
    plan: async () => ({
      publicScene: [
        { beat: 0, text: "The host lowers her voice.", perceivedBy: ["host"] },
        ...(arrivesAt === undefined
          ? []
          : [
              { beat: arrivesAt, text: "The guest enters later.", perceivedBy: ["guest"], arrivingActorIds: ["guest"] },
            ]),
      ],
      actorRequests: [{ beat: 0, actorId: "host" }],
    }),
    actor: async () => ({
      actorId: "host",
      lines: [{ type: "whisper", targetActorId: "guest", text: "A quiet remark." }],
    }),
  });
  assert.doesNotMatch(whispers.content, /whisper:Guest/u);
}
await assert.rejects(
  () =>
    runIsolatedGameTurn({
      gmPrompt: "context without an observable response",
      actors: [],
      plan: async () => ({
        publicScene: [{ beat: 0, contextOnly: true, text: "Previous conversation.", perceivedBy: [] }],
        actorRequests: [],
      }),
      actor: async () => {
        throw new Error("must not call actors");
      },
    }),
  /player-visible scene beat/u,
);

const dependentPrompts = new Map<string, any>();
let zetaFinishedAt = 0;
let alphaStartedAt = 0;
const dependent = await runIsolatedGameTurn({
  gmPrompt: "same beat dependency",
  actors: [
    { actorId: "zeta", name: "Zeta", card: "zeta" },
    { actorId: "alpha", name: "Alpha", card: "alpha" },
  ],
  plan: async () => ({
    publicScene: [{ beat: 0, text: "The room is quiet.", perceivedBy: ["zeta", "alpha"] }],
    // The planner order is deliberate: stable beat sorting must preserve zeta before alpha.
    actorRequests: [
      { beat: 0, actorId: "zeta", perceivedBy: ["zeta", "alpha", "alpha"] },
      { beat: 0, actorId: "alpha", perceivedBy: ["zeta", "alpha"] },
    ],
  }),
  actor: async (prompt) => {
    dependentPrompts.set(prompt.expectedActorId, prompt);
    if (prompt.expectedActorId === "zeta") {
      await new Promise((resolve) => setTimeout(resolve, 15));
      zetaFinishedAt = Date.now();
      return {
        actorId: "zeta",
        lines: [
          { type: "main", text: "The latch is warm." },
          { type: "thought", text: "I must not reveal this." },
          { type: "whisper", targetActorId: "zeta", text: "Only I hear this." },
          { type: "whisper", targetActorId: "alpha", text: "Watch the door." },
        ],
      };
    }
    alphaStartedAt = Date.now();
    return { actorId: "alpha", lines: [{ type: "main", text: "I heard the latch." }] };
  },
  maxConcurrency: 2,
});
assert.deepEqual(dependent.plan.actorRequests.map((request) => request.actorId), ["zeta", "alpha"]);
assert.deepEqual(dependent.plan.actorRequests[0]?.perceivedBy, ["zeta", "alpha"]);
assert.deepEqual(
  dependentPrompts.get("alpha")?.priorActorLines.map((entry: any) => entry.lines.map((line: any) => line.text)),
  [["The latch is warm.", "Watch the door."]],
);
assert.ok(alphaStartedAt >= zetaFinishedAt);

let omittedPredecessorCalls = 0;
const omittedPredecessor = await runIsolatedGameTurn({
  gmPrompt: "omitted predecessor",
  actors: [
    { actorId: "first", name: "First", card: "first" },
    { actorId: "second", name: "Second", card: "second" },
  ],
  plan: async () => ({
    publicScene: [{ beat: 0, text: "A shared room.", perceivedBy: ["first", "second"] }],
    actorRequests: [
      { beat: 0, actorId: "first", perceivedBy: ["second"] },
      { beat: 0, actorId: "second", perceivedBy: ["second"] },
    ],
  }),
  actor: async (prompt) => {
    omittedPredecessorCalls++;
    if (prompt.expectedActorId === "first") throw new Error("omitted predecessor");
    assert.deepEqual(prompt.priorActorLines, []);
    return { actorId: "second", lines: [] };
  },
});
assert.equal(omittedPredecessorCalls, 2);
assert.equal(omittedPredecessor.actorDiagnostics.find((item) => item.actorId === "first")?.status, "omitted");

let independentActive = 0;
let independentPeak = 0;
await runIsolatedGameTurn({
  gmPrompt: "independent actors",
  actors: [
    { actorId: "one", name: "One", card: "one" },
    { actorId: "two", name: "Two", card: "two" },
  ],
  plan: async () => ({
    publicScene: [{ beat: 0, text: "Two corners of the room.", perceivedBy: ["one", "two"] }],
    actorRequests: [
      { beat: 0, actorId: "one", perceivedBy: ["one"] },
      { beat: 0, actorId: "two", perceivedBy: ["two"] },
    ],
  }),
  actor: async (prompt) => {
    independentActive++;
    independentPeak = Math.max(independentPeak, independentActive);
    assert.deepEqual(prompt.priorActorLines, []);
    await new Promise((resolve) => setTimeout(resolve, 10));
    independentActive--;
    return { actorId: prompt.expectedActorId, lines: [{ type: "main", text: `${prompt.expectedActorId} speaks.` }] };
  },
  maxConcurrency: 2,
});
assert.equal(independentPeak, 2);

const fallbackHandoff = await runIsolatedGameTurn({
  gmPrompt: "omitted audience fallback",
  actors: [
    { actorId: "speaker", name: "Speaker", card: "speaker" },
    { actorId: "listener", name: "Listener", card: "listener" },
  ],
  plan: async () => ({
    publicScene: [{ beat: 0, text: "A shared observation.", perceivedBy: ["speaker", "listener"] }],
    actorRequests: [
      { beat: 0, actorId: "speaker" },
      { beat: 0, actorId: "listener", perceivedBy: ["listener"] },
    ],
  }),
  actor: async (prompt) => {
    if (prompt.expectedActorId === "speaker")
      return { actorId: "speaker", lines: [{ type: "main", text: "The hinge clicks." }] };
    assert.deepEqual(prompt.priorActorLines.map((entry) => entry.actorId), ["speaker"]);
    return { actorId: "listener", lines: [] };
  },
});
assert.match(fallbackHandoff.content, /The hinge clicks/u);

const lateArrivalPrompts = new Map<string, any>();
await runIsolatedGameTurn({
  gmPrompt: "late listener",
  actors: [
    { actorId: "host", name: "Host", card: "host" },
    { actorId: "guest", name: "Guest", card: "guest", initiallyPresent: false },
  ],
  plan: async () => ({
    publicScene: [
      { beat: 0, text: "HOST EARLIER LINE", perceivedBy: ["host"] },
      { beat: 1, text: "The guest arrives.", perceivedBy: ["guest"], arrivingActorIds: ["guest"] },
    ],
    actorRequests: [
      { beat: 0, actorId: "host", perceivedBy: ["host"] },
      { beat: 1, actorId: "guest", perceivedBy: ["guest"] },
    ],
  }),
  actor: async (prompt) => {
    lateArrivalPrompts.set(prompt.expectedActorId, prompt);
    return { actorId: prompt.expectedActorId, lines: [] };
  },
});
assert.equal(
  lateArrivalPrompts.get("guest").publicScene.some((beat: any) => beat.text.includes("HOST EARLIER LINE")),
  false,
);

const cancellation = new AbortController();
let cancelledFirstFinished = false;
let cancelledSecondCalled = false;
const cancelledRun = runIsolatedGameTurn({
  gmPrompt: "cancel dependent actors",
  actors: [
    { actorId: "first-cancel", name: "First Cancel", card: "first" },
    { actorId: "second-cancel", name: "Second Cancel", card: "second" },
  ],
  plan: async () => ({
    publicScene: [{ beat: 0, text: "Cancellation room.", perceivedBy: ["first-cancel", "second-cancel"] }],
    actorRequests: [
      { beat: 0, actorId: "first-cancel", perceivedBy: ["second-cancel"] },
      { beat: 0, actorId: "second-cancel", perceivedBy: ["second-cancel"] },
    ],
  }),
  signal: cancellation.signal,
  actor: async (prompt, signal) => {
    if (prompt.expectedActorId === "second-cancel") {
      cancelledSecondCalled = true;
      return { actorId: prompt.expectedActorId, lines: [] };
    }
    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      signal.throwIfAborted();
      return { actorId: prompt.expectedActorId, lines: [] };
    } finally {
      cancelledFirstFinished = true;
    }
  },
  maxConcurrency: 2,
});
setTimeout(() => cancellation.abort(new Error("dependent cancellation")), 2);
await assert.rejects(cancelledRun);
assert.equal(cancelledFirstFinished, true);
assert.equal(cancelledSecondCalled, false);

await assert.rejects(
  () =>
    runIsolatedGameTurn({
      gmPrompt: "unknown request audience",
      actors: [{ actorId: "alice", name: "Alice", card: "card" }],
      plan: async () => ({
        publicScene: [{ beat: 0, text: "visible", perceivedBy: ["alice"] }],
        actorRequests: [{ beat: 0, actorId: "alice", perceivedBy: ["missing"] }],
      }),
      actor: async () => ({ actorId: "alice", lines: [] }),
    }),
  /unknown audience actor/,
);

await assert.rejects(
  () =>
    runIsolatedGameTurn({
      gmPrompt: "late request audience",
      actors: [
        { actorId: "host", name: "Host", card: "host" },
        { actorId: "guest", name: "Guest", card: "guest", initiallyPresent: false },
      ],
      plan: async () => ({
        publicScene: [
          { beat: 0, text: "before arrival", perceivedBy: ["host"] },
          { beat: 1, text: "arrival", perceivedBy: ["guest"], arrivingActorIds: ["guest"] },
        ],
        actorRequests: [{ beat: 0, actorId: "host", perceivedBy: ["guest"] }],
      }),
      actor: async () => ({ actorId: "host", lines: [] }),
    }),
  /nonpresent audience actor/,
);
