/** Per-chat literal edits to app-owned Game prompt instructions. */
export interface GamePromptTextReplacement {
  find: string;
  replace: string;
}

const MAX_RULES = 32;
const MIN_FIND_LENGTH = 3;
const MAX_FIND_LENGTH = 4_000;
const MAX_REPLACEMENT_LENGTH = 12_000;
const MAX_TOTAL_LENGTH = 64_000;

/** Returns null for malformed metadata so the write route can reject it. */
export function parseGamePromptTextReplacements(value: unknown): GamePromptTextReplacement[] | null {
  if (!Array.isArray(value) || value.length > MAX_RULES) return null;
  const seen = new Set<string>();
  const rules: GamePromptTextReplacement[] = [];
  let totalLength = 0;
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const { find, replace } = entry as Record<string, unknown>;
    if (
      typeof find !== "string" ||
      find.length < MIN_FIND_LENGTH ||
      find.length > MAX_FIND_LENGTH ||
      typeof replace !== "string" ||
      replace.length > MAX_REPLACEMENT_LENGTH ||
      seen.has(find)
    )
      return null;
    totalLength += find.length + replace.length;
    if (totalLength > MAX_TOTAL_LENGTH) return null;
    seen.add(find);
    rules.push({ find, replace });
  }
  return rules;
}

export function replaceGamePromptText(content: string, rules: readonly GamePromptTextReplacement[]): string {
  if (rules.length === 0) return content;
  // Search only the original text. A replacement containing another rule's search
  // string must not trigger that rule or compound on a later provider request.
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < content.length) {
    let nextIndex = content.length;
    let nextRule: GamePromptTextReplacement | undefined;
    for (const rule of rules) {
      const index = content.indexOf(rule.find, cursor);
      if (index >= 0 && index < nextIndex) {
        nextIndex = index;
        nextRule = rule;
      }
    }
    if (!nextRule) break;
    parts.push(content.slice(cursor, nextIndex), nextRule.replace);
    cursor = nextIndex + nextRule.find.length;
  }
  if (parts.length === 0) return content;
  parts.push(content.slice(cursor));
  return parts.join("");
}
