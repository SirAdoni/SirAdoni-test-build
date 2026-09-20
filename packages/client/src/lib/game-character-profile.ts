import type { RPGStatPool } from "@marinara-engine/shared";
import { normalizeRpgStatAttributes, normalizeRpgStatPools } from "@marinara-engine/shared";

export interface GameCharacterLibraryRpgStats {
  attributes: Array<{ name: string; value: number }>;
  hp?: { value: number; max: number };
  pools: RPGStatPool[];
}

export interface GameCharacterLibraryProfile {
  description?: string;
  personality?: string;
  backstory?: string;
  appearance?: string;
  aboutMe?: string;
  rpgStats?: GameCharacterLibraryRpgStats;
  level?: number;
}

function finiteNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
}

export function normalizeGameCharacterLibraryProfile(raw: Record<string, unknown>): GameCharacterLibraryProfile {
  const extensions =
    raw.extensions && typeof raw.extensions === "object" && !Array.isArray(raw.extensions)
      ? (raw.extensions as Record<string, unknown>)
      : {};
  const rawRpg =
    extensions.rpgStats && typeof extensions.rpgStats === "object" && !Array.isArray(extensions.rpgStats)
      ? (extensions.rpgStats as Record<string, unknown>)
      : null;

  let rpgStats: GameCharacterLibraryRpgStats | undefined;
  if (rawRpg?.enabled === true) {
    const attributes = normalizeRpgStatAttributes(rawRpg.attributes);
    const rawHp =
      rawRpg.hp && typeof rawRpg.hp === "object" && !Array.isArray(rawRpg.hp)
        ? (rawRpg.hp as Record<string, unknown>)
        : null;
    const hpMax = finiteNumber(rawHp?.max);
    const hpValue = finiteNumber(rawHp?.value ?? rawHp?.current);
    const hp =
      hpMax !== null && hpMax > 0 && hpValue !== null
        ? { value: Math.max(0, Math.min(hpMax, hpValue)), max: hpMax }
        : undefined;
    const rawPools = Array.isArray(rawRpg.pools)
      ? rawRpg.pools.filter((pool) => {
          if (!pool || typeof pool !== "object" || Array.isArray(pool)) return false;
          const candidate = pool as Record<string, unknown>;
          const value = finiteNumber(candidate.value ?? candidate.current);
          const max = finiteNumber(candidate.max);
          return (
            typeof candidate.name === "string" &&
            candidate.name.trim().length > 0 &&
            value !== null &&
            max !== null &&
            max > 0
          );
        })
      : [];
    const pools =
      rawPools.length > 0
        ? normalizeRpgStatPools({ hp: hp ?? { value: 0, max: 1 }, pools: rawPools as RPGStatPool[] })
        : [];
    const hasExplicitHpPool = pools.some((pool) =>
      /^(?:hp|health|health points?|hit points?)$/i.test(pool.name.trim()),
    );
    const displayPools =
      hp && !hasExplicitHpPool ? [{ name: "HP", value: hp.value, max: hp.max, color: "#ef4444" }, ...pools] : pools;
    if (attributes.length > 0 || hp || displayPools.length > 0) {
      rpgStats = { attributes, ...(hp ? { hp } : {}), pools: displayPools };
    }
  }

  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  const levelAttribute = rpgStats?.attributes.find((attribute) => /^(?:level|lvl)$/i.test(attribute.name));
  const level = finiteNumber(extensions.level ?? raw.level ?? levelAttribute?.value);
  return {
    description: text(raw.description),
    personality: text(raw.personality),
    backstory: text(extensions.backstory),
    appearance: text(extensions.appearance),
    aboutMe: text(extensions.aboutMe),
    ...(rpgStats ? { rpgStats } : {}),
    ...(level !== null && level > 0 ? { level } : {}),
  };
}
