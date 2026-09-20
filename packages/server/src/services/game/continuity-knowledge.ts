import type { GameContinuityRecord } from "@marinara-engine/shared";

export type ContinuityAudience = { kind: "gm" } | { kind: "character"; name: string; aliases?: string[] };

function normalizeName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

/** GM may inspect all records; characters receive only records held by them. */
export function selectContinuityRecordsForAudience<T extends GameContinuityRecord>(
  records: readonly T[],
  audience: ContinuityAudience,
): T[] {
  if (audience.kind === "gm") return [...records];
  const names = new Set([audience.name, ...(audience.aliases ?? [])].map(normalizeName).filter(Boolean));
  if (names.size === 0) return [];
  return records.filter((record) => {
    if (!record.knowledge || record.knowledge.scope === "unknown") return false;
    const holders = record.knowledge?.holders ?? [];
    return holders.some((holder) => names.has(normalizeName(holder)));
  });
}
