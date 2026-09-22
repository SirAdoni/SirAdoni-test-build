import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "marinara-text-snippets-"));
process.env.DATA_DIR = directory;
process.env.FILE_STORAGE_DIR = join(directory, "storage");
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";

const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify") as typeof import("fastify").default;

const { filterSnippets, findSnippetExpansion, insertSnippetEdit, renderSnippetExpansion } =
  await import("../../packages/client/src/lib/text-snippets.js");
const { textSnippetCatalogSchema } = await import("../../packages/shared/src/schemas/text-snippets.schema.ts");
const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
const { appSettingsRoutes } = await import("../../packages/server/src/routes/app-settings.routes.js");

const snippets = [
  { id: "1", trigger: ";ooc", expansion: "(OOC: {{cursor}})" },
  { id: "2", trigger: ";sig", expansion: "Cheers, {{user}}" },
  { id: "3", trigger: "/me", expansion: "*{{char}} {{ cursor }} quietly*" },
];

function apply(value: string, edit: { start: number; end: number; replacement: string; caret: number } | null) {
  assert.ok(edit, "expected an expansion");
  const next = value.slice(0, edit.start) + edit.replacement + value.slice(edit.end);
  return { next, before: next.slice(0, edit.caret), after: next.slice(edit.caret) };
}

// ── {{cursor}} placement ──
assert.deepEqual(renderSnippetExpansion("(OOC: {{cursor}})"), { text: "(OOC: )", caretOffset: 6 });
assert.deepEqual(
  renderSnippetExpansion("a{{CURSOR}}b{{cursor}}c"),
  { text: "abc", caretOffset: 1 },
  "first marker wins",
);
assert.deepEqual(renderSnippetExpansion("plain"), { text: "plain", caretOffset: 5 });

// ── Space: the space was typed already and is consumed when a {{cursor}} exists ──
{
  const value = "Hello ;ooc ";
  const { next, before, after } = apply(value, findSnippetExpansion(value, value.length, snippets, "space"));
  assert.equal(next, "Hello (OOC: )");
  assert.equal(before, "Hello (OOC: ");
  assert.equal(after, ")");
}
// ── Space without {{cursor}}: keep the space so typing continues; macros stay literal ──
{
  const value = ";sig ";
  const { next, after } = apply(value, findSnippetExpansion(value, value.length, snippets, "space"));
  assert.equal(next, "Cheers, {{user}} ");
  assert.equal(after, "");
}
// ── Tab: trigger ends at the caret, text after the caret is preserved ──
{
  const value = "x /me and more";
  const { next, before } = apply(value, findSnippetExpansion(value, 5, snippets, "tab"));
  assert.equal(next, "x *{{char}}  quietly* and more");
  assert.equal(before, "x *{{char}} ");
}
// ── Only whole words fire; unknown words and missing delimiters do nothing ──
assert.equal(findSnippetExpansion("abc;ooc ", 8, snippets, "space"), null, "trigger glued to a word");
assert.equal(findSnippetExpansion(";oo ", 4, snippets, "space"), null, "unknown trigger");
assert.equal(findSnippetExpansion(";ooc", 4, snippets, "space"), null, "space delimiter requires the typed space");
assert.equal(findSnippetExpansion(";ooc ", 5, [], "space"), null, "no snippets");
assert.equal(findSnippetExpansion(" ", 1, snippets, "space"), null);
assert.ok(findSnippetExpansion("line one\n;ooc ", 14, snippets, "space"), "newline counts as a boundary");

// ── Picker insertion replaces the selection ──
assert.deepEqual(insertSnippetEdit(snippets[0]!, 2, 5), { start: 2, end: 5, replacement: "(OOC: )", caret: 8 });

// ── Filtering puts trigger matches first ──
assert.deepEqual(
  filterSnippets(snippets, "me").map((snippet) => snippet.id),
  ["3"],
);
assert.deepEqual(
  filterSnippets(snippets, "ch").map((snippet) => snippet.id),
  ["2", "3"],
  "expansion text matches",
);
assert.equal(filterSnippets(snippets, "").length, 3);

// ── Schema ──
assert.equal(textSnippetCatalogSchema.safeParse({ version: 1, snippets }).success, true);
assert.equal(
  textSnippetCatalogSchema.safeParse({ version: 1, snippets: [{ id: "a", trigger: "has space", expansion: "x" }] })
    .success,
  false,
  "triggers cannot contain whitespace",
);
assert.equal(
  textSnippetCatalogSchema.safeParse({
    version: 1,
    snippets: [
      { id: "a", trigger: ";x", expansion: "1" },
      { id: "b", trigger: ";x", expansion: "2" },
    ],
  }).success,
  false,
  "duplicate triggers are rejected",
);
assert.equal(
  textSnippetCatalogSchema.safeParse({ version: 1, snippets: [{ id: "a", trigger: ";x", expansion: "   " }] }).success,
  false,
  "blank expansions are rejected",
);

// ── Server persistence via the synced app settings route ──
const db = await createFileNativeDB();
try {
  const app = Fastify();
  app.decorate("db", db);
  await app.register(appSettingsRoutes, { prefix: "/api/app-settings" });
  const empty = await app.inject({ method: "GET", url: "/api/app-settings/text-snippets" });
  assert.deepEqual(empty.json(), { version: 1, snippets: [] });
  const saved = await app.inject({
    method: "PUT",
    url: "/api/app-settings/text-snippets",
    payload: { version: 1, snippets },
  });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(
    (await app.inject({ method: "GET", url: "/api/app-settings/text-snippets" })).json().snippets,
    snippets,
  );
  const invalid = await app.inject({
    method: "PUT",
    url: "/api/app-settings/text-snippets",
    payload: { version: 1, snippets: [{ id: "a", trigger: "", expansion: "x" }] },
  });
  assert.notEqual(invalid.statusCode, 200);
  await app.close();
} finally {
  await db._fileStore.close();
  rmSync(directory, { recursive: true, force: true });
}

// ── Both chat composers wire expansion in (input for space, keydown for Tab) ──
for (const file of ["ChatInput.tsx", "ConversationInput.tsx"]) {
  const source = readFileSync(new URL(`../../packages/client/src/components/chat/${file}`, import.meta.url), "utf8");
  assert.match(source, /useSnippetExpansion\(/u, `${file} uses snippet expansion`);
  assert.match(source, /expandOnInput\(event\)/u, `${file} expands on input`);
  assert.match(source, /expandOnKeyDown\(e/u, `${file} expands on Tab`);
  assert.match(source, /<SnippetPicker/u, `${file} renders the snippet picker`);
}

// ── The controlled Game Mode input stores the expanded text and skips its own change ──
{
  const source = readFileSync(
    new URL("../../packages/client/src/components/game/GameInput.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /useSnippetExpansion\(inputRef/u, "GameInput uses snippet expansion");
  assert.match(source, /if \(expandOnInput\(e\)\) return;/u, "GameInput expands on space");
  assert.match(source, /if \(expandOnKeyDown\(e\)\) return;/u, "GameInput expands on Tab");
  assert.match(source, /<SnippetPicker/u, "GameInput answers the palette's snippet picker request");
}

// ── Settings never saves over a catalog it failed to load (each save writes the whole list) ──
{
  const source = readFileSync(
    new URL("../../packages/client/src/components/panels/settings/TextSnippetsSettings.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /if \(!data && isError\) \{/u, "a failed load blocks editing instead of showing an empty list");
}

// ── Picker: IME Enter does not pick, Escape hands focus back to the composer ──
{
  const source = readFileSync(
    new URL("../../packages/client/src/components/chat/SnippetPicker.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /if \(event\.nativeEvent\.isComposing\) return;/u, "picker ignores keys during IME composition");
  assert.match(source, /querySelector<HTMLTextAreaElement>\("textarea:not\(\[disabled\]\)"\)\?\.focus\(\)/u);
}

console.log("text snippets regression passed");
