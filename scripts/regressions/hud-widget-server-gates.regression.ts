import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import vm from "node:vm";
import ts from "typescript";
import * as shared from "../../packages/shared/src/index.js";

const routePath = new URL("../../packages/server/src/routes/game.routes.ts", import.meta.url);
const source = ts.createSourceFile(
  fileURLToPath(routePath),
  readFileSync(routePath, "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const names = [
  "storedGameHudWidgets",
  "extendedHudWidgetsEnabled",
  "enforceExtendedHudWidgetOptIn",
  "mergeDisabledExtendedHudWidgets",
];
const declarations = source.statements.filter(
  (node) => ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text),
);
assert.equal(declarations.length, names.length, "extract exact current server guard functions");
const featureState = { enabled: false };
const exports: Record<string, unknown> = {};
const context = vm.createContext({
  exports,
  ...shared,
  isDeepStrictEqual,
  featureState,
  MAX_BASELINE_GAME_HUD_WIDGETS: 4,
  isFeatureEnabled: (name: string) => name === "extendedHudWidgets" && featureState.enabled,
  sanitizeGameHudWidgets: (widgets: unknown) => (Array.isArray(widgets) ? widgets : []),
});
vm.runInContext(
  ts.transpileModule(declarations.map((node) => node.getText(source)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText + `\n${names.map((name) => `exports.${name} = ${name};`).join("\n")}`,
  context,
);
const {
  storedGameHudWidgets,
  extendedHudWidgetsEnabled,
  enforceExtendedHudWidgetOptIn,
  mergeDisabledExtendedHudWidgets,
} = exports as Record<string, (...args: any[]) => any>;
const equalData = (actual: unknown, expected: unknown, message?: string) =>
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message);

const counter = { id: "count", type: "counter", label: "Count", position: "hud_left", config: { count: 1 } };
const note = { id: "note", type: "note", label: "Note", position: "hud_right", config: { text: "Keep" } };
const editedCounter = { ...counter, config: { count: 2 } };
const changedNote = { ...note, config: { text: "Changed" } };

featureState.enabled = false;
const saved = { gameWidgetState: [counter, note], gameBlueprint: { hudWidgets: [counter] } };
equalData(storedGameHudWidgets(saved), [counter, note], "current state takes precedence over blueprint");
assert.equal(extendedHudWidgetsEnabled({ ...saved, gameExtendedWidgetsEnabled: true }), false, "global OFF wins");
equalData(
  enforceExtendedHudWidgetOptIn(saved, [editedCounter]),
  [editedCounter, note],
  "setup edits preserve hidden extended widgets while disabled",
);
equalData(
  mergeDisabledExtendedHudWidgets([counter, note], [editedCounter]),
  [editedCounter, note],
  "omitting a hidden widget does not delete it",
);
assert.equal(mergeDisabledExtendedHudWidgets([counter, note], [counter, changedNote]), null);
assert.equal(mergeDisabledExtendedHudWidgets([counter, note], [counter, { ...note, id: "new" }]), null);
assert.equal(mergeDisabledExtendedHudWidgets([counter, note], [{ ...editedCounter, id: "note" }]), null);
equalData(
  storedGameHudWidgets({ gameWidgetState: [], gameBlueprint: { hudWidgets: [note] } }),
  [],
  "an explicit empty state is authoritative",
);

featureState.enabled = true;
const many = Array.from({ length: 6 }, (_, index) => ({ ...counter, id: `counter-${index}` }));
equalData(enforceExtendedHudWidgetOptIn({}, many), many, "ON permits more than four ordinary widgets");
featureState.enabled = false;
assert.throws(() => enforceExtendedHudWidgetOptIn({}, many), /four widgets/);
equalData(mergeDisabledExtendedHudWidgets(many, many), many, "OFF retains an existing larger set");
assert.equal(mergeDisabledExtendedHudWidgets(many, [...many, { ...counter, id: "extra" }]), null);
featureState.enabled = true;
assert.equal(extendedHudWidgetsEnabled({ gameExtendedWidgetsEnabled: true }), true);
assert.equal(extendedHudWidgetsEnabled({ gameExtendedWidgetsEnabled: false }), false, "chat OFF wins");
equalData(enforceExtendedHudWidgetOptIn(saved, [note]), [note], "enabled requests use the requested state");

// Execute the real final setup callback after its awaited hydration has completed.
let setupFunction: ts.VariableDeclaration | undefined;
function findSetup(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "applyGameSetupPayload") setupFunction = node;
  ts.forEachChild(node, findSetup);
}
findSetup(source);
assert.ok(setupFunction);
let setupCallback: ts.Expression | undefined;
function findWrite(node: ts.Node) {
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "patchMetadata"
  )
    setupCallback = node.arguments[1];
  ts.forEachChild(node, findWrite);
}
findWrite(setupFunction);
assert.ok(setupCallback);
vm.runInContext(
  ts.transpileModule(`exports.admitSetup = ${setupCallback.getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText,
  context,
);
context.customHudWidgets = [];
context.hydratedUpdates = {
  gameBlueprint: { hudWidgets: [counter, changedNote] },
  gameSetupConfig: {},
  gameSessionStatus: "ready",
};
const admitSetup = exports.admitSetup as (meta: Record<string, unknown>) => any;
featureState.enabled = false;
const offSetup = admitSetup({ ...saved, gameSessionStatus: "setup" });
equalData(offSetup.gameWidgetState, [counter, note], "late OFF after hydration retains old hidden content");
equalData(offSetup.gameWidgetInitialState, [counter, note]);
featureState.enabled = true;
const onSetup = admitSetup({ gameSessionStatus: "setup" });
equalData(onSetup.gameWidgetState, [counter, changedNote], "generated blueprint initializes the new session");
equalData(onSetup.gameWidgetInitialState, onSetup.gameWidgetState);
const activeSetup = admitSetup({
  gameSessionStatus: "active",
  gameWidgetInitialState: [counter],
  gameWidgetState: [editedCounter],
});
equalData(activeSetup.gameWidgetState, [editedCounter], "stale setup completion preserves live widget values");
assert.equal(activeSetup.gameSessionStatus, "active", "stale setup cannot return an active session to ready");
equalData(activeSetup.gameWidgetInitialState, [counter], "active history anchor is immutable");

console.log("Server widget opt-in preserves hidden data and rejects extended edits while disabled.");
