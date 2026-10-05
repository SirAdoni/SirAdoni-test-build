import assert from "node:assert/strict";
import {
  appendSceneVisits,
  sceneReviewSource,
  sceneTurnHash,
  validateSceneEvidence,
} from "../../packages/server/src/services/game/scene-timeline-model.js";
import type { GameSceneTimelineEntry, GameSceneVisit } from "../../packages/shared/src/types/game-scene-timeline.js";

const visit = (location: string, names: string[], facts: GameSceneVisit["facts"] = []): GameSceneVisit => ({
  location,
  present: names,
  participants: names,
  departures: [],
  facts,
});

const scenes: GameSceneTimelineEntry[] = [];
appendSceneVisits(scenes, "turn-1", [visit("East Hall", ["Player One", "Guide One"])]);
appendSceneVisits(scenes, "turn-2", [visit("West Bridge", ["Player One", "Guide Two"])]);
appendSceneVisits(scenes, "turn-3", [visit("East Hall", ["Player One", "Guide One"])]);
assert.deepEqual(
  scenes.map(({ location, closed }) => [location, closed]),
  [["East Hall", true], ["West Bridge", true], ["East Hall", false]],
  "scene changes preserve chronological order when a location is revisited",
);
assert.deepEqual(scenes[0]?.present, ["Player One", "Guide One"], "a later visit cannot rewrite an earlier roster");
assert.deepEqual(scenes[0]?.messageIds, ["turn-1"], "each scene retains its source-turn identity");

const arrival = visit("North Room", ["Player One", "New Witness"], [
  { text: "The witness describes the broken lock.", quote: "The broken lock is still warm." },
]);
arrival.presenceEvidence = [
  { name: "Player One", quote: "Player One enters the north room with New Witness." },
  { name: "New Witness", quote: "Player One enters the north room with New Witness." },
];
validateSceneEvidence(
  [arrival],
  "Player One enters the north room with New Witness. The broken lock is still warm.",
  { requirePresenceEvidence: true, previous: null },
);
assert.throws(
  () => validateSceneEvidence([arrival], "Player One enters the north room.", { requirePresenceEvidence: true }),
  /exact supporting transcript quote/,
  "facts and arrivals must retain exact source evidence",
);

const visits = [
  visit("North Room", ["Player One"], [{ text: "A door opens.", quote: "The north door opens." }]),
  visit("South Room", ["Player One"], [{ text: "A light fails.", quote: "The south light fails." }]),
];
assert.equal(
  sceneReviewSource("The north door opens. The south light fails.", visits, 0),
  "The north door opens.",
  "a closed-scene review excludes evidence from the next scene in the same turn",
);
assert.notEqual(
  sceneTurnHash("prior", "assistant: original swipe"),
  sceneTurnHash("prior", "assistant: replacement swipe"),
  "a changed swipe invalidates its saved scene timeline version",
);
