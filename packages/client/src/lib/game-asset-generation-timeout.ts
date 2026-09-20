import { normalizeIllustratorImagesPerGeneration } from "@marinara-engine/shared";

const FIRST_IMAGE_TIMEOUT_MS = 240_000;
const EXTRA_IMAGE_TIMEOUT_MS = 180_000;
// Match the server's request deadline. The route accepts up to one background,
// three illustration variants, and ten portraits; its default queued mode can
// render all fourteen serially, which needs 43 minutes under this budget.
const MAX_TIMEOUT_MS = 45 * 60_000;

export type GameAssetGenerationWorkload = {
  backgroundTag?: string;
  illustration?: unknown;
  npcsNeedingAvatars?: readonly unknown[];
};

/**
 * Keep the existing four-minute budget for one image, then allow time for each
 * additional physical render represented by the batch request. One illustration
 * request can expand into several variants through illustratorImagesPerGeneration.
 */
export function gameAssetGenerationTimeoutMs(
  workload: GameAssetGenerationWorkload,
  illustratorImagesPerGeneration: unknown,
): number {
  const imageJobCount =
    (workload.backgroundTag?.trim() ? 1 : 0) +
    (workload.illustration ? normalizeIllustratorImagesPerGeneration(illustratorImagesPerGeneration) : 0) +
    (workload.npcsNeedingAvatars?.length ?? 0);
  const additionalImageJobs = Math.max(0, imageJobCount - 1);
  return Math.min(MAX_TIMEOUT_MS, FIRST_IMAGE_TIMEOUT_MS + additionalImageJobs * EXTRA_IMAGE_TIMEOUT_MS);
}
