// ──────────────────────────────────────────────
// Campaign roster grouping: split a campaign's characters
// into game master, party, linked NPC cards and the rest
// (added by hand or only listed on the chats). Each
// character lands in one group; GM beats party beats NPC.
// ──────────────────────────────────────────────
import type { LibraryCampaign } from "@marinara-engine/shared";

export type CampaignRosterRole = "gm" | "party" | "npc" | "other";

export type CampaignRosterGroup = { role: CampaignRosterRole; characterIds: string[] };

export function buildCampaignRosterGroups(
  campaign: Pick<LibraryCampaign, "characterIds" | "roster">,
): CampaignRosterGroup[] {
  const members = new Set(campaign.characterIds);
  const placed = new Set<string>();
  const take = (ids: readonly string[] | undefined) => {
    const result: string[] = [];
    for (const id of ids ?? []) {
      if (!members.has(id) || placed.has(id)) continue;
      placed.add(id);
      result.push(id);
    }
    return result;
  };
  const groups: CampaignRosterGroup[] = [
    { role: "gm", characterIds: take(campaign.roster?.gmCharacterIds) },
    { role: "party", characterIds: take(campaign.roster?.partyCharacterIds) },
    { role: "npc", characterIds: take(campaign.roster?.npcCharacterIds) },
    { role: "other", characterIds: take(campaign.characterIds) },
  ];
  return groups.filter((group) => group.characterIds.length > 0);
}
