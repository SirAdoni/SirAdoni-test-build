import type { CampaignMemoryEntity, CampaignMemoryRelationship, CampaignFactionWeb } from "@marinara-engine/shared";

/** Pure projection: no inferred alliances, reciprocal edges, or duplicate organization registry. */
export function buildCampaignFactionWeb(
  entities: CampaignMemoryEntity[],
  relationships: CampaignMemoryRelationship[],
  entityId: string,
  offset: number,
  limit: number,
  includeEnded: boolean,
): CampaignFactionWeb {
  const organizations = new Map(
    entities.filter((entity) => entity.kind === "organization").map((entity) => [entity.entityId, entity]),
  );
  const links = relationships
    .filter(
      (link) =>
        organizations.has(link.sourceEntityId) &&
        organizations.has(link.targetEntityId) &&
        (link.sourceEntityId === entityId || link.targetEntityId === entityId) &&
        (includeEnded || link.status !== "ended"),
    )
    .sort((a, b) => a.relationshipId.localeCompare(b.relationshipId));
  const items = links.slice(offset, offset + limit);
  const visible = new Set([entityId, ...items.flatMap((link) => [link.sourceEntityId, link.targetEntityId])]);
  return {
    entities: [...organizations.values()].filter((entity) => visible.has(entity.entityId)),
    relationships: { items, total: links.length, offset, limit },
  };
}
