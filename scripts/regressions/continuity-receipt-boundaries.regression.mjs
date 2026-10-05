import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
const parse = (p) =>
  ts.createSourceFile(p, readFileSync(new URL("../../" + p, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const find = (source, predicate) => {
  let found;
  const walk = (n) => {
    if (predicate(n)) found = n;
    ts.forEachChild(n, walk);
  };
  walk(source);
  assert.ok(found);
  return found;
};
const evaluate = (code, scope) =>
  new Function(
    ...Object.keys(scope),
    ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
  )(...Object.values(scope));
for (const [file, variable] of [
  ["packages/server/src/routes/game-continuity-backfill.routes.ts", "acceptedEligible"],
  ["packages/server/src/services/game/continuity-state.ts", "eligible"],
]) {
  const source = parse(file);
  const call = find(
    source,
    (n) =>
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "where" &&
      n.arguments[0]?.getText(source).includes(variable),
  );
  const predicate = evaluate("return " + call.arguments[0].getText(source), {
    and:
      (...checks) =>
      (row) =>
        checks.every((check) => check(row)),
    eq: (key, value) => (row) => row[key] === value,
    inArray: (key, values) => (row) => values.includes(row[key]),
    gameStateSnapshots: { chatId: "chatId", messageId: "messageId" },
    chatId: "current",
    [variable]: [{ id: "accepted" }],
  });
  assert.equal(predicate({ chatId: "current", messageId: "accepted" }), true);
  assert.equal(predicate({ chatId: "other", messageId: "accepted" }), false);
  assert.equal(predicate({ chatId: "current", messageId: "other" }), false);
}
const runtime = parse("packages/server/src/services/game/continuity-runtime.ts");
const index = find(runtime, (n) => ts.isVariableStatement(n) && n.getText(runtime).includes("const siblingIndex ="));
const statements = index.parent.statements;
const pos = statements.indexOf(index);
assert.ok(pos >= 0);
const update = index.getText(runtime) + "\n" + statements[pos + 1].getText(runtime);
for (const exists of [false, true]) {
  const old = { id: "old" },
    next = { id: "next", updated: true },
    siblings = exists ? [old, { id: "next" }] : [old];
  evaluate(update, { siblings, next });
  assert.deepEqual(siblings, [old, next]);
}
console.log("Continuity receipt boundaries: cross-chat snapshots excluded; missing cached siblings append safely");
