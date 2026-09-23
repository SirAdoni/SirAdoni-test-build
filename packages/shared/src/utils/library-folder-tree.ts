// ──────────────────────────────────────────────
// Library folder tree: nesting rules shared by the
// server (parent validation, delete re-parenting) and
// the client (tree rendering, counts, move picker).
// Used by resource library folders (lorebooks, presets,
// agents) and by character folders (character groups).
// A folder without a parentId, or whose parent is gone,
// is a root folder, so flat folders need no migration.
// ──────────────────────────────────────────────

/** Deepest allowed nesting. A root folder has depth 1. */
export const LIBRARY_FOLDER_MAX_DEPTH = 6;

export type LibraryTreeFolder = { id: string; parentId?: string | null };
export type LibraryTreeFolderWithItems = LibraryTreeFolder & { itemIds: readonly string[] };

export type LibraryFolderMoveErrorCode = "not_found" | "parent_not_found" | "self" | "cycle" | "depth";

export type LibraryFolderMoveCheck = { ok: true } | { ok: false; code: LibraryFolderMoveErrorCode; reason: string };

/**
 * Effective parent of every folder. Parents that do not exist fall back to root,
 * and folders caught in a stored cycle are cut loose so the tree always renders.
 * The cut is deterministic: the earliest folder (input order) of each loop
 * becomes a root.
 */
export function resolveLibraryFolderParents(folders: readonly LibraryTreeFolder[]): Map<string, string | null> {
  const ids = new Set(folders.map((folder) => folder.id));
  const order = new Map(folders.map((folder, index) => [folder.id, index]));
  const parents = new Map<string, string | null>();
  for (const folder of folders) {
    const parentId = folder.parentId ?? null;
    parents.set(folder.id, parentId && parentId !== folder.id && ids.has(parentId) ? parentId : null);
  }

  const settled = new Set<string>();
  for (const folder of folders) {
    const path: string[] = [];
    const onPath = new Set<string>();
    let current: string | null = folder.id;
    while (current !== null && !settled.has(current)) {
      if (onPath.has(current)) {
        const loop = path.slice(path.indexOf(current));
        const cut = loop.reduce((earliest, id) => ((order.get(id) ?? 0) < (order.get(earliest) ?? 0) ? id : earliest));
        parents.set(cut, null);
        break;
      }
      onPath.add(current);
      path.push(current);
      current = parents.get(current) ?? null;
    }
    for (const id of path) settled.add(id);
  }
  return parents;
}

export type LibraryFolderTree<T extends LibraryTreeFolder> = {
  roots: T[];
  childrenByParent: Map<string, T[]>;
  parentById: Map<string, string | null>;
  /** Root folders have depth 1. */
  depthById: Map<string, number>;
  byId: Map<string, T>;
};

/** Arrange flat folders into a tree. Sibling order follows the input order. */
export function buildLibraryFolderTree<T extends LibraryTreeFolder>(folders: readonly T[]): LibraryFolderTree<T> {
  const parentById = resolveLibraryFolderParents(folders);
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const roots: T[] = [];
  const childrenByParent = new Map<string, T[]>();
  for (const folder of folders) {
    const parentId = parentById.get(folder.id) ?? null;
    if (parentId === null) {
      roots.push(folder);
      continue;
    }
    const siblings = childrenByParent.get(parentId);
    if (siblings) siblings.push(folder);
    else childrenByParent.set(parentId, [folder]);
  }

  const depthById = new Map<string, number>();
  const stack: Array<[T, number]> = roots.map((folder) => [folder, 1]);
  while (stack.length > 0) {
    const [folder, depth] = stack.pop()!;
    depthById.set(folder.id, depth);
    for (const child of childrenByParent.get(folder.id) ?? []) stack.push([child, depth + 1]);
  }
  return { roots, childrenByParent, parentById, depthById, byId };
}

/** Ancestor ids of a folder, nearest parent first. */
export function getLibraryFolderAncestorIds(parentById: ReadonlyMap<string, string | null>, folderId: string) {
  const ancestors: string[] = [];
  const seen = new Set<string>([folderId]);
  let current = parentById.get(folderId) ?? null;
  while (current !== null && !seen.has(current)) {
    ancestors.push(current);
    seen.add(current);
    current = parentById.get(current) ?? null;
  }
  return ancestors;
}

/** Folders from the root down to (and including) `folderId`. Empty when the folder is unknown. */
export function getLibraryFolderPath<T extends LibraryTreeFolder>(folders: readonly T[], folderId: string): T[] {
  const parentById = resolveLibraryFolderParents(folders);
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const self = byId.get(folderId);
  if (!self) return [];
  const path = getLibraryFolderAncestorIds(parentById, folderId)
    .map((id) => byId.get(id))
    .filter((folder): folder is T => Boolean(folder))
    .reverse();
  path.push(self);
  return path;
}

/** The folder itself plus every descendant id. */
export function collectLibraryFolderSubtreeIds(folders: readonly LibraryTreeFolder[], folderId: string): string[] {
  const { childrenByParent, byId } = buildLibraryFolderTree(folders);
  if (!byId.has(folderId)) return [];
  const ids: string[] = [];
  const stack = [folderId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    ids.push(id);
    for (const child of childrenByParent.get(id) ?? []) stack.push(child.id);
  }
  return ids;
}

/** Levels in the subtree rooted at `folderId`: 1 for a folder without subfolders. */
export function getLibraryFolderSubtreeHeight(folders: readonly LibraryTreeFolder[], folderId: string): number {
  const { childrenByParent, byId } = buildLibraryFolderTree(folders);
  if (!byId.has(folderId)) return 0;
  let height = 0;
  const stack: Array<[string, number]> = [[folderId, 1]];
  while (stack.length > 0) {
    const [id, level] = stack.pop()!;
    height = Math.max(height, level);
    for (const child of childrenByParent.get(id) ?? []) stack.push([child.id, level + 1]);
  }
  return height;
}

/**
 * Can `folderId` live under `parentId`? Pass `folderId: null` to check where a
 * brand new (empty) folder may be created. Rejects missing folders, self or
 * descendant parents (cycles) and anything that would nest deeper than
 * `maxDepth` once the moving folder's own subfolders are counted.
 */
export function checkLibraryFolderParent(
  folders: readonly LibraryTreeFolder[],
  folderId: string | null,
  parentId: string | null,
  maxDepth = LIBRARY_FOLDER_MAX_DEPTH,
): LibraryFolderMoveCheck {
  const tree = buildLibraryFolderTree(folders);
  if (folderId !== null && !tree.byId.has(folderId)) {
    return { ok: false, code: "not_found", reason: "Folder not found." };
  }
  if (parentId === null) {
    const height = folderId === null ? 1 : getLibraryFolderSubtreeHeight(folders, folderId);
    return height > maxDepth
      ? { ok: false, code: "depth", reason: `Folders can nest at most ${maxDepth} levels deep.` }
      : { ok: true };
  }
  if (!tree.byId.has(parentId)) {
    return { ok: false, code: "parent_not_found", reason: "Parent folder not found." };
  }
  if (folderId !== null) {
    if (parentId === folderId) return { ok: false, code: "self", reason: "A folder cannot be inside itself." };
    if (getLibraryFolderAncestorIds(tree.parentById, parentId).includes(folderId)) {
      return { ok: false, code: "cycle", reason: "A folder cannot move into one of its own subfolders." };
    }
  }
  const parentDepth = tree.depthById.get(parentId) ?? 1;
  const height = folderId === null ? 1 : getLibraryFolderSubtreeHeight(folders, folderId);
  if (parentDepth + height > maxDepth) {
    return { ok: false, code: "depth", reason: `Folders can nest at most ${maxDepth} levels deep.` };
  }
  return { ok: true };
}

export type LibraryFolderDeletePlan = {
  /** Where the deleted folder's subfolders and items go; null means the library root. */
  parentId: string | null;
  /** Direct subfolders that move up one level. */
  childIds: string[];
  /** Items that land in the parent folder (empty when the parent is the root). */
  itemIdsForParent: string[];
};

/** Deleting a folder moves its subfolders and items up to its parent (or the root). */
export function planLibraryFolderDelete(
  folders: readonly LibraryTreeFolderWithItems[],
  folderId: string,
): LibraryFolderDeletePlan | null {
  const tree = buildLibraryFolderTree(folders);
  const folder = tree.byId.get(folderId);
  if (!folder) return null;
  const parentId = tree.parentById.get(folderId) ?? null;
  const childIds = (tree.childrenByParent.get(folderId) ?? []).map((child) => child.id);
  if (parentId === null) return { parentId, childIds, itemIdsForParent: [] };
  const parentItems = new Set(tree.byId.get(parentId)?.itemIds ?? []);
  return { parentId, childIds, itemIdsForParent: folder.itemIds.filter((id) => !parentItems.has(id)) };
}

/**
 * Items per folder including every descendant folder, each item counted once.
 * `isVisible` restricts the count to items the caller can currently show.
 */
export function countLibraryFolderItems(
  folders: readonly LibraryTreeFolderWithItems[],
  isVisible: (itemId: string) => boolean = () => true,
): Map<string, number> {
  const { childrenByParent, roots } = buildLibraryFolderTree(folders);
  const counts = new Map<string, number>();
  const collect = (folder: LibraryTreeFolderWithItems): Set<string> => {
    const items = new Set(folder.itemIds.filter(isVisible));
    for (const child of childrenByParent.get(folder.id) ?? []) {
      for (const id of collect(child)) items.add(id);
    }
    counts.set(folder.id, items.size);
    return items;
  };
  for (const root of roots) collect(root);
  return counts;
}
