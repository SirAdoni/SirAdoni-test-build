// ──────────────────────────────────────────────
// Library folder view: what a nested folder tree shows
// for the current filters (visible folders, counts,
// auto-expanded ancestors, item breadcrumbs).
// ──────────────────────────────────────────────
import { buildLibraryFolderTree, countLibraryFolderItems, type LibraryFolderTree } from "@marinara-engine/shared";

export type LibraryFolderNode = {
  id: string;
  name: string;
  parentId: string | null;
  itemIds: string[];
};

export type LibraryFolderView = {
  tree: LibraryFolderTree<LibraryFolderNode>;
  /** Items per folder including subfolders; limited to visible items while a filter is active. */
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
  const counts = countLibraryFolderItems(folders, filterActive ? isItemVisible : undefined);
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
