import assert from "node:assert/strict";
import {
  buildCampaignPortraitBatches,
  buildCampaignPortraitRosterCandidates,
  DEFAULT_CAMPAIGN_PORTRAIT_STYLE_PROMPT,
} from "../../packages/client/src/components/game/game-asset-generation-payload.ts";

const trackedNpcs = [
  { npcId: "offscene", name: "Offscene", description: "An offscreen campaign contact" },
  { npcId: "party", characterId: "card-party", name: "Party", description: "Party member" },
  { npcId: "linked", characterId: "card-linked", name: "Linked", description: "Has card portrait" },
  {
    npcId: "linked-fallback",
    characterId: "card-linked-fallback",
    name: "Global Match",
    description: "Linked card without portrait",
  },
  { npcId: "duplicate", name: "Duplicate", description: "No portrait" },
  { npcId: "same-a", name: "Shared Name", description: "First" },
  { npcId: "same-b", name: "Shared Name", description: "Second" },
  ...Array.from({ length: 12 }, (_, index) => ({
    npcId: `extra-${index}`,
    name: `Extra ${index}`,
    description: "Campaign NPC",
  })),
];

const candidates = buildCampaignPortraitRosterCandidates(
  trackedNpcs,
  [
    { npcId: "offscene", name: "Offscene", description: "Metadata duplicate" },
    { npcId: "duplicate", name: "Duplicate", description: "Existing portrait", avatarUrl: "/existing.png" },
  ],
  [
    { id: "card-party", name: "Party", description: "Canonical party card" },
    { id: "card-unlinked", name: "Unlinked Party", description: "Canonical unlinked party card" },
    { id: "unrelated", name: "Library only", description: "Must not be included" },
  ],
  new Set(["card-party", "card-unlinked"]),
);
const batches = buildCampaignPortraitBatches(
  [...candidates],
  new Map([
    ["linked", "/api/avatars/npc/chat/card.png"],
    ["global match", "/api/avatars/library/card.png"],
  ]),
  "editable campaign style",
  new Set(["card-party", "card-linked"]),
);
const selected = batches.flatMap((batch) => batch.candidates);

assert(
  selected.some((candidate) => candidate.npcId === "offscene"),
  "offscene campaign NPCs are included",
);
assert.equal(
  candidates.filter((candidate) => candidate.npcId === "offscene").length,
  1,
  "NPC and metadata rows union by stable ID",
);
assert(!selected.some((candidate) => candidate.npcId === "linked"), "linked portraits are preserved");
assert(
  !selected.some((candidate) => candidate.npcId === "duplicate"),
  "an avatar on any duplicate suppresses the identity",
);
assert(
  !selected.some((candidate) => candidate.npcId === "party:card-party"),
  "a linked party card does not create a duplicate candidate",
);
assert(
  selected.some((candidate) => candidate.npcId === "party:card-unlinked" && candidate.characterId === "card-unlinked"),
  "unlinked active party cards are included with their stable card ID",
);
assert(!selected.some((candidate) => candidate.name === "Library only"), "unrelated library cards are excluded");
assert(
  selected.some((candidate) => candidate.npcId === "same-a"),
  "ambiguous names do not hide a missing identity",
);
assert(
  selected.some((candidate) => candidate.npcId === "same-b"),
  "same-name distinct identities remain separate",
);
assert(
  selected.some((candidate) => candidate.npcId === "linked-fallback"),
  "linked identities take precedence over global same-name avatar matches",
);
assert(batches.length > 1, "more than ten identities are split into bounded batches");
assert(
  batches.every((batch) => batch.candidates.length <= 10),
  "each request respects the ten-character cap",
);
assert(
  batches.every((batch) => batch.stylePrompt === "editable campaign style"),
  "the same editable style reaches each batch",
);
assert(
  buildCampaignPortraitBatches([], new Map(), "", new Set()).length === 0 &&
    DEFAULT_CAMPAIGN_PORTRAIT_STYLE_PROMPT.includes("not photorealistic"),
  "empty rosters no-op and the default style remains explicit",
);

console.info("Campaign portrait batch selection regression passed.");
