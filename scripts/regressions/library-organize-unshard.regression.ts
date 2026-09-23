// Library organize vs the launcher's unshard step (scripts/protect-launcher-data.mjs):
// library_campaign_links is on its sharded-table list next to the store's own
// built-in list, its shard rows are rebuilt into a monolith, folder parentIds
// survive, and pre-branch data without the links table is a no-op for it.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileNativeDB } from "../../packages/server/src/db/file-backed-store.js";
import { libraryCampaignLinks, libraryFolders } from "../../packages/server/src/db/schema/index.js";
// @ts-expect-error plain ESM launcher script without type declarations
import { unshardLauncherStorage } from "../../scripts/protect-launcher-data.mjs";

const LINKS = "library_campaign_links";
const storeSource = readFileSync(new URL("../../packages/server/src/db/file-backed-store.ts", import.meta.url), "utf8");
const launcherSource = readFileSync(new URL("../protect-launcher-data.mjs", import.meta.url), "utf8");
assert.ok(storeSource.includes(`"${LINKS}"`), "the store registers library_campaign_links as a built-in table");
assert.ok(
  /const SHARDED_TABLES = \[[^\]]*"library_campaign_links"/s.test(launcherSource),
  "the launcher's unshard list covers library_campaign_links",
);

const root = mkdtempSync(join(tmpdir(), "marinara-library-organize-unshard-"));
const storageRoot = join(root, "storage");
const previousStorageRoot = process.env.FILE_STORAGE_DIR;
process.env.FILE_STORAGE_DIR = storageRoot;
const stamp = "2026-01-01T00:00:00.000Z";

try {
  const db = await createFileNativeDB();
  await db.insert(libraryFolders).values([
    {
      id: "top",
      scope: "lorebooks",
      name: "Top",
      collapsed: "false",
      sortOrder: 0,
      itemIds: "[]",
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: "child",
      scope: "lorebooks",
      name: "Child",
      collapsed: "false",
      sortOrder: 1,
      itemIds: "[]",
      parentId: "top",
      createdAt: stamp,
      updatedAt: stamp,
    },
  ]);
  await db.insert(libraryCampaignLinks).values({
    id: "link-1",
    campaignId: "game",
    itemType: "lorebook",
    itemId: "book-1",
    mode: "include",
    createdAt: stamp,
  });
  await db._fileStore.close();

  const tablesDir = join(storageRoot, "tables");
  const unshard = await unshardLauncherStorage({ root, env: { FILE_STORAGE_DIR: storageRoot }, probeServer: false });
  const linkResult = (unshard.results as string[]).find((line) => line.startsWith(`${LINKS}:`));
  assert.ok(linkResult?.includes("rebuilt the monolith from 1 row"), `unshard rebuilds the links table: ${linkResult}`);
  const monolith = JSON.parse(readFileSync(join(tablesDir, `${LINKS}.json`), "utf8")) as Array<{ itemId: string }>;
  assert.deepEqual(
    monolith.map((row) => row.itemId),
    ["book-1"],
  );
  const folders = JSON.parse(readFileSync(join(tablesDir, "library_folders.json"), "utf8")) as Array<{
    id: string;
    parentId?: string | null;
  }>;
  assert.equal(folders.find((row) => row.id === "child")?.parentId, "top", "parentId survives unshard");

  const emptyRoot = join(root, "empty");
  const empty = await unshardLauncherStorage({
    root: emptyRoot,
    env: { FILE_STORAGE_DIR: join(emptyRoot, "storage") },
    probeServer: false,
  });
  assert.ok(
    (empty.results as string[]).includes(`${LINKS}: no data to convert`),
    "unshard of data without the links table is a no-op for it",
  );

  console.log("library organize unshard regression passed");
} finally {
  if (previousStorageRoot === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousStorageRoot;
  rmSync(root, { recursive: true, force: true });
}
