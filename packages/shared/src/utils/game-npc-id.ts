/**
 * Build the deterministic NPC identity shared by Game metadata, party links,
 * portrait generation, and automatic Character-card creation.
 *
 * Existing ASCII slugs remain unchanged. Names containing non-ASCII text use
 * a percent-encoded name so different Unicode or mixed-script names cannot
 * collapse onto the same ASCII fragment. Long values retain a deterministic
 * hash suffix so they remain within API/storage identity limits.
 */
const MAX_GAME_NPC_ID_LENGTH = 200;

const GAME_NPC_IDENTITY_TITLE_WORDS = new Set([
  "captain",
  "commander",
  "count",
  "countess",
  "doctor",
  "duchess",
  "duke",
  "elder",
  "founder",
  "lady",
  "lord",
  "magister",
  "master",
  "mistress",
  "prince",
  "princess",
  "proctor",
  "professor",
  "saint",
  "sir",
  "steward",
  "warmagus",
]);

const GAME_NPC_RELATIONAL_LABEL_PATTERN =
  /^(?:(?:my|your|his|her|its|our|their)\s+|.+(?:['’]s|s['’])\s+)(?:mother|father|parent|brother|sister|sibling|son|daughter|child|husband|wife|spouse|partner|grandmother|grandfather|grandparent|aunt|uncle|cousin|niece|nephew)$/iu;

const GAME_NPC_GENERIC_IDENTITY_LABELS = new Set([
  "another",
  "anybody",
  "anyone",
  "attendant",
  "bandit",
  "boy",
  "butler",
  "child",
  "clerk",
  "cook",
  "crowd",
  "da",
  "dad",
  "daughter",
  "dinner",
  "driver",
  "everybody",
  "everyone",
  "father",
  "figure",
  "girl",
  "guard",
  "guards",
  "healer",
  "innkeeper",
  "maid",
  "man",
  "merchant",
  "messenger",
  "mom",
  "mother",
  "mum",
  "narrator",
  "nobody",
  "no one",
  "one",
  "other",
  "officer",
  "pa",
  "parent",
  "servant",
  "soldier",
  "someone",
  "somebody",
  "steward",
  "stranger",
  "traveler",
  "traveller",
  "villager",
  "voice",
  "waiter",
  "waitress",
  "woman",
  "worker",
]);

const GAME_NPC_CLAUSE_WORDS = new Set([
  "already",
  "and",
  "are",
  "be",
  "because",
  "been",
  "being",
  "but",
  "did",
  "do",
  "does",
  "had",
  "has",
  "have",
  "he",
  "her",
  "hers",
  "him",
  "his",
  "i",
  "id",
  "if",
  "im",
  "is",
  "it",
  "its",
  "ive",
  "me",
  "mine",
  "my",
  "now",
  "or",
  "our",
  "ours",
  "she",
  "that",
  "their",
  "theirs",
  "them",
  "then",
  "these",
  "they",
  "theyre",
  "theyve",
  "this",
  "those",
  "was",
  "we",
  "were",
  "weve",
  "while",
  "who",
  "whom",
  "whose",
  "unknown",
  "unidentified",
  "unnamed",
  "you",
  "youd",
  "youre",
  "your",
  "yours",
  "youve",
]);

const GAME_NPC_LOWERCASE_NAME_PARTICLES = new Set([
  "al",
  "ap",
  "ben",
  "bin",
  "da",
  "de",
  "del",
  "della",
  "der",
  "di",
  "du",
  "el",
  "hai",
  "ibn",
  "la",
  "le",
  "of",
  "the",
  "van",
  "von",
]);

/** A relationship reference such as "your father" is context, not a character name. */
export function isGameNpcRelationalLabel(value: unknown): boolean {
  return typeof value === "string" && GAME_NPC_RELATIONAL_LABEL_PATTERN.test(value.trim());
}

function gameNpcNameTokenStartsLikeName(token: string, index: number): boolean {
  const trimmed = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}'’.\-]+$/gu, "");
  if (!trimmed) return false;
  const normalized = normalizeGameNpcIdentityName(trimmed);
  if (index > 0 && GAME_NPC_LOWERCASE_NAME_PARTICLES.has(normalized)) return true;
  if (index > 0 && /^(?:al|da|de|del|di|el|hai|ibn|van|von)-\p{Lu}/u.test(trimmed)) return true;
  if (!/[\p{Lu}\p{Ll}]/u.test(trimmed)) return true;
  return /^\p{Lu}/u.test(trimmed);
}

/**
 * Reject prose fragments and unnamed roles before model-extracted narration can
 * become a durable NPC identity. Explicit user/library roster names are not
 * routed through this stricter heuristic.
 */
export function isPlausibleNarrationNpcName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const name = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!name || name.length < 2 || name.length > 120) return false;
  if (/[<>{}\[\]"“”]/u.test(name) || isGameNpcRelationalLabel(name)) return false;

  const normalized = normalizeGameNpcIdentityName(name);
  if (!normalized || GAME_NPC_GENERIC_IDENTITY_LABELS.has(normalized)) return false;
  const normalizedTokens = normalized.split(" ").filter(Boolean);
  if (normalizedTokens.some((token) => GAME_NPC_CLAUSE_WORDS.has(token))) return false;

  const displayTokens = name.split(/\s+/u).filter(Boolean);
  return displayTokens.every(gameNpcNameTokenStartsLikeName);
}

/** Normalize a displayed NPC name for identity and alias comparisons. */
export function normalizeGameNpcIdentityName(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Identity-bearing name tokens with common honorifics and titles removed. */
export function gameNpcIdentityTokens(value: unknown): string[] {
  return normalizeGameNpcIdentityName(value)
    .split(" ")
    .filter((token) => token.length >= 3 && !GAME_NPC_IDENTITY_TITLE_WORDS.has(token));
}

/**
 * Return whether two names could be full/short or title/plain forms of one
 * identity. This is deliberately only a candidate check; callers must still
 * require a unique owner before merging or revealing data.
 */
export function gameNpcNamesCouldBeAliases(left: unknown, right: unknown): boolean {
  const leftName = normalizeGameNpcIdentityName(left);
  const rightName = normalizeGameNpcIdentityName(right);
  if (!leftName || !rightName) return false;
  if (leftName === rightName) return true;

  const leftTokens = gameNpcIdentityTokens(left);
  const rightTokens = gameNpcIdentityTokens(right);
  if (leftTokens.length === 0 || rightTokens.length === 0) return false;
  if (leftTokens.join(" ") === rightTokens.join(" ")) return true;
  if (leftTokens.length === 1 && rightTokens.includes(leftTokens[0]!)) return true;
  if (rightTokens.length === 1 && leftTokens.includes(rightTokens[0]!)) return true;
  return false;
}

/**
 * Resolve a displayed name to exactly one known identity. Exact names win;
 * short forms and title variants are accepted only when one candidate owns
 * the alias. A negative result means missing or ambiguous.
 */
export function findUnambiguousGameNpcNameMatch(name: unknown, candidateNames: readonly string[]): number {
  const normalizedName = normalizeGameNpcIdentityName(name);
  if (!normalizedName) return -1;

  const exactMatches = candidateNames
    .map((candidate, index) => (normalizeGameNpcIdentityName(candidate) === normalizedName ? index : -1))
    .filter((index) => index >= 0);
  if (exactMatches.length > 0) return exactMatches.length === 1 ? exactMatches[0]! : -1;

  const aliasMatches = candidateNames
    .map((candidate, index) => (gameNpcNamesCouldBeAliases(name, candidate) ? index : -1))
    .filter((index) => index >= 0);
  return aliasMatches.length === 1 ? aliasMatches[0]! : -1;
}

function gameNpcIdentityHash(value: string): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193) >>> 0;
    right = Math.imul(right ^ code, 0x85ebca6b) >>> 0;
  }
  return `${left.toString(16).padStart(8, "0")}${right.toString(16).padStart(8, "0")}`;
}

function boundedGameNpcId(slug: string, normalizedName: string): string {
  const candidate = `npc:${slug || "unknown"}`;
  if (candidate.length <= MAX_GAME_NPC_ID_LENGTH) return candidate;
  const suffix = `-${gameNpcIdentityHash(normalizedName)}`;
  const prefixLength = MAX_GAME_NPC_ID_LENGTH - suffix.length;
  const prefix = candidate.slice(0, prefixLength).replace(/-+$/g, "");
  return `${prefix}${suffix}`;
}

export function buildStableGameNpcId(name: string): string {
  const normalized = name.trim().normalize("NFKC").toLowerCase();
  const asciiSlug = normalized.replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  if (/^[\x00-\x7f]*$/.test(normalized)) return boundedGameNpcId(asciiSlug, normalized);

  try {
    const encodedSlug = encodeURIComponent(normalized)
      .toLowerCase()
      .replace(/%/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
    return boundedGameNpcId(encodedSlug, normalized);
  } catch {
    const codePointSlug = Array.from(normalized, (character) => character.codePointAt(0)?.toString(16) ?? "")
      .filter(Boolean)
      .join("-");
    return boundedGameNpcId(codePointSlug, normalized);
  }
}

/**
 * Match a removed/ignored NPC without letting a legacy name fallback erase a
 * different same-named character. Explicit IDs are authoritative; the stable
 * name-derived ID is used only for old records that genuinely have no ID.
 */
export function isIgnoredGameNpcIdentity(
  ignoredNpcIds: ReadonlySet<string>,
  npcId: string | null | undefined,
  name: string,
): boolean {
  const explicitId = npcId?.trim();
  return explicitId ? ignoredNpcIds.has(explicitId) : ignoredNpcIds.has(buildStableGameNpcId(name));
}

/** Resolve the durable campaign identity used by both current and legacy chats. */
export function resolveEffectiveGameId(
  metadataGameId: unknown,
  groupId: string | null | undefined,
  chatId: string,
): string {
  const explicit = typeof metadataGameId === "string" ? metadataGameId.trim() : "";
  return explicit || groupId?.trim() || chatId;
}
