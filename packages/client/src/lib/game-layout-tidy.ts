// Pure tidy and align helpers for the Game layout editor. Tidy packs unlocked
// panels into non-overlapping left, centre and right columns, keeping each
// panel's column and vertical order. Locked panels stay put and are obstacles.
import { LAYOUT_PANEL_GAP, rectsOverlap, type LayoutRect } from "./game-layout-geometry";

export interface TidyItem {
  id: string;
  rect: LayoutRect;
  locked: boolean;
  /** Smallest readable height; a panel that does not fit is shortened to at least this and scrolls. */
  minHeight?: number;
}

export interface TidyBounds {
  width: number;
  height: number;
}

export const TIDY_MARGIN = 8;
export const TIDY_MIN_HEIGHT = 120;

export type TidyColumn = "left" | "centre" | "right";

export function tidyColumnOf(rect: LayoutRect, bounds: TidyBounds): TidyColumn {
  const centre = rect.x + rect.width / 2;
  if (centre < bounds.width / 3) return "left";
  if (centre > (bounds.width * 2) / 3) return "right";
  return "centre";
}

function columnX(column: TidyColumn, width: number, bounds: TidyBounds, margin: number): number {
  const x =
    column === "left"
      ? margin
      : column === "right"
        ? bounds.width - margin - width
        : Math.round((bounds.width - width) / 2);
  return Math.max(0, Math.min(x, Math.max(0, bounds.width - width)));
}

function hits(rect: LayoutRect, placed: LayoutRect[], gap: number): boolean {
  return placed.some((other) => rectsOverlap(rect, other, gap));
}

/** Room below `y` at column `x` before the next obstacle or the bottom margin. */
function roomBelow(x: number, y: number, width: number, placed: LayoutRect[], limit: number, gap: number): number {
  let bottom = limit;
  for (const other of placed) {
    if (x >= other.x + other.width + gap || x + width + gap <= other.x) continue;
    if (other.y + other.height + gap <= y) continue;
    if (other.y < y + 1) return 0;
    bottom = Math.min(bottom, other.y - gap);
  }
  return bottom - y;
}

/**
 * Pack unlocked panels. Returns the new rect for every unlocked panel (locked
 * panels are returned unchanged). Widths are kept; heights only shrink when a
 * panel cannot fit, never below its readable minimum.
 */
export function tidyLayout(
  items: TidyItem[],
  bounds: TidyBounds,
  options: { gap?: number; margin?: number } = {},
): Map<string, LayoutRect> {
  const gap = options.gap ?? LAYOUT_PANEL_GAP;
  const margin = options.margin ?? TIDY_MARGIN;
  const result = new Map<string, LayoutRect>();
  const placed: LayoutRect[] = [];
  for (const item of items) {
    if (!item.locked) continue;
    result.set(item.id, { ...item.rect });
    placed.push(item.rect);
  }
  const movable = items
    .filter((item) => !item.locked)
    .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x || a.id.localeCompare(b.id));
  const cursors: Record<TidyColumn, number> = { left: margin, centre: margin, right: margin };
  const limit = bounds.height - margin;
  for (const item of movable) {
    const width = Math.min(item.rect.width, bounds.width);
    const column = tidyColumnOf(item.rect, bounds);
    const minHeight = Math.min(item.rect.height, item.minHeight ?? TIDY_MIN_HEIGHT);
    const tryColumn = (x: number, from: number): LayoutRect | null => {
      const ys = [
        ...new Set([from, ...placed.map((other) => other.y + other.height + gap).filter((y) => y >= from)]),
      ].sort((a, b) => a - b);
      for (const y of ys) {
        const full = { x, y, width, height: item.rect.height };
        if (y + full.height <= limit && !hits(full, placed, gap)) return full;
      }
      for (const y of ys) {
        const room = roomBelow(x, y, width, placed, limit, gap);
        if (room >= minHeight) return { x, y, width, height: Math.min(item.rect.height, room) };
      }
      return null;
    };
    const home = columnX(column, width, bounds, margin);
    let next = tryColumn(home, cursors[column]);
    if (!next) {
      const xs = [
        ...new Set([margin, bounds.width - margin - width, ...placed.map((other) => other.x + other.width + gap)]),
      ]
        .filter((x) => x >= 0 && x + width <= bounds.width)
        .sort((a, b) => Math.abs(a - home) - Math.abs(b - home));
      for (const x of xs) {
        next = tryColumn(x, margin);
        if (next) break;
      }
    }
    // Nowhere left: keep it in its column at the readable minimum (the screen is simply full).
    if (!next) next = { x: home, y: Math.max(0, Math.min(cursors[column], limit - minHeight)), width, height: minHeight };
    if (next.x === home) cursors[column] = next.y + next.height + gap;
    placed.push(next);
    result.set(item.id, next);
  }
  return result;
}

export type AlignMode = "left" | "right" | "top" | "matchWidth";

/** Align two or more selected panels to the first selected one's edge (or its width). Locked panels stay. */
export function alignPanels(
  items: TidyItem[],
  mode: AlignMode,
  bounds: TidyBounds,
  reference?: string,
): Map<string, LayoutRect> {
  const result = new Map<string, LayoutRect>();
  if (items.length < 2) return result;
  const anchor = items.find((item) => item.id === reference) ?? items[0];
  const target =
    mode === "left"
      ? Math.min(...items.map((item) => item.rect.x))
      : mode === "right"
        ? Math.max(...items.map((item) => item.rect.x + item.rect.width))
        : mode === "top"
          ? Math.min(...items.map((item) => item.rect.y))
          : anchor.rect.width;
  for (const item of items) {
    if (item.locked) continue;
    const rect = { ...item.rect };
    if (mode === "left") rect.x = target;
    else if (mode === "right") rect.x = target - rect.width;
    else if (mode === "top") rect.y = target;
    else rect.width = target;
    rect.width = Math.min(rect.width, bounds.width);
    rect.x = Math.max(0, Math.min(rect.x, bounds.width - rect.width));
    rect.y = Math.max(0, Math.min(rect.y, bounds.height - rect.height));
    result.set(item.id, rect);
  }
  return result;
}
