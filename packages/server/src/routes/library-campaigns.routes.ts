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

/** Most ids one `ids=` list query may name; the client asks in slices. */
export const LIBRARY_IDS_QUERY_MAX = 100;

/** Parse a comma-separated `ids` query value; undefined when absent or empty. */
export function parseCatalogIdsQuery(value: unknown): string[] | undefined {
  if (typeof value !== "string") return undefined;
  const ids = Array.from(new Set(value.split(",").map((id) => id.trim()))).filter(
    (id) => id.length > 0 && id.length <= 256,
  );
  return ids.length > 0 ? ids.slice(0, LIBRARY_IDS_QUERY_MAX) : undefined;
}

/** Narrow an id filter (a campaign filter or none) to `only`, keeping its exclusions. */
export function restrictLibraryIdFilter(
  filter: LibraryCampaignIdFilter | undefined,
  only: string[] | undefined,
): LibraryCampaignIdFilter | undefined {
  if (!only) return filter;
  if (!filter?.include) return { ...filter, include: only };
  const allowed = new Set(filter.include);
  return { ...filter, include: only.filter((id) => allowed.has(id)) };
}

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
