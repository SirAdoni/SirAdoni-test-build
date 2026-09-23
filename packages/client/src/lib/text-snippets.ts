// ──────────────────────────────────────────────
// Text snippets: trigger -> expansion helpers (pure, DOM-free)
// ──────────────────────────────────────────────
// Macros such as {{char}} and {{user}} are left in place: the chat input
// resolves them when the message is sent, exactly as if they were typed.
import type { TextSnippet } from "@marinara-engine/shared";

const CURSOR_PLACEHOLDER = /\{\{\s*cursor\s*\}\}/giu;

export interface SnippetEdit {
  /** Replace value.slice(start, end) with `replacement`. */
  start: number;
  end: number;
  replacement: string;
  /** Absolute caret position after the edit. */
  caret: number;
}

/** Removes every {{cursor}} marker and reports where the first one was. */
export function renderSnippetExpansion(expansion: string): { text: string; caretOffset: number } {
  let caretOffset = -1;
  let removed = 0;
  const text = expansion.replace(CURSOR_PLACEHOLDER, (match, offset: number) => {
    if (caretOffset === -1) caretOffset = offset - removed;
    removed += match.length;
    return "";
  });
  return { text, caretOffset: caretOffset === -1 ? text.length : caretOffset };
}

function hasCursorPlaceholder(expansion: string): boolean {
  CURSOR_PLACEHOLDER.lastIndex = 0;
  const found = CURSOR_PLACEHOLDER.test(expansion);
  CURSOR_PLACEHOLDER.lastIndex = 0;
  return found;
}

/** Edit that inserts a snippet over the current selection (used by the picker). */
export function insertSnippetEdit(
  snippet: Pick<TextSnippet, "expansion">,
  selectionStart: number,
  selectionEnd: number,
) {
  const { text, caretOffset } = renderSnippetExpansion(snippet.expansion);
  return {
    start: selectionStart,
    end: selectionEnd,
    replacement: text,
    caret: selectionStart + caretOffset,
  } satisfies SnippetEdit;
}

/**
 * Finds the snippet whose trigger sits right before the caret.
 *
 * - `"space"`: the space was already typed, so it must be at caret - 1 and is
 *   consumed. When the expansion has no {{cursor}}, a trailing space is kept so
 *   typing flows on naturally.
 * - `"tab"`: the trigger ends exactly at the caret; Tab itself is never inserted.
 *
 * A trigger only fires as a whole word: it must start the text or follow whitespace.
 */
export function findSnippetExpansion(
  value: string,
  caret: number,
  snippets: readonly Pick<TextSnippet, "trigger" | "expansion">[],
  delimiter: "space" | "tab",
): SnippetEdit | null {
  if (snippets.length === 0 || caret <= 0 || caret > value.length) return null;
  let wordEnd = caret;
  if (delimiter === "space") {
    if (value[caret - 1] !== " ") return null;
    wordEnd = caret - 1;
  }
  let wordStart = wordEnd;
  while (wordStart > 0 && !/\s/u.test(value[wordStart - 1]!)) wordStart -= 1;
  if (wordStart === wordEnd) return null;
  const word = value.slice(wordStart, wordEnd);
  const snippet = snippets.find((entry) => entry.trigger === word);
  if (!snippet) return null;

  const keepSpace = delimiter === "space" && !hasCursorPlaceholder(snippet.expansion);
  const { text, caretOffset } = renderSnippetExpansion(snippet.expansion);
  const replacement = keepSpace ? `${text} ` : text;
  return {
    start: wordStart,
    end: caret,
    replacement,
    caret: wordStart + (keepSpace ? replacement.length : caretOffset),
  };
}

/** Case-insensitive filter over trigger and expansion text, triggers first. */
export function filterSnippets<T extends Pick<TextSnippet, "trigger" | "expansion">>(
  snippets: readonly T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...snippets];
  const byTrigger: T[] = [];
  const byText: T[] = [];
  for (const snippet of snippets) {
    if (snippet.trigger.toLowerCase().includes(needle)) byTrigger.push(snippet);
    else if (snippet.expansion.toLowerCase().includes(needle)) byText.push(snippet);
  }
  return [...byTrigger, ...byText];
}
