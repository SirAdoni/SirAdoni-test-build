/** Edits made in the full Game prompt editor. Each edit is applied once to the
 * newly assembled request, so live history and campaign state are rebuilt on
 * every turn rather than saved as a stale prompt snapshot. */
export interface GamePromptDirectEdit {
  role: string;
  find: string;
  replace: string;
}

const MAX_EDITS = 128;
const MAX_FIND_LENGTH = 128_000;
const MAX_REPLACE_LENGTH = 128_000;
const MAX_TOTAL_LENGTH = 900_000;

export function parseGamePromptDirectEdits(value: unknown): GamePromptDirectEdit[] | null {
  if (!Array.isArray(value) || value.length > MAX_EDITS) return null;
  const edits: GamePromptDirectEdit[] = [];
  let totalLength = 0;
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const { role, find, replace } = item as Record<string, unknown>;
    if (
      typeof role !== "string" ||
      !/^[a-z_]{3,32}$/.test(role) ||
      typeof find !== "string" ||
      find.length < 3 ||
      find.length > MAX_FIND_LENGTH ||
      typeof replace !== "string" ||
      replace.length > MAX_REPLACE_LENGTH
    )
      return null;
    totalLength += find.length + replace.length;
    if (totalLength > MAX_TOTAL_LENGTH) return null;
    edits.push({ role, find, replace });
  }
  return edits;
}

/** Preserve roles, attachments and provider metadata. A match is deliberately
 * changed only once per edit across the request, even if that phrase later
 * appears in unrelated history. Edits are sequential so a later save can
 * refine text changed by an earlier save. */
export function applyGamePromptDirectEdits<T extends { role: string; content: string }>(
  messages: readonly T[],
  edits: readonly GamePromptDirectEdit[],
): T[] {
  if (edits.length === 0) return [...messages];
  const result = messages.map((message) => ({ ...message }));
  for (const edit of edits) {
    let match: { messageIndex: number; offset: number } | null = null;
    let ambiguous = false;
    for (let messageIndex = 0; messageIndex < result.length; messageIndex += 1) {
      const message = result[messageIndex]!;
      if (message.role !== edit.role) continue;
      const index = message.content.indexOf(edit.find);
      if (index < 0) continue;
      if (match || message.content.indexOf(edit.find, index + 1) >= 0) {
        ambiguous = true;
        break;
      }
      match = { messageIndex, offset: index };
    }
    if (!match || ambiguous) continue;
    const message = result[match.messageIndex]!;
    message.content =
      message.content.slice(0, match.offset) + edit.replace + message.content.slice(match.offset + edit.find.length);
  }
  return result;
}
