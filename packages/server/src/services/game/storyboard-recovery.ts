import { setTimeout as delay } from "node:timers/promises";
import { logger } from "../../lib/logger.js";
import {
  buildSceneIllustrationProviderPrompt,
  type SceneIllustrationGenRequest,
  type SceneIllustrationPromptBudgetRepair,
} from "./game-asset-generation.js";
import { timeStoryboardStage } from "./storyboard-progress.js";

/** Publish a replacement scene only after the fully assembled request passes validation. */
export async function prepareStoryboardFrameImagePrompt(
  request: SceneIllustrationGenRequest,
  repair: SceneIllustrationPromptBudgetRepair,
) {
  let repairedScene: string | undefined;
  const compiled = await buildSceneIllustrationProviderPrompt({
    ...request,
    repairPromptBudget: async (args) => {
      repairedScene = await repair(args);
      return repairedScene;
    },
  });
  return { compiled, repairedScene: repairedScene?.trim() };
}

/** Retry only an explicit temporary image-service failure, never a whole frame/gallery save. */
export async function withStoryboardImageRetry<T>(
  action: () => Promise<T>,
  signal: AbortSignal,
  allowRetry: boolean,
): Promise<T> {
  signal.throwIfAborted();
  try {
    return await action();
  } catch (error) {
    signal.throwIfAborted();
    // Transport loss is ambiguous: the provider may already have generated an image.
    // Quota/auth/content errors and a configured fallback chain must not loop either.
    if (
      !allowRetry ||
      !(error instanceof Error) ||
      !/image generation failed \((?:502|503|504)\)/iu.test(error.message)
    )
      throw error;
    logger.warn(error, "[game/storyboard] Temporary image service failure; retrying this image once");
    return timeStoryboardStage("Retry image request", async () => {
      await delay(1500, undefined, { signal });
      signal.throwIfAborted();
      return action();
    });
  }
}
