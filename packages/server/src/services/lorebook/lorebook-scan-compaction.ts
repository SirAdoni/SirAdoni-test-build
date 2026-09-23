/**
 * Every generated message records the lorebook scan that built its prompt (`extra.lorebookScan`), and that scan
 * used to carry the full resolved text of every activated entry. With large lorebooks that is hundreds of KB per
 * message, stored again in each swipe: one 473-message chat held 184 MB of copied lore in a 192 MB shard, and
 * because chats stay resident once loaded it drove the server towards its heap limit in long sessions.
 *
 * Only the newest generated message's scan is ever read with its text (Active Context and agent retries), so that
 * one message row keeps the text and every other stored scan keeps only ids, keys and scores. Readers fall back to
 * the entry's stored text when a scan has no text.
 */

export const COMPACT_LOREBOOK_SCAN_MARKER = "contentStripped";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** True when a stored scan still carries entry text. */
export function lorebookScanHasContent(scan: unknown): boolean {
  if (!isRecord(scan) || !Array.isArray(scan.activatedEntries)) return false;
  return scan.activatedEntries.some((entry) => isRecord(entry) && typeof entry.content === "string");
}

/** The same scan without entry text; anything that is not a scan is returned unchanged. */
export function compactLorebookScan<T>(scan: T): T {
  if (!isRecord(scan) || !Array.isArray(scan.activatedEntries)) return scan;
  return {
    ...scan,
    activatedEntries: scan.activatedEntries.map((entry) => {
      if (!isRecord(entry) || !("content" in entry)) return entry;
      const { content: _content, ...rest } = entry;
      return rest;
    }),
    [COMPACT_LOREBOOK_SCAN_MARKER]: true,
  } as T;
}

/** Cheap pre-check on a serialized extra so the sweep only parses extras that still hold a full scan. */
export function serializedExtraMayHoldFullLorebookScan(extra: unknown): boolean {
  return (
    typeof extra === "string" &&
    extra.includes('"lorebookScan"') &&
    !extra.includes(`"${COMPACT_LOREBOOK_SCAN_MARKER}":true`)
  );
}

/** Returns the extra with a compacted scan, or null when there was nothing to compact. */
export function compactLorebookScanInExtra(extra: Record<string, unknown>): Record<string, unknown> | null {
  if (!lorebookScanHasContent(extra.lorebookScan)) return null;
  return { ...extra, lorebookScan: compactLorebookScan(extra.lorebookScan) };
}
