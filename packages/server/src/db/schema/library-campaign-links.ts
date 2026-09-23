// ──────────────────────────────────────────────
// Schema: Library Campaign Links
// Manual campaign membership for library items. Campaigns
// themselves are derived from Game Mode chats (gameId);
// these rows only record what the user changed by hand.
// ──────────────────────────────────────────────
import { fileTable, text } from "../file-schema.js";

export const libraryCampaignLinks = fileTable(
  "library_campaign_links",
  {
    id: text("id").primaryKey(),
    /** The Game Mode gameId the campaign is derived from. */
    campaignId: text("campaign_id").notNull(),
    itemType: text("item_type", { enum: ["character", "persona", "lorebook"] }).notNull(),
    itemId: text("item_id").notNull(),
    /** "include" adds an unused item; "exclude" hides an item the campaign's chats reference. */
    mode: text("mode", { enum: ["include", "exclude"] }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  { uniqueBy: [["campaignId", "itemType", "itemId"]] },
);
