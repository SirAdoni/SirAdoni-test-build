// ──────────────────────────────────────────────
// Relative timestamp formatting
// ──────────────────────────────────────────────
import { i18n } from "../localization/i18n";

/** One formatter per locale — constructing an Intl formatter is the expensive part. */
const formatters = new Map<string, Intl.RelativeTimeFormat>();

function formatterFor(locale: string) {
  let formatter = formatters.get(locale);
  if (!formatter) {
    formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "narrow" });
    formatters.set(locale, formatter);
  }
  return formatter;
}

/**
 * "now" / "5m ago" / "3d ago" for an ISO timestamp, in the active UI language.
 * Returns null for unparseable input.
 */
export function formatRelativeContact(isoTimestamp: string, now = Date.now()): string | null {
  const timestamp = new Date(isoTimestamp).getTime();
  if (!Number.isFinite(timestamp)) return null;

  const format = formatterFor(i18n.resolvedLanguage ?? i18n.language ?? "en");
  const diffMs = now - timestamp;
  if (diffMs < 60_000) return format.format(0, "second");

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return format.format(-minutes, "minute");

  const hours = Math.floor(diffMs / 3_600_000);
  if (hours < 24) return format.format(-hours, "hour");

  const days = Math.floor(diffMs / 86_400_000);
  if (days < 7) return format.format(-days, "day");

  const weeks = Math.floor(days / 7);
  if (weeks < 5) return format.format(-weeks, "week");

  const months = Math.floor(days / 30);
  if (months < 12) return format.format(-months, "month");

  return format.format(-Math.floor(days / 365), "year");
}
