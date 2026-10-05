import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import ts from "typescript";
import {
  resolveFeatureEnabled,
  FEATURE_SWITCH_DEFAULTS,
} from "../../packages/shared/src/schemas/feature-settings.schema.ts";
import { gameInventoryBagKey, gameInventoryItemId } from "../../packages/shared/src/utils/game-inventory-stacks.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const gameInventoryPath = join(repositoryRoot, "packages/client/src/components/game/GameInventory.tsx");
const gameSurfacePath = join(repositoryRoot, "packages/client/src/components/game/GameSurface.tsx");
const setupWizardPath = join(repositoryRoot, "packages/client/src/components/game/GameSetupWizard.tsx");
const gameInventorySource = readFileSync(gameInventoryPath, "utf8");
const gameSurfaceSource = readFileSync(gameSurfacePath, "utf8");
const setupWizardSource = readFileSync(setupWizardPath, "utf8");
const gameInventory = ts.createSourceFile(
  gameInventoryPath,
  gameInventorySource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const gameSurface = ts.createSourceFile(
  gameSurfacePath,
  gameSurfaceSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const setupWizard = ts.createSourceFile(
  setupWizardPath,
  setupWizardSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

function findNode<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T): T {
  let result: T | undefined;
  const visit = (node: ts.Node): void => {
    if (predicate(node)) {
      result = node;
      return;
    }
    if (!result) ts.forEachChild(node, visit);
  };
  visit(root);
  assert.ok(result, "expected source node is present");
  return result;
}

function transpileExpression(expression: ts.Expression): string {
  return ts.transpileModule(`return (${expression.getText(expression.getSourceFile())});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

const reorderViewDeclaration = findNode(
  gameInventory,
  (node): node is ts.VariableDeclaration =>
    ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "viewActive",
);
const reorderEnabledDeclaration = findNode(
  gameInventory,
  (node): node is ts.VariableDeclaration =>
    ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "reorderEnabled",
);
assert.ok(reorderViewDeclaration.initializer && reorderEnabledDeclaration.initializer);
const isViewActive = new Function(
  "query",
  "sortMode",
  "browsingEnabled",
  transpileExpression(reorderViewDeclaration.initializer),
) as (query: string, sortMode: string, browsingEnabled: boolean) => boolean;
const isReorderEnabled = new Function(
  "onReorderItem",
  "viewActive",
  "browsingEnabled",
  transpileExpression(reorderEnabledDeclaration.initializer),
) as (onReorderItem: unknown, viewActive: boolean, browsingEnabled: boolean) => boolean;

const featureSource = ts.createSourceFile(
  "features.ts",
  readFileSync(join(repositoryRoot, "packages/client/src/hooks/use-feature-settings.ts"), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const gate = findNode(
  featureSource,
  (node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === "isInventoryBrowsingEnabled",
);
const { QueryClient } = createRequire(join(repositoryRoot, "packages/client/package.json"))("@tanstack/react-query");
const queryClient = new QueryClient();
const featureSettingsKeys = { all: ["features"] };
const isInventoryBrowsingEnabled = new Function(
  "featureSettingsKeys",
  "resolveFeatureEnabled",
  ts.transpileModule(gate.getText(featureSource).replace("export function", "return function"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText,
)(featureSettingsKeys, resolveFeatureEnabled) as (client: unknown) => boolean;
assert.equal(FEATURE_SWITCH_DEFAULTS.inventoryBrowsing, false);
assert.equal(isInventoryBrowsingEnabled(queryClient), false);
queryClient.setQueryData(featureSettingsKeys.all, { settings: {} });
assert.equal(isInventoryBrowsingEnabled(queryClient), false);
queryClient.setQueryData(featureSettingsKeys.all, { settings: { inventoryBrowsing: true } });
assert.equal(isInventoryBrowsingEnabled(queryClient), true);

const gameInventoryElement = findNode(
  gameSurface,
  (node): node is ts.JsxSelfClosingElement =>
    ts.isJsxSelfClosingElement(node) && node.tagName.getText(gameSurface) === "GameInventory",
);
const reorderAttribute = gameInventoryElement.attributes.properties.find(
  (property): property is ts.JsxAttribute =>
    ts.isJsxAttribute(property) && property.name.getText(gameSurface) === "onReorderItem",
);
assert.ok(reorderAttribute?.initializer && ts.isJsxExpression(reorderAttribute.initializer));
const reorderCallback = reorderAttribute.initializer.expression;
assert.ok(reorderCallback && ts.isArrowFunction(reorderCallback), "GameSurface wires an executable reorder callback");
const callsiteSwapCalls: Array<[string, string]> = [];
const handleSwapInventoryStacks = (firstId: string, secondId: string): void => {
  callsiteSwapCalls.push([firstId, secondId]);
};
const callsiteReorder = new Function(
  "inventoryItems",
  "handleSwapInventoryStacks",
  transpileExpression(reorderCallback),
) as (
  inventoryItems: Array<{ id: string }>,
  swap: typeof handleSwapInventoryStacks,
) => (fromIndex: number, toIndex: number) => void;
const inventoryItems = [
  { id: "stack-a", name: "Arrow", item: "arrow", quantity: 2 },
  { id: "stack-b", name: "Potion", item: "potion", quantity: 1 },
  { id: "stack-c", name: "Rope", item: "rope", quantity: 3 },
];
callsiteReorder(inventoryItems, handleSwapInventoryStacks)(0, 2);
assert.deepEqual(
  callsiteSwapCalls,
  [["stack-a", "stack-c"]],
  "GameSurface maps original indices to the selected stack IDs",
);
callsiteSwapCalls.length = 0;

const dragEndDeclaration = findNode(
  gameInventory,
  (node): node is ts.VariableDeclaration =>
    ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "handleDragEnd",
);
assert.ok(dragEndDeclaration.initializer && ts.isCallExpression(dragEndDeclaration.initializer));
const dragEndArrow = dragEndDeclaration.initializer.arguments[0];
assert.ok(dragEndArrow && ts.isArrowFunction(dragEndArrow), "GameInventory drag handler remains directly executable");
const makeDragEnd = new Function(
  "bags",
  "items",
  "visibleItems",
  "onGiveItem",
  "onMergeItems",
  "onReorderItem",
  "onSwapItems",
  "reorderEnabled",
  "browsingEnabled",
  "isInventoryBrowsingEnabled",
  "queryClient",
  "settle",
  "gameInventoryBagKey",
  "gameInventoryItemId",
  transpileExpression(dragEndArrow),
) as (...dependencies: unknown[]) => (event: unknown) => void;

function drag(
  fromId: string,
  over: { id?: string; bag?: string },
  options: {
    query?: string;
    sortMode?: string;
    browsingEnabled?: boolean;
    visibleItems?: typeof inventoryItems;
    onMergeItems?: (...ids: string[]) => void;
    onGiveItem?: (id: string, holder?: string) => void;
  } = {},
): void {
  const enabled = options.browsingEnabled ?? true;
  const viewActive = isViewActive(options.query ?? "", options.sortMode ?? "original", enabled);
  const reorderEnabled = isReorderEnabled(callsiteReorder, viewActive, enabled);
  const handler = makeDragEnd(
    [{ holder: "Bram" }],
    inventoryItems,
    options.visibleItems ?? inventoryItems,
    options.onGiveItem,
    options.onMergeItems,
    callsiteReorder(inventoryItems, handleSwapInventoryStacks),
    enabled
      ? () => assert.fail("legacy swap fallback must not run when enabled reorder is wired")
      : handleSwapInventoryStacks,
    reorderEnabled,
    enabled,
    isInventoryBrowsingEnabled,
    queryClient,
    (result: unknown) => result,
    gameInventoryBagKey,
    gameInventoryItemId,
  );
  handler({
    active: { data: { current: { id: fromId } } },
    over: { data: { current: over } },
  });
}

drag("stack-a", { id: "stack-c" });
assert.deepEqual(
  callsiteSwapCalls,
  [["stack-a", "stack-c"]],
  "original-order drag swaps the correct original inventory indices",
);
callsiteSwapCalls.length = 0;

drag(
  "stack-c",
  { id: "stack-a" },
  { sortMode: "quantity", visibleItems: [inventoryItems[2]!, inventoryItems[0]!, inventoryItems[1]!] },
);
assert.deepEqual(callsiteSwapCalls, [], "sorted views cannot reorder stacks");

drag("stack-a", { id: "stack-c" }, { query: "r", visibleItems: [inventoryItems[0]!, inventoryItems[2]!] });
assert.deepEqual(callsiteSwapCalls, [], "filtered views cannot reorder stacks");

const mergeCalls: Array<[string, string]> = [];
drag(
  "stack-a",
  { id: "stack-b" },
  {
    sortMode: "quantity",
    visibleItems: [inventoryItems[0]!, { ...inventoryItems[1]!, name: "Arrow", item: "arrow" }],
    onMergeItems: (firstId, secondId) => mergeCalls.push([firstId, secondId]),
  },
);
assert.deepEqual(mergeCalls, [["stack-a", "stack-b"]], "same-item merge remains available in a sorted view");
assert.equal(
  gameInventoryItemId(inventoryItems[0]!),
  gameInventoryItemId({ ...inventoryItems[1]!, name: "Arrow", item: "arrow" }),
);

const giveCalls: Array<[string, string | undefined]> = [];
drag(
  "stack-a",
  { bag: gameInventoryBagKey("Bram") },
  {
    query: "arrow",
    visibleItems: [inventoryItems[0]!],
    onGiveItem: (id, holder) => giveCalls.push([id, holder]),
  },
);
assert.deepEqual(giveCalls, [["stack-a", "Bram"]], "giving a stack to a bag remains available in a filtered view");
assert.deepEqual(callsiteSwapCalls, [], "bag-give does not also reorder");

queryClient.setQueryData(featureSettingsKeys.all, { settings: { inventoryBrowsing: false } });
drag("stack-a", { id: "stack-c" });
assert.deepEqual(callsiteSwapCalls, [], "stale enabled drag cannot dispatch after OFF");
assert.equal(isViewActive("retained search", "quantity", false), false);
drag("stack-a", { id: "stack-c" }, { browsingEnabled: false, query: "retained search", sortMode: "quantity" });
assert.deepEqual(callsiteSwapCalls, [["stack-a", "stack-c"]], "OFF retains baseline identity-safe swap");
callsiteSwapCalls.length = 0;
queryClient.setQueryData(featureSettingsKeys.all, { settings: { inventoryBrowsing: true } });
queryClient
  .getQueryCache()
  .find({ queryKey: featureSettingsKeys.all })
  .setState({ status: "error", error: new Error("offline") });
assert.equal(isInventoryBrowsingEnabled(queryClient), false);
drag("stack-a", { id: "stack-c" });
assert.deepEqual(callsiteSwapCalls, [], "query error rejects optional dispatch even with cached ON data");
queryClient.setQueryData(featureSettingsKeys.all, { settings: { inventoryBrowsing: true } });
drag("stack-a", { id: "stack-c" });
assert.deepEqual(callsiteSwapCalls, [["stack-a", "stack-c"]], "re-enable restores optional dispatch");

console.info("game inventory UI wiring regression checks passed.");
