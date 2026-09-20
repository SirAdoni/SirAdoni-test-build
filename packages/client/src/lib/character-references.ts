import { gameNpcIdentityTokens, normalizeGameNpcIdentityName } from "@marinara-engine/shared";

export interface CharacterReference {
  id: string;
  name: string;
  aliases?: string[];
  avatarUrl?: string | null;
}

/** Longest whole-name match wins. An ambiguous name is never assigned arbitrarily. */
export function createCharacterMatcher(characters: CharacterReference[]) {
  const names = new Map<string, CharacterReference | null>();
  const exact = new Set<string>();
  const keyFor = (name: string) => normalizeGameNpcIdentityName(name);
  const keysFor = (name: string) => {
    const raw = name.trim().toLocaleLowerCase();
    const normalized = keyFor(name);
    return raw && raw !== normalized ? [raw, normalized] : [normalized];
  };
  const addExact = (name: string, character: CharacterReference) => {
    for (const key of keysFor(name)) {
      if (!key) continue;
      exact.add(key);
      if (!names.has(key)) names.set(key, character);
      else if (names.get(key)?.id !== character.id) names.set(key, null);
    }
  };
  const addAlias = (name: string, character: CharacterReference) => {
    for (const key of keysFor(name)) {
      if (!key || exact.has(key) || key.length < 2) continue;
      if (!names.has(key)) names.set(key, character);
      else if (names.get(key)?.id !== character.id) names.set(key, null);
    }
  };
  for (const character of characters) {
    addExact(character.name, character);
  }
  for (const character of characters) {
    for (const name of [character.name, ...(character.aliases ?? [])]) {
      if (name !== character.name) addAlias(name, character);
      const normalized = normalizeGameNpcIdentityName(name);
      const identityTokens = gameNpcIdentityTokens(name);
      const allTokens = normalized.split(" ");
      const first = identityTokens[0];
      if (first && first.length >= 3) addAlias(first, character);
      // Strip only a leading title when a multi-word identity remains.
      if (
        identityTokens.length >= 2 &&
        allTokens.length > identityTokens.length &&
        allTokens.slice(-identityTokens.length).join(" ") === identityTokens.join(" ")
      ) {
        addAlias(identityTokens.join(" "), character);
      }
    }
  }
  const keys = [...names.keys()].sort((a, b) => b.length - a.length);
  const pattern = keys.length
    ? new RegExp(
        `(?<![\\p{L}\\p{N}_])(${keys.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\p{L}\\p{N}_])`,
        "giu",
      )
    : null;
  return (text: string): Array<{ text: string; character?: CharacterReference }> => {
    if (!pattern) return [{ text }];
    pattern.lastIndex = 0;
    const result: Array<{ text: string; character?: CharacterReference }> = [];
    let end = 0;
    for (const match of text.matchAll(pattern)) {
      if (match.index > end) result.push({ text: text.slice(end, match.index) });
      const character = names.get(keyFor(match[0])) ?? names.get(match[0].toLocaleLowerCase());
      result.push({ text: match[0], ...(character ? { character } : {}) });
      end = match.index + match[0].length;
    }
    if (end < text.length) result.push({ text: text.slice(end) });
    return result;
  };
}
