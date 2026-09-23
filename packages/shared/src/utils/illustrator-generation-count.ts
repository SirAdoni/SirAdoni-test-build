export const MAX_ILLUSTRATOR_IMAGES_PER_GENERATION = 4;

export function normalizeIllustratorImagesPerGeneration(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 1;
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(MAX_ILLUSTRATOR_IMAGES_PER_GENERATION, Math.trunc(parsed)));
}
