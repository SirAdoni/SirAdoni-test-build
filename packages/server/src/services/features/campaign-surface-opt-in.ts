import type { FastifyReply } from "fastify";
import { isFeatureEnabled } from "./feature-settings.js";

export type CampaignSurfaceFeature =
  "campaignMemory" | "campaignWiki" | "familyTree" | "factionWeb" | "gameCalendar" | "worldHistory";

const enabled = isFeatureEnabled as (name: CampaignSurfaceFeature) => boolean;

export function isCampaignSurfaceEnabled(name: CampaignSurfaceFeature): boolean {
  return enabled(name);
}

export class CampaignSurfaceDisabledError extends Error {
  readonly code = "FEATURE_DISABLED";

  constructor(readonly feature: CampaignSurfaceFeature) {
    super(`FEATURE_DISABLED:${feature}`);
    this.name = "CampaignSurfaceDisabledError";
  }
}

export function requireCampaignSurface(...features: CampaignSurfaceFeature[]): void {
  for (const feature of features) {
    if (!isCampaignSurfaceEnabled(feature)) throw new CampaignSurfaceDisabledError(feature);
  }
}

export function rejectCampaignSurfaceWhenDisabled(reply: FastifyReply, ...features: CampaignSurfaceFeature[]): boolean {
  const feature = features.find((item) => !isCampaignSurfaceEnabled(item));
  if (!feature) return false;
  reply.status(403).send({
    error: { code: "FEATURE_DISABLED", feature, message: "This feature is disabled in Settings." },
  });
  return true;
}

export function sendCampaignSurfaceDisabled(reply: FastifyReply, error: unknown): boolean {
  if (!(error instanceof CampaignSurfaceDisabledError)) return false;
  reply.status(403).send({
    error: { code: error.code, feature: error.feature, message: "This feature is disabled in Settings." },
  });
  return true;
}
