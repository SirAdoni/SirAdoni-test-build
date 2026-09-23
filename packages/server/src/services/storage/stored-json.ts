// ──────────────────────────────────────────────
// Stored JSON columns: parse with a fallback and report corruption once
// ──────────────────────────────────────────────
// Storage rows keep many JSON strings (chat metadata, message extra, card data).
// A value that no longer parses used to fall back silently. parseStoredJson keeps
// the same fallback and writes one warn line per table/rowId/field through
// logRepeated. The raw text is never logged, only its length. See
// docs/development/logging.md.
import { logRepeated } from "../../lib/log-events.js";

export interface StoredJsonLocation {
  table: string;
  rowId: string;
  field: string;
}

export const STORAGE_JSON_CORRUPT = "ME_STORAGE_JSON_CORRUPT";

/** Reports one unparsable stored JSON value. Logs the length of `raw`, never its text. */
export function reportStoredJsonCorrupt(raw: unknown, where: StoredJsonLocation, error?: unknown): void {
  const rawLength = typeof raw === "string" ? raw.length : undefined;
  logRepeated(
    `storage.json_corrupt:${where.table}:${where.rowId}:${where.field}`,
    "warn",
    {
      event: "storage.json_corrupt",
      table: where.table,
      rowId: where.rowId,
      field: where.field,
      ...(rawLength !== undefined ? { rawLength } : {}),
      errorCode: STORAGE_JSON_CORRUPT,
      ...(error instanceof Error ? { errorName: error.name } : {}),
    },
    "[storage] Stored JSON could not be parsed; using the fallback value",
  );
}

/**
 * Parses a stored JSON column. Empty values (null, undefined, "") return
 * `fallback` silently. A non-string value is treated as already parsed and
 * returned as is. A string that does not parse returns `fallback` and reports
 * `storage.json_corrupt` once per table/rowId/field.
 */
export function parseStoredJson<T>(raw: unknown, fallback: T, where: StoredJsonLocation): T {
  if (raw === null || raw === undefined || raw === "") return fallback;
  if (typeof raw !== "string") return raw as T;
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    reportStoredJsonCorrupt(raw, where, error);
    return fallback;
  }
}
