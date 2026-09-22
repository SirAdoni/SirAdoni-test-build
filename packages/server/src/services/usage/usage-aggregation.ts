// ──────────────────────────────────────────────
// Usage dashboard aggregation (pure)
// ──────────────────────────────────────────────
import {
  USAGE_DASHBOARD_MAX_RANGE_DAYS,
  type UsageChatBucket,
  type UsageConnectionBucket,
  type UsageDayBucket,
  type UsageSummary,
  type UsageTotals,
} from "@marinara-engine/shared";

const DAY_MS = 86_400_000;

export interface UsageLedgerRow {
  chatId: string | null;
  connectionId: string | null;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  createdAt: string;
}

export interface UsageRange {
  from: string;
  to: string;
  /** Inclusive UTC bounds matching the viewer's local days. */
  fromIso: string;
  toIso: string;
  days: string[];
}

function dayStartUtcMs(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

/**
 * Resolves local calendar days into inclusive UTC ISO bounds. The range is
 * swapped when reversed and clamped to USAGE_DASHBOARD_MAX_RANGE_DAYS ending at `to`.
 */
export function resolveUsageRange(from: string, to: string, tzOffsetMinutes: number): UsageRange | null {
  let startMs = dayStartUtcMs(from);
  let endMs = dayStartUtcMs(to);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  if (startMs > endMs) [startMs, endMs] = [endMs, startMs];
  const maxSpan = (USAGE_DASHBOARD_MAX_RANGE_DAYS - 1) * DAY_MS;
  if (endMs - startMs > maxSpan) startMs = endMs - maxSpan;
  const offsetMs = tzOffsetMinutes * 60_000;
  const days: string[] = [];
  for (let ms = startMs; ms <= endMs; ms += DAY_MS) days.push(new Date(ms).toISOString().slice(0, 10));
  return {
    from: days[0]!,
    to: days[days.length - 1]!,
    fromIso: new Date(startMs - offsetMs).toISOString(),
    toIso: new Date(endMs + DAY_MS - 1 - offsetMs).toISOString(),
    days,
  };
}

export function localUsageDay(createdAt: string, tzOffsetMinutes: number): string {
  return new Date(Date.parse(createdAt) + tzOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

function emptyTotals(): UsageTotals {
  return { requests: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
}

function addRow(target: UsageTotals, row: UsageLedgerRow) {
  target.requests += 1;
  target.inputTokens += row.inputTokens;
  target.outputTokens += row.outputTokens;
  target.cachedInputTokens += row.cachedInputTokens;
}

const byTokensDesc = (left: UsageTotals, right: UsageTotals) =>
  right.inputTokens + right.outputTokens - (left.inputTokens + left.outputTokens) || right.requests - left.requests;

export function aggregateUsage(
  rows: readonly UsageLedgerRow[],
  range: UsageRange,
  tzOffsetMinutes: number,
  names: { connections: ReadonlyMap<string, string>; chats: ReadonlyMap<string, string> },
): UsageSummary {
  const totals = emptyTotals();
  const connections = new Map<string, UsageConnectionBucket & { modelSet: Set<string> }>();
  const chats = new Map<string, UsageChatBucket>();
  const days = new Map<string, UsageDayBucket>(range.days.map((day) => [day, { day, ...emptyTotals() }]));

  for (const row of rows) {
    if (row.createdAt < range.fromIso || row.createdAt > range.toIso) continue;
    const day = days.get(localUsageDay(row.createdAt, tzOffsetMinutes));
    if (!day) continue;
    addRow(totals, row);
    addRow(day, row);

    const connectionKey = row.connectionId ?? `provider:${row.provider}`;
    let connection = connections.get(connectionKey);
    if (!connection) {
      connection = {
        connectionId: row.connectionId,
        name: row.connectionId ? (names.connections.get(row.connectionId) ?? null) : null,
        provider: row.provider || null,
        models: [],
        modelSet: new Set(),
        ...emptyTotals(),
      };
      connections.set(connectionKey, connection);
    }
    addRow(connection, row);
    if (row.model) connection.modelSet.add(row.model);

    const chatKey = row.chatId ?? "";
    let chat = chats.get(chatKey);
    if (!chat) {
      chat = { chatId: row.chatId, name: row.chatId ? (names.chats.get(row.chatId) ?? null) : null, ...emptyTotals() };
      chats.set(chatKey, chat);
    }
    addRow(chat, row);
  }

  return {
    from: range.from,
    to: range.to,
    totals,
    byConnection: [...connections.values()]
      .map(({ modelSet, ...bucket }) => ({ ...bucket, models: [...modelSet].sort() }))
      .sort(byTokensDesc),
    byChat: [...chats.values()].sort(byTokensDesc),
    byDay: [...days.values()],
  };
}
