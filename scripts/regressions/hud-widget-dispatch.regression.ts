import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { isGameExtendedWidgetsEnabled } from "../../packages/shared/src/index.js";

const path = new URL("../../packages/server/src/services/generation/game-gm-prompt-runtime.ts", import.meta.url);
const source = ts.createSourceFile(path.pathname, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
const names = ["parseExtra", "assertExtendedWidgetDispatchAllowed"];
const declarations = source.statements.filter(
  (node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ""),
);
assert.equal(declarations.length, names.length);
let enabled = true;
const exports: Record<string, any> = {};
vm.runInNewContext(
  ts.transpileModule(declarations.map((node) => node.getText(source).replace(/^export /, "")).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText + "\nexports.check = assertExtendedWidgetDispatchAllowed;",
  {
    exports,
    isGameExtendedWidgetsEnabled,
    isFeatureEnabled: () => enabled,
  },
);
let calls = 0;
const send = async (applied: boolean, load: () => Promise<unknown>) => {
  await exports.check(applied, load);
  calls++;
};
await send(false, async () => {
  throw new Error("baseline must not read optional state");
});
await send(true, async () => ({ metadata: "{}" }));
assert.equal(calls, 2);
let release!: (value: unknown) => void;
const waiting = send(
  true,
  () =>
    new Promise((resolve) => {
      release = resolve;
    }),
);
enabled = false;
release({ metadata: "{}" });
await assert.rejects(waiting, /disabled before dispatch/);
assert.equal(calls, 2, "late OFF never reaches provider");
enabled = true;
await assert.rejects(
  send(true, async () => ({ metadata: '{"gameExtendedWidgetsEnabled":false}' })),
  /disabled before dispatch/,
);
await assert.rejects(
  send(true, async () => null),
  /disabled before dispatch/,
);
await send(true, async () => ({ metadata: "{}" }));
assert.equal(calls, 3, "re-enable admits the preserved prompt");
console.log("Actual widget dispatch guard preserves baseline and blocks late OFF before mock provider.");
