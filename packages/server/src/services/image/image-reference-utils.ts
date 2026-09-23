export function imageReferencePayloadKey(reference: string): string {
  return reference
    .trim()
    .replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "")
    .replace(/\s+/g, "")
    .replace(/=+$/, "");
}

export function dedupeImageReferences(references: Iterable<string>): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const reference of references) {
    const key = imageReferencePayloadKey(reference);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(reference);
  }
  return unique;
}
