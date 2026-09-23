// Pure geometry for the Game layout editor: smart snapping, overlap detection
// and settling a dropped panel into the nearest free spot. No DOM access here,
// so everything is covered by node regressions.

export interface LayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutBounds {
  width: number;
  height: number;
}

/** Which anchor of the moving rect a target line may attract. */
type SnapAnchor = "start" | "center" | "end";

export interface SnapTarget {
  value: number;
  anchors: SnapAnchor[];
  /** Extent of the source object on the perpendicular axis, used to draw guides. */
  start: number;
  end: number;
}

export interface SnapTargets {
  x: SnapTarget[];
  y: SnapTarget[];
}

/** A guide line in surface coordinates. `axis: "x"` is a vertical line at `value`. */
export interface SnapGuide {
  axis: "x" | "y";
  value: number;
  start: number;
  end: number;
}

export interface SnapOptions {
  /** Distance in px within which a line attracts an anchor. */
  threshold?: number;
  /** Grid fallback in px when no line is close; 0 disables it. */
  grid?: number;
  bounds: LayoutBounds;
}

export const LAYOUT_SNAP_THRESHOLD = 8;
export const LAYOUT_GRID = 16;
/** Matches the automatic resolver gap so a snapped neighbour never looks like a collision. */
export const LAYOUT_PANEL_GAP = 8;

/**
 * Build every snap line once, at drag or resize start. Lines are the surface
 * edges and centre, every other panel's edges and centre, and the "next to"
 * lines one resolver gap away from each neighbour.
 */
export function buildSnapTargets(bounds: LayoutBounds, others: LayoutRect[], gap = LAYOUT_PANEL_GAP): SnapTargets {
  const x: SnapTarget[] = [
    { value: 0, anchors: ["start"], start: 0, end: bounds.height },
    { value: bounds.width / 2, anchors: ["center"], start: 0, end: bounds.height },
    { value: bounds.width, anchors: ["end"], start: 0, end: bounds.height },
  ];
  const y: SnapTarget[] = [
    { value: 0, anchors: ["start"], start: 0, end: bounds.width },
    { value: bounds.height / 2, anchors: ["center"], start: 0, end: bounds.width },
    { value: bounds.height, anchors: ["end"], start: 0, end: bounds.width },
  ];
  for (const other of others) {
    const right = other.x + other.width;
    const bottom = other.y + other.height;
    x.push(
      { value: other.x, anchors: ["start"], start: other.y, end: bottom },
      { value: right, anchors: ["end"], start: other.y, end: bottom },
      { value: other.x + other.width / 2, anchors: ["center"], start: other.y, end: bottom },
      { value: right + gap, anchors: ["start"], start: other.y, end: bottom },
      { value: other.x - gap, anchors: ["end"], start: other.y, end: bottom },
    );
    y.push(
      { value: other.y, anchors: ["start"], start: other.x, end: right },
      { value: bottom, anchors: ["end"], start: other.x, end: right },
      { value: other.y + other.height / 2, anchors: ["center"], start: other.x, end: right },
      { value: bottom + gap, anchors: ["start"], start: other.x, end: right },
      { value: other.y - gap, anchors: ["end"], start: other.x, end: right },
    );
  }
  return { x, y };
}

function clampAxis(value: number, size: number, limit: number): number {
  return Math.max(0, Math.min(value, Math.max(0, limit - size)));
}

function snapAxis(
  position: number,
  size: number,
  targets: SnapTarget[],
  threshold: number,
): { offset: number; target: SnapTarget } | null {
  const anchors: Record<SnapAnchor, number> = { start: position, center: position + size / 2, end: position + size };
  let best: { offset: number; target: SnapTarget } | null = null;
  for (const target of targets) {
    for (const anchor of target.anchors) {
      const offset = target.value - anchors[anchor];
      if (Math.abs(offset) > threshold) continue;
      if (!best || Math.abs(offset) < Math.abs(best.offset)) best = { offset, target };
    }
  }
  return best;
}

function guideFor(axis: "x" | "y", target: SnapTarget, rect: LayoutRect): SnapGuide {
  const ownStart = axis === "x" ? rect.y : rect.x;
  const ownEnd = axis === "x" ? rect.y + rect.height : rect.x + rect.width;
  return {
    axis,
    value: target.value,
    start: Math.min(ownStart, target.start),
    end: Math.max(ownEnd, target.end),
  };
}

function gridAxis(value: number, grid: number): number {
  return grid > 0 ? Math.round(value / grid) * grid : value;
}

/**
 * Snap a moving rect. Each axis snaps to the closest line within the threshold;
 * an axis without a close line falls back to the grid. The result stays inside
 * the bounds and reports the guides that should be drawn.
 */
export function snapMoveRect(
  rect: LayoutRect,
  targets: SnapTargets | null,
  options: SnapOptions,
): { x: number; y: number; guides: SnapGuide[] } {
  const threshold = options.threshold ?? LAYOUT_SNAP_THRESHOLD;
  const grid = options.grid ?? 0;
  const guides: SnapGuide[] = [];
  let x = clampAxis(rect.x, rect.width, options.bounds.width);
  let y = clampAxis(rect.y, rect.height, options.bounds.height);
  if (!targets) return { x, y, guides };
  const snapX = snapAxis(x, rect.width, targets.x, threshold);
  const snapY = snapAxis(y, rect.height, targets.y, threshold);
  if (snapX) x += snapX.offset;
  else x = gridAxis(x, grid);
  if (snapY) y += snapY.offset;
  else y = gridAxis(y, grid);
  x = clampAxis(x, rect.width, options.bounds.width);
  y = clampAxis(y, rect.height, options.bounds.height);
  const placed = { ...rect, x, y };
  if (snapX) guides.push(guideFor("x", snapX.target, placed));
  if (snapY) guides.push(guideFor("y", snapY.target, placed));
  return { x, y, guides };
}

export interface ResizeEdges {
  left?: boolean;
  right?: boolean;
  top?: boolean;
  bottom?: boolean;
}

export interface ResizeOptions extends SnapOptions {
  minWidth: number;
  minHeight: number;
}

function snapEdge(value: number, targets: SnapTarget[], threshold: number): SnapTarget | null {
  let best: SnapTarget | null = null;
  for (const target of targets) {
    const distance = Math.abs(target.value - value);
    if (distance <= threshold && (!best || distance < Math.abs(best.value - value))) best = target;
  }
  return best;
}

/**
 * Snap the moving edges of a resize. The opposite edges stay put, minimum sizes
 * win over snapping, and the rect is kept inside the bounds.
 */
export function snapResizeRect(
  rect: LayoutRect,
  edges: ResizeEdges,
  targets: SnapTargets | null,
  options: ResizeOptions,
): { rect: LayoutRect; guides: SnapGuide[] } {
  const threshold = options.threshold ?? LAYOUT_SNAP_THRESHOLD;
  const grid = options.grid ?? 0;
  let left = rect.x;
  let right = rect.x + rect.width;
  let top = rect.y;
  let bottom = rect.y + rect.height;
  const guides: Array<{ axis: "x" | "y"; target: SnapTarget }> = [];
  const resolve = (value: number, axis: "x" | "y") => {
    if (!targets) return value;
    const target = snapEdge(value, axis === "x" ? targets.x : targets.y, threshold);
    if (target) {
      guides.push({ axis, target });
      return target.value;
    }
    return gridAxis(value, grid);
  };
  if (edges.left) left = resolve(left, "x");
  if (edges.right) right = resolve(right, "x");
  if (edges.top) top = resolve(top, "y");
  if (edges.bottom) bottom = resolve(bottom, "y");
  left = Math.max(0, left);
  top = Math.max(0, top);
  right = Math.min(options.bounds.width, right);
  bottom = Math.min(options.bounds.height, bottom);
  if (right - left < options.minWidth) {
    if (edges.left) left = Math.max(0, right - options.minWidth);
    if (right - left < options.minWidth) right = Math.min(options.bounds.width, left + options.minWidth);
  }
  if (bottom - top < options.minHeight) {
    if (edges.top) top = Math.max(0, bottom - options.minHeight);
    if (bottom - top < options.minHeight) bottom = Math.min(options.bounds.height, top + options.minHeight);
  }
  const result = { x: left, y: top, width: right - left, height: bottom - top };
  return {
    rect: result,
    guides: guides
      .filter(({ axis, target }) =>
        axis === "x"
          ? target.value === left || target.value === right
          : target.value === top || target.value === bottom,
      )
      .map(({ axis, target }) => guideFor(axis, target, result)),
  };
}

/**
 * Stop resized edges one gap short of neighbours they would newly run into.
 * Neighbours the panel already overlapped at resize start are ignored, so an
 * overlapping saved layout can still be resized. When a corner drag hits a
 * neighbour, the axis cut that keeps more area wins. Returns null when no cut
 * can keep the minimum size.
 */
export function constrainResizeRect(
  rect: LayoutRect,
  origin: LayoutRect,
  edges: ResizeEdges,
  obstacles: LayoutRect[],
  minSize: { width: number; height: number },
  gap = LAYOUT_PANEL_GAP,
): LayoutRect | null {
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.width;
  let bottom = rect.y + rect.height;
  const relevant = obstacles.filter((obstacle) => !rectsOverlap(origin, obstacle, gap - 0.5));
  for (let pass = 0; pass < 4; pass += 1) {
    const current = { x: left, y: top, width: right - left, height: bottom - top };
    const hit = relevant.find((obstacle) => rectsOverlap(current, obstacle, gap - 0.5));
    if (!hit) break;
    const cuts: Array<{ area: number; apply: () => void }> = [];
    const consider = (next: { left: number; top: number; right: number; bottom: number }) => {
      const width = next.right - next.left;
      const height = next.bottom - next.top;
      if (width + 0.01 < minSize.width || height + 0.01 < minSize.height) return;
      cuts.push({
        area: width * height,
        apply: () => {
          ({ left, top, right, bottom } = next);
        },
      });
    };
    const box = { left, top, right, bottom };
    if (edges.right && hit.x >= origin.x + origin.width - 0.5) consider({ ...box, right: hit.x - gap });
    if (edges.left && hit.x + hit.width <= origin.x + 0.5) consider({ ...box, left: hit.x + hit.width + gap });
    if (edges.bottom && hit.y >= origin.y + origin.height - 0.5) consider({ ...box, bottom: hit.y - gap });
    if (edges.top && hit.y + hit.height <= origin.y + 0.5) consider({ ...box, top: hit.y + hit.height + gap });
    // No cut keeps the minimum size: the caller keeps its last valid frame.
    if (!cuts.length) return null;
    cuts.sort((a, b) => b.area - a.area)[0]!.apply();
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Positive-area overlap, optionally treating panels closer than `gap` as overlapping. */
export function rectsOverlap(a: LayoutRect, b: LayoutRect, gap = 0): boolean {
  return (
    a.x < b.x + b.width + gap && a.x + a.width + gap > b.x && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y
  );
}

/** Intersection rects between `rect` and every obstacle it overlaps. */
export function overlapAreas(rect: LayoutRect, obstacles: LayoutRect[]): LayoutRect[] {
  const areas: LayoutRect[] = [];
  for (const obstacle of obstacles) {
    if (!rectsOverlap(rect, obstacle)) continue;
    const x = Math.max(rect.x, obstacle.x);
    const y = Math.max(rect.y, obstacle.y);
    areas.push({
      x,
      y,
      width: Math.min(rect.x + rect.width, obstacle.x + obstacle.width) - x,
      height: Math.min(rect.y + rect.height, obstacle.y + obstacle.height) - y,
    });
  }
  return areas;
}

/**
 * Find the free position closest to the drop point. Free rectangles always
 * start at a surface edge or one gap away from an obstacle edge, so those lines
 * (plus the drop point itself) are the only candidates worth testing. Candidates
 * are tried nearest first, so the first free one is the answer.
 */
export function findNearestFreePosition(
  rect: LayoutRect,
  obstacles: LayoutRect[],
  bounds: LayoutBounds,
  gap = LAYOUT_PANEL_GAP,
): { x: number; y: number } | null {
  const maxX = bounds.width - rect.width;
  const maxY = bounds.height - rect.height;
  if (maxX < 0 || maxY < 0) return null;
  const start = { x: clampAxis(rect.x, rect.width, bounds.width), y: clampAxis(rect.y, rect.height, bounds.height) };
  const xs = new Set<number>([start.x, 0, maxX]);
  const ys = new Set<number>([start.y, 0, maxY]);
  for (const obstacle of obstacles) {
    xs.add(obstacle.x + obstacle.width + gap);
    xs.add(obstacle.x - rect.width - gap);
    xs.add(obstacle.x);
    ys.add(obstacle.y + obstacle.height + gap);
    ys.add(obstacle.y - rect.height - gap);
    ys.add(obstacle.y);
  }
  const validX = [...xs].filter((value) => value >= 0 && value <= maxX);
  const validY = [...ys].filter((value) => value >= 0 && value <= maxY);
  const candidates: Array<{ x: number; y: number; distance: number }> = [];
  for (const x of validX)
    for (const y of validY) candidates.push({ x, y, distance: Math.hypot(x - start.x, y - start.y) });
  candidates.sort((a, b) => a.distance - b.distance || a.y - b.y || a.x - b.x);
  for (const candidate of candidates) {
    const placed = { ...rect, x: candidate.x, y: candidate.y };
    // Keep the resolver gap, so the automatic reflow never treats the drop as a collision.
    if (!obstacles.some((obstacle) => rectsOverlap(placed, obstacle, gap - 0.5)))
      return { x: candidate.x, y: candidate.y };
  }
  return null;
}

/** True when the dropped rect needs settling: a real overlap or a neighbour inside the resolver gap. */
export function needsSettling(rect: LayoutRect, obstacles: LayoutRect[], gap = LAYOUT_PANEL_GAP): boolean {
  return obstacles.some((obstacle) => rectsOverlap(rect, obstacle, gap - 0.5));
}
