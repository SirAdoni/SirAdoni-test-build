import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const ts = createRequire(new URL("../../packages/server/package.json", import.meta.url))("typescript");
// Platform-only processes and deliberately mocked launch-option tests.
const exclusions = new Set([
  // The supervised launcher deliberately inherits the console so Windows
  // Ctrl+C can reach the server; it is a foreground console child, not a
  // background helper that would flash a window.
  "scripts/run-server.mjs",
  "packages/server/src/app.ts", // sw_vers: macOS-only branch
  "packages/server/src/services/sidecar/mlx-runtime.service.ts", // macOS ARM runtime
  "packages/server/src/services/sandbox/bubblewrap-runtime.ts", // Linux only
  "scripts/docker-entrypoint.mjs", // Linux container entrypoint
  "scripts/regressions/hidden-test-cleanup.regression.mjs", // mocked negative controls
]);
const failures = [];
let checked = 0;
for (const root of ["scripts", "e2e", "packages/server/src", "packages/server/scripts", "packages/client/scripts"]) {
  for (const relative of readdirSync(root, { recursive: true })) {
    const file = join(root, relative).replaceAll("\\", "/");
    if (!/\.(?:ts|mjs|cjs|js)$/.test(file) || exclusions.has(file)) continue;
    const source = readFileSync(file, "utf8");
    if (!source.includes("child_process")) continue;
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const names = new Set();
    tree.forEachChild((node) => {
      if (ts.isImportDeclaration(node) && /^(?:node:)?child_process$/.test(node.moduleSpecifier.text)) {
        for (const binding of node.importClause?.namedBindings?.elements ?? []) {
          if (
            /^(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)$/.test(
              binding.propertyName?.text ?? binding.name.text,
            )
          )
            names.add(binding.name.text);
        }
      }
    });
    function aliases(node) {
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        ts.isCallExpression(node.initializer) &&
        node.initializer.expression.getText(tree) === "promisify" &&
        names.has(node.initializer.arguments[0]?.getText(tree))
      )
        names.add(node.name.getText(tree));
      ts.forEachChild(node, aliases);
    }
    aliases(tree);
    function visit(node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && names.has(node.expression.text)) {
        checked++;
        const options = node.arguments[/^exec(?:Sync)?$/.test(node.expression.text) ? 1 : 2];
        const forwarded =
          file === "scripts/ensure-native-deps.mjs" &&
          options?.getText(tree) === "options" &&
          source.includes("options = { windowsHide: true, ...options }");
        const hidden =
          options &&
          ts.isObjectLiteralExpression(options) &&
          options.properties.some(
            (property) =>
              property.name?.getText(tree) === "windowsHide" &&
              property.initializer?.kind === ts.SyntaxKind.TrueKeyword,
          );
        if (!hidden && !forwarded)
          failures.push(`${file}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
  }
}
assert.deepEqual(failures, [], "Background subprocess calls must explicitly hide Windows consoles");
console.info(`Windows launch guard passed (${checked} direct and promisified calls; platform exclusions documented).`);
