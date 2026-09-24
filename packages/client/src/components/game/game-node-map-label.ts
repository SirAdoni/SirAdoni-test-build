// Node map tooltip label: the full place name, wrapped onto as many lines as it needs instead of an
// ellipsis, so a long name stays readable on the legacy node map (hover on desktop, first tap on touch).

/** Characters that fit on one tooltip line at the tooltip's font size and width. */
export const NODE_LABEL_LINE_CHARS = 14;

/** Word-wrap a label into lines of at most `maxChars`, hard-splitting any single word that is longer. */
export function wrapNodeLabel(label: string, maxChars = NODE_LABEL_LINE_CHARS): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of label.trim().split(/\s+/).filter(Boolean)) {
    const chars = Array.from(word);
    if (chars.length > maxChars) {
      if (line) lines.push(line);
      line = "";
      for (let index = 0; index < chars.length; index += maxChars) {
        const piece = chars.slice(index, index + maxChars).join("");
        if (index + maxChars < chars.length) lines.push(piece);
        else line = piece;
      }
      continue;
    }
    const next = line ? `${line} ${word}` : word;
    if (Array.from(next).length > maxChars) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

export interface NodeLabelBox {
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  /** Baseline of each line, top to bottom. */
  baselines: number[];
}

/**
 * Place the tooltip above the node, or below it when the grown box would leave the top of the view,
 * and keep it inside the view horizontally.
 */
export function layoutNodeLabel(
  node: { x: number; y: number },
  lineCount: number,
  scale: number,
  view: { minX: number; minY: number; width: number; height: number },
): NodeLabelBox {
  const width = 80 * scale;
  const lineHeight = 9 * scale;
  const height = 16 * scale + Math.max(0, lineCount - 1) * lineHeight;
  const aboveTop = node.y - 16 * scale - height;
  const y = aboveTop >= view.minY ? aboveTop : node.y + 18 * scale;
  const half = width / 2;
  const centerX = Math.min(Math.max(node.x, view.minX + half), view.minX + view.width - half);
  const baselines = Array.from({ length: Math.max(1, lineCount) }, (_, index) => y + 10 * scale + index * lineHeight);
  return { x: centerX - half, y, width, height, centerX, baselines };
}
