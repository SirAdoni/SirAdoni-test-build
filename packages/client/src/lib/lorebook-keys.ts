/**
 * Split pasted lorebook activation keys on commas and append only new, non-empty
 * values. Existing key order and the user's pasted order are preserved.
 */
export function appendLorebookActivationKeys(existingKeys: string[], input: string): string[] {
  const seen = new Set(existingKeys);
  const nextKeys = [...existingKeys];

  for (const candidate of input.split(",")) {
    const key = candidate.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    nextKeys.push(key);
  }

  return nextKeys;
}
