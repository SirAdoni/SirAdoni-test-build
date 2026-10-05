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
} from "@marinara-engine/shared";
import type { DB } from "../db/connection.js";
import {
  createLibraryCampaignsStorage,
  CampaignRosterDisabledError,
} from "../services/storage/library-campaigns.storage.js";
import { isFeatureEnabled } from "../services/features/feature-settings.js";

const CAMPAIGN_ROSTER_DISABLED = {
  error: { code: "FEATURE_DISABLED", feature: "campaignRoster", message: "Campaign roster is disabled" },
};

function campaignRosterEnabled() {
  return isFeatureEnabled("campaignRoster");
}

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
  if (!campaignRosterEnabled()) return undefined;
  const value = campaign?.trim();
  if (!value) return undefined;
  const storage = createLibraryCampaignsStorage(db);
  if (value === LIBRARY_CAMPAIGN_NONE) {
    const ids = await storage.memberIds(itemType, null);
    return campaignRosterEnabled() ? { exclude: [...ids] } : undefined;
  }
  const campaigns = await storage.list();
  if (!campaignRosterEnabled() || !campaigns.some((candidate) => candidate.id === value)) return undefined;
  const ids = await storage.memberIds(itemType, value);
  return campaignRosterEnabled() ? { include: [...ids] } : undefined;
}

export async function libraryCampaignsRoutes(app: FastifyInstance) {
  const storage = createLibraryCampaignsStorage(app.db);

  app.get("/campaigns", async (_req, reply) => {
    if (!campaignRosterEnabled()) return reply.status(403).send(CAMPAIGN_ROSTER_DISABLED);
    const campaigns = await storage.list();
    if (!campaignRosterEnabled()) return reply.status(403).send(CAMPAIGN_ROSTER_DISABLED);
    return { campaigns };
  });

  app.post("/campaigns/:campaignId/items", async (req, reply) => {
    if (!campaignRosterEnabled()) return reply.status(403).send(CAMPAIGN_ROSTER_DISABLED);
    const { campaignId } = libraryCampaignParamsSchema.parse(req.params);
    const input = libraryCampaignItemsSchema.parse(req.body);
    try {
      const ok = await storage.addItems(campaignId, input.itemType, input.itemIds);
      if (!ok) return reply.status(404).send({ error: "Campaign not found" });
      return reply.send({ ok: true });
    } catch (error) {
      if (error instanceof CampaignRosterDisabledError) return reply.status(403).send(CAMPAIGN_ROSTER_DISABLED);
      throw error;
    }
  });

  app.post("/campaigns/:campaignId/items/remove", async (req, reply) => {
    if (!campaignRosterEnabled()) return reply.status(403).send(CAMPAIGN_ROSTER_DISABLED);
    const { campaignId } = libraryCampaignParamsSchema.parse(req.params);
    const input = libraryCampaignItemsSchema.parse(req.body);
    try {
      const ok = await storage.removeItems(campaignId, input.itemType, input.itemIds);
      if (!ok) return reply.status(404).send({ error: "Campaign not found" });
      return reply.send({ ok: true });
    } catch (error) {
      if (error instanceof CampaignRosterDisabledError) return reply.status(403).send(CAMPAIGN_ROSTER_DISABLED);
      throw error;
    }
  });
}
