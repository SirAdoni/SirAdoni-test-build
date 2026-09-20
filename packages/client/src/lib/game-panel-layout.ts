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
  /** Panels sharing a stack move and resolve as one vertical group. */
  stackGroup?: string | null;
  stackOrder?: number;
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
      if (distance === 0) return origin < min || origin > max ? null : [-Infinity, Infinity];
      const first = (min - origin) / distance;
      const second = (max - origin) / distance;
      return [Math.min(first, second), Math.max(first, second)];
    };
    const xTimes = axisTimes(start.x, delta.x, obstacle.x - size.width, obstacle.x + obstacle.width);
    const yTimes = axisTimes(start.y, delta.y, obstacle.y - size.height, obstacle.y + obstacle.height);
    if (!xTimes || !yTimes) continue;
    const entry = Math.max(xTimes[0], yTimes[0], 0);
    const exit = Math.min(xTimes[1], yTimes[1], 1);
    if (entry <= exit && exit >= 0 && entry <= 1) earliest = Math.min(earliest, entry);
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

/** Resolve sibling collisions without changing the saved position of panels that already fit. */
export function resolveGamePanelLayout(items: GamePanelLayoutItem[], bounds: GamePanelLayoutBounds): boolean {
  const layoutItems = collapseStackGroups(items);
  // Prefer full panels. If the screen is crowded, retry with bounded reading
  // windows; only panel contents scroll, and saved sizes remain untouched.
  for (const cap of [...new Set([bounds.height, bounds.height / 2, bounds.height / 3, bounds.height / 4, 64])]) {
    const result = layoutItems.map((item) => ({
      x: item.x,
      y: item.y,
      height: Math.min(item.height, Math.max(64, bounds.height - (item.bottomInset ?? 0))),
    }));
    const overflow = resolvePanelPositions(
      layoutItems.map((item, index) => ({
        ...item,
        height: item.setHeightLimit ? Math.min(item.height, Math.max(64, cap - (item.bottomInset ?? 0))) : item.height,
        setPosition: (x, y) => {
          result[index]!.x = x;
          result[index]!.y = y;
        },
        setHeightLimit: item.setHeightLimit
          ? (height) => {
              result[index]!.height = height;
            }
          : undefined,
      })),
      bounds,
    );
    if (overflow) continue;
    layoutItems.forEach((item, index) => {
      const resolved = result[index]!;
      item.setHeightLimit?.(resolved.height);
      if (item.stackGroup || Math.abs(item.x - resolved.x) > 0.5 || Math.abs(item.y - resolved.y) > 0.5)
        item.setPosition(resolved.x, resolved.y);
    });
    return false;
  }
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

function resolvePanelPositions(items: GamePanelLayoutItem[], bounds: GamePanelLayoutBounds): boolean {
  const gap = bounds.gap ?? 8;
  const placed: GamePanelLayoutItem[] = [];
  const ordered = items
    .map((item) => ({ ...item, height: Math.min(item.height, bounds.height) }))
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

  let overflow = false;
  for (const source of ordered) {
    const anchorX = Number.isFinite(source.preferredX) ? source.preferredX! : source.x;
    const anchorY =
      source.bottomInset != null
        ? Math.max(0, bounds.height - source.height - source.bottomInset)
        : Number.isFinite(source.preferredY)
          ? source.preferredY!
          : source.y;
    let current = clamp({ ...source, x: anchorX, y: anchorY }, bounds);
    if (!source.fixed && placed.some((item) => intersects(current, item, gap))) {
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
      if (!best && source.setHeightLimit) {
        for (const x of xs)
          for (const y of ys) {
            let height = Math.min(source.height, bounds.height - y);
            for (const item of placed) {
              if (x >= item.x + item.width + gap || x + source.width + gap <= item.x || y >= item.y + item.height + gap)
                continue;
              height = Math.min(height, item.y - gap - y);
            }
            if (height < Math.min(64, source.height)) continue;
            const candidate = { ...source, x, y, height };
            const score = (item: GamePanelLayoutItem) => distance(item) + (source.height - item.height) * 2;
            if (!best || score(candidate) < score(best)) best = candidate;
          }
      }
      if (best) current = best;
      else overflow = true;
    }
    source.setHeightLimit?.(current.height);
    placed.push(current);
    if (Math.abs(current.x - source.x) > 0.5 || Math.abs(current.y - source.y) > 0.5)
      source.setPosition(current.x, current.y);
  }
  return overflow;
}

type RegisteredPanel = Omit<GamePanelLayoutItem, "width" | "height" | "x" | "y" | "setPosition" | "priority"> & {
  element: HTMLElement;
  getPosition: () => { x: number; y: number };
  /** The user's saved/manual position, excluding temporary collision reflow. */
  getPreferredPosition?: () => { x: number; y: number };
  getSize?: () => { width: number; height: number };
  setPosition: (x: number, y: number) => void;
  setPreferredPosition?: () => void;
  priority?: number;
  fixed?: boolean;
  bottomInset?: number;
};

const registries = new WeakMap<HTMLElement, Map<string, RegisteredPanel>>();
const scheduled = new WeakMap<HTMLElement, number>();
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
  return () => {
    registry?.delete(panel.id);
    if (!registry?.size) restoreSurfaceOverflow(surface);
    scheduleGamePanelLayout(surface);
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
    if (groupId && member.stackGroup === groupId) member.setPreferredPosition?.();
  }
}

export function scheduleGamePanelLayout(surface: HTMLElement): void {
  if (scheduled.has(surface)) return;
  const frame = requestAnimationFrame(() => {
    scheduled.delete(surface);
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
        setPosition: panel.setPosition,
        setHeightLimit: panel.setHeightLimit,
      } satisfies GamePanelLayoutItem;
    });
    const overflow = resolveGamePanelLayout(items, { width: surface.clientWidth, height: surface.clientHeight });
    if (overflow) {
      surface.dataset.gamePanelOverflow = "true";
    } else delete surface.dataset.gamePanelOverflow;
  });
  scheduled.set(surface, frame);
}
