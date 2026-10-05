import assert from "node:assert/strict";
import { buildCampaignRosterGroups } from "../../packages/client/src/lib/library-campaign-roster.js";
import { deriveLibraryCampaigns } from "../../packages/server/src/services/storage/library-campaigns.storage.js";

// Campaign roster roles (GM, party, linked NPC cards, and the rest).
{
  const chat = (id: string, metadata: Record<string, unknown>, characterIds: string[] = []) => ({
    id,
    name: "Siege — Session 1",
    mode: "game",
    groupId: null,
    personaId: null,
    characterIds: JSON.stringify(characterIds),
    metadata: JSON.stringify(metadata),
    lastMessageAt: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  });
  const [campaign] = deriveLibraryCampaigns({
    chats: [
      chat(
        "s1",
        {
          gameId: "siege",
          gameGmCharacterId: "gm",
          gamePartyCharacterIds: ["hero", "gm"],
          gameNpcs: [{ characterId: "smith" }, { characterId: "npc:loose" }, { name: "No card" }],
        },
        ["hero", "bystander"],
      ),
      chat("s2", { gameId: "siege", gameSetupConfig: { partyCharacterIds: ["rogue"] } }),
    ],
    lorebooks: [],
    lorebookCharacterLinks: [],
    lorebookPersonaLinks: [],
    links: [
      { campaignId: "siege", itemType: "character", itemId: "rogue", mode: "exclude" },
      { campaignId: "siege", itemType: "character", itemId: "added", mode: "include" },
    ],
    characterIds: new Set(["gm", "hero", "smith", "bystander", "rogue", "added"]),
    personaIds: new Set(),
  });
  assert.deepEqual(
    campaign!.roster,
    {
      gmCharacterIds: ["gm"],
      partyCharacterIds: ["hero", "gm"],
      npcCharacterIds: ["smith"],
    },
    "roles come from every session; excluded characters leave the roster",
  );
  assert.deepEqual(
    buildCampaignRosterGroups(campaign!).map((group) => `${group.role}:${group.characterIds.join(",")}`),
    ["gm:gm", "party:hero", "npc:smith", "other:bystander,added"],
    "each character shows once: GM before party before NPCs, the rest last",
  );
  assert.deepEqual(buildCampaignRosterGroups({ characterIds: ["solo"] }), [{ role: "other", characterIds: ["solo"] }]);
}

console.log("library-campaign-roster regression passed");
