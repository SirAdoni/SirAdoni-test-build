import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { resolveScenePresence } from "../../packages/client/src/components/game/game-scene-presence.js";

type Candidate = {
  id: string;
  name: string;
  avatarUrl?: string | null;
  avatarCrop?: { srcX: number; srcY: number; srcWidth: number; srcHeight: number } | null;
};

const present = [
  "Rowan Mercer",
  "Caden Vale",
  "Vashti Orlane",
  "Liveth Corren",
  "Princess Ysolde",
  "Neris Voss",
];
const library: Candidate[] = [
  { id: "player", name: "Rowan Mercer", avatarUrl: "/player.png" },
  { id: "warden", name: "Caden Vale", avatarUrl: "/warden.png" },
  { id: "vashti", name: "Vashti Orlane", avatarUrl: "/vashti.png" },
  { id: "liveth", name: "Liveth Corren", avatarUrl: "/liveth.png" },
  { id: "princess", name: "Princess Ysolde", avatarUrl: "/princess.png" },
  {
    id: "oracle",
    name: "Neris Voss",
    avatarUrl: "/oracle.png",
    avatarCrop: {
      srcX: 0.17878761291503906,
      srcY: 0.018181694878472224,
      srcWidth: 0.5333329518636067,
      srcHeight: 0.35555530124240453,
    },
  },
  { id: "unrelated", name: "Unrelated Library Card", avatarUrl: "/unrelated.png" },
];

const resolved = resolveScenePresence(present, [], library);
assert.deepEqual(
  resolved.sceneMembers.map((member) => member.id),
  ["player", "warden", "vashti", "liveth", "princess", "oracle"],
  "every recorded occupant resolves to its canonical library identity",
);
assert.equal(resolved.sceneExtras.length, 0, "unrelated library cards are never admitted");
assert.equal(
  resolved.scopedLibraryCandidates.some((candidate) => candidate.id === "oracle"),
  true,
);
assert.equal(resolved.libraryAvatarLookup.get("neris voss"), "/oracle.png");
assert.deepEqual(
  resolved.scopedLibraryCandidates.find((candidate) => candidate.id === "oracle")?.avatarCrop,
  {
    srcX: 0.17878761291503906,
    srcY: 0.018181694878472224,
    srcWidth: 0.5333329518636067,
    srcHeight: 0.35555530124240453,
  },
  "canonical scene library candidates retain their saved avatar crop for thumbnail projection",
);

const gameSurface = readFileSync(
  new URL("../../packages/client/src/components/game/GameSurface.tsx", import.meta.url),
  "utf8",
);
assert.match(
  gameSurface,
  /map\.set\(key, \{ url: avatarUrl, crop: libraryCandidate\?\.avatarCrop \?\? null \}\)/u,
  "scene library speaker avatars must carry the saved crop into dialogue thumbnails",
);

const duplicate = resolveScenePresence(
  ["Vashti Orlane", "Neris Voss", "Absent Character"],
  [],
  [...library, { id: "vashti-copy", name: "Vashti Orlane", avatarUrl: "/other-vashti.png" }],
);
assert.deepEqual(
  duplicate.sceneMembers.map((member) => member.id),
  ["oracle"],
  "duplicate library names stay unresolved while unique identities still resolve",
);
assert.deepEqual(duplicate.sceneExtras, ["Vashti Orlane", "Absent Character"]);

const existingStable = resolveScenePresence(
  ["Vashti Orlane"],
  [{ id: "known-vashti", name: "Vashti Orlane", avatarUrl: "/known.png" }],
  [
    { id: "vashti-a", name: "Vashti Orlane" },
    { id: "vashti-b", name: "Vashti Orlane" },
  ],
);
assert.equal(existingStable.sceneMembers[0]?.id, "known-vashti", "a known stable identity survives library ambiguity");
