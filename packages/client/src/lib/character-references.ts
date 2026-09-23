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
  // Scan with a precomputed name set instead of one giant alternation regex, so
  // long messages against a large library stay linear in the message length.
  const lengths = [...new Set([...names.keys()].map((key) => key.length))].sort((a, b) => b - a);
  const firstChars = new Set([...names.keys()].map((key) => key[0]));
  const wordChar = /[\p{L}\p{N}_]/u;
  const endsWithWordChar = (text: string, index: number) =>
    index > 0 && wordChar.test(String.fromCodePoint(text.codePointAt(index - 1 - (isLowSurrogate(text, index - 1) ? 1 : 0))!));
  const startsWithWordChar = (text: string, index: number) =>
    index < text.length && wordChar.test(String.fromCodePoint(text.codePointAt(index)!));
  let fallback: RegExp | null | undefined;
  const fallbackPattern = () => {
    if (fallback !== undefined) return fallback;
    const keys = [...names.keys()].sort((a, b) => b.length - a.length);
    fallback = keys.length
      ? new RegExp(
          `(?<![\\p{L}\\p{N}_])(${keys.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\p{L}\\p{N}_])`,
          "giu",
        )
      : null;
    return fallback;
  };
  const resolve = (found: string) => names.get(keyFor(found)) ?? names.get(found.toLocaleLowerCase());
  return (text: string): Array<{ text: string; character?: CharacterReference }> => {
    if (!names.size || !text) return [{ text }];
    const result: Array<{ text: string; character?: CharacterReference }> = [];
    let end = 0;
    const push = (index: number, found: string) => {
      if (index > end) result.push({ text: text.slice(end, index) });
      const character = resolve(found);
      result.push({ text: found, ...(character ? { character } : {}) });
      end = index + found.length;
    };
    const lower = text.toLocaleLowerCase();
    if (lower.length !== text.length) {
      // Rare case-mapping that changes string length: keep the exact regex semantics.
      const pattern = fallbackPattern();
      if (!pattern) return [{ text }];
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) push(match.index, match[0]);
    } else {
      for (let index = 0; index < text.length; index++) {
        if (!firstChars.has(lower[index]!) || endsWithWordChar(text, index)) continue;
        for (const length of lengths) {
          const stop = index + length;
          if (stop > text.length || !names.has(lower.slice(index, stop)) || startsWithWordChar(text, stop)) continue;
          push(index, text.slice(index, stop));
          index = stop - 1;
          break;
        }
      }
    }
    if (end < text.length) result.push({ text: text.slice(end) });
    return result.length ? result : [{ text }];
  };
}

function isLowSurrogate(text: string, index: number) {
  const code = text.charCodeAt(index);
  return index > 0 && code >= 0xdc00 && code <= 0xdfff;
}
