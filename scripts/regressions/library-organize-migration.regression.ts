// Library organize migration safety: data written before nested folders and
// library campaigns existed must load cleanly. A storage dir whose
// library_folders and character_groups rows have no parentId, and that has no
// library_campaign_links table at all (no shard files, no manifest entry),
// opens through createFileNativeDB with every folder at the root, an empty links
// table, and working folder/campaign storage and routes. The launcher side
// lives in library-organize-unshard.regression.ts.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileNativeDB } from "../../packages/server/src/db/file-backed-store.js";
import {
  characterGroups,
  chats,
  characters,
  libraryCampaignLinks,
  libraryFolders,
} from "../../packages/server/src/db/schema/index.js";
import { createLibraryFoldersStorage } from "../../packages/server/src/services/storage/library-folders.storage.js";
import { createCharactersStorage } from "../../packages/server/src/services/storage/characters.storage.js";
import { createLibraryCampaignsStorage } from "../../packages/server/src/services/storage/library-campaigns.storage.js";
import { libraryCampaignsRoutes } from "../../packages/server/src/routes/library-campaigns.routes.js";
import { libraryFoldersRoutes } from "../../packages/server/src/routes/library-folders.routes.js";

const LINKS = "library_campaign_links";
const root = mkdtempSync(join(tmpdir(), "marinara-library-organize-migration-"));
const storageRoot = join(root, "storage");
const previousStorageRoot = process.env.FILE_STORAGE_DIR;
process.env.FILE_STORAGE_DIR = storageRoot;
const stamp = "2026-01-01T00:00:00.000Z";

// ── 1. Write "old" data, then strip everything this branch added. ──
{
  const db = await createFileNativeDB();
  await db.insert(libraryFolders).values([
    {
      id: "old-a",
      scope: "lorebooks",
      name: "World",
      collapsed: "false",
      sortOrder: 0,
      itemIds: '["book-1"]',
      createdAt: stamp,
      updatedAt: stamp,
    },
    {
      id: "old-b",
      scope: "lorebooks",
      name: "Regions",
      collapsed: "true",
      sortOrder: 1,
      itemIds: '["book-2"]',
      createdAt: stamp,
      updatedAt: stamp,
    },
  ]);
  await db.insert(characterGroups).values([
    { id: "grp-a", name: "Party", description: "", characterIds: '["hero"]', createdAt: stamp, updatedAt: stamp },
    {
      id: "grp-b",
      name: "Villains",
      description: "",
      characterIds: '["lich"]',
      createdAt: stamp,
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
  ]);
  await db
    .insert(characters)
    .values({ id: "hero", data: JSON.stringify({ name: "Hero" }), createdAt: stamp, updatedAt: stamp });
  await db.insert(chats).values({
    id: "game-1",
    name: "Old campaign",
    mode: "game",
    characterIds: '["hero"]',
    metadata: JSON.stringify({ gameId: "old-game", gameSessionNumber: 1 }),
    createdAt: stamp,
    updatedAt: stamp,
  });
  await db._fileStore.close();
}

const tablesDir = join(storageRoot, "tables");
for (const table of ["library_folders", "character_groups"]) {
  const dir = join(tablesDir, table);
  for (const name of readdirSync(dir).filter((file) => file.endsWith(".json"))) {
    const rows = JSON.parse(readFileSync(join(dir, name), "utf8")) as Array<Record<string, unknown>>;
    writeFileSync(join(dir, name), JSON.stringify(rows.map(({ parentId: _parentId, ...row }) => row)));
  }
}
rmSync(join(tablesDir, LINKS), { recursive: true, force: true });
rmSync(join(tablesDir, `${LINKS}.json`), { force: true });
for (const file of ["manifest.json", "manifest.json.bak"]) {
  const path = join(storageRoot, file);
  if (!existsSync(path)) continue;
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, Record<string, unknown> | unknown>;
  for (const key of ["tables", "shards"]) {
    const section = manifest[key];
    if (section && typeof section === "object") delete (section as Record<string, unknown>)[LINKS];
  }
  writeFileSync(path, JSON.stringify(manifest, null, 2));
}
assert.equal(existsSync(join(tablesDir, LINKS)), false);
assert.ok(
  readFileSync(join(tablesDir, "library_folders", "old-a.json"), "utf8").includes('"name"') &&
    !readFileSync(join(tablesDir, "library_folders", "old-a.json"), "utf8").includes("parentId"),
  "fixture rows really lack parentId",
);

// ── 2. Reopen with the current code. ──
try {
  const db = await createFileNativeDB();
  try {
    assert.deepEqual(await db.select().from(libraryCampaignLinks), [], "the missing links table loads empty");

    const folders = createLibraryFoldersStorage(db);
    const lorebookFolders = await folders.list("lorebooks");
    assert.deepEqual(
      lorebookFolders.map((folder) => [folder.id, folder.parentId, folder.sortOrder, folder.itemIds]),
      [
        ["old-a", null, 0, ["book-1"]],
        ["old-b", null, 1, ["book-2"]],
      ],
      "legacy folders are root folders with their order and items intact",
    );
    const nested = await folders.update("lorebooks", "old-b", { parentId: "old-a" });
    assert.equal(nested?.parentId, "old-a", "a legacy folder can be nested");

    const characterStorage = createCharactersStorage(db);
    const groups = await characterStorage.listGroups();
    assert.deepEqual(
      groups.map((group) => [group.id, group.parentId ?? null]),
      [
        ["grp-b", null],
        ["grp-a", null],
      ],
      "legacy character groups are root folders and keep their newest-first order",
    );
    await characterStorage.removeGroup("grp-b");
    assert.deepEqual(
      (await characterStorage.listGroups()).map((group) => [group.id, group.characterIds]),
      [["grp-a", '["hero"]']],
      "deleting a legacy root group leaves the other preset alone",
    );

    const campaigns = await createLibraryCampaignsStorage(db).list();
    assert.deepEqual(
      campaigns.map((campaign) => [campaign.id, campaign.characterIds, campaign.manualKeys]),
      [["old-game", ["hero"], []]],
      "campaigns derive from old game chats with no manual links",
    );

    const require = createRequire(new URL("../../packages/server/package.json", import.meta.url));
    const app = require("fastify")();
    app.decorate("db", db);
    await app.register(libraryCampaignsRoutes, { prefix: "/api/library" });
    await app.register(libraryFoldersRoutes, { prefix: "/api/library-folders" });
    try {
      const listed = await app.inject({ method: "GET", url: "/api/library/campaigns" });
      assert.equal(listed.statusCode, 200);
      assert.equal(listed.json().campaigns[0].id, "old-game");
      const added = await app.inject({
        method: "POST",
        url: "/api/library/campaigns/old-game/items",
        payload: { itemType: "lorebook", itemIds: ["book-1"] },
      });
      assert.equal(added.statusCode, 200, "the first link write creates the table");
      const folderList = await app.inject({ method: "GET", url: "/api/library-folders/lorebooks" });
      assert.equal(folderList.statusCode, 200);
      assert.deepEqual(
        folderList.json().map((folder: { id: string; parentId: string | null }) => [folder.id, folder.parentId]),
        [
          ["old-a", null],
          ["old-b", "old-a"],
        ],
      );
    } finally {
      await app.close();
    }
    assert.equal((await db.select().from(libraryCampaignLinks)).length, 1);
  } finally {
    await db._fileStore.close();
  }
  assert.ok(existsSync(join(tablesDir, LINKS)), "the links table is persisted like any other sharded table");

  console.log("library organize migration regression passed");
} finally {
  if (previousStorageRoot === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousStorageRoot;
  rmSync(root, { recursive: true, force: true });
}
