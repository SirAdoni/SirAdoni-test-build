import { normalizeIllustratorImagesPerGeneration } from "@marinara-engine/shared";

export async function generateIllustratorImageVariants<T>({
  count,
  generate,
  onVariantError,
  onVariantReady,
}: {
  count: unknown;
  generate: (index: number) => Promise<T>;
  onVariantReady?: (result: T, index: number) => Promise<void>;
  onVariantError?: (error: unknown, index: number) => void;
}): Promise<T[]> {
  const variantCount = normalizeIllustratorImagesPerGeneration(count);
  const results: T[] = [];
  let lastError: unknown;

  for (let index = 0; index < variantCount; index += 1) {
    try {
      const result = await generate(index);
      // Persist each completed image before waiting for the next slow variant.
      await onVariantReady?.(result, index);
      results.push(result);
    } catch (error) {
      lastError = error;
      onVariantError?.(error, index);
    }
  }

  if (results.length === 0 && lastError) throw lastError;
  return results;
}
