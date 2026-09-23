/** Normalize a displayed or recorded Game Mode choice for stable comparison. */
export function normalizeChoiceText(value: string): string {
  return value
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();
}
