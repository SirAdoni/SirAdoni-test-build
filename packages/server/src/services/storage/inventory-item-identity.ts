import { newId } from "../../utils/id-generator.js";
import type { InventoryItem, InventoryTrackerRow, PlayerStats } from "@marinara-engine/shared";

const TRACKER_FIELDS = ["inventoryTrackerCurrencies", "inventoryTrackerEquipped", "inventoryTrackerInventory"] as const;

type IdentityRow = { itemId?: unknown; name?: unknown } & Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseStats(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function normalizedName(value: unknown): string {
  return typeof value === "string"
    ? value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US")
    : "";
}

function rowId(row: IdentityRow): string | null {
  return typeof row.itemId === "string" && row.itemId.trim() ? row.itemId.trim() : null;
}

function rows(value: unknown): IdentityRow[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function knownIds(stats: Record<string, unknown> | null): Set<string> {
  const result = new Set<string>();
  for (const row of rows(stats?.inventory)) {
    const id = rowId(row);
    if (id) result.add(id);
  }
  for (const field of TRACKER_FIELDS) {
    for (const row of rows(stats?.[field])) {
      const id = rowId(row);
      if (id) result.add(id);
    }
  }
  return result;
}

function previousIdsByName(stats: Record<string, unknown> | null): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  const add = (row: IdentityRow) => {
    const name = normalizedName(row.name);
    const id = rowId(row);
    if (!name || !id) return;
    const ids = result.get(name) ?? new Set<string>();
    ids.add(id);
    result.set(name, ids);
  };
  for (const row of rows(stats?.inventory)) add(row);
  for (const field of TRACKER_FIELDS) for (const row of rows(stats?.[field])) add(row);
  return result;
}

function reconcileRows(
  value: unknown,
  known: Set<string>,
  previousNameIds: Map<string, Set<string>>,
  claimed: Set<string>,
  trustedIncomingIds: ReadonlySet<string>,
): unknown {
  if (!Array.isArray(value)) return value;
  const source = value.filter(isRecord);
  const nameCounts = new Map<string, number>();
  for (const row of source) {
    const name = normalizedName(row.name);
    if (name) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  const result: IdentityRow[] = [];
  for (const original of source) {
    const row = { ...original };
    const incomingId = rowId(row);
    let id: string | null = null;
    if (incomingId && (known.has(incomingId) || trustedIncomingIds.has(incomingId)) && !claimed.has(incomingId)) {
      id = incomingId;
    } else {
      const candidates = [...(previousNameIds.get(normalizedName(row.name)) ?? [])].filter(
        (candidate) => !claimed.has(candidate),
      );
      if (nameCounts.get(normalizedName(row.name)) === 1 && candidates.length === 1) id = candidates[0]!;
      else if (nameCounts.get(normalizedName(row.name)) === 1 && candidates.length === 0) id = newId();
    }
    if (id) {
      row.itemId = id;
      claimed.add(id);
    } else {
      delete row.itemId;
    }
    result.push(row);
  }
  return result;
}

/** Reconcile host-owned item IDs without treating names as durable identity. */
export function reconcileInventoryItemIdentities(
  previousValue: unknown,
  nextValue: unknown,
  options?: { trustedIncomingIds?: ReadonlySet<string> },
): unknown {
  const next = parseStats(nextValue);
  if (!next) return nextValue;
  const previous = parseStats(previousValue);
  const previousNameIds = previousIdsByName(previous);
  const trustedIncomingIds = options?.trustedIncomingIds ?? new Set<string>();
  const result: Record<string, unknown> = { ...next };

  if (Array.isArray(next.inventory)) {
    result.inventory = reconcileRows(
      next.inventory,
      knownIds(previous),
      previousNameIds,
      new Set<string>(),
      trustedIncomingIds,
    );
    for (const row of rows(result.inventory)) {
      const name = normalizedName(row.name);
      const id = rowId(row);
      if (!name || !id) continue;
      const ids = previousNameIds.get(name) ?? new Set<string>();
      ids.add(id);
      previousNameIds.set(name, ids);
    }
  }
  for (const field of TRACKER_FIELDS) {
    if (Array.isArray(next[field])) {
      result[field] = reconcileRows(
        next[field],
        knownIds(previous),
        previousNameIds,
        new Set<string>(),
        trustedIncomingIds,
      );
    }
  }
  return result as PlayerStats & Record<string, unknown>;
}

export function parseStoredPlayerStats(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return parseStats(value);
  try {
    return parseStats(JSON.parse(value));
  } catch {
    return null;
  }
}

export type { InventoryItem, InventoryTrackerRow };
