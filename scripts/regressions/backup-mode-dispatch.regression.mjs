import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(new URL("../../packages/client/package.json", import.meta.url));
const { QueryClient } = require("@tanstack/react-query");
const source = readFileSync(
  new URL("../../packages/client/src/components/panels/SettingsPanel.tsx", import.meta.url),
  "utf8",
);
const ast = ts.createSourceFile("SettingsPanel.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let initializer;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "backupModeNow") initializer = node.initializer;
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(initializer, "actual dispatch helper must exist");
const code = ts.transpileModule(`globalThis.readMode = ${initializer.getText(ast)}`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const qc = new QueryClient();
let enabled = true;
const context = { qc, backupModesEnabledNow: () => enabled, localizeUi: (key) => key };
vm.runInNewContext(code, context);
try {
  assert.throws(() => context.readMode(), /failedToCreateBackup/);
  qc.setQueryData(["backups", "automatic"], { mode: "incremental" });
  assert.equal(context.readMode(), "incremental");
  qc.setQueryData(["backups", "automatic"], { mode: "data" });
  assert.equal(context.readMode(), "data", "same callback reads current cache after selection changes");
  qc.getQueryCache()
    .find({ queryKey: ["backups", "automatic"], exact: true })
    .setState({ status: "error", error: new Error("offline") });
  assert.throws(() => context.readMode(), /failedToCreateBackup/, "stale data after query failure must not dispatch");
  enabled = false;
  assert.equal(context.readMode(), "full", "OFF retains baseline full download even if mode query fails");
  assert.match(source, /const mode = backupModeNow\(\);/u);
} finally {
  qc.clear();
}
console.log("Backup current-mode dispatch regression passed.");
