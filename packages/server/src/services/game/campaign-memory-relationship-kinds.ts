import type { CampaignMemoryEntityKind } from "@marinara-engine/shared";

/**
 * Allowed endpoint kinds per relationship type. Types are matched case-insensitively
 * after trimming. Unknown types fall back to DEFAULT_ENDPOINTS. Personal types never
 * accept a location, item, quest, or note as the source.
 */
export interface CampaignMemoryRelationshipEndpointKinds {
  source: readonly CampaignMemoryEntityKind[];
  target: readonly CampaignMemoryEntityKind[];
}

const PERSON: readonly CampaignMemoryEntityKind[] = ["character", "persona"];
const PERSON_OR_GROUP: readonly CampaignMemoryEntityKind[] = [...PERSON, "organization"];
const DEFAULT_ENDPOINTS: CampaignMemoryRelationshipEndpointKinds = {
  source: [...PERSON, "location", "lore"],
  target: [...PERSON, "location", "lore"],
};
const PERSONAL: CampaignMemoryRelationshipEndpointKinds = { source: PERSON, target: PERSON };
const AFFILIATION: CampaignMemoryRelationshipEndpointKinds = { source: PERSON_OR_GROUP, target: PERSON_OR_GROUP };

const ENDPOINT_KINDS: Readonly<Record<string, CampaignMemoryRelationshipEndpointKinds>> = {
  "friend-of": PERSONAL,
  "enemy-of": PERSONAL,
  "rival-of": PERSONAL,
  loves: PERSONAL,
  hates: PERSONAL,
  trusts: PERSONAL,
  distrusts: PERSONAL,
  knows: PERSONAL,
  "parent-of": PERSONAL,
  "child-of": PERSONAL,
  "sibling-of": PERSONAL,
  "spouse-of": PERSONAL,
  "mentor-of": PERSONAL,
  "student-of": PERSONAL,
  "allied-with": AFFILIATION,
  "member-of": { source: PERSON, target: ["organization"] },
  leads: { source: PERSON, target: ["organization"] },
  serves: { source: PERSON, target: PERSON_OR_GROUP },
  employs: { source: PERSON_OR_GROUP, target: PERSON },
  owns: { source: PERSON_OR_GROUP, target: ["item", "location"] },
  "located-in": { source: [...PERSON_OR_GROUP, "item", "location"], target: ["location"] },
  visits: { source: PERSON, target: ["location"] },
  "part-of": {
    source: ["location", "organization", "quest", "lore"],
    target: ["location", "organization", "quest", "lore"],
  },
};

export function campaignMemoryRelationshipEndpointKinds(type: string): CampaignMemoryRelationshipEndpointKinds {
  return ENDPOINT_KINDS[type.trim().toLowerCase()] ?? DEFAULT_ENDPOINTS;
}

/** Returns the rejection message for a source/target kind pair, or null when the pair is allowed. */
export function campaignMemoryRelationshipKindError(
  type: string,
  sourceKind: CampaignMemoryEntityKind,
  targetKind: CampaignMemoryEntityKind,
): string | null {
  const allowed = campaignMemoryRelationshipEndpointKinds(type);
  if (!allowed.source.includes(sourceKind)) return `Relationship type ${type} cannot start from a ${sourceKind}`;
  if (!allowed.target.includes(targetKind)) return `Relationship type ${type} cannot point at a ${targetKind}`;
  return null;
}
