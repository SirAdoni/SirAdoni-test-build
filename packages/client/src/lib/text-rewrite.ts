export interface TextRewriteSelectionSnapshot {
  start: number;
  end: number;
  sourceText: string;
}

export interface TextRewriteTarget {
  start: number;
  end: number;
  selectedText: string;
  sourceText: string;
  isSelection: boolean;
}

/** Resolve an exact selection, falling back to the whole current draft when it is stale or invalid. */
export function resolveTextRewriteTarget(
  sourceText: string,
  selection: TextRewriteSelectionSnapshot | null,
): TextRewriteTarget {
  const hasValidSelection =
    selection !== null &&
    selection.sourceText === sourceText &&
    Number.isInteger(selection.start) &&
    Number.isInteger(selection.end) &&
    selection.start >= 0 &&
    selection.start < selection.end &&
    selection.end <= sourceText.length;
  const start = hasValidSelection ? selection.start : 0;
  const end = hasValidSelection ? selection.end : sourceText.length;

  return {
    start,
    end,
    selectedText: sourceText.slice(start, end),
    sourceText,
    isSelection: hasValidSelection,
  };
}

/** Apply a reviewed rewrite to the exact occurrence that was sent, or refuse if the draft changed meanwhile. */
export function applyTextRewriteResult(
  currentText: string,
  target: TextRewriteTarget,
  replacement: string,
): string | null {
  if (currentText !== target.sourceText) return null;
  if (currentText.slice(target.start, target.end) !== target.selectedText) return null;
  return currentText.slice(0, target.start) + replacement + currentText.slice(target.end);
}
