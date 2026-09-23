/** Parse a complete decimal draft while accepting either dot or comma separators. */
export function parseGenerationParameterDraft(value: string): number | null {
  const normalized = value.trim().replace(",", ".");
  if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) return null;

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}
