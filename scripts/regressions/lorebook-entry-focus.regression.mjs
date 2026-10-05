import fs from "node:fs";
import assert from "node:assert/strict";
import vm from "node:vm";
import ts from "typescript";

const read = (p) => fs.readFileSync(p, "utf8");
const editor = read("packages/client/src/components/lorebooks/LorebookEditor.tsx");
const ast = ts.createSourceFile("editor.tsx", editor, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const effects = [];
function visit(node) {
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(ast) === "useEffect" &&
    node.arguments[0]?.getText(ast).includes("lorebookDetailInitialEntryId")
  )
    effects.push(node.arguments[0].getText(ast));
  ts.forEachChild(node, visit);
}
visit(ast);
assert.equal(effects.length, 1);
assert.match(editor, /useUIStore\(\(s\) => s\.lorebookDetailInitialEntryId\)/);
const code = ts.transpile(`(${effects[0]})`, { target: ts.ScriptTarget.ES2022 });
let state = { lorebookDetailId: "book", lorebookDetailInitialEntryId: "old" };
const jumps = [];
const render = (entries, loading = false) => {
  const ctx = {
    lorebookId: state.lorebookDetailId,
    lorebookDetailInitialEntryId: state.lorebookDetailInitialEntryId,
    lorebook: {},
    rawEntries: loading ? undefined : entries,
    entries,
    isLoading: loading,
    useUIStore: {
      getState: () => state,
      setState: (patch) => {
        state = { ...state, ...patch };
      },
    },
    jumpToEntry: (id) => jumps.push(id),
  };
  vm.createContext(ctx);
  return () => vm.runInContext(code, ctx)();
};
render([], true)();
render([])();
assert.equal(state.lorebookDetailInitialEntryId, "old");
const stale = render([{ id: "old" }]);
state.lorebookDetailInitialEntryId = "new";
stale();
assert.equal(state.lorebookDetailInitialEntryId, "new");
assert.deepEqual(jumps, []);
render([{ id: "old" }])();
assert.equal(state.lorebookDetailInitialEntryId, "new");
render([{ id: "old" }, { id: "new" }])();
assert.deepEqual(jumps, ["new"]);
assert.equal(state.lorebookDetailInitialEntryId, null);
render([{ id: "new" }])();
assert.deepEqual(jumps, ["new"]);
state.lorebookDetailInitialEntryId = "new";
render([{ id: "new" }])();
assert.deepEqual(jumps, ["new", "new"]);
state.lorebookDetailInitialEntryId = "old";
const oldBook = render([{ id: "old" }]);
state = { lorebookDetailId: "other", lorebookDetailInitialEntryId: "other-entry" };
oldBook();
assert.equal(state.lorebookDetailInitialEntryId, "other-entry");
assert.deepEqual(jumps, ["new", "new"]);
render([{ id: "other-entry" }])();
assert.deepEqual(jumps, ["new", "new", "other-entry"]);

const helper = read("packages/client/src/lib/lorebook-entry-focus.ts");
const helperAst = ts.createSourceFile("helper.ts", helper, ts.ScriptTarget.Latest, true);
const opener = helperAst.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === "openLorebookEntry");
assert.ok(opener);
const calls = [];
const ctx = { useUIStore: { getState: () => ({ openLorebookDetail: (...args) => calls.push(args) }) } };
vm.createContext(ctx);
vm.runInContext(
  ts.transpile(opener.getText(helperAst).replace(/^export\s+/, "") + '\nopenLorebookEntry("book", "entry");', {
    target: ts.ScriptTarget.ES2022,
  }),
  ctx,
);
assert.equal(JSON.stringify(calls), JSON.stringify([["book", { initialTab: "entries", entryId: "entry" }]]));
assert.doesNotMatch(helper, /sessionStorage|let pending/);
console.log(
  "PASS: actual focus callback and opener preserve loading, latest request, one-shot, repeat and book isolation.",
);
