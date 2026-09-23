import type { RPGStatPool, RPGStatsConfig } from "../types/character.js";

export const DEFAULT_RPG_STAT_POOLS: readonly RPGStatPool[] = [
  { name: "HP", value: 100, max: 100, color: "#ef4444" },
  { name: "MP", value: 100, max: 100, color: "#3b82f6" },
];

export type RPGStatAttribute = RPGStatsConfig["attributes"][number];

/**
 * Coerce persisted attribute data into the canonical `[{ name, value }]` array.
 * Imported character cards and model output frequently store attributes as a
 * plain map (`{ "STR": 18, "DEX": 10 }`); iterating that shape with `for...of`
 * or spread crashes with "object is not iterable", so every consumer must read
 * attributes through this normalizer instead of trusting the declared type.
 * Entries without a usable name or finite numeric value are dropped.
 */
export function normalizeRpgStatAttributes(raw: unknown): RPGStatAttribute[] {
  const entries: Array<[unknown, unknown]> = Array.isArray(raw)
    ? raw.map((entry) => {
        const record = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
        return [record?.name, record?.value] as [unknown, unknown];
      })
    : raw && typeof raw === "object"
      ? Object.entries(raw as Record<string, unknown>)
      : [];

  const attributes: RPGStatAttribute[] = [];
  for (const [rawName, rawValue] of entries) {
    const name = typeof rawName === "string" ? rawName.trim() : "";
    if (!name) continue;
    const value =
      typeof rawValue === "number"
        ? rawValue
        : typeof rawValue === "string" && rawValue.trim()
          ? Number(rawValue)
          : Number.NaN;
    if (!Number.isFinite(value)) continue;
    attributes.push({ name, value });
  }
  return attributes;
}

const HP_NAME_RE = /^(?:hp|health|health points?|hit points?)$/i;

function finiteNumber(value: unknown, fallback: number, min = 0): number {
  const numeric =
    typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(numeric) ? Math.max(min, numeric) : fallback;
}

function normalizePool(value: unknown, fallback: RPGStatPool): RPGStatPool | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Partial<RPGStatPool> & { current?: unknown };
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : fallback.name;
  const max = finiteNumber(raw.max, fallback.max, 1);
  const valueNumber = Math.min(max, finiteNumber(raw.value ?? raw.current, fallback.value, 0));
  const color = typeof raw.color === "string" && /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color : fallback.color;
  const { current: _legacyCurrent, ...canonical } = raw;
  // Canonical known fields win, but valid extension metadata is part of the
  // accepted persisted shape and must survive routine pool edits.
  return { ...canonical, name, value: valueNumber, max, color };
}

export function createDefaultRpgStatPools(): RPGStatPool[] {
  return DEFAULT_RPG_STAT_POOLS.map((pool) => ({ ...pool }));
}

export function normalizeRpgStatPools(
  rpgStats: Pick<RPGStatsConfig, "hp" | "pools"> | null | undefined,
): RPGStatPool[] {
  if (Array.isArray(rpgStats?.pools) && rpgStats.pools.length > 0) {
    return rpgStats.pools
      .map((pool, index) => normalizePool(pool, DEFAULT_RPG_STAT_POOLS[index] ?? DEFAULT_RPG_STAT_POOLS[0]!))
      .filter((pool): pool is RPGStatPool => !!pool);
  }

  const hp = rpgStats?.hp as (RPGStatsConfig["hp"] & { current?: unknown }) | undefined;
  const hpMax = finiteNumber(hp?.max, 100, 1);
  const hpValue = Math.min(hpMax, finiteNumber(hp?.value ?? hp?.current ?? hp?.max, hpMax, 0));
  return [{ name: "HP", value: hpValue, max: hpMax, color: "#ef4444" }];
}

export function syncRpgHpFromPools(
  pools: readonly RPGStatPool[],
  fallbackHp: RPGStatsConfig["hp"] = { value: 100, max: 100 },
): RPGStatsConfig["hp"] {
  const hpPool = pools.find((pool) => HP_NAME_RE.test(pool.name.trim())) ?? pools[0];
  if (!hpPool) return fallbackHp;
  return {
    ...fallbackHp,
    value: Math.max(0, Math.min(Math.max(1, Number(hpPool.max) || 1), Number(hpPool.value) || 0)),
    max: Math.max(1, Number(hpPool.max) || 1),
  };
}

export function formatRpgStatsForPrompt(rpgStats: RPGStatsConfig | undefined): string {
  if (!rpgStats?.enabled) return "";
  const lines: string[] = [];
  const pools = normalizeRpgStatPools(rpgStats);
  if (pools.length > 0) {
    lines.push(...pools.map((pool) => `${pool.name}: ${pool.value}/${pool.max}`));
  } else {
    lines.push(`Max HP: ${rpgStats.hp.max}`);
  }
  const attributes = normalizeRpgStatAttributes(rpgStats.attributes);
  if (attributes.length > 0) {
    lines.push(attributes.map((attribute) => `${attribute.name}: ${attribute.value}`).join(", "));
  }
  return lines.join("\n");
}
