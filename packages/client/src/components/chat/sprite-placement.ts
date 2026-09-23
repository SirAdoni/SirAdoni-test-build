import type { SpritePlacement, SpriteSide } from "@marinara-engine/shared";

export type SpritePlacementMap = Record<string, SpritePlacement>;

const MIN_X = 10;
const MAX_X = 90;
const MIN_Y = 46;
const MAX_Y = 98;

export function clampSpritePlacement(placement: SpritePlacement): SpritePlacement {
  return {
    x: Math.max(MIN_X, Math.min(MAX_X, placement.x)),
    y: Math.max(MIN_Y, Math.min(MAX_Y, placement.y)),
  };
}

export function normalizeSpritePlacements(raw: unknown): SpritePlacementMap {
  if (!raw || typeof raw !== "object") return {};

  const entries = Object.entries(raw as Record<string, unknown>)
    .map(([characterId, value]) => {
      if (!value || typeof value !== "object") return null;
      const x = Number((value as { x?: unknown }).x);
      const y = Number((value as { y?: unknown }).y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return [characterId, clampSpritePlacement({ x, y })] as const;
    })
    .filter((entry): entry is readonly [string, SpritePlacement] => entry !== null);

  return Object.fromEntries(entries);
}

export function mirrorSpritePlacements(
  placements: SpritePlacementMap,
  excludedCharacterIds: readonly string[] = [],
): SpritePlacementMap {
  return Object.fromEntries(
    Object.entries(placements).map(([placementKey, placement]) => {
      const excluded = excludedCharacterIds.some(
        (characterId) => placementKey === characterId || placementKey.startsWith(`${characterId}:`),
      );
      return [placementKey, excluded ? placement : clampSpritePlacement({ x: 100 - placement.x, y: placement.y })];
    }),
  );
}

export function mirrorCharacterSpritePlacements(
  placements: SpritePlacementMap,
  characterId: string,
): SpritePlacementMap {
  return Object.fromEntries(
    Object.entries(placements).map(([placementKey, placement]) => [
      placementKey,
      placementKey === characterId || placementKey.startsWith(`${characterId}:`)
        ? clampSpritePlacement({ x: 100 - placement.x, y: placement.y })
        : placement,
    ]),
  );
}

export function getDefaultSpritePlacement(index: number, total: number, side: SpriteSide | "center"): SpritePlacement {
  const layouts: Record<string, number[][]> = {
    left: [[26], [22, 42], [18, 34, 50]],
    right: [[74], [58, 78], [50, 66, 82]],
    center: [[50], [35, 65], [25, 50, 75]],
  };

  if (total > 3) {
    const start = side === "right" ? 86 : 14;
    const end = side === "right" ? 14 : 86;
    const x = start + ((end - start) * index) / (total - 1);
    const y = 98 - (index % 4) * 1.5;
    return clampSpritePlacement({ x, y });
  }

  const byCount = layouts[side][Math.max(0, total - 1)] ?? layouts[side][0];
  const x = byCount[index] ?? (side === "left" ? 26 + index * 16 : 74 - index * 16);
  const yOffsets = total >= 3 ? [98, 96, 94] : total === 2 ? [98, 96] : [98];
  const y = yOffsets[index] ?? 98;

  return clampSpritePlacement({ x, y });
}
