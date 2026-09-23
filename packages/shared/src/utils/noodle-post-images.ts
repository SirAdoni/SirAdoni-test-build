import { noodlePostImageCropSchema } from "../schemas/noodle.schema.js";
import type { NoodlePostImageCrop } from "../types/noodle.js";

export function readNoodlePostImageCrop(
  metadata: Record<string, unknown> | null | undefined,
): NoodlePostImageCrop | null {
  const parsed = noodlePostImageCropSchema.safeParse(metadata?.imageCrop);
  return parsed.success ? parsed.data : null;
}
