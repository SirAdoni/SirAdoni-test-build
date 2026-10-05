import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";
import { prepareContinuitySources } from "../../packages/server/src/services/game/continuity-sources.js";

// Exercise the actual evaluator with a controlled, already-validated read snapshot.
// This proves range calculation, not acceptance of a legacy receipt by storage.
const filename = new URL("../../packages/server/src/services/game/session-summary-dependencies.ts", import.meta.url);
const source = readFileSync(filename, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const require = createRequire(import.meta.url);
const messages = [{ id: "source", role: "assistant", content: "A😀BC", activeSwipeIndex: 0 }];
const summary = { text: "Saved summary" };
let ranges: Array<{ start: number; end?: number; content: string }> = [];
const exports: Record<string, any> = {};
const dependencies: Record<string, unknown> = {
  "./continuity-sources.js": { prepareContinuitySources },
  "../storage/chats.storage.js": {
    createChatsStorage: () => ({ getById: async () => ({ metadata: "{}" }), listMessages: async () => messages }),
  },
  "./continuity-state.js": {
    readGameContinuityState: async () => ({
      currentPublishedReceiptIds: ["published"],
      receipts: [
        {
          sourceCurrent: true,
          receipt: {
            id: "published",
            status: "published",
            sources: ranges.map((range) => ({ messageId: "source", ...range })),
          },
        },
      ],
    }),
  },
};
new vm.Script(compiled, { filename: filename.pathname }).runInNewContext({
  exports,
  require: (name: string) => (Object.hasOwn(dependencies, name) ? dependencies[name] : require(name)),
});
const descriptor = exports.buildSessionSummaryRefreshDescriptor({
  messages,
  metadata: {},
  sessionNumber: 1,
  summary,
  continuityRequired: true,
});
// VM objects have a different prototype; compare the evaluator's serialized result.
const evaluate = async () =>
  JSON.parse(JSON.stringify(await exports.evaluateSessionSummaryRefreshInTransaction({}, "chat", descriptor, summary)));
ranges = [
  { start: 0, end: 2, content: "A😀" },
  { start: 2, content: "BC" },
];
assert.deepEqual(await evaluate(), { status: "ready" }, "Missing end is relative to the stored slice start");
ranges = [
  { start: 0, end: 2, content: "A😀" },
  { start: 2, end: 3, content: "BC" },
];
assert.deepEqual(
  await evaluate(),
  { status: "pending", reason: "held_continuity" },
  "An explicit short end still withholds the summary",
);
ranges = [
  { start: 0, end: 2, content: "A😀" },
  { start: 3, content: "C" },
];
assert.deepEqual(
  await evaluate(),
  { status: "pending", reason: "held_continuity" },
  "A real uncovered gap still withholds the summary",
);
ranges = [
  { start: 0, end: 1, content: "A" },
  { start: 1, content: "😀B" },
];
assert.deepEqual(
  await evaluate(),
  { status: "pending", reason: "held_continuity" },
  "Supplementary Unicode characters count as one codepoint",
);
