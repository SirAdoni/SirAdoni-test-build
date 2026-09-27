import assert from "node:assert/strict";
import {
  resolveIsolatedPresentActorIds,
  selectIsolatedActorCandidateIds,
} from "../../packages/server/src/services/game/isolated-game-presence";
import { appendSceneVisits } from "../../packages/server/src/services/game/scene-timeline-model";

const npcs = [{ id: "npc:dorian", characterId: "char:dorian", name: "Dorian" }];
const characters = [{ id: "char:alice", name: "Alice" }];
const libraryCharacters = [
  { id: "library:first-guest", name: "Mara Reed" },
  { id: "library:second-guest", name: "Nora Pike" },
];
assert.deepEqual(
  [...resolveIsolatedPresentActorIds({ snapshotIds: [], sceneNames: ["Dorian"], npcs, characters })],
  ["char:dorian"],
);
assert.deepEqual(
  [
    ...resolveIsolatedPresentActorIds({
      snapshotIds: [],
      sceneNames: ["Dorian", "Mara Reed", "Nora Pike"],
      npcs,
      characters: [...characters, ...libraryCharacters],
    }),
  ],
  ["char:dorian", "library:first-guest", "library:second-guest"],
);
assert.equal(
  resolveIsolatedPresentActorIds({
    snapshotIds: [],
    sceneNames: ["Dorian"],
    npcs: [
      { id: "a", name: "Dorian" },
      { id: "b", name: "Dorian" },
    ],
    characters,
  }).size,
  0,
);
const candidateCharacters = [
  { id: "char:mara", name: "Mara Reed" },
  { id: "char:nora", name: "Nora Pike" },
  { id: "char:alice", name: "Alice Vale" },
  { id: "char:alicia", name: "Alice Stone" },
  { id: "char:alina", name: "Alina Stone" },
];
assert.deepEqual(
  [...selectIsolatedActorCandidateIds({ presentIds: new Set(["player"]), excludedIds: ["player"], npcs: [], characters: candidateCharacters })],
  ["char:mara", "char:nora", "char:alice", "char:alicia", "char:alina"],
);
assert.deepEqual(
  [...selectIsolatedActorCandidateIds({ presentIds: new Set(), npcs: [], characters: candidateCharacters })],
  ["char:mara", "char:nora", "char:alice", "char:alicia", "char:alina"],
);
assert.deepEqual(
  [...selectIsolatedActorCandidateIds({ presentIds: new Set(), npcs: [{ id: "npc:dorian", characterId: "char:dorian", name: "Dorian" }], characters: [] })],
  ["char:dorian"],
);
assert.deepEqual(
  [...selectIsolatedActorCandidateIds({ presentIds: new Set(["already-here", "player"]), npcs: [], characters: [{ id: "a", name: "Mara Reed" }, { id: "b", name: "Mara Stone" }], excludedIds: ["player", "b"] })],
  ["already-here", "a"],
);
assert.equal(
  resolveIsolatedPresentActorIds({
    snapshotIds: [],
    sceneNames: ["Mara Reed"],
    npcs,
    characters: [...libraryCharacters, { id: "library:duplicate", name: "Mara Reed" }],
  }).size,
  0,
);
assert.equal(
  resolveIsolatedPresentActorIds({
    snapshotIds: ["player"],
    sceneNames: ["Player"],
    npcs,
    characters: [{ id: "player", name: "Player" }],
    excludedIds: ["player"],
  }).size,
  0,
);
const visits = [
  { location: "Hall", present: ["Dorian"], participants: ["Dorian"], departures: [], facts: [] },
  {
    location: "Hall",
    present: [],
    participants: ["Dorian"],
    departures: [{ name: "Dorian", quote: "Dorian leaves." }],
    facts: [],
  },
];
const scopedScenes: any[] = [];
appendSceneVisits(scopedScenes, "current", [visits[0]!]);
// A future same-location visit must not be appended to the scoped source before presence is read.
assert.deepEqual(scopedScenes.at(-1)?.present, ["Dorian"]);
const afterDeparture: any[] = [];
appendSceneVisits(afterDeparture, "current", visits);
assert.deepEqual(afterDeparture.at(-1)?.present, []);
console.info("isolated-game-presence regression passed");
