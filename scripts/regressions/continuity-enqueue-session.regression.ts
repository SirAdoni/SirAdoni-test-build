import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
const parse = (file: string) =>
  ts.createSourceFile(
    file,
    readFileSync(new URL("../../" + file, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
const generation = parse("packages/server/src/routes/generate.routes.ts");
let enqueue: ts.IfStatement | undefined;
const findEnqueue = (n: ts.Node) => {
  if (
    ts.isIfStatement(n) &&
    n.expression.getText(generation) === 'requestChatMode === "game" && acceptedAssistantMessageId'
  )
    enqueue = n;
  n.forEachChild(findEnqueue);
};
findEnqueue(generation);
assert.ok(enqueue);
const enqueueCode = ts.transpileModule(enqueue.getText(generation), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const execute = new Function(
  "earlyMeta",
  "app",
  "continuityChanges",
  "input",
  "requestChatMode",
  "acceptedAssistantMessageId",
  `return (async () => { ${enqueueCode} })();`,
);
const queued: number[] = [];
let notifications = 0;
for (const sessionNumber of [undefined, null, "abc", "2", 0, -1, 1.5, NaN, Infinity, 2]) {
  await execute(
    { gameSessionNumber: sessionNumber },
    {
      gameContinuity: { enqueueCommittedTurn: async (v: { sessionNumber: number }) => queued.push(v.sessionNumber) },
      log: { warn: () => assert.fail("unexpected enqueue failure") },
    },
    { notify: () => notifications++ },
    { chatId: "synthetic" },
    "game",
    "assistant",
  );
}
assert.deepEqual(queued, [2]);
assert.equal(notifications, 10, "invalid immediate enqueue still notifies reconciliation");
process.stdout.write("Actual valid-session enqueue and reconciliation notification passed\n");
