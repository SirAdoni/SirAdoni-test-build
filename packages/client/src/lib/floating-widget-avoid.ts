// Placement math for the collapsed floating music bubbles (YouTube, custom music, Spotify).
// Pure functions only, so scripts/regressions can exercise them without a DOM.

/** Elements carrying this attribute are kept clear of the collapsed floating bubbles. */
export const FLOATING_WIDGET_AVOID_ATTRIBUTE = "data-floating-widget-avoid";
export const FLOATING_WIDGET_AVOID_SELECTOR = `[${FLOATING_WIDGET_AVOID_ATTRIBUTE}]`;

export interface FloatingWidgetRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface FloatingWidgetPlacementInput {
  /** Requested top-left corner (the user's stored or dragged position). */
  x: number;
  y: number;
  /** The collapsed bubble is a square of this edge length. */
  size: number;
  /** Visible viewport origin in fixed-layer CSS coordinates; defaults to the layout origin. */
  viewportLeft?: number;
  viewportTop?: number;
  viewportWidth: number;
  viewportHeight: number;
  /** Minimum distance from every viewport edge. */
  padding: number;
  /** Extra space kept free at the bottom (for the chat composer). */
  bottomReserve?: number;
  /** Rects the bubble must not overlap. */
  obstacles?: readonly FloatingWidgetRect[];
  /** Clearance kept between the bubble and an obstacle. */
  gap?: number;
}

export interface FloatingWidgetPlacement {
  x: number;
  y: number;
  /** True when the requested spot overlapped an obstacle and the bubble was moved. */
  moved: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function overlaps(x: number, y: number, size: number, rect: FloatingWidgetRect, gap: number): boolean {
  return x < rect.right + gap && x + size > rect.left - gap && y < rect.bottom + gap && y + size > rect.top - gap;
}

function isFree(x: number, y: number, size: number, obstacles: readonly FloatingWidgetRect[], gap: number): boolean {
  return obstacles.every((rect) => !overlaps(x, y, size, rect, gap));
}

/** Clamp the bubble inside the viewport, above the bottom reserve when there is room for it. */
export function clampFloatingWidgetPosition(input: FloatingWidgetPlacementInput): { x: number; y: number } {
  const { size, viewportWidth, viewportHeight, padding } = input;
  const viewportLeft = input.viewportLeft ?? 0;
  const viewportTop = input.viewportTop ?? 0;
  const minX = viewportLeft + padding;
  const minY = viewportTop + padding;
  const maxX = Math.max(minX, viewportLeft + viewportWidth - size - padding);
  const maxY = Math.max(minY, viewportTop + viewportHeight - size - Math.max(padding, input.bottomReserve ?? padding));
  return { x: clamp(input.x, minX, maxX), y: clamp(input.y, minY, maxY) };
}

/** Nearest free top along one vertical column, or null when the column is fully blocked. */
function nearestFreeY(
  x: number,
  preferredY: number,
  minY: number,
  maxY: number,
  size: number,
  obstacles: readonly FloatingWidgetRect[],
  gap: number,
): number | null {
  // Only obstacle edges and the column bounds can be the nearest free spot, so test just those.
  const candidates = new Set<number>([preferredY, minY, maxY]);
  for (const rect of obstacles) {
    candidates.add(rect.bottom + gap);
    candidates.add(rect.top - gap - size);
  }
  let best: number | null = null;
  for (const raw of candidates) {
    if (raw < minY || raw > maxY) continue;
    if (!isFree(x, raw, size, obstacles, gap)) continue;
    if (best === null || Math.abs(raw - preferredY) < Math.abs(best - preferredY)) best = raw;
  }
  return best;
}

/**
 * Where the collapsed bubble should render. A position that is already free is returned
 * unchanged (only viewport-clamped), so a spot the user dragged to is respected. When it
 * overlaps an obstacle, the bubble goes to the nearest free spot along the right edge,
 * else along the left edge; with no free spot it keeps the clamped position.
 */
export function placeFloatingWidget(input: FloatingWidgetPlacementInput): FloatingWidgetPlacement {
  const clamped = clampFloatingWidgetPosition(input);
  const obstacles = input.obstacles ?? [];
  const gap = input.gap ?? 4;
  const { size, viewportWidth, viewportHeight, padding } = input;
  const viewportLeft = input.viewportLeft ?? 0;
  const viewportTop = input.viewportTop ?? 0;
  if (isFree(clamped.x, clamped.y, size, obstacles, gap)) return { ...clamped, moved: false };

  const minY = viewportTop + padding;
  const maxY = Math.max(minY, viewportTop + viewportHeight - size - Math.max(padding, input.bottomReserve ?? padding));
  const leftX = viewportLeft + padding;
  const rightX = Math.max(leftX, viewportLeft + viewportWidth - size - padding);
  for (const columnX of [rightX, leftX]) {
    const y = nearestFreeY(columnX, clamped.y, minY, maxY, size, obstacles, gap);
    if (y !== null) return { x: columnX, y, moved: true };
  }
  return { ...clamped, moved: false };
}
