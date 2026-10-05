import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";
import * as shared from "../../packages/shared/src/index.js";

const requireClient = createRequire(new URL("../../packages/client/package.json", import.meta.url));
const { QueryClient } = requireClient("@tanstack/react-query");
const exports: Record<string, any> = {};
const context = vm.createContext({ exports, ...shared });
function load(path: string, names: string[]) {
  const source = ts.createSourceFile(
    path,
    readFileSync(new URL(path, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const declarations = source.statements.filter((node) => {
    if (ts.isFunctionDeclaration(node)) return !!node.name && names.includes(node.name.text);
    return (
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && names.includes(d.name.text))
    );
  });
  assert.equal(declarations.length, names.length, "extract exact current declarations");
  const text = declarations.map((node) => node.getText(source).replace(/^export\s+/, "")).join("\n");
  vm.runInContext(
    ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText +
      "\n" +
      names.map((name) => `exports.${name} = ${name};`).join("\n"),
    context,
  );
}
load("../../packages/client/src/hooks/use-feature-settings.ts", ["featureSettingsKeys", "isWidgetFeatureEnabledNow"]);
load("../../packages/client/src/hooks/use-chats.ts", ["chatKeys"]);
load("../../packages/client/src/hooks/use-extended-widgets.ts", [
  "metadata",
  "canUseExtendedWidgetsNow",
  "assertWidgetUpdateAllowed",
  "isNewGameWidgetSetupAllowed",
]);
const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const {
  featureSettingsKeys,
  chatKeys,
  isWidgetFeatureEnabledNow,
  canUseExtendedWidgetsNow,
  assertWidgetUpdateAllowed,
} = exports;
const note = { id: "n", type: "note", label: "Note", position: "hud_right", config: { text: "Keep" } };
const counter = { id: "c", type: "counter", label: "Count", position: "hud_left", config: { count: 1 } };
const chat = (meta: Record<string, unknown>) =>
  qc.setQueryData(chatKeys.detail("chat"), { id: "chat", metadata: JSON.stringify(meta) });
const flags = (settings: Record<string, boolean>) => qc.setQueryData(featureSettingsKeys.all, { settings });
assert.equal(isWidgetFeatureEnabledNow(qc, "extendedHudWidgets"), false);
chat({ gameBlueprint: { hudWidgets: [counter, note] } });
flags({});
assert.equal(canUseExtendedWidgetsNow(qc, "chat"), false);
// Red before repair: client hydration uses blueprint fallback, so a baseline counter edit must retain its note.
assert.doesNotThrow(() => assertWidgetUpdateAllowed(qc, "chat", [{ ...counter, config: { count: 2 } }, note]));
assert.throws(() => assertWidgetUpdateAllowed(qc, "chat", [counter]), /disabled/);
assert.equal(exports.isNewGameWidgetSetupAllowed(qc, [note]), false);
assert.equal(exports.isNewGameWidgetSetupAllowed(qc, [counter]), true);
assert.equal(
  exports.isNewGameWidgetSetupAllowed(
    qc,
    Array.from({ length: 5 }, () => counter),
  ),
  false,
);
flags({ extendedHudWidgets: true });
assert.equal(canUseExtendedWidgetsNow(qc, null), true, "new setup ignores unrelated active chat");
assert.equal(exports.isNewGameWidgetSetupAllowed(qc, [note]), true);
const queuedSetup = () => exports.isNewGameWidgetSetupAllowed(qc, [note]);
flags({});
assert.equal(queuedSetup(), false, "setup completion rechecks current permission");
assert.throws(
  () => assertWidgetUpdateAllowed(qc, "chat", [counter, { ...note, config: { text: "Changed" } }]),
  /disabled/,
);
chat({ gameWidgetState: [], gameBlueprint: { hudWidgets: [note] } });
assert.throws(() => assertWidgetUpdateAllowed(qc, "chat", [note]), /disabled/, "saved empty state overrides blueprint");
flags({ playerStatus: true });
assert.equal(isWidgetFeatureEnabledNow(qc, "playerStatus"), true);
assert.equal(canUseExtendedWidgetsNow(qc, "chat"), false);
flags({ extendedHudWidgets: true });
assert.equal(isWidgetFeatureEnabledNow(qc, "playerStatus"), false);
assert.equal(canUseExtendedWidgetsNow(qc, "chat"), true);
const queued = () => assertWidgetUpdateAllowed(qc, "chat", [note]);
flags({});
assert.throws(queued, /disabled/, "stale ON callback reads current OFF");
flags({ extendedHudWidgets: true });
chat({ gameExtendedWidgetsEnabled: false });
assert.equal(canUseExtendedWidgetsNow(qc, "chat"), false);
chat({ gameExtendedWidgetsEnabled: true });
assert.equal(canUseExtendedWidgetsNow(qc, "chat"), true);
await qc
  .fetchQuery({ queryKey: featureSettingsKeys.all, staleTime: 0, queryFn: () => Promise.reject(new Error("fixture")) })
  .catch(() => {});
assert.equal(canUseExtendedWidgetsNow(qc, "chat"), false, "error with stale ON data fails closed");
qc.clear();
load("../../packages/client/src/components/game/ExtendedWidgets.tsx", ["DEFAULT_ACCENT"]);
vm.runInContext("const EXTENDED_WIDGET_ACCENTS = DEFAULT_ACCENT", context);
load("../../packages/client/src/components/game/GameWidgetSetupEditor.tsx", [
  "DEFAULT_ACCENTS",
  "DEFAULT_ICONS",
  "isHudWidgetType",
  "formatWidgetTypeLabel",
  "slugifyWidgetId",
  "nextWidgetId",
  "parseNumber",
  "defaultWidgetConfig",
  "normalizeConfig",
  "normalizeGameHudWidgets",
]);
const storedNote = { ...note, label: " Keep whitespace ", config: { text: " Keep\n", futureKey: 7 } };
const normalized = exports.normalizeGameHudWidgets([counter, storedNote]);
assert.equal(normalized[1], storedNote, "settings normalization preserves hidden stored payload exactly");
assert.equal(normalized[0].config.count, 1);
const importedNote = exports.normalizeGameHudWidgets([storedNote], { preserveExtended: false })[0];
assert.notEqual(importedNote, storedNote, "imports validate rather than trusting saved-record preservation");
assert.equal(importedNote.label, "Keep whitespace");
const editorSource = ts.createSourceFile(
  "editor.tsx",
  readFileSync(new URL("../../packages/client/src/components/game/GameWidgetSetupEditor.tsx", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
let draftCallback: ts.Expression | undefined;
function findDraft(node: ts.Node) {
  if (
    ts.isVariableDeclaration(node) &&
    node.name.getText(editorSource) === "normalizedWidgets" &&
    node.initializer &&
    ts.isCallExpression(node.initializer) &&
    node.initializer.expression.getText(editorSource) === "useMemo"
  )
    draftCallback = node.initializer.arguments[0];
  ts.forEachChild(node, findDraft);
}
findDraft(editorSource);
assert.ok(draftCallback);
context.widgets = [null, counter, storedNote];
context.allowExtended = false;
vm.runInContext(
  ts.transpileModule(`exports.draft = (${draftCallback.getText(editorSource)})();`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText,
  context,
);
assert.equal(exports.draft.length, 2);
assert.equal(
  exports.draft[1],
  storedNote,
  "actual editor callback retains the hidden payload after a malformed source entry",
);
const panelSource = ts.createSourceFile(
  "panel.tsx",
  readFileSync(new URL("../../packages/client/src/components/game/GameWidgetPanel.tsx", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
let visibleDraft: ts.Expression | undefined;
let emptyCondition: ts.Expression | undefined;
function findVisible(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(panelSource) === "visibleDraftWidgets")
    visibleDraft = node.initializer;
  if (
    ts.isConditionalExpression(node) &&
    node.condition.getText(panelSource) === 'mode === "initial"' &&
    ts.isConditionalExpression(node.whenFalse)
  )
    emptyCondition = node.whenFalse.condition;
  ts.forEachChild(node, findVisible);
}
findVisible(panelSource);
assert.ok(visibleDraft);
assert.ok(emptyCondition);
context.draftWidgets = [storedNote];
vm.runInContext(
  ts.transpileModule(
    `const visibleDraftWidgets = ${visibleDraft.getText(panelSource)}; exports.empty = ${emptyCondition.getText(panelSource)};`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText,
  context,
);
assert.equal(exports.empty, true, "actual panel empty state accounts for hidden-only widget drafts");
console.log("Actual current widget permission helpers and blueprint fallback passed with real QueryClient.");
