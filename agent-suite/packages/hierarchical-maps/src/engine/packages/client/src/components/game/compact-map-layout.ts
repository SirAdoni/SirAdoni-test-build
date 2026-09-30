export interface CompactMapLocation {
  id: string;
  parentId?: string | null;
  links?: readonly { targetId: string; bidirectional?: boolean; state?: string }[];
}

export interface MapPlacement {
  x: number;
  y: number;
}

/** Keep compact runtime maps inside the currently browsed hierarchy level. */
export function getCompactMapLocations<T extends CompactMapLocation>(
  activeLocations: readonly T[],
  visibleLocations: readonly T[],
  currentLocationId: string | null,
  viewLocationId: string | null,
  showAllCompact: boolean,
): T[] {
  if (showAllCompact) return [...visibleLocations];

  // World view is the synthetic root and must always show its own roots,
  // regardless of where the story is currently located.
  if (viewLocationId === null) return [...visibleLocations];

  const current = currentLocationId
    ? (activeLocations.find((location) => location.id === currentLocationId) ?? null)
    : null;

  const visibleIds = new Set(visibleLocations.map((location) => location.id));
  if (!current || (current.id !== viewLocationId && !visibleIds.has(current.id))) return [...visibleLocations];

  const focusedIds = new Set<string>([current.id]);
  for (const location of visibleLocations) {
    if (location.parentId === current.id) focusedIds.add(location.id);
    if (
      location.links?.some((link) => link.targetId === current.id && link.bidirectional && link.state === "available")
    ) {
      focusedIds.add(location.id);
    }
  }
  for (const link of current.links ?? []) {
    if (link.state !== "available" || !visibleIds.has(link.targetId)) continue;
    focusedIds.add(link.targetId);
  }
  return activeLocations.filter((location) => focusedIds.has(location.id));
}

/** Stable display-only positions for the compact runtime map. */
export function focusedMapPlacement(
  locations: readonly CompactMapLocation[],
  currentLocationId: string | null,
  locationId: string,
): MapPlacement {
  if (locationId === currentLocationId) return { x: 50, y: 50 };
  const neighbors = locations.filter((location) => location.id !== currentLocationId);
  const neighborIndex = neighbors.findIndex((location) => location.id === locationId);
  const angle = (neighborIndex * 2 * Math.PI) / Math.max(1, neighbors.length);
  return {
    x: 50 + Math.cos(angle) * 32,
    y: 50 + Math.sin(angle) * 28,
  };
}
