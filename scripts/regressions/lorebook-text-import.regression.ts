import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  detectLorebookTextFormat,
  exportLorebookToCsv,
  exportLorebookToMarkdown,
  parseLorebookCsv,
  parseLorebookMarkdown,
  planLorebookTextImport,
  readCsvRows,
  summarizeLorebookTextImport,
} from "../../packages/shared/src/utils/lorebook-text-format.js";

// Covers Markdown / CSV lorebook import and export: parsers, validation,
// duplicate planning, round trips, and the import route end to end.

const codes = (issues: Array<{ code: string }>) => issues.map((issue) => issue.code);

// ── CSV reader ──
{
  const { rows } = readCsvRows(
    '﻿name,keys,content\r\n"Harbor","docks, pier","Line one\r\nLine ""two"""\r\n\r\nMoon,moon,Pale\r\n',
  );
  assert.equal(rows.length, 3, "BOM header, one quoted multiline row, blank line skipped, one plain row");
  assert.deepEqual(rows[0]!.cells, ["name", "keys", "content"], "BOM is stripped from the first header");
  assert.deepEqual(rows[1]!.cells, ["Harbor", "docks, pier", 'Line one\nLine "two"']);
  assert.equal(rows[2]!.line, 5, "line numbers count the newline inside the quoted cell");
  assert.equal(readCsvRows('name\n"open').unterminatedAt, 2);
  assert.deepEqual(
    readCsvRows("a,b\rc,d").rows.map((row) => row.cells),
    [
      ["a", "b"],
      ["c", "d"],
    ],
    "bare CR rows",
  );
}

// ── CSV parser ──
{
  const parsed = parseLorebookCsv(
    [
      "Name,Keys,Content,Folder,Enabled,Constant,Probability,Notes",
      'Tamsin,"Tamsin, the smith","A smith.\nWorks late.",People / Crafters,yes,no,50%,x',
      ",nokey,No name",
      "Ysolde,ysolde,,,maybe,,150",
      "tamsin,again,Second copy",
      ",,,,,,",
    ].join("\n"),
  );
  assert.equal(parsed.entries.length, 4, "an all-empty row is skipped");
  const [tamsin, noName, ysolde, copy] = parsed.entries;
  assert.deepEqual(tamsin!.keys, ["Tamsin", "the smith"]);
  assert.equal(tamsin!.content, "A smith.\nWorks late.");
  assert.deepEqual(tamsin!.folderPath, ["People", "Crafters"]);
  assert.equal(tamsin!.enabled, true);
  assert.equal(tamsin!.constant, false);
  assert.equal(tamsin!.probability, 50);
  assert.equal(tamsin!.invalid, false);
  assert.equal(noName!.invalid, true);
  assert.equal(ysolde!.invalid, true);
  assert.equal(copy!.invalid, false, "an in-file duplicate is a warning, not an error");
  assert.deepEqual(codes(parsed.issues.filter((issue) => issue.entryIndex === 2)).sort(), [
    "empty_content",
    "invalid_boolean",
    "invalid_probability",
  ]);
  assert.ok(parsed.issues.some((issue) => issue.code === "unknown_column" && issue.detail === "Notes"));
  assert.ok(parsed.issues.some((issue) => issue.code === "missing_name" && issue.line === 4));
  assert.ok(parsed.issues.some((issue) => issue.code === "duplicate_in_file" && issue.entryIndex === 3));

  assert.deepEqual(codes(parseLorebookCsv("name,content\nA,b").issues), ["missing_columns"]);
  assert.equal(parseLorebookCsv("name,content\nA,b").issues[0]!.detail, "keys");
  assert.deepEqual(codes(parseLorebookCsv('name,keys,content\n"A,b,c').issues), ["unterminated_quote"]);
  assert.deepEqual(codes(parseLorebookCsv("name,keys,content\n").issues), ["no_entries"]);
}

// ── Markdown parser ──
{
  const parsed = parseLorebookMarkdown(
    "﻿# Test World\r\nIntro text is ignored.\r\n\r\n## The Harbor\r\nKeys: harbor, docks\r\nFolder: Places\r\nConstant: yes\r\n\r\nBusy docks.\r\n\\## Not a heading\r\n\r\n## Rules\r\n\r\nNo keys here.\r\n## \r\nOrphan body\r\n",
  );
  assert.equal(parsed.title, "Test World");
  assert.equal(parsed.entries.length, 3);
  const [harbor, rules, orphan] = parsed.entries;
  assert.equal(harbor!.name, "The Harbor");
  assert.deepEqual(harbor!.keys, ["harbor", "docks"]);
  assert.deepEqual(harbor!.folderPath, ["Places"]);
  assert.equal(harbor!.constant, true);
  assert.equal(
    harbor!.content,
    "Busy docks.\n## Not a heading",
    "escaped heading lines stay in the body, CRLF normalised",
  );
  assert.equal(harbor!.line, 4);
  assert.deepEqual(rules!.keys, []);
  assert.equal(rules!.content, "No keys here.");
  assert.equal(orphan!.invalid, true);
  assert.ok(parsed.issues.some((issue) => issue.code === "missing_name" && issue.line === 15));
  assert.deepEqual(codes(parseLorebookMarkdown("just text").issues), ["no_entries"]);
}

// ── Format detection ──
assert.equal(detectLorebookTextFormat("", "world.CSV"), "csv");
assert.equal(detectLorebookTextFormat("name,keys,content\n"), "csv");
assert.equal(detectLorebookTextFormat("## Entry\n"), "markdown");

// ── Round trips ──
{
  const folders = [
    { id: "f1", name: "People", parentFolderId: null },
    { id: "f2", name: "Crafters", parentFolderId: "f1" },
  ];
  const entries = [
    {
      name: "Tamsin",
      keys: ["Tamsin", "smith"],
      content: 'A "smith", she said.\n\nWorks late.',
      folderId: "f2",
      enabled: true,
      constant: false,
      probability: null,
    },
    {
      name: "Rules",
      keys: [],
      content: "# Heading-like line\n\\# already escaped\nKeys: not metadata",
      folderId: null,
      enabled: false,
      constant: true,
      probability: 25,
    },
    { name: "Ysolde", keys: ["Ysolde"], content: "", folderId: "f1", enabled: true, constant: false, probability: 0 },
  ];
  const expected = entries.map((entry) => ({
    name: entry.name,
    keys: entry.keys,
    content: entry.content,
    folderPath: entry.folderId === "f2" ? ["People", "Crafters"] : entry.folderId === "f1" ? ["People"] : [],
    enabled: entry.enabled,
    constant: entry.constant,
    probability: entry.probability,
  }));
  const strip = (parsed: ReturnType<typeof parseLorebookCsv>) =>
    parsed.entries.map(({ line: _line, invalid: _invalid, ...entry }) => entry);

  const markdown = exportLorebookToMarkdown({ name: "Test World", entries, folders });
  const fromMarkdown = parseLorebookMarkdown(markdown);
  assert.equal(fromMarkdown.title, "Test World");
  assert.deepEqual(strip(fromMarkdown), expected, "Markdown round trip");
  assert.deepEqual(codes(fromMarkdown.issues.filter((issue) => issue.severity === "error")), []);
  assert.equal(
    exportLorebookToMarkdown({
      name: "Test World",
      entries: strip(fromMarkdown).map((entry, index) => ({ ...entry, folderId: entries[index]!.folderId })),
      folders,
    }),
    markdown,
    "Markdown export is stable",
  );

  const csv = exportLorebookToCsv({ entries, folders });
  assert.ok(csv.includes("\r\n"), "CSV uses CRLF rows");
  assert.deepEqual(strip(parseLorebookCsv(csv)), expected, "CSV round trip");
  assert.deepEqual(strip(parseLorebookCsv(`﻿${csv}`)), expected, "CSV round trip with BOM");
}

// ── Duplicate planning ──
{
  const entry = (name: string) => ({
    name,
    keys: [],
    content: name,
    folderPath: [],
    enabled: true,
    constant: false,
    probability: null,
  });
  const existing = [
    { id: "e1", name: "Harbor" },
    { id: "e2", name: "Harbor (2)" },
  ];
  const incoming = [entry("harbor"), entry("Moon"), entry("moon")];
  const skip = planLorebookTextImport(incoming, existing, "skip");
  assert.deepEqual(
    skip.map((action) => action.kind),
    ["skip", "create", "skip"],
  );
  const rename = planLorebookTextImport(incoming, existing, "rename");
  assert.deepEqual(
    rename.map((action) => (action.kind === "create" ? action.name : action.kind)),
    ["harbor (3)", "Moon", "moon (2)"],
  );
  assert.deepEqual(summarizeLorebookTextImport(rename), { created: 1, renamed: 2, overwritten: 0, skipped: 0 });
  const overwrite = planLorebookTextImport([...incoming, entry("HARBOR")], existing, "overwrite");
  assert.deepEqual(
    overwrite.map((action) => action.kind),
    ["skip", "skip", "create", "overwrite"],
    "the last copy in the file wins",
  );
  assert.equal(overwrite[3]!.kind === "overwrite" && overwrite[3]!.targetId, "e1");

  // A renamed copy of a 200-character name still fits the entry name limit.
  const longName = "x".repeat(200);
  const longRename = planLorebookTextImport([entry(longName)], [{ id: "e9", name: longName }], "rename");
  const renamed = longRename[0]!.kind === "create" ? longRename[0]!.name : "";
  assert.equal(renamed.length, 200);
  assert.ok(renamed.endsWith(" (2)"));
}

// ── Route ──
const dataDir = mkdtempSync(join(tmpdir(), "marinara-lorebook-text-import-"));
const previous = {
  DATA_DIR: process.env.DATA_DIR,
  FILE_STORAGE_DIR: process.env.FILE_STORAGE_DIR,
  MARINARA_FILE_STORAGE_DIR: process.env.MARINARA_FILE_STORAGE_DIR,
};
type Response = { statusCode: number; body: string; headers: Record<string, unknown>; json(): any };
let app: { close(): Promise<void>; inject(options: Record<string, unknown>): Promise<Response> } | null = null;

try {
  const fileStorageDir = join(dataDir, "file-storage");
  process.env.DATA_DIR = dataDir;
  process.env.FILE_STORAGE_DIR = fileStorageDir;
  process.env.MARINARA_FILE_STORAGE_DIR = fileStorageDir;

  // Only the text routes are mounted; the full lorebook route module is slow to load.
  const [{ createFileNativeDB }, { lorebookTextRoutes }, { createLorebooksStorage }] = await Promise.all([
    import("../../packages/server/src/db/file-backed-store.js"),
    import("../../packages/server/src/routes/lorebook-text.routes.js"),
    import("../../packages/server/src/services/storage/lorebooks.storage.js"),
  ]);
  const db = await createFileNativeDB();
  const Fastify = createRequire(new URL("../../packages/server/package.json", import.meta.url))("fastify");
  const server = Fastify({ bodyLimit: 256 * 1024 * 1024 });
  server.decorate("db", db);
  await server.register(lorebookTextRoutes, { prefix: "/api/lorebooks" });
  const storage = createLorebooksStorage(db);
  app = server;
  const request = async (method: string, url: string, payload?: unknown, expected = 200) => {
    const response = await app!.inject({ method, url, payload });
    assert.equal(response.statusCode, expected, `${method} ${url} -> ${response.statusCode} ${response.body}`);
    return response;
  };

  const book = (await storage.create({ name: "Test World" } as any)) as { id: string };
  await storage.createEntry({ lorebookId: book.id, name: "Harbor", keys: ["harbor"], content: "Old docks." } as any);

  const markdown =
    "## Harbor\nKeys: harbor, pier\nFolder: Places / Coast\n\nNew docks.\n\n## Moon\nKeys: moon\n\nPale.\n\n## \nBroken\n";
  const skipped = (
    await request("POST", `/api/lorebooks/${book.id}/import-text`, {
      format: "markdown",
      text: markdown,
      duplicateMode: "skip",
    })
  ).json();
  assert.equal(skipped.created, 1);
  assert.equal(skipped.skipped, 1);
  assert.equal(skipped.invalid, 1);
  assert.equal(skipped.foldersCreated, 0, "a skipped entry does not create its folder");

  const overwritten = (
    await request("POST", `/api/lorebooks/${book.id}/import-text`, {
      format: "markdown",
      text: markdown,
      duplicateMode: "overwrite",
    })
  ).json();
  assert.equal(overwritten.overwritten, 2);
  assert.equal(overwritten.foldersCreated, 2);
  const entries = (await storage.listEntries(book.id)) as unknown as Array<Record<string, any>>;
  assert.equal(entries.length, 2);
  const harbor = entries.find((entry) => entry.name === "Harbor")!;
  assert.equal(harbor.content, "New docks.");
  assert.deepEqual(harbor.keys, ["harbor", "pier"]);
  const folders = (await storage.listFolders(book.id)) as unknown as Array<Record<string, any>>;
  const coast = folders.find((folder) => folder.name === "Coast")!;
  assert.equal(harbor.folderId, coast.id);
  assert.equal(folders.find((folder) => folder.id === coast.parentFolderId)?.name, "Places");

  await request("POST", `/api/lorebooks/${book.id}/import-text`, { format: "csv", text: "name,content\nA,b" }, 400);
  await request("POST", `/api/lorebooks/${book.id}/import-text`, { format: "xml", text: "x" }, 400);
  await request("POST", "/api/lorebooks/missing/import-text", { format: "csv", text: "name,keys,content\nA,a,b" }, 404);

  // Export, then import into a new lorebook, reproduces the entries and folders.
  const exported = await request("GET", `/api/lorebooks/${book.id}/export-text?format=csv`);
  assert.match(String(exported.headers["content-type"]), /text\/csv/);
  assert.match(String(exported.headers["content-disposition"]), /Test%20World\.csv/);
  const fresh = (
    await request("POST", "/api/lorebooks/import-text", { name: "Copy", format: "csv", text: exported.body })
  ).json();
  assert.equal(fresh.created, 2);
  const copied = (await storage.listEntries(fresh.lorebookId)) as unknown as Array<Record<string, any>>;
  assert.deepEqual(
    copied.map((entry) => [entry.name, entry.content, entry.keys]),
    entries.map((entry) => [entry.name, entry.content, entry.keys]),
  );
  const copiedBook = (await storage.getById(fresh.lorebookId)) as { name: string };
  assert.equal(copiedBook.name, "Copy");

  const md = await request("GET", `/api/lorebooks/${book.id}/export-text?format=markdown`);
  assert.ok(md.body.startsWith("# Test World\n\n## "));

  // A failed import into a new lorebook does not leave an empty book behind.
  const before = (await storage.list()).length;
  await request("POST", "/api/lorebooks/import-text", { name: "Nope", format: "csv", text: "title\nx" }, 400);
  // Nor does a file whose every entry has an error.
  await request("POST", "/api/lorebooks/import-text", { name: "Nope", format: "markdown", text: "## \nbody" }, 400);
  assert.equal((await storage.list()).length, before);

  console.log("lorebook-text-import regression passed");
} finally {
  await app?.close();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dataDir, { recursive: true, force: true });
}
