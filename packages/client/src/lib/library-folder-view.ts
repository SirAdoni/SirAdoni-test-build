// ──────────────────────────────────────────────
// Library folder view: what a nested folder tree shows
// for the current filters (visible folders, counts,
// auto-expanded ancestors, item breadcrumbs).
// ──────────────────────────────────────────────
import {
  buildLibraryFolderTree,
  collectLibraryFolderSubtreeIds,
  countLibraryFolderItems,
  type LibraryFolderTree,
} from "@marinara-engine/shared";

export type LibraryFolderNode = {
  id: string;
  name: string;
  parentId: string | null;
  itemIds: string[];
};

export type LibraryFolderView = {
  tree: LibraryFolderTree<LibraryFolderNode>;
  /** Items per folder including subfolders, counting only items the caller can show. */
  counts: Map<string, number>;
  /** Folders to render. While filtering, only folders with a visible item somewhere below them. */
  shownFolderIds: Set<string>;
  /** Folders opened because a filter match sits inside them. */
  revealedFolderIds: Set<string>;
  /** "Parent / Child" path of the folder that holds each item. */
  pathByItemId: Map<string, string>;
  /** Items that sit in any folder. */
  folderedItemIds: Set<string>;
};

export function buildLibraryFolderView(
  folders: LibraryFolderNode[],
  isItemVisible: (itemId: string) => boolean,
  filterActive: boolean,
): LibraryFolderView {
  const tree = buildLibraryFolderTree(folders);
  // Counts always go through isItemVisible: folders keep ids of deleted items and of items
  // outside the panel's category, and a badge must never promise rows the folder cannot show.
  const counts = countLibraryFolderItems(folders, isItemVisible);
  const shownFolderIds = new Set<string>();
  const revealedFolderIds = new Set<string>();
  for (const folder of folders) {
    const count = counts.get(folder.id) ?? 0;
    if (!filterActive || count > 0) shownFolderIds.add(folder.id);
    if (filterActive && count > 0) revealedFolderIds.add(folder.id);
  }

  const pathByFolderId = new Map<string, string>();
  const walk = (folder: LibraryFolderNode, prefix: string) => {
    const path = prefix ? `${prefix} / ${folder.name}` : folder.name;
    pathByFolderId.set(folder.id, path);
    for (const child of tree.childrenByParent.get(folder.id) ?? []) walk(child, path);
  };
  for (const root of tree.roots) walk(root, "");

  const pathByItemId = new Map<string, string>();
  const folderedItemIds = new Set<string>();
  for (const folder of folders) {
    for (const itemId of folder.itemIds) {
      folderedItemIds.add(itemId);
      if (!pathByItemId.has(itemId)) pathByItemId.set(itemId, pathByFolderId.get(folder.id) ?? folder.name);
    }
  }
  return { tree, counts, shownFolderIds, revealedFolderIds, pathByItemId, folderedItemIds };
}

/** Folder choices for a "Move to..." picker, depth-first in tree order. */
export function listLibraryFolderChoices(tree: LibraryFolderTree<LibraryFolderNode>) {
  const choices: Array<{ folder: LibraryFolderNode; depth: number }> = [];
  const walk = (folder: LibraryFolderNode, depth: number) => {
    choices.push({ folder, depth });
    for (const child of tree.childrenByParent.get(folder.id) ?? []) walk(child, depth + 1);
  };
  for (const root of tree.roots) walk(root, 0);
  return choices;
}

/** Every item id in a folder and all of its subfolders, each once. */
export function collectLibraryFolderItemIds(folders: LibraryFolderNode[], folderId: string): string[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const ids = new Set<string>();
  for (const id of collectLibraryFolderSubtreeIds(folders, folderId)) {
    for (const itemId of byId.get(id)?.itemIds ?? []) ids.add(itemId);
  }
  return [...ids];
}

/**
 * What a folder's lorebook switch does: disable every enabled lorebook while any is on,
 * otherwise enable them all. Unknown ids (deleted or not loaded) are left alone; null
 * when the folder holds no known lorebook.
 */
export function planLibraryFolderLorebookToggle(
  itemIds: readonly string[],
  enabledById: ReadonlyMap<string, boolean>,
): { enable: boolean; ids: string[] } | null {
  const known = itemIds.filter((id) => enabledById.has(id));
  if (known.length === 0) return null;
  const enable = !known.some((id) => enabledById.get(id));
  return { enable, ids: known.filter((id) => enabledById.get(id) !== enable) };
}

/** Subtree item ids for every folder at once (one tree walk), for per-folder actions in big trees. */
export function collectLibraryFolderItemIdsByFolder(folders: LibraryFolderNode[]): Map<string, string[]> {
  const { roots, childrenByParent } = buildLibraryFolderTree(folders);
  const result = new Map<string, string[]>();
  const walk = (folder: LibraryFolderNode): Set<string> => {
    const ids = new Set(folder.itemIds);
    for (const child of childrenByParent.get(folder.id) ?? []) for (const id of walk(child)) ids.add(id);
    result.set(folder.id, [...ids]);
    return ids;
  };
  for (const root of roots) walk(root);
  return result;
}
