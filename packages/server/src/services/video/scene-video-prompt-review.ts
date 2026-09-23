import { limitSceneVideoPromptForProvider } from "./prompt-context.js";

/** A client-correctable validation error for a reviewed scene-video prompt. */
export class SceneVideoPromptReviewError extends Error {
  constructor(
    readonly statusCode: 400,
    message: string,
  ) {
    super(message);
    this.name = "SceneVideoPromptReviewError";
  }
}

/** Select and provider-limit a generated or reviewed scene-video prompt. */
export function resolveSceneVideoPrompt(args: {
  generatedPrompt: string;
  promptOverride?: string;
  maxPromptLength: number | null;
}): string {
  const generatedPrompt = limitSceneVideoPromptForProvider(args.generatedPrompt, args.maxPromptLength);
  const promptOverride = args.promptOverride?.trim();
  if (promptOverride && args.maxPromptLength && promptOverride.length > args.maxPromptLength) {
    throw new SceneVideoPromptReviewError(
      400,
      `Video prompt must contain at most ${args.maxPromptLength} characters for this provider.`,
    );
  }
  return promptOverride || generatedPrompt;
}
