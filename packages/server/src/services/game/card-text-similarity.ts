/**
 * Settings > Features "Session-frozen NPC cards" (gameFreezeNpcCardsPerSession): tell a reworded card text from one
 * whose facts changed, so a rewording is neither saved nor sent to the model again.
 *
 * Two texts are substantively the same when, ignoring case, whitespace and punctuation:
 * - they hold the same words in any order, or
 * - their words overlap almost completely (Dice coefficient over the word multisets), at most one word was swapped
 *   for another, and they carry exactly the same fact words (numbers, capitalized names) and negations. A new name,
 *   age, count, place or "not" is always a change. When in doubt it is a change: the cost is one small delta.
 */

/** Word overlap from which a rewording counts as the same text, when no fact word changed. */
export const CARD_TEXT_SAME_SIMILARITY = 0.9;

const NEGATION_WORDS: ReadonlySet<string> = new Set([
  "not",
  "no",
  "never",
  "none",
  "nor",
  "nothing",
  "without",
  "cannot",
  "t", // the tail of "isn't", "doesn't" once punctuation is removed
  "neither",
  "nobody",
  "former",
  "formerly",
  "ex",
  "dead",
  "alive",
]);

function words(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/u)
    .filter(Boolean);
}

/** Numbers and capitalized words that do not open a sentence or line. */
function factWords(text: string): string[] {
  const facts: string[] = [];
  const numbers: string[] = [];
  for (const sentence of text.normalize("NFKC").split(/(?<=[.!?:;])\s+|\n+/u)) {
    const tokens = sentence.split(/\s+/u).filter(Boolean);
    tokens.forEach((raw, index) => {
      const token = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
      if (!token) return;
      // Numbers count every time (a new "2" is a new fact); names once (a rewording may name someone again).
      if (/\p{N}/u.test(token)) numbers.push(token.toLowerCase());
      else if (index > 0 && /^\p{Lu}/u.test(token)) facts.push(token.toLowerCase());
    });
  }
  return [...[...new Set(facts)].sort(), "|", ...numbers.sort()];
}

function counts(list: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const word of list) map.set(word, (map.get(word) ?? 0) + 1);
  return map;
}

export function isSubstantivelySameText(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = left ?? "";
  const b = right ?? "";
  if (a === b) return true;
  const leftWords = words(a);
  const rightWords = words(b);
  if (leftWords.length === 0 || rightWords.length === 0) return leftWords.length === rightWords.length;
  if (leftWords.slice().sort().join(" ") === rightWords.slice().sort().join(" ")) return true;
  if (factWords(a).join(" ") !== factWords(b).join(" ")) return false;
  // "is loyal" and "is not loyal" overlap almost completely; a changed negation is always a change.
  const negations = (list: string[]) => list.filter((word) => NEGATION_WORDS.has(word)).length;
  if (negations(leftWords) !== negations(rightWords)) return false;
  // At most one new and one lost word (a synonym swap); two new words can already be a new fact ("fears water").
  const leftSet = new Set(leftWords);
  const rightSet = new Set(rightWords);
  const novel = [...rightSet].filter((word) => word.length >= 3 && !leftSet.has(word)).length;
  const lost = [...leftSet].filter((word) => word.length >= 3 && !rightSet.has(word)).length;
  if (novel > 1 || lost > 1) return false;
  const leftCounts = counts(leftWords);
  let shared = 0;
  for (const [word, times] of counts(rightWords)) shared += Math.min(times, leftCounts.get(word) ?? 0);
  return (2 * shared) / (leftWords.length + rightWords.length) >= CARD_TEXT_SAME_SIMILARITY;
}
