// Applies Tidy and multi-select align from the Layout toolbar. Measures the
// floating panels, runs the pure helpers in game-layout-tidy.ts and writes the
// result into a copy of the scope's layout snapshot (one undo step).
import { LAYOUT_PANEL_GAP, findNearestFreePosition, rectsOverlap, type LayoutRect } from "./game-layout-geometry";
import type { LayoutSnapshot } from "./game-layout-snapshots";
import { GAME_READING_PANEL_IDS, gameReadingPanelFloor } from "./game-panel-layout";
import { TIDY_MIN_HEIGHT, alignPanels, tidyLayout, type AlignMode, type TidyItem } from "./game-layout-tidy";

export interface MeasuredPanel {
  id: string;
  rect: LayoutRect;
  locked: boolean;
}

export type ArrangeMode = "tidy" | AlignMode;

interface Block extends TidyItem {
  members: MeasuredPanel[];
}

/** Stacked panels (same stack group) move as one block; a block with any locked member stays put. */
function buildBlocks(panels: MeasuredPanel[], stacks: Record<string, string>, surfaceHeight: number): Block[] {
  const groups = new Map<string, MeasuredPanel[]>();
  for (const panel of panels) {
    const key = stacks[panel.id] ? `stack:${stacks[panel.id]}` : panel.id;
    groups.set(key, [...(groups.get(key) ?? []), panel]);
  }
  return [...groups.entries()].map(([id, members]) => {
    const left = Math.min(...members.map((m) => m.rect.x));
    const top = Math.min(...members.map((m) => m.rect.y));
    const right = Math.max(...members.map((m) => m.rect.x + m.rect.width));
    const bottom = Math.max(...members.map((m) => m.rect.y + m.rect.height));
    const height = bottom - top;
    const single = members.length === 1 ? members[0]! : null;
    const minHeight = !single
      ? height
      : GAME_READING_PANEL_IDS.has(single.id)
        ? gameReadingPanelFloor(surfaceHeight)
        : TIDY_MIN_HEIGHT;
    return {
      id,
      members,
      rect: { x: left, y: top, width: right - left, height },
      locked: members.some((m) => m.locked),
      minHeight,
    };
  });
}

/** Slide a rect along one axis only (keeping the aligned edge) to the nearest spot clear of obstacles. */
function settleAlongAxis(
  rect: LayoutRect,
  obstacles: LayoutRect[],
  bounds: { width: number; height: number },
  axis: "x" | "y",
): LayoutRect | null {
  const size = axis === "x" ? rect.width : rect.height;
  const max = (axis === "x" ? bounds.width : bounds.height) - size;
  const start = rect[axis];
  const candidates = [start, 0, max];
  for (const other of obstacles) {
    const low = axis === "x" ? other.x : other.y;
    const extent = axis === "x" ? other.width : other.height;
    candidates.push(low + extent + LAYOUT_PANEL_GAP, low - size - LAYOUT_PANEL_GAP);
  }
  const sorted = candidates
    .filter((value) => value >= 0 && value <= max)
    .sort((a, b) => Math.abs(a - start) - Math.abs(b - start));
  for (const value of sorted) {
    const next = { ...rect, [axis]: value };
    if (!obstacles.some((other) => rectsOverlap(next, other))) return next;
  }
  // No clean slot on that axis: fall back to the nearest free spot anywhere.
  const free = findNearestFreePosition(rect, obstacles, bounds);
  return free ? { ...rect, ...free } : null;
}

/** New rect for every panel that changes. */
export function arrangePanels(
  mode: ArrangeMode,
  panels: MeasuredPanel[],
  options: {
    bounds: { width: number; height: number };
    stacks?: Record<string, string>;
    selection?: string[];
    collisions?: boolean;
  },
): Map<string, LayoutRect> {
  const { bounds } = options;
  const blocks = buildBlocks(panels, options.stacks ?? {}, bounds.height);
  const blockOf = (panelId: string) => blocks.find((block) => block.members.some((m) => m.id === panelId));
  let placed: Map<string, LayoutRect>;
  if (mode === "tidy") placed = tidyLayout(blocks, bounds);
  else {
    const chosen: Block[] = [];
    for (const id of options.selection ?? []) {
      const block = blockOf(id);
      if (block && !chosen.includes(block)) chosen.push(block);
    }
    placed = alignPanels(chosen, mode, bounds, chosen[0]?.id);
    if (options.collisions !== false) {
      // Settle each aligned block clear of everything else, in top-to-bottom order.
      // Blocks that did not move (the reference edge, for example) are obstacles from the start.
      const moved = new Set(
        [...placed.entries()]
          .filter(([id, rect]) => {
            const from = blocks.find((block) => block.id === id)!.rect;
            return rect.x !== from.x || rect.y !== from.y || rect.width !== from.width;
          })
          .map(([id]) => id),
      );
      const obstacles = blocks.filter((block) => !moved.has(block.id)).map((block) => block.rect);
      for (const [id, rect] of [...placed.entries()].filter(([id]) => moved.has(id)).sort((a, b) => a[1].y - b[1].y)) {
        if (obstacles.some((other) => rectsOverlap(rect, other))) {
          const free = settleAlongAxis(rect, obstacles, bounds, mode === "top" ? "x" : "y");
          if (free) placed.set(id, free);
        }
        obstacles.push(placed.get(id)!);
      }
    }
  }
  const result = new Map<string, LayoutRect>();
  for (const block of blocks) {
    const next = placed.get(block.id);
    if (!next || block.locked) continue;
    const dx = next.x - block.rect.x;
    const dy = next.y - block.rect.y;
    for (const member of block.members) {
      const rect: LayoutRect = {
        x: Math.round(member.rect.x + dx),
        y: Math.round(member.rect.y + dy),
        width: block.members.length === 1 || mode === "matchWidth" ? Math.round(next.width) : member.rect.width,
        height: block.members.length === 1 ? Math.round(next.height) : member.rect.height,
      };
      if (
        rect.x !== Math.round(member.rect.x) ||
        rect.y !== Math.round(member.rect.y) ||
        rect.width !== Math.round(member.rect.width) ||
        rect.height !== Math.round(member.rect.height)
      )
        result.set(member.id, rect);
    }
  }
  return result;
}

function parse(raw: string | undefined): Record<string, unknown> {
  try {
    const value = JSON.parse(raw ?? "null");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/** Write arranged rects into a copy of the snapshot, in the keys the panels read on mount. */
export function writeArrangedSnapshot(
  snapshot: LayoutSnapshot,
  before: MeasuredPanel[],
  changes: Map<string, LayoutRect>,
  bounds: { width: number; height: number },
): LayoutSnapshot {
  const entries = { ...snapshot.entries };
  for (const [id, rect] of changes) {
    const old = before.find((panel) => panel.id === id)?.rect;
    const positionKey = `panel:floating:${id}`;
    const maxX = Math.max(0, bounds.width - rect.width);
    const maxY = Math.max(0, bounds.height - rect.height);
    entries[positionKey] = JSON.stringify({
      ...parse(entries[positionKey]),
      locked: false,
      x: rect.x,
      y: rect.y,
      bottom: rect.y + rect.height,
      relativeX: maxX > 0 ? Math.min(1, rect.x / maxX) : 0,
      relativeY: maxY > 0 ? Math.min(1, rect.y / maxY) : 0,
      surfaceWidth: bounds.width,
      surfaceHeight: bounds.height,
    });
    const widthChanged = !!old && Math.round(old.width) !== rect.width;
    const heightShrunk = !!old && rect.height < Math.round(old.height);
    if (!widthChanged && !heightShrunk) continue;
    const sizeKey = `${positionKey}:size-v2`;
    const size = parse(entries[sizeKey]);
    const next: Record<string, unknown> = { ...size, width: Number.isFinite(size.width) ? size.width : rect.width };
    if (widthChanged) Object.assign(next, { width: rect.width, manualWidth: true });
    if (heightShrunk) {
      next.height = rect.height;
      entries[`${sizeKey}:growth`] = "fixed";
      entries[`${sizeKey}:growth-explicit`] = "true";
    }
    entries[sizeKey] = JSON.stringify(next);
  }
  return { entries };
}

/** Measure every visible floating panel against the surface. Tucked or non-editable panels count as locked. */
export function measureFloatingPanels(surface: HTMLElement): MeasuredPanel[] {
  const host = surface.getBoundingClientRect();
  return [...surface.querySelectorAll<HTMLElement>("[data-game-floating-panel]")].flatMap((element) => {
    const id = element.dataset.gameFloatingPanel;
    const box = element.getBoundingClientRect();
    if (!id || box.width <= 0 || box.height <= 0) return [];
    return [
      {
        id,
        rect: { x: box.left - host.left, y: box.top - host.top, width: box.width, height: box.height },
        locked: element.dataset.layoutEditing !== "true" || element.dataset.layoutLocked === "true",
      },
    ];
  });
}
