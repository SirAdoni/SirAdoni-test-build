import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
const parse = (p) =>
  ts.createSourceFile(
    p,
    readFileSync(new URL("../../" + p, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
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
const evaluate = (text, scope) =>
  new Function(
    ...Object.keys(scope),
    ts.transpileModule("return " + text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
  )(...Object.values(scope));
const dialog = parse("packages/client/src/components/game/CampaignIndexDialog.tsx");
const disabled = find(
  dialog,
  (n) =>
    ts.isVariableDeclaration(n) &&
    n.name.getText(dialog) === "disabled" &&
    n.initializer?.getText(dialog).includes("stepAllowed"),
).initializer.getText(dialog);
for (const [state, allowed, configured, key, expected] of [
  ["unavailable", true, true, "import", true],
  ["ready", true, true, "import", false],
  ["ready", false, true, "import", true],
  ["ready", true, false, "backfill", true],
])
  assert.equal(
    evaluate(disabled, {
      state,
      stepAllowed: () => allowed,
      step: { key },
      game: { continuityConfigured: configured },
    }),
    expected,
  );
const surface = parse("packages/client/src/components/game/GameSurface.tsx");
const callback = find(
  surface,
  (n) =>
    ts.isJsxAttribute(n) &&
    n.name.getText(surface) === "onClick" &&
    n.initializer?.getText(surface).includes("setCampaignIndexOpen(true)") &&
    n.initializer?.getText(surface).includes("setMobileActionsOpen(false)"),
).initializer.expression;
const calls = [];
evaluate(callback.getText(surface), {
  setMobileActionsOpen: (value) => calls.push(["menu", value]),
  setCampaignIndexOpen: (value) => calls.push(["index", value]),
})();
assert.deepEqual(calls, [
  ["menu", false],
  ["index", true],
]);
console.log("Index UI: unavailable/prerequisite controls disabled; mobile menu closes before dialog opens");
