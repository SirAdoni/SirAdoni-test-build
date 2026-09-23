import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Random tables and the oracle: the pure roll module with seeded randomness, the
// file-backed table (global and per game), the routes (CRUD, import, roll with
// nested references, oracle, lorebook-built tables, dice-log logging) and the
// registrations a new table needs.

const root = mkdtempSync(join(tmpdir(), "marinara-random-tables-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

try {
  const tables = await import("../../packages/shared/src/utils/random-tables.ts");
  const {
    createSeededRng,
    createTableLookup,
    buildLorebookTableRows,
    formatOracleLine,
    formatTableRollLine,
    inferDiceForSpan,
    listTableReferences,
    oracleBands,
    parsePlainTableList,
    formatPlainTableList,
    parseRandomTableImport,
    buildRandomTableExport,
    resolveOracleRoll,
    resolveTableRanges,
    rollOracle,
    rollRandomTable,
  } = tables;

  // ── Seeded randomness is deterministic and in range ──
  {
    const a = createSeededRng("brindlemere");
    const b = createSeededRng("brindlemere");
    const seqA = Array.from({ length: 20 }, () => a());
    assert.deepEqual(
      seqA,
      Array.from({ length: 20 }, () => b()),
      "the same seed repeats",
    );
    assert.ok(seqA.every((value) => value >= 0 && value < 1));
    assert.notDeepEqual(seqA.slice(0, 5), Array.from({ length: 5 }, createSeededRng("other")));
  }

  // ── Ranges: explicit, follow-on and weighted ──
  {
    const dice = resolveTableRanges({
      name: "Encounters",
      dice: "2d6",
      rows: [{ text: "Bandits", min: 2, max: 5 }, { text: "Wolves", weight: 3 }, { text: "Merchant" }, { text: "   " }],
    });
    assert.equal(dice.notation, "2d6");
    assert.deepEqual(
      dice.rows.map((row) => [row.text, row.min, row.max]),
      [
        ["Bandits", 2, 5],
        ["Wolves", 6, 8],
        ["Merchant", 9, 9],
      ],
      "a row without a range follows on and spans its weight; blank rows are dropped",
    );
    assert.deepEqual(dice.gaps, [10, 11, 12]);

    const weighted = resolveTableRanges({
      name: "Weather",
      rows: [{ text: "Sun", weight: 3 }, { text: "Rain" }, { text: "Fog", weight: 2 }],
    });
    assert.equal(weighted.notation, "d6", "a weighted table rolls d<total weight>");
    assert.deepEqual(
      weighted.rows.map((row) => [row.min, row.max]),
      [
        [1, 3],
        [4, 4],
        [5, 6],
      ],
    );
    assert.equal(resolveTableRanges({ name: "Bad dice", dice: "d6+2", rows: [{ text: "x" }] }).notation, "d1");
  }

  // ── Rolls are reproducible with a seed and land on a covering row ──
  {
    const table = { name: "Weather", rows: [{ text: "Sun", weight: 3 }, { text: "Rain" }, { text: "Fog", weight: 2 }] };
    const first = rollRandomTable(table, { rng: createSeededRng(7) });
    const again = rollRandomTable(table, { rng: createSeededRng(7) });
    assert.deepEqual(first, again, "same seed, same result");
    const counts = { Sun: 0, Rain: 0, Fog: 0 } as Record<string, number>;
    const rng = createSeededRng("weights");
    for (let index = 0; index < 6000; index += 1) counts[rollRandomTable(table, { rng }).text]! += 1;
    assert.ok(counts.Sun! > 2700 && counts.Sun! < 3300, `Sun is about half: ${counts.Sun}`);
    assert.ok(counts.Rain! > 800 && counts.Rain! < 1200, `Rain is about a sixth: ${counts.Rain}`);

    const gap = rollRandomTable(
      { name: "Short", dice: "d20", rows: [{ text: "Only", min: 1, max: 1 }] },
      {
        rng: () => 0.99,
      },
    );
    assert.equal(gap.total, 20);
    assert.equal(gap.rowIndex, -1, "a total no row covers is reported, not forced onto a row");
    assert.equal(formatTableRollLine(gap), "Short (d20: 20): (no row for this total)");
  }

  // ── Nested references roll recursively, with a depth limit and a loop guard ──
  {
    const all = [
      { name: "Encounters", rows: [{ text: "[[Monsters]] near the [[ place ]] ([[1d1+2]] of them)" }] },
      { name: "Monsters", rows: [{ text: "Ghouls" }] },
      { name: "Place", rows: [{ text: "old mill" }] },
      { name: "Loop", rows: [{ text: "again [[Loop]]" }] },
      { name: "Deep 1", rows: [{ text: "a [[Deep 2]]" }] },
      { name: "Deep 2", rows: [{ text: "b [[Deep 3]]" }] },
      { name: "Deep 3", rows: [{ text: "c [[Deep 4]]" }] },
      { name: "Deep 4", rows: [{ text: "d" }] },
    ];
    const lookup = createTableLookup(all);
    const nested = rollRandomTable(all[0]!, { rng: createSeededRng(1), lookup });
    assert.equal(nested.text, "Ghouls near the old mill (3 of them)", "tables and inline dice both expand");
    assert.deepEqual(
      nested.nested.map((entry) => entry.tableName),
      ["Monsters", "Place"],
    );
    assert.deepEqual(listTableReferences(all[0]!), ["Monsters", "place"], "inline dice are not table references");

    const loop = rollRandomTable(all[3]!, { rng: createSeededRng(1), lookup });
    assert.equal(loop.text, "again Loop", "a table never rolls itself inside itself");
    assert.deepEqual(loop.unresolved, ["Loop"]);

    const limited = rollRandomTable(all[4]!, { rng: createSeededRng(1), lookup, maxDepth: 2 });
    assert.equal(limited.text, "a b c Deep 4", "two levels of nesting, then the name is left as is");
    const full = rollRandomTable(all[4]!, { rng: createSeededRng(1), lookup });
    assert.equal(full.text, "a b c d");

    const missing = rollRandomTable(
      { name: "M", rows: [{ text: "see [[Nowhere]]" }] },
      { rng: createSeededRng(1), lookup },
    );
    assert.equal(missing.text, "see [[Nowhere]]", "an unknown reference stays visible");
    assert.deepEqual(missing.unresolved, ["Nowhere"]);
  }

  // ── Plain-list paste ──
  {
    const ranged = parsePlainTableList("1-3: Bandits\n4. Wolves\n5 - 6) Rain\n\n");
    assert.equal(ranged.dice, "d6", "ranges covering 1..6 infer a d6");
    assert.deepEqual(ranged.rows[1], { text: "Wolves", min: 4, max: 4 });
    assert.equal(parsePlainTableList("2-6: A\n7: B\n8-12: C").dice, "2d6");
    const plain = parsePlainTableList("- Rain\n* Snow (x3)\nFog\n1-2: mixed");
    assert.equal(plain.dice, null, "an unranged or mixed list rolls by weight");
    assert.deepEqual(
      plain.rows,
      [{ text: "Rain" }, { text: "Snow", weight: 3 }, { text: "Fog" }, { text: "1-2: mixed" }],
      "a mixed list keeps leading numbers as text",
    );
    const odd = parsePlainTableList("5-10: Storm\n11: Calm");
    assert.equal(odd.dice, null, "5..11 fits no plain dice");
    assert.deepEqual(odd.rows[0], { text: "Storm", min: 5, max: 10, weight: 6 }, "the span becomes the weight");
    const source = "1-3: Bandits\n4: Wolves\n5-6: [[Weather]]";
    assert.equal(formatPlainTableList(parsePlainTableList(source).rows), source, "the editor text round-trips");
    assert.equal(formatPlainTableList([{ text: "Snow", weight: 3 }, { text: "Fog" }]), "Snow (x3)\nFog");
    assert.equal(inferDiceForSpan(1, 100), "d100");
    assert.equal(inferDiceForSpan(3, 18), "3d6");
    assert.equal(inferDiceForSpan(1, 1), null);
    // The editor parses on every keystroke: a long whitespace run must stay linear
    // (the old `\s+\(` weight suffix took seconds on 50k spaces).
    const started = performance.now();
    const spaced = parsePlainTableList(`a${" ".repeat(200_000)}b\n1${" ".repeat(200_000)}-${" ".repeat(1000)}x`);
    assert.ok(performance.now() - started < 1000, "long whitespace runs parse in linear time");
    assert.equal(spaced.rows.length, 2);
    assert.deepEqual(parsePlainTableList("Snow  (weight 2)\nfoo(x2)").rows, [
      { text: "Snow", weight: 2 },
      { text: "foo(x2)" },
    ]);
  }

  // ── Import / export ──
  {
    const exported = buildRandomTableExport([{ name: "Loot", dice: "d4", rows: [{ text: "Gold", min: 1, max: 4 }] }]);
    assert.equal(exported.format, "marinara-random-tables");
    assert.deepEqual(parseRandomTableImport(JSON.parse(JSON.stringify(exported))), [
      { name: "Loot", dice: "d4", description: "", rows: [{ text: "Gold", min: 1, max: 4 }] },
    ]);
    const loose = parseRandomTableImport([
      { name: "  A  ", dice: "bogus", entries: ["x", { result: "y", weight: 2 }, 5, { text: "" }] },
      { rows: ["no name"] },
    ]);
    assert.deepEqual(loose, [
      { name: "A", dice: null, description: "", rows: [{ text: "x" }, { text: "y", weight: 2 }] },
    ]);
    assert.equal(parseRandomTableImport({ name: "Single", rows: ["a"] }).length, 1);
    const flood = parseRandomTableImport(Array.from({ length: 5000 }, (_, index) => ({ name: `T${index}`, rows: [] })));
    assert.equal(flood.length, 2000, "an import reads at most one scope's worth of tables");
  }

  // ── Lorebook rows ──
  {
    const rows = buildLorebookTableRows(
      [
        { name: "Mira", folderId: "npcs", tag: "npc", enabled: true },
        { name: "Leofric", folderId: "nobles", tag: "NPC", enabled: true },
        { name: "mira", folderId: "npcs", tag: "npc", enabled: true },
        { name: "Hidden", folderId: "npcs", tag: "npc", enabled: false },
        { name: "Ashford", folderId: "places", tag: "location", enabled: true },
      ],
      { folderIds: ["npcs", "nobles"] },
    );
    assert.deepEqual(rows, [{ text: "Leofric" }, { text: "Mira" }], "sorted, deduplicated, disabled skipped");
    assert.deepEqual(
      buildLorebookTableRows([{ name: "Ashford", folderId: null, tag: "Location", enabled: true }], {
        tag: "location",
      }),
      [{ text: "Ashford" }],
    );
  }

  // ── Oracle ──
  {
    assert.deepEqual(oracleBands("even"), { chance: 50, exceptionalYes: 10, exceptionalNo: 91 });
    const outcomes = [1, 10, 11, 45, 46, 50, 51, 55, 56, 90, 91, 100].map(
      (roll) => resolveOracleRoll("even", roll).outcome,
    );
    assert.deepEqual(outcomes, [
      "yes_and",
      "yes_and",
      "yes",
      "yes",
      "yes_but",
      "yes_but",
      "no_but",
      "no_but",
      "no",
      "no",
      "no_and",
      "no_and",
    ]);
    assert.equal(resolveOracleRoll("certain", 90).answer, "yes");
    assert.equal(resolveOracleRoll("impossible", 11).answer, "no");
    assert.equal(resolveOracleRoll("impossible", 2).outcome, "yes_and");
    assert.equal(resolveOracleRoll("certain", 99).outcome, "no_and");
    assert.equal(resolveOracleRoll("certain", 97).exceptional, false);
    const seeded = rollOracle("likely", createSeededRng("oracle"));
    assert.deepEqual(seeded, rollOracle("likely", createSeededRng("oracle")));
    assert.equal(
      formatOracleLine(resolveOracleRoll("likely", 73), "  Is the gate open? "),
      "Is the gate open? Oracle (likely, d100: 73): Yes, but",
    );
  }

  // ── Registration ──
  const { createFileNativeDB, FILE_BACKED_TABLES, getFileTableShardStrategy, isLazyUnitTable } =
    await import("../../packages/server/src/db/file-backed-store.js");
  assert.ok(FILE_BACKED_TABLES.includes("random_tables"));
  assert.equal(getFileTableShardStrategy("random_tables").kind, "primary-key", "one record per table id");
  assert.equal(isLazyUnitTable("random_tables"), false);
  assert.match(read("../protect-launcher-data.mjs"), /"random_tables"/);
  assert.match(read("../../packages/server/src/db/schema/index.ts"), /random-tables\.js/);
  assert.match(
    read("../../packages/server/src/routes/index.ts"),
    /randomTablesRoutes, \{ prefix: "\/api\/random-tables" \}/,
  );

  // ── Routes ──
  const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
  const Fastify = requireServer("fastify") as typeof import("fastify").default;
  const { chats, lorebooks, lorebookEntries, lorebookFolders } =
    await import("../../packages/server/src/db/schema/index.js");
  const { randomTablesRoutes } = await import("../../packages/server/src/routes/random-tables.routes.js");
  const { createGameDiceRollsStorage } =
    await import("../../packages/server/src/services/storage/game-dice-rolls.storage.js");

  const db = await createFileNativeDB();
  const createdAt = new Date().toISOString();
  await db.insert(chats).values({
    id: "session-1",
    name: "Brindlemere — Session 1",
    mode: "game",
    groupId: "game-1",
    metadata: JSON.stringify({ gameId: "game-1" }),
    createdAt,
    updatedAt: createdAt,
  });
  await db.insert(chats).values({
    id: "rp-1",
    name: "Roleplay",
    mode: "roleplay",
    metadata: "{}",
    createdAt,
    updatedAt: createdAt,
  });

  const app = Fastify();
  app.decorate("db", db);
  await app.register(randomTablesRoutes, { prefix: "/api/random-tables" });
  await app.ready();
  const call = async (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) => {
    const response = await app.inject({ method, url: `/api/random-tables${url}`, payload: payload as never });
    return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : null };
  };

  try {
    const global = await call("POST", "/", {
      scope: "global",
      table: { name: "Monsters", dice: "d4", rows: [{ text: "Ghouls", min: 1, max: 4 }] },
    });
    assert.equal(global.status, 200);
    assert.equal(global.body.gameId, "");
    const gameTable = await call("POST", "/", {
      scope: "game",
      chatId: "session-1",
      table: { name: "Encounters", dice: null, rows: [{ text: "[[Monsters]] at the ford" }] },
    });
    assert.equal(gameTable.body.gameId, "game-1", "a game table is scoped to the chat's campaign");
    assert.equal(
      (await call("POST", "/", { scope: "game", chatId: "rp-1", table: { name: "X", rows: [] } })).status,
      400,
      "only a Game Mode chat has a game",
    );

    const listed = await call("GET", "/?chatId=session-1");
    assert.equal(listed.body.gameId, "game-1");
    assert.deepEqual(
      listed.body.tables.map((table: { name: string }) => table.name),
      ["Encounters", "Monsters"],
      "game tables first, then global",
    );
    assert.deepEqual(
      (await call("GET", "/")).body.tables.map((table: { name: string }) => table.name),
      ["Monsters"],
      "outside a game only global tables are visible",
    );

    const rolled = await call("POST", "/roll", { tableId: gameTable.body.id, chatId: "session-1", log: true });
    assert.equal(rolled.status, 200);
    assert.equal(rolled.body.result.text, "Ghouls at the ford", "references resolve across scopes");
    assert.equal(rolled.body.line, "Encounters (d1: 1): Ghouls at the ford");
    assert.equal(rolled.body.logged, 1);
    const unlogged = await call("POST", "/roll", { tableId: gameTable.body.id, chatId: "session-1" });
    assert.equal(unlogged.body.logged, 0, "logging is opt-in");

    const oracle = await call("POST", "/oracle", {
      likelihood: "likely",
      question: "Is it raining?",
      chatId: "session-1",
      log: true,
    });
    assert.equal(oracle.status, 200);
    assert.ok(oracle.body.result.roll >= 1 && oracle.body.result.roll <= 100);
    assert.match(oracle.body.line, /^Is it raining\? Oracle \(likely, d100: \d+\): (Yes|No)/);
    assert.equal((await call("POST", "/oracle", { likelihood: "sure" })).status, 400);

    const log = await createGameDiceRollsStorage(db).list({ chatId: "session-1" });
    assert.equal(log.length, 2);
    assert.ok(log.every((entry) => entry.source === "table"));
    assert.equal(log[1]!.label, "Encounters: Ghouls at the ford");
    assert.match(log[0]!.label ?? "", /^Oracle \(likely\): (Yes|No).*\. Is it raining\?$/);

    const updated = await call("PUT", `/${global.body.id}`, {
      table: { name: "Monsters", dice: "d6", rows: ["Ghouls", "Wights"] },
    });
    assert.equal(updated.body.dice, "d6");
    assert.equal(updated.body.rows.length, 2);
    assert.equal((await call("PUT", "/missing", { table: { name: "A", rows: [] } })).status, 404);

    const imported = await call("POST", "/import", {
      scope: "game",
      chatId: "session-1",
      data: { format: "marinara-random-tables", version: 1, tables: [{ name: "Loot", rows: ["Gold", "Rope"] }, {}] },
    });
    assert.equal(imported.body.created.length, 1);
    assert.equal(imported.body.skipped, 0);
    assert.equal((await call("POST", "/import", { data: [] })).status, 400);
    const oversized = await app.inject({
      method: "POST",
      url: "/api/random-tables/import",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ data: [{ name: "Big", rows: ["x".repeat(17 * 1024 * 1024)] }] }),
    });
    assert.equal(oversized.statusCode, 413, "an import body has its own limit, not the 256 MB upload default");

    // Moving a table into a full scope is refused like a create would be. A second
    // mount with a cap of one stands in for a scope holding MAX_RANDOM_TABLES.
    await db.insert(chats).values({
      id: "session-full",
      name: "Full — Session 1",
      mode: "game",
      groupId: "game-full",
      metadata: JSON.stringify({ gameId: "game-full" }),
      createdAt,
      updatedAt: createdAt,
    });
    const capped = Fastify();
    capped.decorate("db", db);
    await capped.register(randomTablesRoutes, { prefix: "/api/random-tables", maxTables: 1 });
    await capped.ready();
    try {
      const put = async (id: string, payload: unknown) =>
        (await capped.inject({ method: "PUT", url: `/api/random-tables/${id}`, payload: payload as never })).statusCode;
      const filler = await call("POST", "/", { scope: "game", chatId: "session-full", table: { name: "F", rows: [] } });
      assert.equal(filler.status, 200);
      assert.equal(
        await put(updated.body.id, {
          scope: "game",
          chatId: "session-full",
          table: { name: "Monsters", rows: ["Ghouls"] },
        }),
        409,
        "a move keeps to the per-scope cap",
      );
      assert.equal(
        await put(filler.body.id, { scope: "game", chatId: "session-full", table: { name: "F2", rows: [] } }),
        200,
        "an edit that stays in its full scope is fine",
      );
      assert.equal((await call("DELETE", `/${filler.body.id}`)).status, 200);
    } finally {
      await capped.close();
    }

    // Lorebook-built table.
    await db.insert(lorebooks).values({ id: "lb-1", name: "World", createdAt, updatedAt: createdAt } as never);
    await db.insert(lorebookFolders).values({
      id: "f-npcs",
      lorebookId: "lb-1",
      name: "NPCs",
      createdAt,
      updatedAt: createdAt,
    } as never);
    await db.insert(lorebookFolders).values({
      id: "f-nobles",
      lorebookId: "lb-1",
      name: "Nobles",
      parentFolderId: "f-npcs",
      createdAt,
      updatedAt: createdAt,
    } as never);
    const entry = (id: string, name: string, folderId: string | null, tag: string) =>
      db
        .insert(lorebookEntries)
        .values({ id, lorebookId: "lb-1", name, folderId, tag, createdAt, updatedAt: createdAt } as never);
    await entry("e1", "Mira", "f-npcs", "npc");
    await entry("e2", "Lady Leofric", "f-nobles", "npc");
    await entry("e3", "Ashford", null, "location");
    await db.insert(lorebookEntries).values({
      id: "e4",
      lorebookId: "lb-1",
      name: "Sleeping Giant",
      folderId: "f-npcs",
      tag: "npc",
      enabled: "false",
      createdAt,
      updatedAt: createdAt,
    } as never);

    const sources = await call("GET", "/lorebook-sources/lb-1");
    assert.equal(sources.status, 200);
    assert.equal(sources.body.entryCount, 4);
    assert.deepEqual(
      sources.body.tags.map((tag: { tag: string; count: number }) => [tag.tag, tag.count]),
      [
        ["location", 1],
        ["npc", 3],
      ],
    );
    const fromFolder = await call("POST", "/from-lorebook", {
      scope: "global",
      name: "Random NPC",
      lorebookId: "lb-1",
      folderId: "f-npcs",
    });
    assert.equal(fromFolder.status, 200);
    assert.deepEqual(
      fromFolder.body.rows.map((row: { text: string }) => row.text),
      ["Lady Leofric", "Mira"],
      'subfolders are included by default; a disabled entry (stored as "false") is not',
    );
    const topOnly = await call("POST", "/from-lorebook", {
      scope: "global",
      name: "Top",
      lorebookId: "lb-1",
      folderId: "f-npcs",
      includeSubfolders: false,
    });
    assert.deepEqual(
      topOnly.body.rows.map((row: { text: string }) => row.text),
      ["Mira"],
    );
    const byTag = await call("POST", "/from-lorebook", {
      scope: "global",
      name: "Places",
      lorebookId: "lb-1",
      tag: "Location",
    });
    assert.deepEqual(byTag.body.rows, [{ text: "Ashford" }]);
    assert.equal((await call("POST", "/from-lorebook", { name: "None", lorebookId: "lb-1" })).status, 400);
    assert.equal(
      (await call("POST", "/from-lorebook", { name: "None", lorebookId: "lb-1", tag: "nothing" })).status,
      400,
    );

    assert.equal((await call("DELETE", `/${global.body.id}`)).status, 200);
    assert.equal((await call("DELETE", `/${global.body.id}`)).status, 404);
  } finally {
    await app.close();
  }

  // ── Client wiring ──
  const panel = read("../../packages/client/src/components/game/GameToolsPanel.tsx");
  assert.match(panel, /RandomTablesTool/);
  const host = read("../../packages/client/src/components/command-palette/CommandPaletteHost.tsx");
  assert.match(host, /id: "action:random-tables"/);
  const english = JSON.parse(read("../../packages/client/src/localization/locales/en.json")) as Record<string, string>;
  for (const [key, value] of Object.entries(english)) {
    if (key.startsWith("ui.randomTables.")) assert.ok(!value.includes("—"), `${key} has no em dash`);
  }
  assert.ok(english["ui.game.diceLog.sourceTable"]);
  console.log("random tables regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
