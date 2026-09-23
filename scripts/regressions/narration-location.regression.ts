import assert from "node:assert/strict";
import type {
  GameMap,
  ResolvedOwnerSpatialProjection,
  SpatialContextDefinition,
} from "../../packages/shared/src/index.js";
import {
  buildNarratedLocationHistory,
  parseNarratedLocationDecision,
  reconcileNarratedLocation,
  withCompleteLocationCatalog,
} from "../../packages/server/src/services/spatial-context/narration-reconciliation.js";
import {
  identifyGeneratedGameMap,
  withActiveGameMapMeta,
} from "../../packages/server/src/services/game/map-position.service.js";

const projection = {
  currentLocationId: "bedroom",
  breadcrumb: [
    { id: "estate", name: "Estate" },
    { id: "bedroom", name: "Bedroom" },
  ],
  knownLocations: [
    { id: "estate", path: "Estate" },
    { id: "bedroom", path: "Estate > Bedroom" },
    { id: "dining", path: "Estate > Dining Room" },
  ],
} as ResolvedOwnerSpatialProjection;
const narration = "After coffee, you reach the training yard behind the gatehouse. Brynna is beside the shield rack.";
const description =
  "The training yard lies behind the gatehouse. An open chalked circle is marked between four copper ward-posts. A practice-weapon rack stands beside the spectators' rail.";
const discovery = { action: "discover", name: "Training Yard", parentId: "estate", description, evidence: narration };
const parse = (decision: unknown, context = projection) =>
  parseNarratedLocationDecision(
    JSON.stringify(decision),
    context,
    "I head to the training yard after coffee.",
    narration,
  );
assert.deepEqual(parse(discovery), {
  type: "discover",
  name: "Training Yard",
  parentId: "estate",
  relation: "place",
  description,
});
assert.equal(parse({ action: "stay" }), null);
assert.throws(() => parse({ ...discovery, parentId: "invented" }), /unknown parent/);
assert.throws(() => parse({ ...discovery, evidence: "You teleport to the tower." }), /evidence absent/);
assert.throws(() => parse({ action: "move", destinationId: "invented", evidence: narration }), /unknown ID/);
assert.deepEqual(parse({ ...discovery, name: "The Dining Room" }), { type: "move", destinationId: "dining" });
assert.equal(parse({ action: "move", destinationId: "bedroom", evidence: narration }), null);
const ambiguous = {
  ...projection,
  knownLocations: [...projection.knownLocations!, { id: "other-dining", path: "Other > Dining Room" }],
};
assert.deepEqual(parse({ ...discovery, name: "Dining Room" }, ambiguous), { type: "move", destinationId: "dining" });
assert.deepEqual(parse({ ...discovery, name: "Dining Room", parentId: "bedroom" }, ambiguous), {
  type: "discover",
  name: "Dining Room",
  parentId: "bedroom",
  relation: "place",
  description,
});
const otherBuilding = {
  ...projection,
  knownLocations: [
    ...projection.knownLocations!,
    { id: "old", path: "Old" },
    { id: "old-kitchen", path: "Old > Kitchen" },
    { id: "inn", path: "Inn" },
  ],
};
assert.deepEqual(parse({ ...discovery, name: "Kitchen", parentId: "inn" }, otherBuilding), {
  type: "discover",
  name: "Kitchen",
  parentId: "inn",
  relation: "place",
  description,
});
assert.deepEqual(parse({ ...discovery, name: "Kitchen", parentId: "old" }, otherBuilding), {
  type: "move",
  destinationId: "old-kitchen",
});
const twoInside = {
  ...otherBuilding,
  knownLocations: [
    ...otherBuilding.knownLocations,
    { id: "old-wing", path: "Old > Wing" },
    { id: "old-wing-kitchen", path: "Old > Wing > Kitchen" },
    { id: "old-east", path: "Old > East" },
    { id: "old-east-kitchen", path: "Old > East > Kitchen" },
  ].filter(({ id }) => id !== "old-kitchen"),
};
assert.throws(() => parse({ ...discovery, name: "Kitchen", parentId: "old" }, twoInside), /ambiguous/);

const definition = {
  locations: Array.from({ length: 65 }, (_, i) => ({
    id: `room${i}`,
    name: `Room ${i}`,
    parentId: null,
    status: "active",
  })),
} as SpatialContextDefinition;
assert.equal(
  withCompleteLocationCatalog(projection, definition).knownLocations?.length,
  65,
  "Reconciliation must not inherit the storyteller's 50-location cutoff",
);

let calls = 0;
let logged = "";
const result = await reconcileNarratedLocation({
  provider: {
    chatComplete: async (_messages, options) => {
      assert.ok(options.signal);
      calls++;
      return { content: calls === 1 ? "broken JSON" : JSON.stringify(discovery), toolCalls: [], finishReason: "stop" };
    },
  },
  model: "fixture",
  projection,
  userText: "I head to the yard.",
  narration,
  signal: new AbortController().signal,
  debugMode: true,
  debugLog: (message) => {
    logged += message;
  },
});
assert.equal(calls, 2, "Malformed extraction is retried once");
assert.equal(result?.type, "discover");
assert.match(logged, /Prompt/);

let repairCalls = 0;
let repairMessages: readonly { role: string; content: string }[] = [];
const repairedTeleport = await reconcileNarratedLocation({
  provider: {
    chatComplete: async (messages) => {
      repairCalls++;
      if (repairCalls === 2) repairMessages = messages;
      return {
        content:
          repairCalls === 1
            ? JSON.stringify({
                action: "teleport",
                destinationId: "dining",
                evidence: "You arrive somewhere.",
                authorizationEvidence: "I teleport to the estate.",
              })
            : JSON.stringify({
                action: "teleport",
                destinationId: "dining",
                evidence: "The aperture opens into the dining room.",
                authorizationEvidence: "I then teleport to the estate, to enjoy dinner with the ladies and the guests.",
              }),
        toolCalls: [],
        finishReason: "stop",
      };
    },
  },
  model: "fixture",
  projection,
  userText: "I then teleport to the estate, to enjoy dinner with the ladies and the guests.",
  narration: "The aperture opens into the dining room.",
  allowTeleport: true,
  signal: new AbortController().signal,
  debugMode: false,
  debugLog() {},
});
assert.equal(repairCalls, 2, "A validation failure is retried once");
assert.equal(repairedTeleport?.type, "teleport", "A corrected source-bound teleport is accepted");
assert.match(repairMessages.at(-1)?.content ?? "", /Teleport arrival evidence absent from current narration/);
assert.match(repairMessages.at(-1)?.content ?? "", /Previous assistant result \(invalid data\)/);

let invalidTeleportCalls = 0;
await assert.rejects(
  () =>
    reconcileNarratedLocation({
      provider: {
        chatComplete: async () => {
          invalidTeleportCalls++;
          return {
            content: JSON.stringify({
              action: "teleport",
              destinationId: "dining",
              evidence: "Still in the bedroom.",
              authorizationEvidence: "I then teleport to the estate, to enjoy dinner with the ladies and the guests.",
            }),
            toolCalls: [],
            finishReason: "stop",
          };
        },
      },
      model: "fixture",
      projection,
      userText: "I then teleport to the estate, to enjoy dinner with the ladies and the guests.",
      narration: "The aperture opens into the dining room.",
      allowTeleport: true,
      signal: new AbortController().signal,
      debugMode: false,
      debugLog() {},
    }),
  /Teleport arrival evidence absent from current narration/,
);
assert.equal(invalidTeleportCalls, 2, "An invalid repaired teleport is rejected after the bounded retry");

let timeoutCalls = 0;
let firstTimeoutSignal: AbortSignal | undefined;
const timeoutRetry = await reconcileNarratedLocation({
  provider: {
    chatComplete: async (_messages, options) => {
      timeoutCalls++;
      if (timeoutCalls === 1) {
        firstTimeoutSignal = options.signal;
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
      assert.notEqual(options.signal, firstTimeoutSignal, "Timeout retry must use a fresh deadline signal");
      return { content: JSON.stringify(discovery), toolCalls: [], finishReason: "stop" };
    },
  },
  model: "fixture",
  projection,
  userText: "I head to the yard.",
  narration,
  signal: new AbortController().signal,
  debugMode: false,
  debugLog() {},
});
assert.equal(timeoutCalls, 2, "A provider timeout gets one bounded fresh-signal retry");
assert.equal(timeoutRetry?.type, "discover");

const callerAbort = new AbortController();
let callerAbortCalls = 0;
callerAbort.abort(new DOMException("caller cancelled", "AbortError"));
await assert.rejects(
  () =>
    reconcileNarratedLocation({
      provider: {
        chatComplete: async () => {
          callerAbortCalls++;
          throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        },
      },
      model: "fixture",
      projection,
      userText: "I head to the yard.",
      narration,
      signal: callerAbort.signal,
      debugMode: false,
      debugLog() {},
    }),
  /caller cancelled/,
);
assert.equal(callerAbortCalls, 0, "Caller cancellation must not start reconciliation work");

for (const [failure, expectedCalls] of [
  [new DOMException("deadline", "TimeoutError"), 2],
  [new Error("Provider rejected request (401)"), 1],
] as const) {
  let attempts = 0;
  await assert.rejects(reconcileNarratedLocation({
    provider: { chatComplete: async () => { attempts++; throw failure; } },
    model: "fixture", projection, userText: "I head to the yard.", narration,
    signal: new AbortController().signal, debugMode: false, debugLog() {},
  }), (error) => error === failure);
  assert.equal(attempts, expectedCalls, "Retries must be bounded and timeout-specific");
}

const map = {
  type: "node",
  name: "The Root Vault",
  description: "Vault",
  nodes: [],
  edges: [],
  partyPosition: "entry",
} as GameMap;
const maps = [map, map, map, map].map((entry, i) => ({
  ...entry,
  id: i ? `the-root-vault-${i + 1}` : "the-root-vault",
}));
const regenerated = identifyGeneratedGameMap(
  { ...map, id: "model-invented", spatialLocationId: "fake" },
  maps,
  "the-root-vault-4",
  "vault",
);
assert.equal(regenerated.id, "the-root-vault-4");
assert.equal(regenerated.spatialLocationId, "vault");
const meta = withActiveGameMapMeta({ gameMaps: maps }, regenerated);
assert.equal(meta.gameMaps.length, 4, "Regeneration must not append a fifth Root Vault");
assert.equal(maps[3]?.spatialLocationId, undefined, "Identity assignment must not mutate old layouts");
const anotherVault = identifyGeneratedGameMap(
  map,
  [{ ...map, id: "other", spatialLocationId: "other-vault" }],
  "other",
  "vault",
);
assert.notEqual(anotherVault.id, "other", "Same-name maps bound to different places must not be overwritten");
process.stdout.write("Narrated location reconciliation and map identity regressions passed.\n");

const history = [{ role: "assistant", content: "The Coldstream home lies in Greymarch, with a green door." }];
const arrival = "You enter the broad room with a long table and stone hearth.";
const pathDecision = {
  action: "discover_path",
  parentId: null,
  evidence: arrival,
  locations: [
    {
      name: "Greymarch",
      kind: "region",
      description: "The nation containing the Coldstream home.",
      evidence: "Greymarch",
    },
    {
      name: "Coldstream Home",
      kind: "building",
      description: "A home with a green door.",
      evidence: "Coldstream home",
    },
    {
      name: "Main Room",
      kind: "room",
      description: "A broad room with a long table and stone hearth.",
      evidence: arrival,
    },
  ],
};
const parsePath = (decision: unknown, supported = true) =>
  parseNarratedLocationDecision(JSON.stringify(decision), projection, "Let us enter.", arrival, history, supported);
assert.equal(parsePath(pathDecision)?.type, "discover_path");
assert.throws(() => parsePath(pathDecision, false), /must be updated/);
assert.throws(() => parsePath({ ...pathDecision, parentId: "invented" }), /unknown parent/);
assert.throws(() => parsePath({ ...pathDecision, evidence: "Greymarch" }), /absent from this turn/);
assert.throws(
  () =>
    parsePath({ ...pathDecision, locations: [{ ...pathDecision.locations[0], evidence: "A castle never mentioned" }] }),
  /absent from the visible/,
);

const teleportProjection = {
  ...projection,
  currentLocationId: "mentor-root",
  knownLocations: [
    ...projection.knownLocations!,
    { id: "mentor-root", path: "Elowen" },
    { id: "marovska-apartment", path: "Marovska > Guest Apartment" },
  ],
} as ResolvedOwnerSpatialProjection;
const teleportDecision = {
  action: "teleport",
  destinationId: "marovska-apartment",
  evidence: "You arrive in the Marovska guest apartment.",
  authorizationEvidence: "I teleport from Elowen to the Marovska guest apartment now.",
};
const teleportNarration = "A flash of blue light fades. You arrive in the Marovska guest apartment.";
const teleportUser = "I teleport from Elowen to the Marovska guest apartment now.";
assert.deepEqual(
  parseNarratedLocationDecision(
    JSON.stringify(teleportDecision),
    teleportProjection,
    teleportUser,
    teleportNarration,
    [],
    false,
    true,
  ),
  {
    type: "teleport",
    destinationId: "marovska-apartment",
    evidence: teleportDecision.evidence,
    authorizationEvidence: teleportDecision.authorizationEvidence,
  },
);
assert.throws(
  () =>
    parseNarratedLocationDecision(
      JSON.stringify(teleportDecision),
      teleportProjection,
      teleportUser,
      teleportNarration,
    ),
  /must support narrated teleport/,
);
assert.throws(
  () =>
    parseNarratedLocationDecision(
      JSON.stringify({ ...teleportDecision, evidence: "You will arrive in the Marovska guest apartment." }),
      teleportProjection,
      teleportUser,
      teleportNarration,
      [],
      false,
      true,
    ),
  /arrival evidence absent from current narration/,
);
assert.throws(
  () =>
    parseNarratedLocationDecision(
      JSON.stringify(teleportDecision),
      teleportProjection,
      "I might teleport there someday.",
      teleportNarration,
      [{ role: "assistant", content: teleportUser }],
      false,
      true,
    ),
  /authorization evidence absent from visible user history/,
);
assert.throws(
  () =>
    parseNarratedLocationDecision(
      JSON.stringify(teleportDecision),
      teleportProjection,
      "The portal is ready.",
      "You stand at the Elowen root and discuss the Marovska guest apartment.",
      [{ role: "user", content: teleportUser }],
      false,
      true,
    ),
  /arrival evidence absent from current narration/,
);
assert.equal(
  parseNarratedLocationDecision(
    JSON.stringify({ ...teleportDecision, destinationId: "mentor-root" }),
    teleportProjection,
    teleportUser,
    teleportNarration,
    [],
    false,
    true,
  ),
  null,
);
const bounded = buildNarratedLocationHistory([
  { role: "system", content: "Private system content" },
  ...Array.from({ length: 40 }, (_, i) => ({ role: "assistant", content: `${i}:` + "x".repeat(7000) })),
]);
assert.ok(bounded.length <= 32);
assert.ok(bounded.reduce((n, message) => n + message.content.length, 0) <= 32000);
assert.ok(bounded.every((message) => message.content.length <= 6000 && message.role === "assistant"));
assert.equal(
  buildNarratedLocationHistory([{ role: "assistant", content: "<think>hidden</think>Visible" }])[0]?.content,
  "Visible",
);
let sentHistory = false;
await reconcileNarratedLocation({
  provider: {
    async chatComplete(messages) {
      sentHistory = JSON.parse(messages[1]!.content).recentHistory[0].content === history[0]!.content;
      return { content: JSON.stringify(pathDecision) } as never;
    },
  },
  model: "proof",
  projection,
  userText: "Let us enter.",
  narration: arrival,
  recentHistory: history,
  allowDiscoveryPath: true,
  signal: new AbortController().signal,
  debugMode: false,
  debugLog() {},
});
assert.ok(sentHistory, "The provider must receive the preceding destination and physical details");
