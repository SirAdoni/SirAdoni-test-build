// ──────────────────────────────────────────────
// Game: optimistic guard for index-addressed journal entry edits
// ──────────────────────────────────────────────
import { z } from "zod";

export const JOURNAL_ENTRY_MOVED_CODE = "JOURNAL_ENTRY_MOVED";

export const journalEntryExpectedSchema = z
  .object({
    timestamp: z.string().max(200).optional(),
    type: z.string().max(100).optional(),
    title: z.string().max(500).optional(),
  })
  .optional();

export type JournalEntryExpected = z.infer<typeof journalEntryExpectedSchema>;

/** Read expected fields from DELETE query params (expectedTimestamp, expectedType, expectedTitle). */
export function journalEntryExpectedFromQuery(query: unknown): JournalEntryExpected {
  if (!query || typeof query !== "object") return undefined;
  const q = query as Record<string, unknown>;
  const pick = (value: unknown) => (typeof value === "string" ? value : undefined);
  const expected = {
    timestamp: pick(q.expectedTimestamp),
    type: pick(q.expectedType),
    title: pick(q.expectedTitle),
  };
  if (expected.timestamp === undefined && expected.type === undefined && expected.title === undefined) return undefined;
  return journalEntryExpectedSchema.parse(expected);
}

/** Merge body and query expectations; body fields win when both are present. */
export function mergeJournalEntryExpected(
  body: JournalEntryExpected,
  query: JournalEntryExpected,
): JournalEntryExpected {
  if (!body && !query) return undefined;
  return { ...(query ?? {}), ...Object.fromEntries(Object.entries(body ?? {}).filter(([, v]) => v !== undefined)) };
}

/** True when every provided expected field matches the entry. No expectation always matches. */
export function journalEntryMatchesExpected(
  entry: { timestamp?: unknown; type?: unknown; title?: unknown },
  expected: JournalEntryExpected,
): boolean {
  if (!expected) return true;
  if (expected.timestamp !== undefined && entry.timestamp !== expected.timestamp) return false;
  if (expected.type !== undefined && entry.type !== expected.type) return false;
  if (expected.title !== undefined && entry.title !== expected.title) return false;
  return true;
}

export class JournalEntryMovedError extends Error {
  readonly code = JOURNAL_ENTRY_MOVED_CODE;
  constructor() {
    super("This journal entry changed position or was removed. Refresh the journal and try again.");
  }
}
