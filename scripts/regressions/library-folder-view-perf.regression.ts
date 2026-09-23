// Library folder view at scale: 2000 items in 300 nested folders. The view, the
// "Move to..." choices and the per-folder subtree item lists must stay fast (one
// tree walk, not one walk per folder) and must match a slow, obviously-correct
// reference computed folder by folder.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import {
  buildLibraryFolderView,
  collectLibraryFolderItemIds,
  collectLibraryFolderItemIdsByFolder,
  listLibraryFolderChoices,
  type LibraryFolderNode,
} from "../../packages/client/src/lib/library-folder-view.js";

const FOLDERS = 300;
const ITEMS = 2000;
const MAX_DEPTH = 6;
const BUDGET_MS = 750; // generous: a few ms in practice; the per-folder walk this guards against is far slower

let seed = 0x5eed;
const random = () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return seed / 2_147_483_648;
};
const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)]!;

// Folders: each hangs under a random earlier folder while depth allows, else at root.
const folders: LibraryFolderNode[] = [];
const depthById = new Map<string, number>();
for (let index = 0; index < FOLDERS; index += 1) {
  const id = `folder-${index}`;
  const candidates = folders.filter((folder) => (depthById.get(folder.id) ?? 1) < MAX_DEPTH);
  const parent = index > 0 && random() < 0.8 && candidates.length > 0 ? pick(candidates) : null;
  depthById.set(id, parent ? depthById.get(parent.id)! + 1 : 1);
  folders.push({ id, name: `Folder ${index}`, parentId: parent?.id ?? null, itemIds: [] });
}
// A stale parent id (deleted folder) falls back to root, as in real data.
folders[FOLDERS - 1]!.parentId = "folder-deleted";

// Items: most in one folder, some in two, some unfiled; folders also keep ids of deleted items.
const itemIds = Array.from({ length: ITEMS }, (_, index) => `item-${index}`);
for (const itemId of itemIds) {
  const roll = random();
  if (roll < 0.1) continue;
  pick(folders).itemIds.push(itemId);
  if (roll > 0.9) pick(folders).itemIds.push(itemId);
}
for (let index = 0; index < 100; index += 1) pick(folders).itemIds.push(`deleted-${index}`);

const known = new Set(itemIds);
const visibleUnfiltered = (id: string) => known.has(id);
const visibleFiltered = (id: string) => known.has(id) && Number(id.slice(5)) % 7 === 0;

// ── Slow reference, folder by folder ──
const byId = new Map(folders.map((folder) => [folder.id, folder]));
const effectiveParent = (folder: LibraryFolderNode) =>
  folder.parentId && byId.has(folder.parentId) ? folder.parentId : null;
const subtree = (rootId: string) => {
  const ids = [rootId];
  for (let cursor = 0; cursor < ids.length; cursor += 1) {
    for (const folder of folders) if (effectiveParent(folder) === ids[cursor]) ids.push(folder.id);
  }
  return ids;
};
const subtreeItems = (folderId: string) => new Set(subtree(folderId).flatMap((id) => byId.get(id)!.itemIds));
const pathOf = (folder: LibraryFolderNode): string => {
  const parentId = effectiveParent(folder);
  return parentId ? `${pathOf(byId.get(parentId)!)} / ${folder.name}` : folder.name;
};

function assertMatchesReference(filterActive: boolean, isVisible: (id: string) => boolean) {
  const view = buildLibraryFolderView(folders, isVisible, filterActive);
  for (const folder of folders) {
    const expected = [...subtreeItems(folder.id)].filter(isVisible).length;
    assert.equal(view.counts.get(folder.id), expected, `count of ${folder.id}`);
    assert.equal(view.shownFolderIds.has(folder.id), !filterActive || expected > 0, `shown ${folder.id}`);
    assert.equal(view.revealedFolderIds.has(folder.id), filterActive && expected > 0, `revealed ${folder.id}`);
  }
  for (const folder of folders) {
    for (const itemId of folder.itemIds) assert.ok(view.folderedItemIds.has(itemId));
  }
  // First folder (input order) that holds an item names its breadcrumb.
  const expectedPaths = new Map<string, string>();
  for (const folder of folders) {
    for (const itemId of folder.itemIds) if (!expectedPaths.has(itemId)) expectedPaths.set(itemId, pathOf(folder));
  }
  assert.deepEqual(view.pathByItemId, expectedPaths);
  return view;
}

const unfiltered = assertMatchesReference(false, visibleUnfiltered);
assertMatchesReference(true, visibleFiltered);
assert.ok([...unfiltered.counts.values()].some((count) => count > 100), "fixture has big subtrees");
assert.ok(Math.max(...depthById.values()) === MAX_DEPTH, "fixture reaches the maximum depth");

const choices = listLibraryFolderChoices(unfiltered.tree);
assert.equal(choices.length, FOLDERS);
for (const { folder, depth } of choices) {
  assert.equal(depth, pathOf(folder).split(" / ").length - 1, `choice depth of ${folder.id}`);
}

const itemsByFolder = collectLibraryFolderItemIdsByFolder(folders);
assert.equal(itemsByFolder.size, FOLDERS);
for (const folder of folders) {
  const expected = [...subtreeItems(folder.id)].sort();
  assert.deepEqual([...itemsByFolder.get(folder.id)!].sort(), expected, `subtree items of ${folder.id}`);
  if (folder.id.endsWith("0")) assert.deepEqual(collectLibraryFolderItemIds(folders, folder.id).sort(), expected);
}

// ── Timing: repeated runs give identical results inside a generous budget ──
const time = (label: string, run: () => unknown) => {
  run();
  const started = performance.now();
  for (let round = 0; round < 5; round += 1) run();
  const perRun = (performance.now() - started) / 5;
  assert.ok(perRun < BUDGET_MS, `${label} took ${perRun.toFixed(1)}ms per run (budget ${BUDGET_MS}ms)`);
  return perRun;
};
const snapshot = (view: ReturnType<typeof buildLibraryFolderView>) =>
  JSON.stringify([
    [...view.counts],
    [...view.shownFolderIds],
    [...view.revealedFolderIds],
    [...view.pathByItemId],
    [...view.folderedItemIds],
  ]);
const firstFiltered = snapshot(buildLibraryFolderView(folders, visibleFiltered, true));
const viewMs = time("buildLibraryFolderView", () => {
  assert.equal(snapshot(buildLibraryFolderView(folders, visibleFiltered, true)), firstFiltered);
});
const choicesMs = time("listLibraryFolderChoices", () => listLibraryFolderChoices(unfiltered.tree));
const byFolderMs = time("collectLibraryFolderItemIdsByFolder", () => collectLibraryFolderItemIdsByFolder(folders));

console.log(
  `library-folder-view-perf regression passed (view ${viewMs.toFixed(1)}ms, choices ${choicesMs.toFixed(1)}ms, ` +
    `subtree items ${byFolderMs.toFixed(1)}ms)`,
);
