import type { CapabilityCatalogPackage } from "@marinara-engine/shared";

type CapabilityPackageKind = CapabilityCatalogPackage["manifest"]["kind"][number];

const HIDDEN_KIND_BADGES = new Set<CapabilityPackageKind>(["maps", "turn-game"]);

export function isAgentCatalogKindBadgeVisible(kind: CapabilityPackageKind) {
  return !HIDDEN_KIND_BADGES.has(kind);
}
