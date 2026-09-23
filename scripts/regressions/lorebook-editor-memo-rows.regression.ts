import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Lorebook editor performance wiring: entry rows render through a memoized
// wrapper that receives one stable handlers object, and entry search filters
// against a deferred copy of the query. Static source checks only.
const read = (path: string) => readFileSync(new URL(`../../packages/client/src/${path}`, import.meta.url), "utf8");
const editor = read("components/lorebooks/LorebookEditor.tsx");
const item = read("components/lorebooks/LorebookEntryListItem.tsx");

// The wrapper is memoized and adapts the shared handlers into per-row callbacks.
assert.match(
  item,
  /export const LorebookEntryListItem = memo\(function LorebookEntryListItem\(/,
  "wrapper is memoized",
);
assert.match(item, /<LorebookEntryRow\b/, "wrapper renders the real row");
assert.match(
  item,
  /onToggleSelected = useCallback\(\s*\(event\?: \{ shiftKey: boolean \}\) => handlers\.toggleSelected\(entryId, event\)/,
  "wrapper forwards the click so Shift range selection keeps working",
);
assert.match(item, /onUpdateEntry=\{handlers\.updateEntry\}/, "row edits go through the shared handlers");
assert.match(item, /onDragOver=\{sortable \? onDragOver : noop\}/, "flat list rows get no drag wiring");

// The editor renders every entry list through the wrapper, never the bare row.
assert.doesNotMatch(editor, /<LorebookEntryRow\b/, "editor no longer renders LorebookEntryRow directly");
const listItems = editor.match(/<LorebookEntryListItem\b/g) ?? [];
assert.equal(listItems.length, 3, "folder, root and flat lists all use the memoized wrapper");
assert.equal(
  (editor.match(/handlers=\{entryRowHandlers\}/g) ?? []).length,
  3,
  "each list passes the one shared handlers object",
);
// Inline closures would defeat memo; the wrapper call sites must not pass any.
for (const block of editor.split("<LorebookEntryListItem").slice(1)) {
  const props = block.slice(0, block.indexOf("/>"));
  assert.doesNotMatch(props, /=>/, "no inline arrow functions are passed to a memoized row");
}

// Handlers are created once and read the latest state through a ref refreshed after commit.
assert.match(editor, /const entryRowHandlers = useMemo<LorebookEntryListHandlers>\(/, "handlers are memoized");
assert.match(
  editor,
  /\r?\n {4}\}\),\r?\n {4}\[\],\r?\n {2}\);\r?\n\r?\n {2}\/\/ ── Loading/,
  "handlers have no dependencies",
);
assert.match(
  editor,
  /useLayoutEffect\(\(\) => \{\r?\n {4}entryRowLatestRef\.current = \{/,
  "latest-state ref is refreshed after render",
);
// Drag rules: a folder over a folder's entry routes to that folder's body; over a root entry it falls through.
assert.match(
  editor,
  /if \(latest\.draggingFolderIdx !== null\) \{[\s\S]*?if \(containerId !== null\) latest\.handleFolderBodyFolderDragOver\(containerId, e\);\s*return;/,
  "folder drag-over rule kept",
);
assert.match(
  editor,
  /if \(latest\.draggingFolderIdx !== null\) \{\s*(?:\/\/[^\n]*\n\s*)*if \(containerId === null\) return;\s*e\.stopPropagation\(\);\s*latest\.commitFolderDrop\(e\);/,
  "folder drop rule kept",
);

// Search filters through a deferred value, and the grouped/flat switch follows the same value.
assert.match(editor, /const deferredEntrySearch = useDeferredValue\(entrySearch\);/, "search is deferred");
assert.match(editor, /includesTextForMatch\(e\.content, deferredEntrySearch\)/, "filter reads the deferred query");
assert.doesNotMatch(editor, /includesTextForMatch\([^)]*, entrySearch\)/, "filter never reads the urgent query");
assert.match(editor, /deferredEntrySearch\.trim\(\)\.length === 0/, "folder grouping follows the deferred query");
assert.match(editor, /value=\{entrySearch\}/, "the input itself stays bound to the urgent value");

console.log("lorebook-editor-memo-rows regression passed");
