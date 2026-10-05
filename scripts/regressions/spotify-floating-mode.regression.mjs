import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const path = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../packages/client/src/components/spotify/SpotifyMiniPlayer.tsx",
);
const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const expressions = {};
function visit(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    if (node.name.text === "floating") expressions.floating = node.initializer.getText(source);
    if (node.name.text === "floatingAvoid") expressions.enabled = node.initializer.arguments[0].getText(source);
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert.equal(typeof expressions.floating, "string");
assert.equal(typeof expressions.enabled, "string");
const evaluate = new Function(
  "mobile",
  "forceFloating",
  "floatingMediaPlacementEnabled",
  `const floating = ${expressions.floating}; return ${expressions.enabled};`,
);
assert.equal(evaluate(false, true, true), true, "Forced-floating desktop Spotify must register avoid targets");
assert.equal(evaluate(true, false, true), true);
assert.equal(evaluate(false, false, true), false, "Docked desktop player must remain unchanged");
assert.equal(evaluate(false, true, false), false, "Feature OFF must not register observers");
assert.equal(evaluate(true, true, false), false);
console.info("Spotify floating-mode admission regression passed");
