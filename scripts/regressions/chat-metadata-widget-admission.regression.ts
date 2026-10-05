import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import vm from "node:vm";
import ts from "typescript";
import * as shared from "../../packages/shared/src/index.js";

const routePath = new URL("../../packages/server/src/routes/chats.routes.ts", import.meta.url);
const source = ts.createSourceFile(routePath.pathname, readFileSync(routePath, "utf8"), ts.ScriptTarget.Latest, true);
const guard = source.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === "guardExtendedHudWidgetMetadataPatch",
);
assert.ok(guard, "extract the current metadata guard from chats.routes.ts");

const feature = { enabled: false };
const exports: Record<string, unknown> = {};
const context = vm.createContext({
  exports,
  ...shared,
  isDeepStrictEqual,
  isFeatureEnabled: (name: string) => name === "extendedHudWidgets" && feature.enabled,
});
vm.runInContext(
  ts.transpileModule(`${guard.getText(source)}\nexports.guard = guardExtendedHudWidgetMetadataPatch;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText,
  context,
);
const run = exports.guard as (
  incoming: Record<string, unknown>,
  current: Record<string, unknown>,
) => {
  patch: Record<string, unknown>;
  rejected: boolean;
};
const equalData = (actual: unknown, expected: unknown, message: string) =>
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message);

const counter = { id: "count", type: "counter", label: "Count", position: "hud_left", config: { count: 1 } };
const note = { id: "note", type: "note", label: "Note", position: "hud_right", config: { text: "Keep" } };
const changedNote = { ...note, config: { text: "Changed" } };
const existing = { gameWidgetState: [counter, note], gameExtendedWidgetsEnabled: true };
for (const invalid of [null, 7, "broken", []]) {
  assert.equal(
    run({ gameWidgetState: [counter, invalid] }, existing).rejected,
    true,
    "malformed incoming widget is rejected without throwing",
  );
  assert.equal(
    run({ gameWidgetState: [counter] }, { gameWidgetState: [invalid, counter] }).rejected,
    false,
    "malformed saved entry does not crash baseline edits",
  );
}

// Real clients send widget fields beside unrelated setup metadata.
const gameSurfacePayload = { gameSetupConfig: { customHudWidgets: [counter] }, gameImageDynamicPromptEnabled: true };
const acceptedGameSurface = run(gameSurfacePayload, {});
assert.equal(acceptedGameSurface.rejected, false);
equalData(acceptedGameSurface.patch, gameSurfacePayload, "GameSurface setup payload remains valid");
const multiplayerPayload = {
  multiplayerSetupComplete: true,
  gameSetupConfig: { customHudWidgets: [counter] },
  multiplayerGameSetup: { gameName: "Test", preferences: {}, gmConnectionId: "gm" },
};
assert.equal(run(multiplayerPayload, {}).rejected, false, "multiplayer setup metadata remains valid");

feature.enabled = false;
const denied = run(
  { gameSetupConfig: { customHudWidgets: [counter, changedNote] }, gameImageDynamicPromptEnabled: true },
  existing,
);
assert.equal(denied.rejected, true, "OFF rejects changed hidden extended widget content");
equalData(denied.patch, {}, "rejection does not write unrelated metadata keys");
const preserved = run(
  { gameSetupConfig: { customHudWidgets: [counter] }, gameImageDynamicPromptEnabled: true },
  existing,
);
assert.equal(preserved.rejected, false);
equalData(
  (preserved.patch.gameSetupConfig as Record<string, unknown>).customHudWidgets,
  [counter, note],
  "OFF preserves hidden widget data while accepting baseline and sibling edits",
);
assert.equal(
  run({ gameWidgetInitialState: [counter] }, { gameWidgetInitialState: [counter] }).rejected,
  false,
  "unchanged immutable initial state may accompany a patch",
);
assert.equal(run({ gameWidgetInitialState: [changedNote] }, existing).rejected, true);
feature.enabled = true;
assert.equal(
  run({ gameWidgetState: [note] }, {}).rejected,
  false,
  "production per-chat default allows widgets when the global switch is ON",
);
const allowed = run({ gameWidgetState: [counter, changedNote] }, existing);
assert.equal(allowed.rejected, false, "ON admits extended-widget edits");
equalData(allowed.patch.gameWidgetState, [counter, changedNote]);
feature.enabled = false;
const lateOff = run({ gameWidgetState: [counter, changedNote] }, { ...existing, gameExtendedWidgetsEnabled: false });
assert.equal(lateOff.rejected, true, "fresh per-chat OFF wins after a queued ON state");

const route = source.statements.flatMap((statement) => {
  const found: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "patch"
    ) {
      const first = node.arguments[0];
      if (first && ts.isStringLiteral(first) && first.text === "/:id/metadata") found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(statement);
  return found;
});
assert.equal(route.length, 1, "metadata PATCH route remains singular");
const routeText = route[0]!.getText(source);
assert.ok(!routeText.includes("HUD widget metadata must be patched separately"));
assert.ok(routeText.includes("guardExtendedHudWidgetMetadataPatch(incoming, freshMeta)"));
assert.ok(routeText.includes("status(409)"));
assert.ok(routeText.includes("macroVariables must be patched on its own"));

console.log("Mixed metadata patches remain valid; disabled extended-widget edits are rejected atomically.");
