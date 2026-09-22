// ──────────────────────────────────────────────
// Library campaign filter helpers: which ids a campaign
// (or "any campaign") holds, and a content key for them.
// ──────────────────────────────────────────────
import type { LibraryCampaign, LibraryCampaignItemType } from "@marinara-engine/shared";

export function getCampaignItemIds(campaign: LibraryCampaign, itemType: LibraryCampaignItemType) {
  if (itemType === "character") return campaign.characterIds;
  if (itemType === "persona") return campaign.personaIds;
  return campaign.lorebookIds;
}

/**
 * Short content key for the ids a campaign filter resolves to on the server. The
 * filtered library pages put it in their query key, so a membership change made
 * elsewhere (a new session, an edited party) refetches them instead of serving a
 * cached page for minutes.
 */
export function campaignFilterRevision(
  campaigns: readonly LibraryCampaign[],
  itemType: LibraryCampaignItemType,
  campaignId: string | null,
) {
  const ids = new Set<string>();
  for (const campaign of campaigns) {
    if (campaignId !== null && campaign.id !== campaignId) continue;
    for (const id of getCampaignItemIds(campaign, itemType)) ids.add(id);
  }
  let hash = 0x811c9dc5;
  for (const id of [...ids].sort()) {
    for (let index = 0; index < id.length; index += 1) {
      hash ^= id.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= 0x2c;
    hash = Math.imul(hash, 0x01000193);
  }
  return `${ids.size}:${(hash >>> 0).toString(36)}`;
}
