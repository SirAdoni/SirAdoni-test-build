import assert from "node:assert/strict";
import {
  buildPartySpeakerSystemPrompt,
  filterPartyNarrationForSpeaker,
  rejectCrossSpeakerPartyLines,
  runBoundedPartySpeakerRequests,
  selectPresentPartySpeakers,
} from "../../packages/server/src/services/game/party-prompts.js";

const alice = {
  name: "Alice",
  card: "Name: Alice\nBackstory: Alice's private childhood secret\nPersonality: cautious",
};
const bob = {
  name: "Bob",
  card: "Name: Bob\nBackstory: Bob's private oath\nPersonality: direct",
};

const timeline = {
  scenes: [
    {
      id: "scene-1",
      location: "Gate",
      participants: ["Alice", "Bob"],
      present: ["Alice"],
      summary: "",
      closed: false,
      reviewed: false,
      messageIds: ["m1"],
    },
  ],
  pending: false,
  error: null,
  remaining: 0,
};
assert.deepEqual(selectPresentPartySpeakers(timeline, ["Alice", "Bob"]), ["Alice"]);
assert.deepEqual(selectPresentPartySpeakers({ ...timeline, pending: true }, ["Alice"]), []);
assert.deepEqual(selectPresentPartySpeakers({ ...timeline, error: "timeline failed" }, ["Alice"]), []);
assert.deepEqual(selectPresentPartySpeakers({ ...timeline, remaining: 1 }, ["Alice"]), []);
assert.deepEqual(selectPresentPartySpeakers({ ...timeline, scenes: [] }, ["Alice"]), []);
assert.deepEqual(
  selectPresentPartySpeakers({ ...timeline, scenes: [{ ...timeline.scenes[0], closed: true }] }, ["Alice"]),
  [],
);

const aliceRequest = buildPartySpeakerSystemPrompt({
  speaker: alice,
  partyRoster: ["Alice", "Bob"],
  playerName: "Player",
  gameActiveState: "dialogue",
  ownContinuityEvidence: "Alice learned the public gate phrase.",
  sharedContinuityEvidence: "The gate is closed.",
});

assert.match(aliceRequest, /Alice's private childhood secret/);
assert.match(aliceRequest, /Alice learned the public gate phrase/);
assert.match(aliceRequest, /- Bob/);
assert.doesNotMatch(aliceRequest, /Bob's private oath/);
assert.doesNotMatch(aliceRequest, /Bob's hidden arc/);

const bobRequest = buildPartySpeakerSystemPrompt({
  speaker: bob,
  partyRoster: ["Alice", "Bob"],
  playerName: "Player",
  gameActiveState: "dialogue",
  ownContinuityEvidence: "Bob learned the public gate phrase.",
  sharedContinuityEvidence: "The gate is closed.",
});

assert.match(bobRequest, /Bob's private oath/);
assert.doesNotMatch(bobRequest, /Alice's private childhood secret/);

const narration = filterPartyNarrationForSpeaker(
  '[Alice] [thought] [thinking]: Alice private thought\nAlice continuation\n[Alice] [main] [neutral]: "Public line."\n[Bob] [whisper:Alice] [quiet]: "Private to Alice."\n[Bob] [thought] [thinking]: Bob private thought\nBob continuation',
  "Alice",
);
assert.match(narration, /Public line/);
assert.match(narration, /Private to Alice/);
assert.match(narration, /Alice private thought/);
assert.doesNotMatch(narration, /Bob private thought|Bob continuation/);

const unknownPrivate = filterPartyNarrationForSpeaker(
  "[Unknown NPC] [thought] [thinking]: hidden\ncontinuation\n[Narration] [main] [neutral]: Public",
  "Alice",
);
assert.doesNotMatch(unknownPrivate, /hidden|continuation/);
assert.match(unknownPrivate, /Public/);

rejectCrossSpeakerPartyLines('[Alice] [main] [neutral]: "Hello."', "Alice", ["Alice", "Bob"]);
assert.throws(
  () => rejectCrossSpeakerPartyLines('  [Bob] [main] [neutral]: "Private."', "Alice", ["Alice", "Bob"]),
  /another character/,
);
assert.throws(
  () => rejectCrossSpeakerPartyLines('[Alice] [reputation: npc="Bob" action="trust"]', "Alice", ["Alice", "Bob"]),
  /reputation/,
);

const speakers = [{ name: "Alice" }, { name: "Bob" }, { name: "Cara" }];
const started: string[] = [];
const ordered = await runBoundedPartySpeakerRequests(
  speakers,
  async (speaker, index) => {
    started.push(speaker.name);
    await new Promise((resolve) => setTimeout(resolve, index === 0 ? 20 : 1));
    return `${speaker.name}:${index}`;
  },
  { signal: new AbortController().signal, maxConcurrency: 2 },
);
assert.deepEqual(ordered, ["Alice:0", "Bob:1", "Cara:2"]);
assert.deepEqual(started, ["Alice", "Bob", "Cara"]);

const failureController = new AbortController();
let startedAfterFailure = false;
await assert.rejects(
  runBoundedPartySpeakerRequests(
    speakers,
    async (speaker, index, signal) => {
      if (index === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        throw new Error("speaker failure");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      signal.throwIfAborted();
      startedAfterFailure = true;
      return speaker.name;
    },
    { signal: failureController.signal, maxConcurrency: 2 },
  ),
  /speaker failure|aborted/,
);
assert.equal(startedAfterFailure, false);

const cancellationController = new AbortController();
const cancellation = runBoundedPartySpeakerRequests(
  [{ name: "Alice" }],
  async (_speaker, _index, signal) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    signal.throwIfAborted();
    return "unreachable";
  },
  { signal: cancellationController.signal },
);
cancellationController.abort(new Error("cancelled"));
await assert.rejects(cancellation, /cancelled|aborted/);

console.log("game-party-speaker-prompts regression passed");
