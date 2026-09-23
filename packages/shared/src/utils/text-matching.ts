export function normalizeTextForMatch(value: unknown): string {
  return typeof value === "string" ? value.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/gu, " ") : "";
}

export function includesTextForMatch(value: unknown, query: unknown): boolean {
  const normalizedQuery = normalizeTextForMatch(query);
  if (!normalizedQuery) return true;
  return normalizeTextForMatch(value).includes(normalizedQuery);
}

export function startsWithTextForMatch(value: unknown, query: unknown): boolean {
  const normalizedQuery = normalizeTextForMatch(query);
  if (!normalizedQuery) return true;
  return normalizeTextForMatch(value).startsWith(normalizedQuery);
}
