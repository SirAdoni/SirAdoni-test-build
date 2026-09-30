import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const suite = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const host = resolve(process.env.MARINARA_ENGINE_ROOT || join(suite, ".."));
const ts = createRequire(join(suite, "package.json"))("typescript");
const sourcePath = join(suite, "sources/engine/packages/server/src/routes/generate/generate-route-utils.ts");
const source = await readFile(sourcePath, "utf8");
const parsed = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
assert.equal(parsed.parseDiagnostics.length, 0);
// Evaluate the actual pure helpers without importing unrelated host runtime services.
const names = new Set(["parseExtra", "isMessageHiddenFromAI", "resolveRoleplaySummaryTail", "computeSummaryHideIds"]);
const functions = parsed.statements.filter((node) => ts.isFunctionDeclaration(node) && names.has(node.name?.text));
assert.equal(functions.length, names.size);
const { outputText } = ts.transpileModule(functions.map((node) => node.getText(parsed)).join("\n"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const shared = await import(pathToFileURL(join(host, "packages/shared/dist/index.js")).href);
const helpers = {};
new Function("exports", "normalizeSummaryTailMessages", "SUMMARY_TAIL_MESSAGES", outputText)(
  helpers,
  shared.normalizeSummaryTailMessages,
  shared.SUMMARY_TAIL_MESSAGES,
);
const { resolveRoleplaySummaryTail: resolveTail, computeSummaryHideIds: hideIds } = helpers;
for (const [input, expected] of [
  [undefined, 10],
  [null, 10],
  [0, 0],
  [2.9, 2],
  ["12.9", 12],
  [-1, 0],
  [NaN, 0],
  [Infinity, 0],
  ["invalid", 0],
  [1_000_000, 1_000_000],
])
  assert.equal(resolveTail(input), expected, `summary tail ${String(input)}`);
const messages = [{ id: "a" }, { id: "b", extra: JSON.stringify({ hiddenFromAI: true }) }, { id: "c" }, { id: "d" }];
const args = { messages, entryMessageIds: messages.map((message) => message.id) };
assert.deepEqual(hideIds({ ...args, tail: 2.9 }), ["a", "b"]);
assert.deepEqual(hideIds({ ...args, tail: 0 }), ["a", "b", "c", "d"]);
assert.deepEqual(hideIds({ ...args, tail: 1_000_000 }), ["b"]);
for (const tail of [undefined, NaN, Infinity, -1]) {
  assert.deepEqual(hideIds({ ...args, tail }), ["a", "b", "c", "d"], `direct invalid tail ${String(tail)}`);
}
assert.deepEqual(hideIds({ messages, entryMessageIds: ["a", "unrelated"], tail: 1 }), ["a"]);
assert.deepEqual(hideIds({ messages, entryMessageIds: [], tail: 1 }), []);
process.stdout.write(
  "Captured summary-tail helpers: default, invalid, fractional, uncapped and visible-history behavior passed.\n",
);
