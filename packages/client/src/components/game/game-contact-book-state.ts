export interface ContactCategory {
  id: string;
  name: string;
  parentId?: string;
}

export const DEFAULT_CONTACT_CATEGORIES = ["staff", "friends", "enemies"] as const;

export function contactBookPreferenceKey(campaignId: string, chatId: string, branchParentChatId: unknown): string {
  const scope = typeof branchParentChatId === "string" && branchParentChatId.length > 0 ? chatId : "canonical";
  return `${campaignId}:${scope}`;
}

export function contactCategoryId(name: string, used: Set<string> = new Set()): string {
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

export function hasContactCategory(categoryId: string, selectedId: string, categories: ContactCategory[]): boolean {
  let current: string | undefined = categoryId;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    if (current === selectedId) return true;
    seen.add(current);
    current = categories.find((category) => category.id === current)?.parentId;
  }
  return false;
}

export function removeContactCategory(
  categoryId: string,
  categories: ContactCategory[],
  groups: Record<string, string[]>,
) {
  const removed = new Set([categoryId]);
  const deleted = categories.find(({ id }) => id === categoryId);
  return {
    categories: categories
      .filter(({ id }) => !removed.has(id))
      .map((category) => {
        if (category.parentId !== categoryId) return category;
        const child = { ...category };
        delete child.parentId;
        return deleted?.parentId ? { ...child, parentId: deleted.parentId } : child;
      }),
    groups: Object.fromEntries(
      Object.entries(groups).map(([id, values]) => [id, values.filter((value) => !removed.has(value))]),
    ),
    removed,
  };
}

export function migrateContactCategories(
  rawGroups: unknown,
  rawCategories: unknown,
  defaultNames: Record<string, string>,
): { categories: ContactCategory[]; groups: Record<string, string[]> } {
  const groups =
    rawGroups && typeof rawGroups === "object" && !Array.isArray(rawGroups)
      ? (Object.fromEntries(
          Object.entries(rawGroups).filter(
            ([, value]) => Array.isArray(value) && value.every((item) => typeof item === "string"),
          ),
        ) as Record<string, string[]>)
      : {};
  const hasStoredCategories = Array.isArray(rawCategories);
  const stored = hasStoredCategories
    ? rawCategories.filter(
        (item): item is ContactCategory =>
          Boolean(item) && typeof item === "object" && typeof item.id === "string" && typeof item.name === "string",
      )
    : [];
  const categories: ContactCategory[] = (
    hasStoredCategories ? stored : DEFAULT_CONTACT_CATEGORIES.map((id) => ({ id, name: defaultNames[id] ?? id }))
  ).map((category) => ({ ...category }));
  const ids = new Set(categories.map(({ id }) => id));
  for (const category of categories) {
    if (!category.parentId || category.parentId === category.id || !ids.has(category.parentId)) {
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
      parent = categories.find((item) => item.id === parent)?.parentId;
    }
  }
  const names = new Map(categories.map((category) => [category.name.toLocaleLowerCase(), category.id]));
  for (const oldName of new Set(Object.values(groups).flat())) {
    if (!oldName || ids.has(oldName) || names.has(oldName.toLocaleLowerCase())) continue;
    const id = contactCategoryId(oldName, ids);
    ids.add(id);
    names.set(oldName.toLocaleLowerCase(), id);
    categories.push({ id, name: oldName });
  }
  return {
    categories,
    groups: Object.fromEntries(
      Object.entries(groups).map(([id, assigned]) => [
        id,
        assigned.map((value) => (ids.has(value) ? value : (names.get(value.toLocaleLowerCase()) ?? value))),
      ]),
    ),
  };
}
