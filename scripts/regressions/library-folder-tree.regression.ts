// Nested library folders: the shared tree rules (cycle and depth checks, delete
// re-parenting, descendant counts, broken-data tolerance) plus the two stores
// that use them: resource library folders (lorebooks/presets/agents) and
// character groups, which double as the Characters panel folders.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildLibraryFolderTree,
  checkLibraryFolderParent,
  collectLibraryFolderSubtreeIds,
  countLibraryFolderItems,
  getLibraryFolderPath,
  getLibraryFolderSubtreeHeight,
  LIBRARY_FOLDER_MAX_DEPTH,
  planLibraryFolderDelete,
  resolveLibraryFolderParents,
} from "../../packages/shared/src/utils/library-folder-tree.js";
import { buildLibraryFolderView, listLibraryFolderChoices } from "../../packages/client/src/lib/library-folder-view.js";
import { createFileNativeDB } from "../../packages/server/src/db/file-backed-store.js";
import {
  createLibraryFoldersStorage,
  LibraryFolderTreeError,
} from "../../packages/server/src/services/storage/library-folders.storage.js";
import { createCharactersStorage } from "../../packages/server/src/services/storage/characters.storage.js";

// ── Pure tree rules ──
{
  const folders = [
    { id: "a", parentId: null, itemIds: ["x"] },
    { id: "b", parentId: "a", itemIds: ["y", "x"] },
    { id: "c", parentId: "b", itemIds: ["z"] },
    { id: "d", itemIds: [] }, // legacy flat folder: no parentId at all
    { id: "e", parentId: "missing", itemIds: [] },
  ];
  const tree = buildLibraryFolderTree(folders);
  assert.deepEqual(
    tree.roots.map((folder) => folder.id),
    ["a", "d", "e"],
    "absent or dangling parents render at the root",
  );
  assert.deepEqual(
    tree.childrenByParent.get("a")?.map((folder) => folder.id),
    ["b"],
  );
  assert.equal(tree.depthById.get("c"), 3, "depth counts from 1 at the root");
  assert.deepEqual(
    getLibraryFolderPath(folders, "c").map((folder) => folder.id),
    ["a", "b", "c"],
    "path runs root first",
  );
  assert.deepEqual(collectLibraryFolderSubtreeIds(folders, "a").sort(), ["a", "b", "c"]);
  assert.equal(getLibraryFolderSubtreeHeight(folders, "a"), 3);

  const counts = countLibraryFolderItems(folders);
  assert.equal(counts.get("a"), 3, "counts include descendants and count shared ids once");
  assert.equal(counts.get("b"), 3);
  assert.equal(counts.get("c"), 1);
  assert.equal(countLibraryFolderItems(folders, (id) => id !== "x").get("a"), 2, "visibility filter applies");

  assert.equal(checkLibraryFolderParent(folders, "a", "c").ok, false, "a folder cannot move under a descendant");
  const cycle = checkLibraryFolderParent(folders, "a", "c");
  assert.equal(!cycle.ok && cycle.code, "cycle");
  const self = checkLibraryFolderParent(folders, "b", "b");
  assert.equal(!self.ok && self.code, "self");
  const missing = checkLibraryFolderParent(folders, "b", "nope");
  assert.equal(!missing.ok && missing.code, "parent_not_found");
  assert.equal(checkLibraryFolderParent(folders, "c", null).ok, true, "moving to the root is always fine");
  assert.equal(checkLibraryFolderParent(folders, "d", "c").ok, true);
  assert.equal(checkLibraryFolderParent(folders, null, "c").ok, true, "new subfolder under depth 3");

  // Depth limit, counting the moving folder's own subtree.
  const chain = Array.from({ length: LIBRARY_FOLDER_MAX_DEPTH }, (_, index) => ({
    id: `l${index + 1}`,
    parentId: index === 0 ? null : `l${index}`,
  }));
  const deepest = `l${LIBRARY_FOLDER_MAX_DEPTH}`;
  const tooDeep = checkLibraryFolderParent(chain, null, deepest);
  assert.equal(!tooDeep.ok && tooDeep.code, "depth", "no new folder below the maximum depth");
  const withBranch = [...chain, { id: "branch", parentId: null }, { id: "leaf", parentId: "branch" }];
  const branchMove = checkLibraryFolderParent(withBranch, "branch", `l${LIBRARY_FOLDER_MAX_DEPTH - 1}`);
  assert.equal(!branchMove.ok && branchMove.code, "depth", "a two-level branch cannot land one level above the max");
  assert.equal(checkLibraryFolderParent(withBranch, "branch", `l${LIBRARY_FOLDER_MAX_DEPTH - 2}`).ok, true);

  // Stored cycles never hang or hide folders.
  const broken = [
    { id: "p", parentId: "q" },
    { id: "q", parentId: "p" },
    { id: "r", parentId: "q" },
  ];
  const parents = resolveLibraryFolderParents(broken);
  assert.equal(parents.get("p"), null, "earliest member of a stored loop becomes a root");
  assert.equal(parents.get("q"), "p");
  const brokenTree = buildLibraryFolderTree(broken);
  assert.deepEqual(
    brokenTree.roots.map((folder) => folder.id),
    ["p"],
  );
  assert.equal(brokenTree.depthById.get("r"), 3);

  // Delete re-parenting.
  const planB = planLibraryFolderDelete(folders, "b");
  assert.deepEqual(planB, { parentId: "a", childIds: ["c"], itemIdsForParent: ["y"] }, "items join the parent once");
  const planA = planLibraryFolderDelete(folders, "a");
  assert.deepEqual(planA, { parentId: null, childIds: ["b"], itemIdsForParent: [] }, "root delete frees items");
  assert.equal(planLibraryFolderDelete(folders, "nope"), null);
}

// ── Client folder view (what the panels render) ──
{
  const folders = [
    { id: "world", name: "World", parentId: null, itemIds: ["atlas"] },
    { id: "regions", name: "Regions", parentId: "world", itemIds: ["north", "south"] },
    { id: "empty", name: "Empty", parentId: null, itemIds: [] },
  ];
  const unfiltered = buildLibraryFolderView(folders, () => true, false);
  assert.equal(unfiltered.shownFolderIds.size, 3, "without a filter every folder shows, empty ones included");
  assert.equal(unfiltered.revealedFolderIds.size, 0, "nothing is force-opened without a filter");
  assert.equal(unfiltered.counts.get("world"), 3);
  assert.equal(unfiltered.pathByItemId.get("north"), "World / Regions", "breadcrumbs run root first");
  assert.deepEqual(
    listLibraryFolderChoices(unfiltered.tree).map(({ folder, depth }) => `${depth}:${folder.id}`),
    ["0:world", "1:regions", "0:empty"],
    "move picker lists the tree depth-first",
  );

  const searching = buildLibraryFolderView(folders, (id) => id === "south", true);
  assert.deepEqual([...searching.shownFolderIds].sort(), ["regions", "world"], "only folders holding a match show");
  assert.ok(searching.revealedFolderIds.has("world"), "a match deep inside opens its ancestors");
  assert.equal(searching.counts.get("world"), 1, "filtered counts only include visible items");
}

// ── Stores ──
const storageRoot = mkdtempSync(join(tmpdir(), "marinara-library-folder-tree-"));
const previousStorageRoot = process.env.FILE_STORAGE_DIR;
process.env.FILE_STORAGE_DIR = storageRoot;
const db = await createFileNativeDB();
try {
  const folders = createLibraryFoldersStorage(db);
  const world = await folders.create("lorebooks", { name: "World" });
  assert.ok(world);
  assert.equal(world.parentId, null, "flat create stays at the root");
  const regions = await folders.create("lorebooks", { name: "Regions", parentId: world.id });
  assert.equal(regions?.parentId, world.id);
  const north = await folders.create("lorebooks", { name: "North", parentId: regions!.id });
  await folders.moveItems("lorebooks", { itemIds: ["book-1"], folderId: world.id });
  await folders.moveItems("lorebooks", { itemIds: ["book-2", "book-3"], folderId: regions!.id });

  await assert.rejects(
    () => folders.update("lorebooks", world.id, { parentId: north!.id }),
    (error: unknown) => error instanceof LibraryFolderTreeError && error.code === "cycle",
    "the store refuses a cycle",
  );
  await assert.rejects(
    () => folders.create("presets", { name: "Wrong scope", parentId: world.id }),
    (error: unknown) => error instanceof LibraryFolderTreeError && error.code === "parent_not_found",
    "parents must be in the same scope",
  );

  assert.equal(await folders.remove("lorebooks", regions!.id), true);
  const afterDelete = await folders.list("lorebooks");
  const northAfter = afterDelete.find((folder) => folder.id === north!.id);
  assert.equal(northAfter?.parentId, world.id, "subfolders move up to the deleted folder's parent");
  assert.deepEqual(
    afterDelete.find((folder) => folder.id === world.id)?.itemIds,
    ["book-1", "book-2", "book-3"],
    "items move up to the parent",
  );
  assert.equal(
    await folders.update("lorebooks", north!.id, { parentId: null }).then((folder) => folder?.parentId),
    null,
  );

  // Concurrent folder moves: A under B and B under A must not both pass the cycle check.
  const alpha = await folders.create("agents", { name: "Alpha" });
  const beta = await folders.create("agents", { name: "Beta" });
  const moves = await Promise.allSettled([
    folders.update("agents", alpha!.id, { parentId: beta!.id }),
    folders.update("agents", beta!.id, { parentId: alpha!.id }),
  ]);
  assert.equal(
    moves.filter((result) => result.status === "rejected").length,
    1,
    "exactly one of two crossing folder moves is refused",
  );
  const agentFolders = await folders.list("agents");
  const agentParents = resolveLibraryFolderParents(agentFolders);
  assert.ok(
    agentFolders.every((folder) => (folder.parentId ?? null) === agentParents.get(folder.id)),
    "the stored agent folders form a tree without a cut cycle",
  );
  // A subfolder created while its parent is being deleted must not end up under a dead id.
  const doomed = await folders.create("agents", { name: "Doomed" });
  const [, createdChild] = await Promise.allSettled([
    folders.remove("agents", doomed!.id),
    folders.create("agents", { name: "Late child", parentId: doomed!.id }),
  ]);
  const afterRace = await folders.list("agents");
  assert.ok(
    afterRace.every((folder) => !folder.parentId || afterRace.some((other) => other.id === folder.parentId)),
    "no folder points at a deleted parent",
  );
  assert.ok(createdChild.status === "rejected" || afterRace.some((folder) => folder.name === "Late child"));
  assert.equal(await folders.update("agents", "missing-folder", { name: "x" }), null, "unknown folder: null");

  // Character groups (Characters panel folders).
  const characters = createCharactersStorage(db);
  const party = await characters.createGroup("Party", "", ["hero"]);
  const npcs = await characters.createGroup("NPCs", "", ["guard", "hero"], party!.id);
  const town = await characters.createGroup("Town", "", ["baker"], npcs!.id);
  assert.equal(npcs?.parentId, party!.id);
  await assert.rejects(
    () => characters.updateGroup(party!.id, { parentId: town!.id }),
    (error: unknown) => error instanceof LibraryFolderTreeError && error.code === "cycle",
  );
  await assert.rejects(
    () => characters.createGroup("Orphan", "", [], "missing-parent"),
    (error: unknown) => error instanceof LibraryFolderTreeError,
  );
  const townBefore = (await characters.getGroupById(town!.id))!;
  await characters.removeGroup(npcs!.id);
  const groups = await characters.listGroups();
  const townAfter = groups.find((group) => group.id === town!.id);
  assert.equal(townAfter?.parentId, party!.id, "subgroup moves up");
  assert.equal(townAfter?.updatedAt, townBefore.updatedAt, "a re-parented subgroup keeps its place in the list");
  assert.deepEqual(
    JSON.parse(groups.find((group) => group.id === party!.id)!.characterIds),
    ["hero"],
    "deleting a subfolder leaves the parent group preset unchanged (guard is simply unfoldered)",
  );

  // Concurrent moves: A under B and B under A must not both pass the cycle check.
  const left = await characters.createGroup("Left", "", []);
  const right = await characters.createGroup("Right", "", []);
  const groupMoves = await Promise.allSettled([
    characters.updateGroup(left!.id, { parentId: right!.id }),
    characters.updateGroup(right!.id, { parentId: left!.id }),
  ]);
  assert.equal(
    groupMoves.filter((result) => result.status === "rejected").length,
    1,
    "exactly one of two crossing group moves is refused",
  );
  const crossed = await characters.listGroups();
  const crossedParents = resolveLibraryFolderParents(
    crossed.map((group) => ({ id: group.id, parentId: group.parentId ?? null })),
  );
  assert.ok(
    crossed.every((group) => (group.parentId ?? null) === crossedParents.get(group.id)),
    "the stored groups form a tree without a cut cycle",
  );
  await characters.removeGroup(left!.id);
  await characters.removeGroup(right!.id);
  await characters.removeGroup(party!.id);
  const rootGroups = await characters.listGroups();
  assert.equal(rootGroups.find((group) => group.id === town!.id)?.parentId, null, "root delete frees subgroups");

  console.log("library folder tree regression passed");
} finally {
  await db._fileStore.close();
  if (previousStorageRoot === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousStorageRoot;
  rmSync(storageRoot, { recursive: true, force: true });
}
