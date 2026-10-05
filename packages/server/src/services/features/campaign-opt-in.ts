import type { FastifyReply } from "fastify";
import { isFeatureEnabled, onFeatureSettingsChange } from "./feature-settings.js";

/**
 * These feature families are registered by the shared settings schema. This local
 * union keeps the server package independently typeable while the shared/client
 * owner updates that schema in parallel.
 */
export type CampaignOptInFeature =
  | "gameContinuity"
  | "campaignMemory"
  | "campaignIndex"
  | "gameMemoryControls"
  | "campaignMemoryRecall"
  | "sceneTimeline";

const featureEnabled = isFeatureEnabled as (name: CampaignOptInFeature) => boolean;

export function isCampaignOptInEnabled(name: CampaignOptInFeature): boolean {
  return featureEnabled(name);
}

export function isCampaignMemoryRecallEnabled(): boolean {
  return isCampaignOptInEnabled("campaignMemory") && isCampaignOptInEnabled("campaignMemoryRecall");
}

export function wasOptionalMemoryPromptDisabled(args: {
  memoryControlsApplied: boolean;
  campaignMemoryApplied: boolean;
}): boolean {
  return (
    (args.memoryControlsApplied && !isCampaignOptInEnabled("gameMemoryControls")) ||
    (args.campaignMemoryApplied && !isCampaignMemoryRecallEnabled())
  );
}

export class CampaignFeatureDisabledError extends Error {
  readonly code = "FEATURE_DISABLED";
  readonly statusCode = 403;

  constructor(readonly feature: CampaignOptInFeature) {
    super(`FEATURE_DISABLED:${feature}`);
    this.name = "CampaignFeatureDisabledError";
  }
}

export function requireCampaignOptIn(name: CampaignOptInFeature): void {
  if (!isCampaignOptInEnabled(name)) throw new CampaignFeatureDisabledError(name);
}

export function rejectCampaignFeatureWhenDisabled(reply: FastifyReply, name: CampaignOptInFeature): boolean {
  if (isCampaignOptInEnabled(name)) return false;
  reply.status(403).send({
    error: { code: "FEATURE_DISABLED", feature: name, message: "This feature is disabled in Settings." },
  });
  return true;
}

export function sendCampaignFeatureDisabled(reply: FastifyReply, error: unknown): boolean {
  if (!(error instanceof CampaignFeatureDisabledError)) return false;
  reply.status(403).send({
    error: { code: error.code, feature: error.feature, message: "This feature is disabled in Settings." },
  });
  return true;
}

export { onFeatureSettingsChange };
