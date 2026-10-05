import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { applyFeatureSettingsValue } from "../../packages/server/src/services/features/feature-settings.js";
import { isSceneTimelineEnabled } from "../../packages/server/src/services/game/game-feature-switches.js";

const parse = (file: string) =>
  ts.createSourceFile(
    file,
    readFileSync(new URL("../../" + file, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
const game = parse("packages/server/src/routes/game.routes.ts");
const all: ts.Node[] = [];
const visit = (node: ts.Node) => {
  all.push(node);
  node.forEachChild(visit);
};
visit(game);
const code = (node: ts.Node) =>
  ts.transpileModule(node.getText(game), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const resultNode = all.find(
  (n) => ts.isVariableDeclaration(n) && n.name.getText(game) === "sceneTimelineDisabledResult",
) as ts.VariableDeclaration;
assert.ok(resultNode?.initializer);
const disabled = new Function(`return (${resultNode.initializer.getText(game)});`)();
const consumers = all.filter(
  (n) => ts.isIfStatement(n) && n.expression.getText(game) === "conclusionResult === sceneTimelineDisabledResult",
);
assert.equal(consumers.length, 4, "both route owners and both concurrent waiters handle their own reply");
const lateGate = all.find((n) => ts.isIfStatement(n) && n.expression.getText(game) === "sceneTimelineRecapText");
assert.ok(lateGate);
const evaluate = new Function(
  "sceneTimelineRecapText",
  "createChatsStorage",
  "app",
  "chatId",
  "isSceneTimelineEnabled",
  "parseMeta",
  "sceneTimelineDisabledResult",
  `return (async () => { ${code(lateGate)} return "dispatch"; })();`,
);
let metadata: Record<string, unknown> = {};
const run = () =>
  evaluate(
    "retained recap",
    () => ({ getById: async () => ({ metadata }) }),
    { db: {} },
    "synthetic",
    isSceneTimelineEnabled,
    (v: unknown) => v,
    disabled,
  );
try {
  applyFeatureSettingsValue(null);
  const shared = run();
  const replies = consumers.map(() => ({
    statusCode: 200,
    body: null as unknown,
    status(value: number) {
      this.statusCode = value;
      return this;
    },
    send(value: unknown) {
      this.body = value;
      return this;
    },
  }));
  const responses = await Promise.all(
    consumers.map(async (node, i) =>
      new Function("conclusionResult", "sceneTimelineDisabledResult", "reply", code(node))(
        await shared,
        disabled,
        replies[i],
      ),
    ),
  );
  responses.forEach((response, i) => {
    assert.equal(response, replies[i]);
    assert.equal(replies[i].statusCode, 403);
    assert.equal(replies[i].body, disabled);
  });
  applyFeatureSettingsValue(JSON.stringify({ sceneTimeline: true }));
  assert.equal(await run(), "dispatch");
  metadata = { gameSceneTimelineEnabled: false };
  assert.equal(await run(), disabled, "per-chat OFF also cancels a prepared recap");
} finally {
  applyFeatureSettingsValue(null);
}

process.stdout.write("Actual shared conclusion consumers passed\n");
