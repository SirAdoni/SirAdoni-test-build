import { z } from "zod";

/** Library item kinds a Game Mode campaign can list. */
export const libraryCampaignItemTypeSchema = z.enum(["character", "persona", "lorebook"]);

export const libraryCampaignParamsSchema = z.object({
  campaignId: z.string().min(1).max(256),
});

/** Add or remove library items to/from a campaign by hand. */
export const libraryCampaignItemsSchema = z.object({
  itemType: libraryCampaignItemTypeSchema,
  itemIds: z.array(z.string().min(1).max(256)).min(1).max(5_000),
});

/** Query value that filters a library list to items in no campaign at all. */
export const LIBRARY_CAMPAIGN_NONE = "__none__";

export type LibraryCampaignItemType = z.infer<typeof libraryCampaignItemTypeSchema>;
export type LibraryCampaignItemsInput = z.infer<typeof libraryCampaignItemsSchema>;

/** Who plays which part, from the campaign's chats. Ids are also listed in `characterIds`. */
export interface LibraryCampaignRoster {
  /** Game master cards (game setup or chat metadata). */
  gmCharacterIds: string[];
  /** Party members across the sessions. */
  partyCharacterIds: string[];
  /** NPCs linked to a character card. */
  npcCharacterIds: string[];
}

/**
 * A Game Mode campaign (all session chats sharing one gameId) and the library
 * items it uses. Lists are the effective membership: what the campaign's chats
 * reference, plus manual additions, minus manual removals.
 */
export interface LibraryCampaign {
  /** The game id shared by every session chat. */
  id: string;
  name: string;
  sessionCount: number;
  /** Newest message or update across the campaign's session chats. */
  lastPlayedAt: string | null;
  characterIds: string[];
  personaIds: string[];
  lorebookIds: string[];
  /** Items the user added by hand ("character:<id>", "persona:<id>", "lorebook:<id>"). */
  manualKeys: string[];
  /** Character roles; older servers omit it. */
  roster?: LibraryCampaignRoster;
}

export interface LibraryCampaignList {
  campaigns: LibraryCampaign[];
}
