const NAME_STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "il",
  "la",
  "le",
  "el",
  "los",
  "las",
  "de",
  "del",
  "della",
  "da",
  "di",
  "du",
  "der",
  "van",
  "von",
]);

function normalizeCharacterName(name: string): string {
  return (
    name
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase()
      // Keep letters/numbers from any script (plus combining marks so e.g. the
      // katakana voiced-sound mark survives) instead of ASCII-only [a-z0-9].
      // ASCII-only normalization collapsed non-Latin names (Japanese, Cyrillic,
      // etc.) to an empty string, so speaker lookups for those names always failed.
      .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
      .trim()
  );
}

function getCharacterNameTokens(name: string): string[] {
  const normalized = normalizeCharacterName(name);
  if (!normalized) return [];
  return normalized
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .filter((token) => token.length > 2 || /\d/.test(token))
    .filter((token) => !NAME_STOP_WORDS.has(token));
}

function buildCharacterNameVariants(name: string): string[] {
  const normalized = normalizeCharacterName(name);
  if (!normalized) return [];

  const variants = new Set<string>([normalized]);
  const tokens = getCharacterNameTokens(name);
  if (tokens.length > 0) {
    variants.add(tokens.join(" "));
    for (const token of tokens) {
      variants.add(token);
    }
  }

  return [...variants];
}

function includesWholeVariant(left: string, right: string): boolean {
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  if (shorter.length < 3) return false;
  return ` ${longer} `.includes(` ${shorter} `);
}

function isSubsetMatch(leftTokens: string[], rightTokens: string[]): boolean {
  if (leftTokens.length === 0 || rightTokens.length === 0) return false;
  const smaller = leftTokens.length <= rightTokens.length ? leftTokens : rightTokens;
  const larger = leftTokens.length <= rightTokens.length ? rightTokens : leftTokens;
  return smaller.every((token) => larger.includes(token));
}

export function characterNamesMatch(leftName: string, rightName: string): boolean {
  const leftVariants = buildCharacterNameVariants(leftName);
  const rightVariants = buildCharacterNameVariants(rightName);
  if (leftVariants.length === 0 || rightVariants.length === 0) return false;

  const rightVariantSet = new Set(rightVariants);
  if (leftVariants.some((variant) => rightVariantSet.has(variant))) {
    return true;
  }

  for (const leftVariant of leftVariants) {
    for (const rightVariant of rightVariants) {
      if (includesWholeVariant(leftVariant, rightVariant)) {
        return true;
      }
    }
  }

  return isSubsetMatch(getCharacterNameTokens(leftName), getCharacterNameTokens(rightName));
}

export function findNamedEntry<T>(
  entries: Iterable<T>,
  targetName: string,
  getName: (entry: T) => string | null | undefined,
): T | undefined {
  const normalizedTarget = normalizeCharacterName(targetName);
  if (!normalizedTarget) return undefined;

  const allEntries = [...entries];

  const exact = allEntries.find((entry) => normalizeCharacterName(getName(entry) ?? "") === normalizedTarget);
  if (exact) return exact;

  const variantExact = allEntries.find((entry) => characterNamesMatch(getName(entry) ?? "", targetName));
  if (variantExact) return variantExact;

  return undefined;
}

export function findNamedMapValue<T>(map: Map<string, T>, targetName: string): T | undefined {
  const entry = findNamedEntry(map.entries(), targetName, ([name]) => name);
  return entry?.[1];
}

/**
 * Resolve a display name without guessing between equally plausible identities.
 * Exact names win; otherwise prefer the complete queried name inside a longer
 * canonical title (for example, "Wynne Brack" -> "Dame Wynne Brack") over
 * a shorter alias ("Wynne").
 */
export function findBestNamedEntry<T>(
  entries: Iterable<T>,
  targetName: string,
  getName: (entry: T) => string | null | undefined,
  getIdentity: (entry: T) => string | null | undefined = () => null,
): T | undefined {
  const target = normalizeCharacterName(targetName);
  const targetTokens = target.split(/\s+/).filter(Boolean);
  if (!target || targetTokens.length === 0) return undefined;

  const scored = [...entries]
    .map((entry) => {
      const name = normalizeCharacterName(getName(entry) ?? "");
      const tokens = name.split(/\s+/).filter(Boolean);
      if (!name || tokens.length === 0) return null;
      if (name === target) return { entry, score: [3, tokens.length, name.length] as const };

      const targetInsideCandidate =
        name.includes(` ${target} `) || name.startsWith(`${target} `) || name.endsWith(` ${target}`);
      if (targetInsideCandidate) {
        return { entry, score: [2, targetTokens.length, target.length] as const };
      }

      const candidateInsideTarget =
        target.includes(` ${name} `) || target.startsWith(`${name} `) || target.endsWith(` ${name}`);
      if (candidateInsideTarget) {
        return { entry, score: [1, tokens.length, name.length] as const };
      }
      return null;
    })
    .filter((item) => item !== null);

  if (scored.length === 0) return undefined;
  scored.sort((left, right) => {
    for (let index = 0; index < left.score.length; index += 1) {
      const difference = right.score[index] - left.score[index];
      if (difference !== 0) return difference;
    }
    return 0;
  });

  const best = scored[0]!;
  const ties = scored.filter((item) => item.score.every((value, index) => value === best.score[index]));
  if (ties.length === 1) return best.entry;

  const identities = ties.map((item) => getIdentity(item.entry)?.trim() ?? "");
  return identities.every((identity) => identity && identity === identities[0]) ? ties[0]!.entry : undefined;
}
