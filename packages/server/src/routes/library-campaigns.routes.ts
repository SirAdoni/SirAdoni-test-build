// ──────────────────────────────────────────────
// Routes: Library Campaigns
// Game Mode campaigns derived from session chats, plus
// manual add/remove of library items per campaign.
// ──────────────────────────────────────────────
import type { FastifyInstance } from "fastify";
import {
  LIBRARY_CAMPAIGN_NONE,
  libraryCampaignItemsSchema,
  libraryCampaignParamsSchema,
  type LibraryCampaignItemType,
  type LibraryCampaignList,
} from "@marinara-engine/shared";
import type { DB } from "../db/connection.js";
import { createLibraryCampaignsStorage } from "../services/storage/library-campaigns.storage.js";

export type LibraryCampaignIdFilter = { include?: string[]; exclude?: string[] };

/**
 * Turn a `campaign` list query value into an id filter: a campaign id keeps only
 * its items, LIBRARY_CAMPAIGN_NONE keeps only items in no campaign. Unknown or
 * empty values filter nothing.
 */
export async function resolveLibraryCampaignFilter(
  db: DB,
  itemType: LibraryCampaignItemType,
  campaign: string | undefined,
): Promise<LibraryCampaignIdFilter | undefined> {
  const value = campaign?.trim();
  if (!value) return undefined;
  const storage = createLibraryCampaignsStorage(db);
  if (value === LIBRARY_CAMPAIGN_NONE) return { exclude: [...(await storage.memberIds(itemType, null))] };
  const campaigns = await storage.list();
  if (!campaigns.some((candidate) => candidate.id === value)) return undefined;
  return { include: [...(await storage.memberIds(itemType, value))] };
}

export async function libraryCampaignsRoutes(app: FastifyInstance) {
  const storage = createLibraryCampaignsStorage(app.db);

  app.get("/campaigns", async (): Promise<LibraryCampaignList> => {
    return { campaigns: await storage.list() };
  });

  app.post("/campaigns/:campaignId/items", async (req, reply) => {
    const { campaignId } = libraryCampaignParamsSchema.parse(req.params);
    const input = libraryCampaignItemsSchema.parse(req.body);
    const ok = await storage.addItems(campaignId, input.itemType, input.itemIds);
    if (!ok) return reply.status(404).send({ error: "Campaign not found" });
    return reply.send({ ok: true });
  });

  app.post("/campaigns/:campaignId/items/remove", async (req, reply) => {
    const { campaignId } = libraryCampaignParamsSchema.parse(req.params);
    const input = libraryCampaignItemsSchema.parse(req.body);
    const ok = await storage.removeItems(campaignId, input.itemType, input.itemIds);
    if (!ok) return reply.status(404).send({ error: "Campaign not found" });
    return reply.send({ ok: true });
  });
}
