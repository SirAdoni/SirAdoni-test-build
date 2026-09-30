/** Legacy coordinates remain valid; the original viewport spans 100 world units. */
export const MAP_GRID_STEP = 5;
export function snapMapCoordinate(value: number): number {
  return Math.round(value / MAP_GRID_STEP) * MAP_GRID_STEP;
}
