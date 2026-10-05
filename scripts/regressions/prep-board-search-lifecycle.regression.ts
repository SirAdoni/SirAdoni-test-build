import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import ts from "typescript";

const path = "packages/client/src/components/game/GamePrepBoard.tsx";
const root = new URL("../../", import.meta.url);
const text = process.env.REPRO_HEAD
  ? execFileSync("git", ["show", `${process.env.REPRO_HEAD}:${path}`], { cwd: root, encoding: "utf8" })
  : readFileSync(new URL(path, root), "utf8");
const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let effect: ts.ArrowFunction | undefined;
const visit = (node: ts.Node) => {
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(source) === "useEffect" &&
    node.arguments[0]?.getText(source).includes("setSearching(true)")
  )
    effect = node.arguments[0] as ts.ArrowFunction;
  ts.forEachChild(node, visit);
};
visit(source);
assert.ok(effect);
const compiled = ts.transpileModule(`const effect = ${effect.getText(source)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
let searching = false;
let entries: unknown[] = [];
let scheduled: (() => void) | undefined;
let resolve: (rows: unknown[]) => void = () => {};
let calls = 0;
const api = {
  get: () => {
    calls++;
    return new Promise<unknown[]>((r) => {
      resolve = r;
    });
  },
};
const window = {
  setTimeout: (fn: () => void) => {
    scheduled = fn;
    return 1;
  },
  clearTimeout: () => {
    scheduled = undefined;
  },
};
const run = (needle: string) =>
  new Function("needle", "setSearching", "setEntries", "api", "window", compiled + "; return effect();")(
    needle,
    (value: boolean) => {
      searching = value;
    },
    (value: unknown[]) => {
      entries = value;
    },
    api,
    window,
  );

const cancelDebounce = run("ab");
assert.equal(searching, true);
cancelDebounce();
run("a");
assert.equal(searching, false, "shortening the query clears the cancelled search spinner");
assert.equal(scheduled, undefined);
assert.equal(calls, 0);
const cancelInFlight = run("abc");
scheduled!();
assert.equal(calls, 1);
cancelInFlight();
run("");
resolve([{ id: "late", lorebookId: "book", name: "Late result" }]);
await new Promise((r) => setImmediate(r));
assert.equal(searching, false);
assert.deepEqual(entries, [], "cancelled responses cannot repopulate a cleared picker");
process.stdout.write("PASS actual search effect debounce and in-flight cancellation\n");
