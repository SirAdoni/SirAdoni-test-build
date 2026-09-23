/**
 * Per-device arrangement of inline Game mode widgets on phones and small tablets (below 1024px).
 * Stored under its own key prefix so desktop floating layouts are never touched.
 */
export interface MobilePanelArrangement {
  order: string[];
  hidden: string[];
  /** Widgets that open as full cards in the vertical choice rails instead of pills. */
  expanded: string[];
}

export const MOBILE_PANEL_ARRANGEMENT_PREFIX = "marinara-game-panel-mobile";

export function mobileArrangementKey(scopeId: string) {
  return `${MOBILE_PANEL_ARRANGEMENT_PREFIX}:${scopeId}:arrangement`;
}

export function emptyMobileArrangement(): MobilePanelArrangement {
  return { order: [], hidden: [], expanded: [] };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string"))] : [];
}

export function parseMobileArrangement(raw: string | null | undefined): MobilePanelArrangement {
  if (!raw) return emptyMobileArrangement();
  try {
    const parsed = JSON.parse(raw) as Partial<Record<keyof MobilePanelArrangement, unknown>>;
    return {
      order: stringList(parsed?.order),
      hidden: stringList(parsed?.hidden),
      expanded: stringList(parsed?.expanded),
    };
  } catch {
    return emptyMobileArrangement();
  }
}

/** Full order for the current ids: saved ids first (in saved order), then new ids in their natural order. */
export function orderMobileIds(ids: readonly string[], arrangement: MobilePanelArrangement): string[] {
  const present = new Set(ids);
  const saved = arrangement.order.filter((id) => present.has(id));
  const savedSet = new Set(saved);
  return [...saved, ...ids.filter((id) => !savedSet.has(id))];
}

/** Ordered ids with hidden ones removed. */
export function visibleMobileIds(ids: readonly string[], arrangement: MobilePanelArrangement): string[] {
  const hidden = new Set(arrangement.hidden);
  return orderMobileIds(ids, arrangement).filter((id) => !hidden.has(id));
}

/** Moves one id to an index within `ids`; ids outside `ids` (the other rail, absent widgets) keep their saved order. */
export function moveMobileItemTo(
  ids: readonly string[],
  arrangement: MobilePanelArrangement,
  id: string,
  index: number,
): MobilePanelArrangement {
  const order = orderMobileIds(ids, arrangement);
  const from = order.indexOf(id);
  if (from < 0) return arrangement;
  const to = Math.max(0, Math.min(order.length - 1, Math.round(index)));
  if (to === from) return arrangement;
  order.splice(to, 0, ...order.splice(from, 1));
  const present = new Set(ids);
  return { ...arrangement, order: [...order, ...arrangement.order.filter((item) => !present.has(item))] };
}

export function moveMobileItem(
  ids: readonly string[],
  arrangement: MobilePanelArrangement,
  id: string,
  delta: number,
): MobilePanelArrangement {
  const from = orderMobileIds(ids, arrangement).indexOf(id);
  return from < 0 ? arrangement : moveMobileItemTo(ids, arrangement, id, from + delta);
}

function toggle(list: string[], id: string, on: boolean) {
  const rest = list.filter((item) => item !== id);
  return on ? [...rest, id] : rest;
}

export function setMobileItemHidden(arrangement: MobilePanelArrangement, id: string, hidden: boolean) {
  return { ...arrangement, hidden: toggle(arrangement.hidden, id, hidden) };
}

export function setMobileItemExpanded(arrangement: MobilePanelArrangement, id: string, expanded: boolean) {
  return { ...arrangement, expanded: toggle(arrangement.expanded, id, expanded) };
}
