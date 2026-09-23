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
  "Rozalind Dulac",
  "Quilla Tallis",
  "Princess Isaura",
  "Neris Voss",
];
const library: Candidate[] = [
  { id: "player", name: "Rowan Mercer", avatarUrl: "/player.png" },
  { id: "warden", name: "Caden Vale", avatarUrl: "/warden.png" },
  { id: "rozalind", name: "Rozalind Dulac", avatarUrl: "/rozalind.png" },
  { id: "quilla", name: "Quilla Tallis", avatarUrl: "/quilla.png" },
  { id: "princess", name: "Princess Isaura", avatarUrl: "/princess.png" },
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
  ["player", "warden", "rozalind", "quilla", "princess", "oracle"],
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
  ["Rozalind Dulac", "Neris Voss", "Absent Character"],
  [],
  [...library, { id: "rozalind-copy", name: "Rozalind Dulac", avatarUrl: "/other-rozalind.png" }],
);
assert.deepEqual(
  duplicate.sceneMembers.map((member) => member.id),
  ["oracle"],
  "duplicate library names stay unresolved while unique identities still resolve",
);
assert.deepEqual(duplicate.sceneExtras, ["Rozalind Dulac", "Absent Character"]);

const existingStable = resolveScenePresence(
  ["Rozalind Dulac"],
  [{ id: "known-rozalind", name: "Rozalind Dulac", avatarUrl: "/known.png" }],
  [
    { id: "rozalind-a", name: "Rozalind Dulac" },
    { id: "rozalind-b", name: "Rozalind Dulac" },
  ],
);
assert.equal(existingStable.sceneMembers[0]?.id, "known-rozalind", "a known stable identity survives library ambiguity");
