import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Starter packs for the random tables tool: every shipped pack parses through the
// import sanitiser unchanged, has 12 to 100 rows a table, dice tables without gaps,
// nested references that stay inside the pack, no em or en dashes, rolls cleanly many
// times, and imports through the route with skipExisting so adding it twice is a no-op.

const root = mkdtempSync(join(tmpdir(), "marinara-random-table-packs-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const packDir = new URL("../../packages/client/src/lib/table-packs/", import.meta.url);

type PackTable = { name: string; dice: string | null; description?: string; rows: unknown[] };
type Pack = { id: string; name: string; description: string; tables: PackTable[] };

try {
  const { resetFeatureSettingsForTests } =
    await import("../../packages/server/src/services/features/feature-settings.js");
  resetFeatureSettingsForTests({ randomTables: true });
  const {
    createSeededRng,
    createTableLookup,
    listTableReferences,
    normalizeTableName,
    parseRandomTableImport,
    resolveTableRanges,
    rollRandomTable,
  } = await import("../../packages/shared/src/utils/random-tables.ts");

  const files = readdirSync(packDir)
    .filter((file) => file.endsWith(".json"))
    .sort();
  assert.ok(files.length >= 5, "at least five starter packs ship");
  const packs: Pack[] = files.map((file) => {
    const text = readFileSync(new URL(file, packDir), "utf8");
    assert.ok(!text.includes("—"), `${file} has no em dash`);
    assert.ok(!text.includes("–"), `${file} has no en dash`);
    return JSON.parse(text) as Pack;
  });

  // The client module lists every pack file and has translation keys for each.
  const packModule = read("../../packages/client/src/lib/random-table-packs.ts");
  for (const file of files) assert.ok(packModule.includes(`table-packs/${file}"`), `${file} is imported`);
  const english = JSON.parse(read("../../packages/client/src/localization/locales/en.json")) as Record<string, string>;
  for (const key of packModule.match(/ui\.randomTables\.pack\w+/g) ?? []) {
    assert.ok(english[key], `${key} is in en.json`);
  }
  for (const [key, value] of Object.entries(english)) {
    if (key.startsWith("ui.randomTables.")) assert.ok(!/[–—]/.test(value), `${key} has no em dash`);
  }

  const packIds = new Set<string>();
  const allNames = new Set<string>();
  let nestedTables = 0;
  let totalTables = 0;
  for (const pack of packs) {
    assert.ok(pack.id && !packIds.has(pack.id), `pack id ${pack.id} is unique`);
    packIds.add(pack.id);
    assert.ok(pack.name && pack.description, `${pack.id} has a name and description`);
    assert.ok(packModule.includes(`"${pack.id}"`) || packModule.includes(`${pack.id}:`), `${pack.id} has keys`);

    const parsed = parseRandomTableImport({ format: "marinara-random-tables", version: 1, tables: pack.tables });
    assert.equal(parsed.length, pack.tables.length, `${pack.id}: every table survives the import sanitiser`);
    const lookup = createTableLookup(parsed);
    for (const [index, table] of parsed.entries()) {
      const source = pack.tables[index]!;
      totalTables += 1;
      assert.equal(table.name, source.name, `${source.name}: name kept`);
      assert.equal(table.dice ?? null, source.dice ?? null, `${source.name}: dice kept`);
      assert.equal(table.rows.length, source.rows.length, `${source.name}: every row kept`);
      assert.ok(table.rows.length >= 12 && table.rows.length <= 100, `${source.name} has 12 to 100 rows`);
      const key = normalizeTableName(table.name);
      assert.ok(!allNames.has(key), `${table.name} is not repeated across packs`);
      allNames.add(key);
      assert.equal(
        new Set(table.rows.map((row) => row.text)).size,
        table.rows.length,
        `${table.name} has no duplicate rows`,
      );

      const ranges = resolveTableRanges(table);
      assert.deepEqual(ranges.gaps, [], `${table.name} covers every total of its dice`);
      const references = listTableReferences(table);
      if (references.length > 0) nestedTables += 1;
      for (const name of references) assert.ok(lookup(name), `${table.name} refers to [[${name}]] inside ${pack.id}`);

      const rng = createSeededRng(`${pack.id}:${table.name}`);
      for (let roll = 0; roll < 100; roll += 1) {
        const result = rollRandomTable(table, { rng, lookup });
        assert.ok(result.rowIndex >= 0, `${table.name} always lands on a row`);
        assert.deepEqual(result.unresolved, [], `${table.name} rolls every reference`);
        assert.ok(!result.text.includes("[["), `${table.name} leaves no reference unrolled`);
        assert.ok(result.text.trim().length > 0);
      }
    }
  }
  assert.ok(nestedTables >= 5, "several tables use nested references");
  assert.ok(totalTables >= 20);

  // ── Import route with skipExisting ──
  const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
  const Fastify = requireServer("fastify") as typeof import("fastify").default;
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  const { chats } = await import("../../packages/server/src/db/schema/index.js");
  const { randomTablesRoutes } = await import("../../packages/server/src/routes/random-tables.routes.js");

  const db = await createFileNativeDB();
  const createdAt = new Date().toISOString();
  await db.insert(chats).values({
    id: "session-1",
    name: "Session 1",
    mode: "game",
    groupId: "game-1",
    metadata: JSON.stringify({ gameId: "game-1" }),
    createdAt,
    updatedAt: createdAt,
  });
  const app = Fastify();
  app.decorate("db", db);
  await app.register(randomTablesRoutes, { prefix: "/api/random-tables" });
  await app.ready();
  const call = async (method: "GET" | "POST", url: string, payload?: unknown) => {
    const response = await app.inject({ method, url: `/api/random-tables${url}`, payload: payload as never });
    return { status: response.statusCode, body: JSON.parse(response.body) };
  };
  const exportOf = (pack: Pack) => ({ format: "marinara-random-tables", version: 1, tables: pack.tables });

  try {
    const taverns = packs.find((pack) => pack.id === "taverns-and-inns")!;
    const treasure = packs.find((pack) => pack.id === "treasure")!;

    // A global table the player already made with a pack table's name (in other case) is kept.
    const own = await call("POST", "/", {
      scope: "global",
      table: { name: "tavern name", dice: null, rows: ["The Player's Own"] },
    });
    assert.equal(own.status, 200);

    const first = await call("POST", "/import", { scope: "global", data: exportOf(taverns), skipExisting: true });
    assert.equal(first.status, 200);
    assert.equal(first.body.created.length, taverns.tables.length - 1);
    assert.equal(first.body.existing, 1);
    assert.equal(first.body.skipped, 1);

    const again = await call("POST", "/import", { scope: "global", data: exportOf(taverns), skipExisting: true });
    assert.equal(again.body.created.length, 0, "adding a pack twice adds nothing");
    assert.equal(again.body.existing, taverns.tables.length);

    // A game import skips names the game already sees from the global scope.
    const intoGame = await call("POST", "/import", {
      scope: "game",
      chatId: "session-1",
      data: { tables: [...taverns.tables.slice(0, 2), ...treasure.tables] },
      skipExisting: true,
    });
    assert.equal(intoGame.body.created.length, treasure.tables.length);
    assert.equal(intoGame.body.existing, 2);
    assert.ok(intoGame.body.created.every((table: { gameId: string }) => table.gameId === "game-1"));

    // An "All games" add is not blocked by a game's own tables, so the picker only checks global names for it.
    const intoGlobal = await call("POST", "/import", {
      scope: "global",
      chatId: "session-1",
      data: exportOf(treasure),
      skipExisting: true,
    });
    assert.equal(intoGlobal.body.created.length, treasure.tables.length);
    assert.equal(intoGlobal.body.existing, 0);

    // Without the flag the import keeps its old behaviour and adds duplicates.
    const plain = await call("POST", "/import", { scope: "global", data: { tables: taverns.tables.slice(0, 1) } });
    assert.equal(plain.body.created.length, 1);
    assert.equal(plain.body.existing, 0);

    // The imported pack rolls through the route with its nested references.
    const visible = await call("GET", "/?chatId=session-1");
    const major = visible.body.tables.find((table: { name: string }) => table.name === "Loot (Major)");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const rolled = await call("POST", "/roll", { tableId: major.id, chatId: "session-1" });
      assert.equal(rolled.status, 200);
      assert.deepEqual(rolled.body.result.unresolved, []);
      assert.ok(!rolled.body.result.text.includes("[["));
    }
  } finally {
    await app.close();
  }

  // ── Client wiring ──
  const tool = read("../../packages/client/src/components/tools/RandomTablesTool.tsx");
  assert.match(tool, /skipExisting: true/);
  assert.match(tool, /ui\.randomTables\.addStarterPack/);
  assert.match(tool, /scope === "global" \? globalTableNames : tableNames/);
  assert.match(tool, /ui\.randomTables\.packCapped/);
  console.log("random table packs regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
