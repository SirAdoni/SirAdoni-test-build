import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  appendSceneVisits,
  sceneTurnHash,
  sceneTurnSchema,
  sceneReviewSource,
  validateSceneEvidence,
  sceneRepairFeedback,
  sceneEvidenceHint,
} from "../../packages/server/src/services/game/scene-timeline-model.js";
import type { GameSceneTimelineEntry, GameSceneVisit } from "../../packages/shared/src/types/game-scene-timeline.js";
import { selectReviewableScene } from "../../packages/server/src/services/game/scene-timeline.service.js";
const scenes: GameSceneTimelineEntry[] = [];
const visit = (
  location: string,
  present: string[],
  facts: GameSceneVisit["facts"] = [],
  departures: GameSceneVisit["departures"] = [],
): GameSceneVisit => ({ location, present, participants: present, facts, departures });
const evidenced = (base: GameSceneVisit, presenceEvidence: Array<{ name: string; quote: string }>): GameSceneVisit => ({
  ...base,
  presenceEvidence,
});
appendSceneVisits(scenes, "one", [
  visit(
    "Gate",
    ["Edmund", "Quenby", "Ferrant"],
    [{ text: "Edmund chose the lesson.", quote: "Learn it the hard way." }],
  ),
]);
appendSceneVisits(scenes, "two", [visit("Gate", ["Edmund"])]);
assert.deepEqual(scenes[0].present, ["Edmund", "Quenby", "Ferrant"], "Silence must not remove occupants");
const departure = visit("Gate", ["Edmund", "Quenby"], [], [{ name: "Ferrant", quote: "Ferrant leaves." }]);
validateSceneEvidence([departure], "Ferrant leaves.");
appendSceneVisits(scenes, "three", [departure]);
assert.deepEqual(scenes[0].present, ["Edmund", "Quenby"]);
assert(scenes[0].participants.includes("Ferrant"), "A departure must remain in scene history");
const returnScenes: GameSceneTimelineEntry[] = [];
appendSceneVisits(returnScenes, "before", [visit("Hall", ["Edmund", "Quenby"])]);
const returnVisit = evidenced(
  visit("Hall", ["Edmund", "Quenby"], [], [{ name: "Quenby", quote: "Quenby leaves." }]),
  [],
);
validateSceneEvidence(
  [returnVisit, evidenced(visit("Hall", ["Edmund", "Quenby"]), [])],
  "Quenby leaves. Later, Quenby returns.",
  { requirePresenceEvidence: true, previous: { location: "Hall", present: ["Edmund", "Quenby"] } },
);
appendSceneVisits(returnScenes, "return", [returnVisit]);
appendSceneVisits(returnScenes, "silent", [visit("Hall", ["Edmund"])]);
assert.deepEqual(
  returnScenes[0].present,
  ["Edmund", "Quenby"],
  "The explicit end-of-visit roster must retain a returned occupant through later silence",
);
appendSceneVisits(scenes, "four", [visit("Hall", ["Edmund", "Ludmila"]), visit("Gate", ["Edmund"])]);
assert.deepEqual(
  scenes.map((scene) => scene.location),
  ["Gate", "Hall", "Gate"],
);
assert.deepEqual(
  scenes.map((scene) => scene.closed),
  [true, true, false],
);
assert(!scenes[2].present.includes("Quenby"), "Old location occupants cannot leak into a later visit");
assert.throws(() => validateSceneEvidence([departure], "Ferrant remains."), /quote/);
validateSceneEvidence(
  [evidenced(visit("Hall", ["Edmund"], [], []), [{ name: "Edmund", quote: "Edmund enters the hall." }])],
  "Edmund enters the hall.",
  { requirePresenceEvidence: true },
);
assert.throws(
  () =>
    validateSceneEvidence(
      [evidenced(visit("Hall", ["Morgavia"], [], []), [{ name: "Morgavia", quote: "Morgavia is a province." }])],
      "Morgavia is a province.",
      { requirePresenceEvidence: true, knownLocationNames: ["Morgavia"] },
    ),
  /cannot be an occupant/,
);
assert.throws(
  () => validateSceneEvidence([visit("Hall", ["Unseen NPC"])], "The room is quiet.", { requirePresenceEvidence: true }),
  /presenceEvidence/,
);
assert.throws(
  () =>
    validateSceneEvidence([visit("Hall", ["Morgavia"])], "They will travel to Morgavia tomorrow.", {
      requirePresenceEvidence: true,
    }),
  /presenceEvidence/,
  "A destination mentioned in the turn cannot become an occupant without physical-presence evidence",
);
validateSceneEvidence(
  [evidenced(visit("Hall", ["Spring"], [], []), [{ name: "Spring", quote: "Spring enters the hall." }])],
  "Spring enters the hall.",
  { requirePresenceEvidence: true, knownCharacterNames: ["Spring"], knownLocationNames: ["Spring"] },
);
const carried = evidenced(visit("Hall", ["Edmund", "Quenby"]), [
  { name: "Edmund", quote: "Edmund enters the hall." },
  { name: "Quenby", quote: "Quenby enters the hall." },
]);
validateSceneEvidence(
  [carried, evidenced(visit("Hall", ["Edmund", "Quenby"]), [])],
  "Edmund enters the hall. Quenby enters the hall.",
  {
    requirePresenceEvidence: true,
  },
);
assert.throws(
  () => validateSceneEvidence([visit("Gate", [], [{ text: "Quenby chose.", quote: "invented" }])], "Edmund chose."),
  /quote/,
);
const oldHash = sceneTurnHash(sceneTurnHash("seed", "user choice"), "old swipe");
const hintSource = "She replied, and I would rather that room be the Regent's.";
const incorrectQuote = "but I would rather that room be the Regent's.";
assert(sceneEvidenceHint(hintSource, incorrectQuote).includes(hintSource));
assert.equal(sceneEvidenceHint(hintSource + hintSource, incorrectQuote), "", "Ambiguous anchors are not suggested");
assert.throws(
  () => validateSceneEvidence([visit("Hall", [], [{ text: "Claim", quote: incorrectQuote }])], hintSource),
  /quote/,
);
const formatting = visit("Hall", ["Edmund"], [{ text: "Exact words retained.", quote: "“The core  glows. [Ready?]”" }]);
const formattingSource = "The core\nglows. [Ready?]";
validateSceneEvidence([formatting], formattingSource);
assert.equal(formatting.facts[0].quote, formattingSource, "Store the exact source substring after formatting repair");
for (const quote of ["The core explodes.", "The core ... [Ready?]", "the core glows. [Ready?]"]) {
  assert.throws(
    () => validateSceneEvidence([visit("Hall", [], [{ text: "Invalid", quote }])], formattingSource),
    /visits\[0\].facts\[0\].quote/,
  );
}
const multipleInvalid = visit(
  "Hall",
  [],
  [
    { text: "Wrong one", quote: "invented one" },
    { text: "Wrong two", quote: "invented two" },
  ],
);
let diagnostic = "";
try {
  validateSceneEvidence([multipleInvalid], formattingSource);
} catch (error) {
  diagnostic = String(error);
}
assert.match(diagnostic, /facts\[0\]/);
assert.match(diagnostic, /facts\[1\]/);
const previousDraft = JSON.stringify({ visits: [multipleInvalid] });
const feedback = sceneRepairFeedback(previousDraft, diagnostic);
assert(feedback.includes(previousDraft));
assert(feedback.includes(diagnostic));
assert.notEqual(oldHash, sceneTurnHash(sceneTurnHash("seed", "corrected user choice"), "old swipe"));
assert.notEqual(oldHash, sceneTurnHash(sceneTurnHash("seed", "user choice"), "new swipe"));

const group = sceneTurnSchema.parse({
  visits: [visit("Hall", ["three house managers"]), visit("Hall", ["two house managers", "Danika"])],
});
const groupScenes: GameSceneTimelineEntry[] = [];
appendSceneVisits(groupScenes, "groups", group.visits);
assert.deepEqual(groupScenes[0].present, ["house managers", "Danika"]);
const recapScenes: GameSceneTimelineEntry[] = [
  {
    id: "old",
    location: "New place",
    participants: ["Old companion"],
    present: ["Old companion"],
    summary: "",
    closed: false,
    reviewed: false,
    messageIds: [],
  },
];
appendSceneVisits(
  recapScenes,
  "recap",
  [evidenced(visit("New place", ["Edmund"], [], []), [{ name: "Edmund", quote: "Edmund enters New place." }])],
  { resetCurrentPresence: true },
);
assert.deepEqual(
  recapScenes.map((scene) => scene.present),
  [["Edmund"]],
);
assert.equal(recapScenes[0]?.closed, false);
appendSceneVisits(recapScenes, "empty-recap", [evidenced(visit("New place", []), [])], { resetCurrentPresence: true });
assert.deepEqual(recapScenes[0].present, []);
assert(recapScenes[0].participants.includes("Old companion"), "Historical participants remain in history");
validateSceneEvidence(
  [evidenced(visit("Hall", ["Edmund"]), []), evidenced(visit("Hall", ["Quenby"]), [])],
  "Silence.",
  {
    requirePresenceEvidence: true,
    previous: { location: "Hall", present: ["Edmund", "Quenby"] },
  },
);
assert.throws(
  () =>
    validateSceneEvidence([evidenced(visit("Garden", ["Quenby"]), [])], "Edmund enters the garden.", {
      requirePresenceEvidence: true,
      previous: { location: "Hall", present: ["Quenby"] },
    }),
  /Quenby/,
);
assert(sceneTurnSchema.safeParse({ visits: [visit("Hall", ["Legacy character"])] }).success);
const service = readFileSync(
  new URL("../../packages/server/src/services/game/scene-timeline.service.ts", import.meta.url),
  "utf8",
);
const inherited = {
  id: "old:0",
  location: "Solis",
  closed: true,
  reviewed: false,
  messageIds: ["old", "current"],
  participants: [],
  present: [],
  summary: "old facts",
};
const local = {
  id: "current:0",
  location: "Peak",
  closed: true,
  reviewed: false,
  messageIds: ["current"],
  participants: [],
  present: [],
  summary: "local facts",
};
assert.equal(
  selectReviewableScene([inherited, local], new Set(["current"])),
  local,
  "missing inherited source defers while a local scene remains reviewable",
);
assert.match(service, /validateSceneEvidence\(saved\.visits, turn\.source, \{\s*requirePresenceEvidence: true/);
assert.match(service, /previous: isOpeningRecap \? null/);
assert.match(service, /presenceEvidence !== undefined/);

const boundary = "user: Enter. assistant: Ferrant leads them across the court. Ludmila welcomes them in the hall.";
const boundaryVisits = [
  visit("Court", ["Edmund"], [{ text: "They cross.", quote: "Ferrant leads them across the court." }]),
  visit(
    "Hall",
    ["Edmund", "Ludmila"],
    [{ text: "Ludmila welcomes them.", quote: "Ludmila welcomes them in the hall." }],
  ),
];
assert(!sceneReviewSource(boundary, boundaryVisits, 0).includes("Ludmila"));
assert(!sceneReviewSource(boundary, boundaryVisits, 1).includes("Ferrant"));
assert.equal(
  sceneReviewSource("user: The party rests. assistant: The fire burns low.", [visit("Camp", ["Edmund"])], 0),
  "user: The party rests. assistant: The fire burns low.",
  "a factless scene continuation must retain its source for factual review",
);
assert.equal(
  sceneReviewSource(
    "user: The party rests. assistant: A private later scene begins.",
    [visit("Camp", ["Edmund"]), visit("Tower", ["Edmund"], [{ text: "Later fact.", quote: "private later scene" }])],
    0,
  ),
  "",
  "a factless visit in a multi-visit turn must not leak the later scene into review",
);
