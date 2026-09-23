import {
  LAYOUT_GRID,
  buildSnapTargets,
  findNearestFreePosition,
  needsSettling,
  overlapAreas,
  snapMoveRect,
  type LayoutRect,
  type SnapGuide,
  type SnapTargets,
} from "./game-layout-geometry";

export interface GamePanelLayoutItem {
  id: string;
  x: number;
  y: number;
  /** Stable user/default anchor; x/y may contain temporary collision output. */
  preferredX?: number;
  preferredY?: number;
  width: number;
  height: number;
  locked: boolean;
  priority: number;
  /** Keep a user-selected screen anchor fixed while siblings reflow around it. */
  fixed?: boolean;
  bottomInset?: number;
  setPosition: (x: number, y: number) => void;
  setHeightLimit?: (height: number) => void;
  /**
   * A height the user set by hand (resize or "Fixed height"). Crowded layouts shrink
   * automatic panels into scrolling windows, but never undo a manual height.
   */
  firmHeight?: boolean;
  /** Panels sharing a stack move and resolve as one vertical group. */
  stackGroup?: string | null;
  stackOrder?: number;
  /**
   * Reading panels (narration, map, storyboard) keep at least a third of the surface
   * (or their natural height) when a crowded screen shrinks other panels.
   */
  reading?: boolean;
}

/** Panels whose content is read continuously; crowded reflow never crushes them to a sliver. */
export const GAME_READING_PANEL_IDS: ReadonlySet<string> = new Set(["narration", "map", "storyboard"]);

/** The smallest height a reading panel is shrunk to when the screen is crowded. */
export function gameReadingPanelFloor(surfaceHeight: number): number {
  return Math.max(160, Math.round(surfaceHeight / 3));
}

export interface GamePanelPosition {
  x: number;
  y: number;
}

export interface GamePanelSize {
  width: number;
  height: number;
}

/** Base surface layer for movable HUD panels. Interactive toolbar stacks use the next layer. */
export const GAME_PANEL_HUD_LAYER = 30;
export const GAME_PANEL_INTERACTIVE_LAYER = 40;

export interface GamePanelLayoutBounds {
  width: number;
  height: number;
  gap?: number;
  /** Collisions off: keep every panel at its own anchor, so manual overlaps are intentional. */
  allowOverlap?: boolean;
}

/** Device-wide editor preference. When "false", panels may overlap and nothing is pushed apart. */
export const GAME_PANEL_COLLISIONS_STORAGE_KEY = "marinara-game-layout-collisions";

export function gamePanelCollisionsEnabled(): boolean {
  try {
    return typeof localStorage === "undefined" || localStorage.getItem(GAME_PANEL_COLLISIONS_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function snapPanelDragPosition(value: number, max: number, grid = 16): number {
  if (value <= 0) return 0;
  if (value >= max) return Math.max(0, max);
  return Math.max(0, Math.min(max, Math.round(value / grid) * grid));
}

function intersects(a: GamePanelLayoutItem, b: GamePanelLayoutItem, gap: number): boolean {
  return (
    a.x < b.x + b.width + gap && a.x + a.width + gap > b.x && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y
  );
}

function overlapsRect(a: GamePanelPosition & GamePanelSize, b: GamePanelPosition & GamePanelSize): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function clampPosition(
  position: GamePanelPosition,
  size: GamePanelSize,
  bounds: GamePanelLayoutBounds,
): GamePanelPosition {
  return {
    x: Math.max(0, Math.min(position.x, Math.max(0, bounds.width - size.width))),
    y: Math.max(0, Math.min(position.y, Math.max(0, bounds.height - size.height))),
  };
}

/**
 * Clamp a manual drag against stationary siblings. This deliberately does not use the automatic
 * resolver: dragging one panel must never move another panel. Touching an edge is allowed.
 */
export function constrainPanelDragPosition(
  from: GamePanelPosition,
  requested: GamePanelPosition,
  size: GamePanelSize,
  obstacles: Array<GamePanelPosition & GamePanelSize>,
  bounds: GamePanelLayoutBounds,
): GamePanelPosition {
  const start = clampPosition(from, size, bounds);
  const candidate = clampPosition(requested, size, bounds);
  const delta = { x: candidate.x - start.x, y: candidate.y - start.y };
  let earliest = 1;
  for (const obstacle of obstacles) {
    // An already-overlapping saved layout must remain escapable by manual dragging.
    if (overlapsRect({ ...start, ...size }, obstacle)) continue;
    const axisTimes = (origin: number, distance: number, min: number, max: number): [number, number] | null => {
      // Touching (origin == min or max) on a stationary axis can never produce positive-area overlap.
      if (distance === 0) return origin <= min || origin >= max ? null : [-Infinity, Infinity];
      const first = (min - origin) / distance;
      const second = (max - origin) / distance;
      return [Math.min(first, second), Math.max(first, second)];
    };
    const xTimes = axisTimes(start.x, delta.x, obstacle.x - size.width, obstacle.x + obstacle.width);
    const yTimes = axisTimes(start.y, delta.y, obstacle.y - size.height, obstacle.y + obstacle.height);
    if (!xTimes || !yTimes) continue;
    const entry = Math.max(xTimes[0], yTimes[0], 0);
    const exit = Math.min(xTimes[1], yTimes[1], 1);
    // Zero-length intervals are edge contact (moving away from or along a touching edge), not penetration.
    if (entry < exit && entry <= 1) earliest = Math.min(earliest, entry);
  }
  // Stop infinitesimally before impact: edge contact is allowed, positive-area overlap is not.
  const safeT = earliest < 1 ? Math.max(0, earliest - 1e-6) : 1;
  return clampPosition({ x: start.x + delta.x * safeT, y: start.y + delta.y * safeT }, size, bounds);
}

function clamp(item: GamePanelLayoutItem, bounds: GamePanelLayoutBounds): GamePanelLayoutItem {
  return {
    ...item,
    x: Math.max(0, Math.min(item.x, Math.max(0, bounds.width - item.width))),
    y: Math.max(0, Math.min(item.y, Math.max(0, bounds.height - item.height))),
  };
}

interface ResolveVariant {
  cap: number;
  readingCap: number;
  promoted: string[];
  packed: boolean;
  /** Smallest window a non-reading panel may be squeezed into to fit a leftover gap. */
  gapFloor: number;
}

/** Crowded layouts search several variants; remember which one won for unchanged input. */
const resolvedVariantCache = new Map<string, ResolveVariant | null>();
const RESOLVED_VARIANT_CACHE_SIZE = 16;

function layoutSignature(items: GamePanelLayoutItem[], bounds: GamePanelLayoutBounds): string {
  const round = (value: number | undefined) => (value == null || !Number.isFinite(value) ? "-" : Math.round(value));
  return [
    bounds.width,
    bounds.height,
    bounds.gap ?? 8,
    bounds.allowOverlap ? 1 : 0,
    ...items.map((item) =>
      [
        item.id,
        round(item.preferredX ?? item.x),
        round(item.preferredY ?? item.y),
        round(item.width),
        round(item.height),
        item.priority,
        item.fixed ? 1 : 0,
        round(item.bottomInset),
        item.firmHeight ? 1 : 0,
        item.reading ? 1 : 0,
        item.setHeightLimit ? 1 : 0,
      ].join(","),
    ),
  ].join("|");
}

/** Resolve sibling collisions without changing the saved position of panels that already fit. */
export function resolveGamePanelLayout(items: GamePanelLayoutItem[], bounds: GamePanelLayoutBounds): boolean {
  const layoutItems = collapseStackGroups(items);
  const readingFloor = gameReadingPanelFloor(bounds.height);
  type Attempt = { result: Array<{ x: number; y: number; height: number }>; overflowIds: string[] };
  const attempt = ({ cap, readingCap, promoted, packed, gapFloor }: ResolveVariant): Attempt => {
    const result = layoutItems.map((item) => ({
      x: item.x,
      y: item.y,
      height: Math.min(item.height, Math.max(64, bounds.height - (item.bottomInset ?? 0))),
    }));
    const overflowIds = resolvePanelPositions(
      layoutItems.map((item, index) => {
        // Reading panels never shrink below the reading floor; other panels follow the cap.
        const itemCap = item.reading ? Math.max(readingCap, readingFloor) : cap;
        // Packed: movable widgets give up their anchors and fill from the top of their side.
        const pack = packed && !item.reading && !item.fixed && item.bottomInset == null;
        const anchorX = Number.isFinite(item.preferredX) ? item.preferredX! : item.x;
        return {
          ...item,
          ...(pack
            ? {
                preferredX: anchorX + item.width / 2 < bounds.width / 2 ? 0 : Math.max(0, bounds.width - item.width),
                preferredY: 0,
              }
            : null),
          height:
            item.setHeightLimit && !item.firmHeight
              ? Math.min(item.height, Math.max(64, itemCap - (item.bottomInset ?? 0)))
              : item.height,
          setPosition: (x: number, y: number) => {
            result[index]!.x = x;
            result[index]!.y = y;
          },
          setHeightLimit: item.setHeightLimit
            ? (height: number) => {
                result[index]!.height = height;
              }
            : undefined,
        };
      }),
      bounds,
      new Set(promoted),
      readingFloor,
      gapFloor,
    );
    return { result, overflowIds };
  };
  const apply = ({ result }: Attempt) =>
    layoutItems.forEach((item, index) => {
      const resolved = result[index]!;
      item.setHeightLimit?.(resolved.height);
      if (item.stackGroup || Math.abs(item.x - resolved.x) > 0.5 || Math.abs(item.y - resolved.y) > 0.5)
        item.setPosition(resolved.x, resolved.y);
    });

  // Steady state: ResizeObserver passes repeat the same input, so reuse the variant that won.
  const signature = layoutSignature(layoutItems, bounds);
  const cached = resolvedVariantCache.get(signature);
  if (cached) {
    const current = attempt(cached);
    if (!current.overflowIds.length) {
      apply(current);
      return false;
    }
  }
  const remember = (variant: ResolveVariant | null) => {
    resolvedVariantCache.delete(signature);
    resolvedVariantCache.set(signature, variant);
    while (resolvedVariantCache.size > RESOLVED_VARIANT_CACHE_SIZE)
      resolvedVariantCache.delete(resolvedVariantCache.keys().next().value!);
  };

  // Prefer full panels. If the screen is crowded, retry with bounded windows; only
  // panel contents scroll, and saved sizes remain untouched. Other panels become
  // scrolling windows before reading panels do, and reading panels stop at the
  // reading floor. Before shrinking every panel another step, each level tries the
  // saved anchors, then places the panels a greedy pass stranded first, then packs
  // the widgets from the top of their side, and last squeezes widgets into any gap.
  const full = bounds.height;
  const ladder: Array<[cap: number, readingCap: number]> = [
    [full, full],
    [full / 2, full],
    [full / 3, full],
    [full / 3, full / 2],
    [full / 3, full / 3],
    [full / 4, full / 3],
    [64, full / 3],
  ];
  let best: Attempt | null = null;
  /** Applies and returns true when the variant fits; otherwise returns the ids that did not. */
  const consider = (variant: ResolveVariant): true | string[] => {
    const current = attempt(variant);
    if (!current.overflowIds.length) {
      apply(current);
      remember(variant);
      return true;
    }
    if (!best || current.overflowIds.length < best.overflowIds.length) best = current;
    return current.overflowIds;
  };
  for (const [cap, readingCap] of ladder) {
    const promoted = new Set<string>();
    for (let pass = 0; pass < 3; pass += 1) {
      const outcome = consider({ cap, readingCap, promoted: [...promoted], packed: false, gapFloor: 96 });
      if (outcome === true) return false;
      const before = promoted.size;
      for (const id of outcome) promoted.add(id);
      if (promoted.size === before) break;
    }
    if (consider({ cap, readingCap, promoted: [...promoted], packed: true, gapFloor: 96 }) === true) return false;
    if (consider({ cap, readingCap, promoted: [...promoted], packed: false, gapFloor: 64 }) === true) return false;
    if (consider({ cap, readingCap, promoted: [...promoted], packed: true, gapFloor: 64 }) === true) return false;
  }
  // Nothing fits even at the smallest windows. Keep the least crowded attempt:
  // the few panels that do not fit stay at their own anchors (overlapping),
  // rather than crushing every panel on the screen.
  remember(null);
  if (best) apply(best);
  return true;
}

function collapseStackGroups(items: GamePanelLayoutItem[]): GamePanelLayoutItem[] {
  const groups = new Map<string, GamePanelLayoutItem[]>();
  const singles: GamePanelLayoutItem[] = [];
  for (const item of items) {
    if (item.stackGroup) {
      const group = groups.get(item.stackGroup) ?? [];
      group.push(item);
      groups.set(item.stackGroup, group);
    } else singles.push(item);
  }
  const grouped = [...groups.entries()].map(([groupId, members]) => {
    const orderedMembers = [...members].sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
    const minX = Math.min(...orderedMembers.map((member) => member.x));
    const minY = Math.min(...orderedMembers.map((member) => member.y));
    const offsets = new Map<string, { x: number; y: number }>();
    let offsetY = 0;
    for (const member of orderedMembers) {
      offsets.set(member.id, { x: member.x - minX, y: offsetY });
      offsetY += member.height + 8;
    }
    const maxRight = Math.max(
      ...orderedMembers.map((member) => minX + (offsets.get(member.id)?.x ?? 0) + member.width),
    );
    const maxBottom = minY + Math.max(0, offsetY - 8);
    return {
      id: `stack:${groupId}`,
      x: minX,
      y: minY,
      preferredX: Math.min(...members.map((member) => member.preferredX ?? member.x)),
      preferredY: Math.min(...members.map((member) => member.preferredY ?? member.y)),
      width: maxRight - minX,
      height: maxBottom - minY,
      stackGroup: groupId,
      locked: members.every((member) => member.locked),
      fixed: members.some((member) => member.fixed),
      priority: Math.min(...members.map((member) => member.priority)),
      setPosition: (x: number, y: number) => {
        for (const member of orderedMembers) {
          const offset = offsets.get(member.id)!;
          member.setPosition(x + offset.x, y + offset.y);
        }
      },
      setHeightLimit: (height: number) => {
        let remaining = Math.max(64, height);
        for (let index = 0; index < orderedMembers.length; index += 1) {
          const member = orderedMembers[index]!;
          const gapsAfter = (orderedMembers.length - index - 1) * 8;
          const limit = Math.max(64, Math.min(member.height, remaining - gapsAfter));
          member.setHeightLimit?.(limit);
          remaining -= limit + 8;
        }
      },
    } satisfies GamePanelLayoutItem;
  });
  return [...singles, ...grouped];
}

function resolvePanelPositions(
  items: GamePanelLayoutItem[],
  bounds: GamePanelLayoutBounds,
  promoted: ReadonlySet<string> = new Set(),
  readingFloor = 64,
  gapFloor = 64,
): string[] {
  const gap = bounds.gap ?? 8;
  const placed: GamePanelLayoutItem[] = [];
  const ordered = items
    .map((item) => ({ ...item, height: Math.min(item.height, bounds.height) }))
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        // Reading panels claim their anchors before same-priority widgets.
        Number(!!b.reading) - Number(!!a.reading) ||
        Number(promoted.has(b.id)) - Number(promoted.has(a.id)) ||
        a.id.localeCompare(b.id),
    );

  const overflowIds: string[] = [];
  for (const source of ordered) {
    const anchorX = Number.isFinite(source.preferredX) ? source.preferredX! : source.x;
    const anchorY =
      source.bottomInset != null
        ? Math.max(0, bounds.height - source.height - source.bottomInset)
        : Number.isFinite(source.preferredY)
          ? source.preferredY!
          : source.y;
    let current = clamp({ ...source, x: anchorX, y: anchorY }, bounds);
    if (!source.fixed && !bounds.allowOverlap && placed.some((item) => intersects(current, item, gap))) {
      // Free rectangles begin at a viewport or obstacle edge. Avoid scanning
      // every pixel on each ResizeObserver pass.
      const xs = [
        ...new Set([
          current.x,
          0,
          bounds.width - source.width,
          ...placed.flatMap((item) => [item.x + item.width + gap, item.x - source.width - gap]),
        ]),
      ].filter((x) => x >= 0 && x + source.width <= bounds.width);
      const ys = [
        ...new Set([
          current.y,
          0,
          bounds.height - source.height,
          ...placed.flatMap((item) => [item.y + item.height + gap, item.y - source.height - gap]),
        ]),
      ].filter((y) => y >= 0 && y < bounds.height);
      const distance = (item: GamePanelLayoutItem) => Math.abs(item.x - anchorX) + Math.abs(item.y - anchorY);
      let best: GamePanelLayoutItem | undefined;
      for (const x of xs)
        for (const y of ys) {
          const candidate = { ...source, x, y };
          if (y + candidate.height > bounds.height || placed.some((item) => intersects(candidate, item, gap))) continue;
          if (!best || distance(candidate) < distance(best)) best = candidate;
        }
      if (!best && source.setHeightLimit && !source.firmHeight) {
        for (const x of xs)
          for (const y of ys) {
            let height = Math.min(source.height, bounds.height - y);
            for (const item of placed) {
              if (x >= item.x + item.width + gap || x + source.width + gap <= item.x || y >= item.y + item.height + gap)
                continue;
              height = Math.min(height, item.y - gap - y);
            }
            // A widget squeezed into a leftover gap must still show a few lines; below that,
            // shrinking every panel a step further gives a better layout.
            if (height < Math.min(source.reading ? Math.max(64, readingFloor) : Math.max(64, gapFloor), source.height))
              continue;
            const candidate = { ...source, x, y, height };
            const score = (item: GamePanelLayoutItem) => distance(item) + (source.height - item.height) * 2;
            if (!best || score(candidate) < score(best)) best = candidate;
          }
      }
      if (best) current = best;
      else overflowIds.push(source.id);
    }
    source.setHeightLimit?.(current.height);
    placed.push(current);
    if (Math.abs(current.x - source.x) > 0.5 || Math.abs(current.y - source.y) > 0.5)
      source.setPosition(current.x, current.y);
  }
  return overflowIds;
}

type RegisteredPanel = Omit<GamePanelLayoutItem, "width" | "height" | "x" | "y" | "setPosition" | "priority"> & {
  element: HTMLElement;
  getPosition: () => { x: number; y: number };
  /** The user's saved/manual position, excluding temporary collision reflow. */
  getPreferredPosition?: () => { x: number; y: number };
  getSize?: () => { width: number; height: number };
  setPosition: (x: number, y: number) => void;
  setPreferredPosition?: () => void;
  /** Persist the current position as the user's anchor (used after a grouped drag). */
  commitPosition?: () => void;
  priority?: number;
  fixed?: boolean;
  bottomInset?: number;
};

const registries = new WeakMap<HTMLElement, Map<string, RegisteredPanel>>();
const scheduled = new WeakMap<HTMLElement, number>();
const registryListeners = new WeakMap<HTMLElement, Set<() => void>>();
const registryNotifyFrames = new WeakMap<HTMLElement, number>();

function notifyRegistry(surface: HTMLElement): void {
  if (registryNotifyFrames.has(surface) || !registryListeners.get(surface)?.size) return;
  registryNotifyFrames.set(
    surface,
    requestAnimationFrame(() => {
      registryNotifyFrames.delete(surface);
      for (const listener of [...(registryListeners.get(surface) ?? [])]) listener();
    }),
  );
}

/** Subscribe to panel registration changes on a surface (batched per frame). */
export function subscribeGamePanelRegistry(surface: HTMLElement, listener: () => void): () => void {
  let listeners = registryListeners.get(surface);
  if (!listeners) {
    listeners = new Set();
    registryListeners.set(surface, listeners);
  }
  listeners.add(listener);
  return () => listeners?.delete(listener);
}

export function registeredGamePanelStates(surface: HTMLElement): Array<{ id: string; locked: boolean }> {
  return [...(registries.get(surface)?.values() ?? [])].map((panel) => ({ id: panel.id, locked: panel.locked }));
}

function measuredRect(panel: RegisteredPanel): LayoutRect {
  const position = panel.getPosition();
  return { x: position.x, y: position.y, width: panel.element.offsetWidth, height: panel.element.offsetHeight };
}

export interface PanelDragFrame {
  /** The moving group's rect (the panel itself, or its whole stack). */
  rect: LayoutRect;
  guides: SnapGuide[];
  overlaps: LayoutRect[];
  /** Where the group will settle on release, when that differs from `rect`. */
  ghost: LayoutRect | null;
}

export interface PanelDragSession {
  /** `collide: false` lets the panel phase through neighbours with no overlap feedback. */
  move(dx: number, dy: number, snap: boolean, collide: boolean): PanelDragFrame;
  /** The free position nearest to the current drop point (or the current position when it is free). */
  settleTarget(collide: boolean): GamePanelPosition;
  setGroupPosition(x: number, y: number): void;
  groupPosition(): GamePanelPosition;
  /** Put every member back where the drag started. */
  cancel(): void;
}

/**
 * Start a manual drag. Snap lines and obstacles are measured once here, never
 * per pointer move. The panel (and its stack) moves freely over neighbours;
 * nothing else moves. On release the caller settles it with `settleTarget`.
 */
export function beginRegisteredPanelDrag(surface: HTMLElement, id: string): PanelDragSession | null {
  const registry = registries.get(surface);
  const current = registry?.get(id);
  if (!registry || !current) return null;
  const bounds = { width: surface.clientWidth, height: surface.clientHeight };
  const groupId = current.stackGroup ?? null;
  const stackMembers = groupId ? [...registry.values()].filter((panel) => panel.stackGroup === groupId) : [];
  const moving = stackMembers.length > 1 ? stackMembers : [current];
  const memberRects = moving.map((panel) => ({ panel, rect: measuredRect(panel) }));
  const left = Math.min(...memberRects.map(({ rect }) => rect.x));
  const top = Math.min(...memberRects.map(({ rect }) => rect.y));
  const start: LayoutRect = {
    x: left,
    y: top,
    width: Math.max(...memberRects.map(({ rect }) => rect.x + rect.width)) - left,
    height: Math.max(...memberRects.map(({ rect }) => rect.y + rect.height)) - top,
  };
  const obstacles = [...registry.values()]
    .filter((panel) => !moving.includes(panel))
    .map(measuredRect)
    .filter((rect) => rect.width > 0 && rect.height > 0);
  const targets = buildSnapTargets(bounds, obstacles);
  let position: GamePanelPosition = { x: start.x, y: start.y };
  const setGroupPosition = (x: number, y: number) => {
    position = { x, y };
    for (const { panel, rect } of memberRects) panel.setPosition(x + rect.x - start.x, y + rect.y - start.y);
  };
  const settleTarget = (collide: boolean): GamePanelPosition => {
    const rect = { ...start, ...position };
    if (!collide || !needsSettling(rect, obstacles)) return position;
    return findNearestFreePosition(rect, obstacles, bounds) ?? position;
  };
  return {
    move(dx, dy, snap, collide) {
      const requested = { ...start, x: start.x + dx, y: start.y + dy };
      const snapped = snapMoveRect(requested, snap ? targets : null, { bounds, grid: snap ? LAYOUT_GRID : 0 });
      setGroupPosition(snapped.x, snapped.y);
      const rect = { ...start, ...position };
      const target = settleTarget(collide);
      const moved = Math.abs(target.x - position.x) > 0.5 || Math.abs(target.y - position.y) > 0.5;
      return {
        rect,
        guides: snapped.guides,
        overlaps: collide ? overlapAreas(rect, obstacles) : [],
        ghost: moved ? { ...start, ...target } : null,
      };
    },
    settleTarget,
    setGroupPosition,
    groupPosition: () => position,
    cancel: () => setGroupPosition(start.x, start.y),
  };
}

/** Snap lines and bounds for resizing one panel, measured once at resize start. */
export function beginRegisteredPanelResize(
  surface: HTMLElement,
  id: string,
): { targets: SnapTargets; bounds: { width: number; height: number }; obstacles: LayoutRect[] } {
  const bounds = { width: surface.clientWidth, height: surface.clientHeight };
  const registry = registries.get(surface);
  const stackGroup = registry?.get(id)?.stackGroup ?? null;
  const others = [...(registry?.values() ?? [])]
    // Stack siblings reflow around a resized member, so they never block its edges.
    .filter((panel) => panel.id !== id && (!stackGroup || panel.stackGroup !== stackGroup))
    .map(measuredRect)
    .filter((rect) => rect.width > 0 && rect.height > 0);
  return { targets: buildSnapTargets(bounds, others), bounds, obstacles: others };
}
/** Dispatched on the surface after panels may have moved (a resolver pass or a committed edit). */
export const GAME_PANEL_LAYOUT_PASS_EVENT = "marinara-game-panel-layout-pass";

/**
 * True when another panel sits within `clearance` px above the given span of this panel,
 * so a name tag drawn above the top border would cover it.
 */
export function gamePanelHasNeighbourAbove(
  surface: HTMLElement,
  id: string,
  span: { x: number; y: number; width: number },
  clearance: number,
): boolean {
  for (const panel of registries.get(surface)?.values() ?? []) {
    if (panel.id === id) continue;
    const other = measuredRect(panel);
    if (other.width <= 0 || other.height <= 0) continue;
    if (other.x >= span.x + span.width || other.x + other.width <= span.x) continue;
    const bottom = other.y + other.height;
    if (bottom > span.y - clearance && other.y < span.y) return true;
  }
  return false;
}

export const GAME_PANEL_STACK_CHANGE_EVENT = "marinara-game-panel-stack-change";
const STACK_STORAGE_PREFIX = "marinara-game-panel-stacks:";

export function readGamePanelStacks(chatId: string): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(`${STACK_STORAGE_PREFIX}${chatId}`) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] =>
          entry[0].length > 0 && typeof entry[1] === "string" && entry[1].length > 0,
      ),
    );
  } catch {
    return {};
  }
}

export function writeGamePanelStack(chatId: string, panelId: string, groupId: string | null): void {
  writeGamePanelStackMembership(chatId, groupId ? [panelId] : [], groupId, groupId ? undefined : panelId);
}

export function writeGamePanelStackMembership(
  chatId: string,
  panelIds: string[],
  groupId: string | null,
  removePanelId?: string,
): void {
  const stacks = readGamePanelStacks(chatId);
  if (removePanelId) delete stacks[removePanelId];
  if (groupId) for (const panelId of panelIds) stacks[panelId] = groupId;
  try {
    localStorage.setItem(`${STACK_STORAGE_PREFIX}${chatId}`, JSON.stringify(stacks));
    window.dispatchEvent(new CustomEvent(GAME_PANEL_STACK_CHANGE_EVENT, { detail: { chatId } }));
  } catch {
    /* Device-local layout preferences are best effort. */
  }
}

export function registeredGamePanelIds(surface: HTMLElement): string[] {
  return [...(registries.get(surface)?.keys() ?? [])];
}

export function registeredGamePanelOptions(surface: HTMLElement): Array<{ id: string; label: string }> {
  const registry = registries.get(surface);
  if (!registry) return [];
  return [...registry.values()].map((panel) => {
    const labelled = panel.element.querySelector<HTMLElement>("[aria-label]")?.getAttribute("aria-label")?.trim();
    const titled = panel.element.querySelector<HTMLElement>("[title]")?.getAttribute("title")?.trim();
    const text = [...panel.element.querySelectorAll<HTMLElement>("span")]
      .map((element) => element.textContent?.trim() ?? "")
      .find((value) => value.length > 1 && value.length < 80);
    return { id: panel.id, label: labelled || titled || text || panel.id };
  });
}

export function arrangeRegisteredPanelStack(surface: HTMLElement, groupId: string): void {
  const registry = registries.get(surface);
  if (!registry) return;
  const members = [...registry.values()]
    .filter((panel) => panel.stackGroup === groupId)
    .sort((a, b) => a.getPosition().y - b.getPosition().y || a.id.localeCompare(b.id));
  if (members.length < 2) return;
  const x = Math.max(0, Math.min(...members.map((member) => member.getPosition().x)));
  let y = Math.max(0, Math.min(...members.map((member) => member.getPosition().y)));
  for (const member of members) {
    const size = member.getSize?.() ?? { width: member.element.offsetWidth, height: member.element.offsetHeight };
    member.setPosition(x, y);
    y += size.height + 8;
  }
}
function restoreSurfaceOverflow(surface: HTMLElement): void {
  delete surface.dataset.gamePanelOverflow;
}

export function registerGamePanel(surface: HTMLElement, panel: RegisteredPanel): () => void {
  let registry = registries.get(surface);
  if (!registry) {
    registry = new Map();
    registries.set(surface, registry);
  }
  registry.set(panel.id, panel);
  scheduleGamePanelLayout(surface);
  notifyRegistry(surface);
  return () => {
    if (registry?.get(panel.id) === panel) registry.delete(panel.id);
    if (!registry?.size) restoreSurfaceOverflow(surface);
    scheduleGamePanelLayout(surface);
    notifyRegistry(surface);
  };
}

export function constrainRegisteredPanelDrag(
  surface: HTMLElement,
  id: string,
  from: GamePanelPosition,
  requested: GamePanelPosition,
  size: GamePanelSize,
): GamePanelPosition {
  const registry = registries.get(surface);
  if (!registry) return clampPosition(requested, size, { width: surface.clientWidth, height: surface.clientHeight });
  const currentPanel = registry.get(id);
  if (!currentPanel)
    return clampPosition(requested, size, { width: surface.clientWidth, height: surface.clientHeight });
  const groupId = currentPanel?.stackGroup ?? null;
  const members = groupId ? [...registry.values()].filter((panel) => panel.stackGroup === groupId) : [];
  const moving = members.length > 1 ? members : currentPanel ? [currentPanel] : [];
  // Framer Motion has already advanced the dragged element by the time this
  // callback runs. Use the accepted `from` position for that member and the
  // registry positions for siblings, otherwise the requested delta is added
  // twice and a collision can start from inside an obstacle.
  const positionFor = (panel: RegisteredPanel): GamePanelPosition => (panel.id === id ? from : panel.getPosition());
  const groupLeft = Math.min(...moving.map((panel) => positionFor(panel).x));
  const groupTop = Math.min(...moving.map((panel) => positionFor(panel).y));
  const groupRight = Math.max(
    ...moving.map((panel) => positionFor(panel).x + (panel.getSize?.().width ?? panel.element.offsetWidth)),
  );
  const groupBottom = Math.max(
    ...moving.map((panel) => positionFor(panel).y + (panel.getSize?.().height ?? panel.element.offsetHeight)),
  );
  const movingSize = { width: groupRight - groupLeft, height: groupBottom - groupTop };
  const delta = { x: requested.x - from.x, y: requested.y - from.y };
  const groupRequested = { x: groupLeft + delta.x, y: groupTop + delta.y };
  const obstacles: Array<GamePanelPosition & GamePanelSize> = [];
  for (const [otherId, panel] of registry) {
    if (moving.some((member) => member.id === otherId)) continue;
    const position = panel.getPosition();
    const measured = panel.getSize?.() ?? { width: panel.element.offsetWidth, height: panel.element.offsetHeight };
    obstacles.push({ x: position.x, y: position.y, width: measured.width, height: measured.height });
  }
  const constrainedGroup = constrainPanelDragPosition(
    { x: groupLeft, y: groupTop },
    groupRequested,
    movingSize,
    obstacles,
    {
      width: surface.clientWidth,
      height: surface.clientHeight,
    },
  );
  const groupDelta = { x: constrainedGroup.x - groupLeft, y: constrainedGroup.y - groupTop };
  for (const member of moving) {
    const position = positionFor(member);
    member.setPosition(position.x + groupDelta.x, position.y + groupDelta.y);
  }
  return { x: from.x + groupDelta.x, y: from.y + groupDelta.y };
}

export function commitRegisteredPanelGroup(surface: HTMLElement, id: string): void {
  const registry = registries.get(surface);
  const panel = registry?.get(id);
  if (!registry || !panel) return;
  const groupId = panel.stackGroup;
  for (const member of registry.values()) {
    if (!groupId || member.stackGroup !== groupId || member.id === id) continue;
    // Persist every member so a grouped drag survives reload, not just the dragged one.
    if (member.commitPosition) member.commitPosition();
    else member.setPreferredPosition?.();
  }
}

const suspendedSurfaces = new WeakSet<HTMLElement>();

/**
 * Pause the automatic resolver while the user drags or resizes, so reflow
 * cannot fight the pointer. Resuming schedules one pass.
 */
export function setGamePanelLayoutSuspended(surface: HTMLElement, suspended: boolean): void {
  if (suspended) suspendedSurfaces.add(surface);
  else if (suspendedSurfaces.delete(surface)) scheduleGamePanelLayout(surface);
}

export function scheduleGamePanelLayout(surface: HTMLElement): void {
  if (scheduled.has(surface)) return;
  const frame = requestAnimationFrame(() => {
    scheduled.delete(surface);
    if (suspendedSurfaces.has(surface)) return;
    const registry = registries.get(surface);
    if (!registry || !registry.size || !surface.clientWidth || !surface.clientHeight) {
      restoreSurfaceOverflow(surface);
      return;
    }
    const items = [...registry.values()].map((panel, index) => {
      const actualPosition = panel.getPosition();
      const position = panel.getPreferredPosition?.() ?? panel.getPosition();
      return {
        id: panel.id,
        x: actualPosition.x,
        y: actualPosition.y,
        preferredX: position.x,
        preferredY: position.y,
        width: panel.getSize?.().width ?? panel.element.offsetWidth,
        height: panel.getSize?.().height ?? panel.element.offsetHeight,
        locked: panel.locked,
        priority: panel.priority ?? index,
        fixed: panel.fixed,
        bottomInset: panel.bottomInset,
        firmHeight: panel.firmHeight,
        reading: panel.reading ?? GAME_READING_PANEL_IDS.has(panel.id),
        stackGroup: panel.stackGroup ?? null,
        setPosition: panel.setPosition,
        setHeightLimit: panel.setHeightLimit,
      } satisfies GamePanelLayoutItem;
    });
    const overflow = resolveGamePanelLayout(items, {
      width: surface.clientWidth,
      height: surface.clientHeight,
      allowOverlap: !gamePanelCollisionsEnabled(),
    });
    if (overflow) {
      surface.dataset.gamePanelOverflow = "true";
    } else delete surface.dataset.gamePanelOverflow;
    surface.dispatchEvent(new Event(GAME_PANEL_LAYOUT_PASS_EVENT));
  });
  scheduled.set(surface, frame);
}
