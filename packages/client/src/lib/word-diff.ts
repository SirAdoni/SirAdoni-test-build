// Self-contained word-level diff for the Professor Mari "Easy Viewer" (no external diff dependency).
// Produces ordered segments describing how to turn `before` into `after`, so the UI can highlight
// removed text in red and added text in green inline.

export type DiffSegmentType = "equal" | "added" | "removed";

export interface DiffSegment {
  type: DiffSegmentType;
  value: string;
}

// Bound the O(m*n) LCS table so a pathologically large field can never freeze the tab; past this we
// fall back to a whole-value replace (the field still shows, just without intra-text highlighting).
const MAX_DIFF_CELLS = 1_000_000;

/** Split into word and whitespace runs, keeping both so the original text reconstructs exactly. */
function tokenize(text: string): string[] {
  return text.match(/\s+|[^\s]+/g) ?? [];
}

function wholeValueReplace(before: string, after: string): DiffSegment[] {
  const segments: DiffSegment[] = [];
  if (before) segments.push({ type: "removed", value: before });
  if (after) segments.push({ type: "added", value: after });
  return segments;
}

/**
 * Word-level diff via a longest-common-subsequence walk. Returns segments in reading order:
 * `equal` text is unchanged, `removed` text is only in `before`, `added` text is only in `after`.
 * Adjacent segments of the same type are merged so the result renders as few spans as possible.
 */
export function diffWords(before: string, after: string): DiffSegment[] {
  if (before === after) return before ? [{ type: "equal", value: before }] : [];
  const a = tokenize(before);
  const b = tokenize(after);
  const m = a.length;
  const n = b.length;
  if (m === 0 || n === 0 || m * n > MAX_DIFF_CELLS) return wholeValueReplace(before, after);

  // dp[i][j] = LCS length of a[i:] and b[j:].
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const segments: DiffSegment[] = [];
  const push = (type: DiffSegmentType, value: string) => {
    const last = segments[segments.length - 1];
    if (last && last.type === type) last.value += value;
    else segments.push({ type, value });
  };

  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      push("equal", a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push("removed", a[i]);
      i++;
    } else {
      push("added", b[j]);
      j++;
    }
  }
  while (i < m) push("removed", a[i++]);
  while (j < n) push("added", b[j++]);
  return segments;
}
