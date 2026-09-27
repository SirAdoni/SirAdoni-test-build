export interface GamePromptDirectEdit {
  role: string;
  find: string;
  replace: string;
}

/** Mirror the server's unique-match rule for a truthful editor preview before
 * another turn has been generated and cached. */
export function previewGamePromptDirectEdits<T extends { role: string; content: string }>(
  messages: readonly T[],
  edits: readonly GamePromptDirectEdit[],
): T[] {
  const result = messages.map((message) => ({ ...message }));
  for (const edit of edits) {
    let match: { messageIndex: number; offset: number } | null = null;
    let ambiguous = false;
    for (let messageIndex = 0; messageIndex < result.length; messageIndex += 1) {
      const message = result[messageIndex]!;
      if (message.role !== edit.role) continue;
      const offset = message.content.indexOf(edit.find);
      if (offset < 0) continue;
      if (match || message.content.indexOf(edit.find, offset + 1) >= 0) {
        ambiguous = true;
        break;
      }
      match = { messageIndex, offset };
    }
    if (!match || ambiguous) continue;
    const message = result[match.messageIndex]!;
    message.content =
      message.content.slice(0, match.offset) + edit.replace + message.content.slice(match.offset + edit.find.length);
  }
  return result;
}

interface PromptTextMessage {
  role: string;
  content: string;
}

const MAX_EDIT_COUNT = 128;
const MAX_FIND_LENGTH = 128_000;
const MAX_REPLACE_LENGTH = 128_000;
const MAX_TOTAL_LENGTH = 900_000;

function countOccurrences(messages: readonly PromptTextMessage[], role: string, needle: string): number {
  let count = 0;
  for (const message of messages) {
    if (message.role !== role) continue;
    let offset = 0;
    while ((offset = message.content.indexOf(needle, offset)) >= 0) {
      count += 1;
      if (count > 1) return count;
      offset += 1;
    }
  }
  return count;
}

function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Stable, unique unchanged lines bound separate edits in a long prompt. */
function uniqueLineAnchors(before: readonly string[], after: readonly string[]): Array<[number, number]> {
  const positions = new Map<string, number>();
  const counts = new Map<string, number>();
  before.forEach((line, index) => {
    positions.set(line, index);
    counts.set(line, (counts.get(line) ?? 0) + 1);
  });
  const afterCounts = new Map<string, number>();
  after.forEach((line) => afterCounts.set(line, (afterCounts.get(line) ?? 0) + 1));
  const candidates: Array<[number, number]> = [];
  after.forEach((line, index) => {
    if (counts.get(line) === 1 && afterCounts.get(line) === 1) candidates.push([positions.get(line)!, index]);
  });

  const tails: number[] = [];
  const predecessors: number[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const originalIndex = candidates[index]![0];
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (candidates[tails[middle]!]![0] < originalIndex) low = middle + 1;
      else high = middle;
    }
    predecessors[index] = low > 0 ? tails[low - 1]! : -1;
    tails[low] = index;
  }
  const anchors: Array<[number, number]> = [];
  let cursor = tails.at(-1) ?? -1;
  while (cursor >= 0) {
    anchors.push(candidates[cursor]!);
    cursor = predecessors[cursor]!;
  }
  return anchors.reverse();
}

function makeEdit(
  role: string,
  original: string,
  changed: string,
  start: number,
  end: number,
  changedStart: number,
  changedEnd: number,
  allMessages: readonly PromptTextMessage[],
): GamePromptDirectEdit | null {
  let before = original.slice(start, end);
  let after = changed.slice(changedStart, changedEnd);
  if (before === after) return null;
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  start += prefix;
  before = before.slice(prefix);
  after = after.slice(prefix);
  let suffix = 0;
  while (
    suffix < before.length &&
    suffix < after.length &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix += 1;
  if (suffix) {
    end -= suffix;
    before = before.slice(0, -suffix);
    after = after.slice(0, -suffix);
  }
  let left = start;
  let right = end;
  let find = before;
  let replace = after;
  // Insertions and short/repeated phrases need unchanged surrounding text, or
  // they could silently modify a different occurrence in the request.
  while ((find.length < 3 || countOccurrences(allMessages, role, find) !== 1) && find.length < MAX_FIND_LENGTH) {
    const previousLeft = left;
    const previousRight = right;
    left = Math.max(0, left - 32);
    right = Math.min(original.length, right + 32);
    if (previousLeft === left && previousRight === right) break;
    find = original.slice(left, right);
    replace = original.slice(left, start) + after + original.slice(end, right);
  }
  if (
    find.length < 3 ||
    find.length > MAX_FIND_LENGTH ||
    replace.length > MAX_REPLACE_LENGTH ||
    countOccurrences(allMessages, role, find) !== 1
  )
    throw new Error("GAME_PROMPT_EDIT_AMBIGUOUS");
  return { role, find, replace };
}

export function createGamePromptDirectEdits(
  originalMessages: readonly PromptTextMessage[],
  changedMessages: readonly PromptTextMessage[],
): GamePromptDirectEdit[] {
  if (originalMessages.length !== changedMessages.length) throw new Error("GAME_PROMPT_EDIT_STALE");
  if (originalMessages.some((message, index) => message.role !== changedMessages[index]!.role)) {
    throw new Error("GAME_PROMPT_EDIT_STALE");
  }
  const edits: GamePromptDirectEdit[] = [];
  originalMessages.forEach((message, messageIndex) => {
    const changed = changedMessages[messageIndex]!.content;
    if (message.content === changed) return;
    const beforeLines = splitLines(message.content);
    const afterLines = splitLines(changed);
    const anchors = uniqueLineAnchors(beforeLines, afterLines);
    const beforeOffsets = [0];
    const afterOffsets = [0];
    beforeLines.forEach((line) => beforeOffsets.push(beforeOffsets.at(-1)! + line.length));
    afterLines.forEach((line) => afterOffsets.push(afterOffsets.at(-1)! + line.length));
    let beforeCursor = 0;
    let afterCursor = 0;
    for (const [beforeIndex, afterIndex] of [...anchors, [beforeLines.length, afterLines.length] as [number, number]]) {
      const edit = makeEdit(
        message.role,
        message.content,
        changed,
        beforeOffsets[beforeCursor]!,
        beforeOffsets[beforeIndex]!,
        afterOffsets[afterCursor]!,
        afterOffsets[afterIndex]!,
        originalMessages,
      );
      if (edit) edits.push(edit);
      beforeCursor = beforeIndex + 1;
      afterCursor = afterIndex + 1;
    }
  });
  if (
    edits.length > MAX_EDIT_COUNT ||
    edits.reduce((size, edit) => size + edit.find.length + edit.replace.length, 0) > MAX_TOTAL_LENGTH
  ) {
    throw new Error("GAME_PROMPT_EDIT_TOO_MANY");
  }
  const applied = previewGamePromptDirectEdits(originalMessages, edits);
  if (applied.some((message, index) => message.content !== changedMessages[index]!.content)) {
    throw new Error("GAME_PROMPT_EDIT_AMBIGUOUS");
  }
  return edits;
}
