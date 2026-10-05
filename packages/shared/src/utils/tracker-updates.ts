import { inventoryTrackerComparableName } from "./inventory-tracker-rows.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isNamedTrackerRow(value: unknown): value is Record<string, unknown> & { name: string } {
  return isRecord(value) && typeof value.name === "string" && value.name.trim().length > 0;
}

export function isTrackerRowsUpdate(value: unknown): value is { updates?: unknown[]; removed?: unknown[] } {
  return (
    isRecord(value) &&
    ("updates" in value || "removed" in value) &&
    (value.updates === undefined || Array.isArray(value.updates)) &&
    (value.removed === undefined || Array.isArray(value.removed))
  );
}

/** Arrays retain their legacy meaning; explicit updates preserve every omitted row/property. */
export function resolveTrackerRowsUpdate(
  value: unknown,
  previous: readonly unknown[],
  identity: "name" | "characterId" | "itemId" = "name",
  canRemove: (row: Record<string, unknown>, index: number) => boolean = () => true,
): Record<string, unknown>[] | undefined {
  if (Array.isArray(value)) return value as Record<string, unknown>[];
  if (!isTrackerRowsUpdate(value)) return undefined;
  const rows = previous.filter(isRecord).map((row) => ({ ...row }));
  // Replacements keep these original identities stable for the entire batch.
  const identityRows = [...rows];
  const findNamed = (name: unknown) => {
    const key = inventoryTrackerComparableName(name);
    if (!key) return -1;
    const matches = identityRows.flatMap((row, index) =>
      inventoryTrackerComparableName(row.name) === key ? [index] : [],
    );
    return matches.length > 1 ? -2 : (matches[0] ?? -1);
  };
  const findId = (id: string) => {
    const identityField = identity === "characterId" ? "characterId" : "itemId";
    const matches = identityRows.flatMap((row, index) => (row[identityField] === id ? [index] : []));
    return matches.length > 1 ? -2 : (matches[0] ?? -1);
  };

  // Resolve references and removal permission before updates can change their identity or locks.
  const removed = new Set<number>();
  for (const reference of value.removed ?? []) {
    if (typeof reference !== "string" || !reference.trim()) continue;
    const byId = identity === "name" ? -1 : findId(reference.trim());
    const index = byId !== -1 ? byId : findNamed(reference);
    if (index >= 0 && canRemove(rows[index]!, index)) removed.add(index);
  }

  for (const raw of value.updates ?? []) {
    if (!isRecord(raw)) continue;
    const idField = identity === "characterId" ? "characterId" : "itemId";
    const id = identity === "name" ? "" : typeof raw[idField] === "string" ? String(raw[idField]).trim() : "";
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (!name && !(identity !== "name" && id)) continue;
    const index = identity !== "name" && id ? findId(id) : findNamed(name);
    if (index === -2) continue;
    // An unknown ID must not silently replace another character with the same name.
    if (index < 0 && identity !== "name" && (!name || (id && findNamed(name) !== -1))) continue;
    const current = index >= 0 ? rows[index]! : {};
    const next = { ...current, ...raw };
    if (typeof current.locked === "boolean") next.locked = current.locked;
    if (identity === "name") next.name = current.name ?? name;
    if (identity !== "name") {
      if (id) next[idField] = id;
      if (name) next.name = name;
      if (identity === "characterId" && isRecord(raw.customFields)) {
        next.customFields = { ...(isRecord(current.customFields) ? current.customFields : {}), ...raw.customFields };
      }
      if (identity === "characterId" && Array.isArray(raw.stats)) {
        next.stats = resolveTrackerRowsUpdate(
          { updates: raw.stats },
          Array.isArray(current.stats) ? current.stats : [],
        );
      }
    }
    if (index >= 0) rows[index] = next;
    else {
      rows.push(next);
      identityRows.push(next);
    }
  }
  return rows.filter((_row, index) => !removed.has(index));
}
