// ──────────────────────────────────────────────
// Usage dashboard helpers (pure, DOM-free)
// ──────────────────────────────────────────────
import type { UsageConnectionPrice, UsageTotals } from "@marinara-engine/shared";

export type UsageRangePreset = "7d" | "30d" | "90d";

export const USAGE_RANGE_PRESET_DAYS: Record<UsageRangePreset, number> = { "7d": 7, "30d": 30, "90d": 90 };

/** YYYY-MM-DD for the given date in the viewer's local calendar. */
export function localDayString(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Inclusive local-day range ending today that spans `days` days. */
export function presetUsageRange(days: number, today: Date = new Date()): { from: string; to: string } {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1));
  return { from: localDayString(start), to: localDayString(today) };
}

/** Estimated cost from per-1M-token prices; null when neither price is set. */
export function estimateUsageCost(
  totals: Pick<UsageTotals, "inputTokens" | "outputTokens">,
  price: UsageConnectionPrice | null | undefined,
): number | null {
  if (!price || (price.input == null && price.output == null)) return null;
  return (
    (totals.inputTokens / 1_000_000) * (price.input ?? 0) + (totals.outputTokens / 1_000_000) * (price.output ?? 0)
  );
}

/** Compact token count: 950, 12.4K, 3.1M. */
export function formatTokenCount(value: number): string {
  if (value < 1000) return String(value);
  const units: Array<[number, string]> = [
    [1_000_000_000, "B"],
    [1_000_000, "M"],
    [1_000, "K"],
  ];
  for (const [size, suffix] of units) {
    if (value >= size) {
      const scaled = value / size;
      return `${scaled >= 100 ? Math.round(scaled) : Number(scaled.toFixed(1))}${suffix}`;
    }
  }
  return String(value);
}

export function formatUsageCost(value: number, currency: string): string {
  const digits = value > 0 && value < 1 ? 4 : 2;
  return `${currency}${value.toFixed(digits)}`;
}

/** Parses a price field; blank means "no price". Returns undefined for invalid input. */
export function parsePriceDraft(value: string): number | null | undefined {
  const trimmed = value.trim().replace(",", ".");
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100_000 ? parsed : undefined;
}
