const SPOTIFY_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "for",
  "from",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

const SPOTIFY_MOOD_EXPANSIONS: Array<[RegExp, string[]]> = [
  [
    /\b(action|battle|boss|chase|combat|danger|duel|fight|war)\b/,
    ["battle", "combat", "fight", "boss", "war", "intense"],
  ],
  [/\b(calm|cozy|gentle|peace|peaceful|rest|safe|soft)\b/, ["calm", "peace", "gentle", "soft", "rest", "serene"]],
  [/\b(dark|dread|fear|horror|ominous|scary|shadow|terror)\b/, ["dark", "ominous", "shadow", "night", "horror"]],
  [/\b(grief|lonely|melancholy|sad|sorrow|tragic|tears)\b/, ["sad", "sorrow", "melancholy", "lament", "lonely"]],
  [/\b(love|romance|romantic|tender|warm)\b/, ["love", "romance", "tender", "heart", "warm"]],
  [/\b(mystery|secret|sneak|stealth|suspense|tense)\b/, ["mystery", "secret", "stealth", "tension", "suspense"]],
  [/\b(epic|heroic|triumph|victory)\b/, ["epic", "hero", "triumph", "victory", "theme"]],
];

export function normalizeSpotifyText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function buildSpotifyCandidateTokens(query: string): string[] {
  const normalized = normalizeSpotifyText(query);
  const tokens = new Set(
    normalized
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 1 && !SPOTIFY_STOP_WORDS.has(token)),
  );

  for (const [pattern, expansions] of SPOTIFY_MOOD_EXPANSIONS) {
    if (pattern.test(normalized)) {
      expansions.forEach((term) => tokens.add(term));
    }
  }

  return Array.from(tokens);
}
