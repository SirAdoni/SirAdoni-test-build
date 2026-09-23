export interface ContactCategoryState {
  id: string;
  name: string;
  parentId?: string;
}

export const DEFAULT_CATEGORY_IDS = ["staff", "friends", "enemies"] as const;

export function displayOpinion(opinion: number | string | undefined): number | null {
  if (typeof opinion === "number") return Number.isFinite(opinion) ? opinion : null;
  if (typeof opinion === "string" && opinion.trim()) {
    const numeric = Number(opinion);
    return Number.isFinite(numeric) ? numeric : null;
  }
  return null;
}

export function contactCategoryId(name: string, used: Set<string> = new Set()) {
  const stem =
    name
      .trim()
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "category";
  let id = stem;
  let suffix = 2;
  while (used.has(id)) id = `${stem}-${suffix++}`;
  return id;
}

export function hasCategory(categoryId: string, selectedId: string, categories: ContactCategoryState[]) {
  let current: string | undefined = categoryId;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    if (current === selectedId) return true;
    seen.add(current);
    current = categories.find((category) => category.id === current)?.parentId;
  }
  return false;
}

export function removeCategoryAssignments(
  categoryId: string,
  categories: ContactCategoryState[],
  groups: Record<string, string[]>,
) {
  const removed = new Set([
    categoryId,
    ...categories.filter((item) => hasCategory(item.id, categoryId, categories)).map((item) => item.id),
  ]);
  return {
    categories: categories.filter((item) => !removed.has(item.id)),
    groups: Object.fromEntries(
      Object.entries(groups).map(([id, values]) => [id, values.filter((value) => !removed.has(value))]),
    ),
    removed,
  };
}

export function migrateContactState(
  rawGroups: unknown,
  rawCategories: unknown,
  defaultNames: Record<string, string> = {},
): { categories: ContactCategoryState[]; groups: Record<string, string[]> } {
  const groups: Record<string, string[]> =
    rawGroups && typeof rawGroups === "object" && !Array.isArray(rawGroups)
      ? (Object.fromEntries(
          Object.entries(rawGroups).filter(
            ([, value]) => Array.isArray(value) && value.every((item) => typeof item === "string"),
          ),
        ) as Record<string, string[]>)
      : {};
  const categoriesStored = Array.isArray(rawCategories);
  const storedCategories: ContactCategoryState[] = categoriesStored
    ? rawCategories.filter(
        (item): item is ContactCategoryState =>
          Boolean(item) && typeof item === "object" && typeof item.id === "string" && typeof item.name === "string",
      )
    : [];
  const defaults = DEFAULT_CATEGORY_IDS.map((id) => ({ id, name: defaultNames[id] ?? id }));
  const next: ContactCategoryState[] = (categoriesStored ? storedCategories : defaults).map((category) => ({
    ...category,
  }));
  const validIds = new Set(next.map((category) => category.id));
  for (const category of next) {
    if (!category.parentId || category.parentId === category.id || !validIds.has(category.parentId)) {
      delete category.parentId;
      continue;
    }
    const seen = new Set([category.id]);
    let parent: string | undefined = category.parentId;
    while (parent) {
      if (seen.has(parent)) {
        delete category.parentId;
        break;
      }
      seen.add(parent);
      parent = next.find((item) => item.id === parent)?.parentId;
    }
  }
  const used = new Set(next.map((category) => category.id));
  const names = new Map(next.map((category) => [category.name.toLocaleLowerCase(), category.id]));
  for (const oldName of new Set(Object.values(groups).flat())) {
    if (!oldName || used.has(oldName) || names.has(oldName.toLocaleLowerCase())) continue;
    const id = contactCategoryId(oldName, used);
    used.add(id);
    names.set(oldName.toLocaleLowerCase(), id);
    next.push({ id, name: oldName });
  }
  return {
    categories: next,
    groups: Object.fromEntries(
      Object.entries(groups).map(([id, assigned]) => [
        id,
        assigned.map((value) => (used.has(value) ? value : (names.get(value.toLocaleLowerCase()) ?? value))),
      ]),
    ),
  };
}
