import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
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
const isViewActive = new Function("query", "sortMode", transpileExpression(reorderViewDeclaration.initializer)) as (
  query: string,
  sortMode: string,
) => boolean;
const isReorderEnabled = new Function(
  "onReorderItem",
  "viewActive",
  transpileExpression(reorderEnabledDeclaration.initializer),
) as (onReorderItem: unknown, viewActive: boolean) => boolean;

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
    visibleItems?: typeof inventoryItems;
    onMergeItems?: (...ids: string[]) => void;
    onGiveItem?: (id: string, holder?: string) => void;
  } = {},
): void {
  const viewActive = isViewActive(options.query ?? "", options.sortMode ?? "original");
  const reorderEnabled = isReorderEnabled(callsiteReorder, viewActive);
  const handler = makeDragEnd(
    [{ holder: "Bram" }],
    inventoryItems,
    options.visibleItems ?? inventoryItems,
    options.onGiveItem,
    options.onMergeItems,
    callsiteReorder(inventoryItems, handleSwapInventoryStacks),
    () => assert.fail("legacy swap fallback must not run when the reorder callback is wired"),
    reorderEnabled,
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

const avatarUpdateHandlers: string[] = [];
const visitAvatar = (node: ts.Node): void => {
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(setupWizard) === "CharacterAvatar") {
    const onUpdate = node.attributes.properties.find(
      (property): property is ts.JsxAttribute =>
        ts.isJsxAttribute(property) && property.name.getText(setupWizard) === "onUpdate",
    );
    if (onUpdate?.initializer && ts.isJsxExpression(onUpdate.initializer) && onUpdate.initializer.expression) {
      avatarUpdateHandlers.push(onUpdate.initializer.expression.getText(setupWizard).replace(/\s+/g, ""));
    }
  }
  ts.forEachChild(node, visitAvatar);
};
visitAvatar(setupWizard);
assert.deepEqual(
  avatarUpdateHandlers,
  ["()=>useUIStore.getState().openPersonaDetail(p.id)", "()=>useUIStore.getState().openPersonaDetail(p.id)"],
  "both GameSetupWizard persona avatars open their persona detail editor",
);

console.info("game inventory UI wiring regression checks passed.");
