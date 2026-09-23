export interface InventoryIdentity {
  itemId?: string;
  name: string;
}

function normalizedName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Pick one of several same-name rows. Rows without any itemId are indistinguishable,
 * so the first one is used (legacy behaviour). When any match carries an itemId we refuse to guess.
 */
function pickNameMatch<T extends InventoryIdentity>(items: readonly T[], matches: number[]): number {
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1 && matches.every((index) => !items[index]!.itemId)) return matches[0]!;
  return -1;
}

/** Resolve an item by host identity, falling back to a name only when it is unambiguous. */
export function findInventoryIndex<T extends InventoryIdentity>(
  items: readonly T[],
  target: InventoryIdentity,
): number {
  if (target.itemId) {
    const index = items.findIndex((item) => item.itemId === target.itemId);
    return index >= 0 ? index : -1;
  }
  const wanted = normalizedName(target.name);
  if (!wanted) return -1;
  const matches = items.reduce<number[]>((result, item, index) => {
    if (normalizedName(item.name) === wanted) result.push(index);
    return result;
  }, []);
  return pickNameMatch(items, matches);
}

export function addInventoryQuantity<T extends InventoryIdentity & { quantity: number }>(
  items: readonly T[],
  name: string,
  quantity: number,
): T[] {
  const cleanName = name.trim().replace(/\s+/g, " ");
  const amount = Math.max(1, Math.floor(quantity));
  if (!cleanName || !Number.isFinite(amount)) return [...items];
  const matches = items.reduce<number[]>((result, item, index) => {
    if (normalizedName(item.name) === normalizedName(cleanName)) result.push(index);
    return result;
  }, []);
  const index = pickNameMatch(items, matches);
  if (index >= 0) {
    return items.map((item, itemIndex) => (itemIndex === index ? { ...item, quantity: item.quantity + amount } : item));
  }
  // The server assigns identity to new rows. The client deliberately leaves itemId absent.
  return [...items, { name: cleanName, quantity: amount } as T];
}

export function updateInventoryQuantity<T extends InventoryIdentity & { quantity: number }>(
  items: readonly T[],
  target: InventoryIdentity,
  delta: number,
): T[] {
  const index = findInventoryIndex(items, target);
  if (index < 0) return items as T[];
  const nextQuantity = items[index]!.quantity + delta;
  return items.flatMap((item, itemIndex) => {
    if (itemIndex !== index) return [item];
    return nextQuantity > 0 ? [{ ...item, quantity: nextQuantity }] : [];
  });
}

export function renameInventoryIdentity<T extends InventoryIdentity & { quantity: number }>(
  items: readonly T[],
  target: InventoryIdentity,
  nextName: string,
): { items: T[]; resolvedName: string } | null {
  const index = findInventoryIndex(items, target);
  const cleanName = nextName.trim().replace(/\s+/g, " ");
  if (index < 0 || !cleanName) return null;
  const source = items[index]!;
  if (source.name.trim().replace(/\s+/g, " ") === cleanName) return { items: [...items], resolvedName: source.name };

  // Identified rows remain distinct even when the new display name matches another row.
  // Rows without an itemId merge into the existing same-name row, as they always did.
  const wanted = normalizedName(cleanName);
  const mergeIndex = items.findIndex((item, itemIndex) => itemIndex !== index && normalizedName(item.name) === wanted);
  if (mergeIndex >= 0) {
    const existing = items[mergeIndex]!;
    if (!source.itemId || !existing.itemId) {
      const sourceRecord = source as T & Record<string, unknown>;
      const existingRecord = existing as T & Record<string, unknown>;
      const sourceDescription = typeof sourceRecord.description === "string" ? sourceRecord.description.trim() : "";
      const existingDescription =
        typeof existingRecord.description === "string" ? existingRecord.description.trim() : "";
      const sourceLocation = typeof sourceRecord.location === "string" ? sourceRecord.location.trim() : "";
      const existingLocation = typeof existingRecord.location === "string" ? existingRecord.location.trim() : "";
      const merged = {
        ...existing,
        quantity: existing.quantity + source.quantity,
        ...(!existing.itemId && source.itemId ? { itemId: source.itemId } : {}),
        ...(!existingDescription && sourceDescription ? { description: sourceDescription } : {}),
        ...(!existingLocation && sourceLocation ? { location: sourceLocation } : {}),
      } as T;
      return {
        items: items.flatMap((item, itemIndex) => {
          if (itemIndex === index) return [];
          return itemIndex === mergeIndex ? [merged] : [item];
        }),
        resolvedName: existing.name,
      };
    }
  }
  return {
    items: items.map((item, itemIndex) => (itemIndex === index ? { ...item, name: cleanName } : item)),
    resolvedName: cleanName,
  };
}
