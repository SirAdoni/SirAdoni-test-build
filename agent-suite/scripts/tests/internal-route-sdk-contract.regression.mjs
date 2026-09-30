import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";

const suite = resolve(import.meta.dirname, "../..");
const host = resolve(process.argv[2] ?? process.env.MARINARA_ENGINE_ROOT ?? join(suite, ".."));
const require = createRequire(join(suite, "package.json"));
const ts = require("typescript");
const parse = (path) => ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
const runtimePath = join(host, "packages/server/src/services/capability-packages/capability-module-runtime.service.ts");
const runtime = parse(runtimePath);
const context = runtime.statements.find(
  (node) => ts.isTypeAliasDeclaration(node) && node.name.text === "CapabilityActivationContext",
);
assert(
  context?.modifiers?.some((node) => node.kind === ts.SyntaxKind.ExportKeyword),
  "Host context must be exported",
);
const api = context.type.members.find((node) => node.name?.getText(runtime) === "api");
const callback = api.type.members.find((node) => node.name?.getText(runtime) === "runInternalRoute");
const hostType = callback.type.getText(runtime);
const sources = [
  ["packages/noodle/src/engine/packages/server/src/services/noodle/server-entry.ts", "activate"],
  [
    "packages/noodle/src/engine/packages/server/src/services/noodle/noodle-refresh-scheduler.service.ts",
    "startNoodleRefreshScheduler",
  ],
  ["packages/slurp2/src/engine/packages/server/src/slp/slp-server-entry.ts", "activate"],
  [
    "packages/slurp2/src/engine/packages/server/src/slp/features/feed/slp-refresh-scheduler-service.ts",
    "startSlpRefreshScheduler",
  ],
];
const types = sources.map(([path, symbol]) => {
  const source = parse(join(suite, path));
  const fn = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === symbol);
  assert(fn, symbol);
  if (symbol !== "activate")
    return fn.parameters.find((node) => node.name.getText(source) === "runInternalRoute").type.getText(source);
  return fn.parameters[0].type.members
    .find((node) => node.name?.getText(source) === "api")
    .type.members.find((node) => node.name?.getText(source) === "runInternalRoute")
    .type.getText(source);
});
const root = mkdtempSync(join(tmpdir(), "me-internal-route-contract-"));
const fixture = join(root, "contract.ts");
const hostRequire = createRequire(join(host, "packages/server/package.json"));
const fastifyDeclaration = join(dirname(hostRequire.resolve("fastify")), "fastify.d.ts");
const compile = (callbackTypes) => {
  writeFileSync(
    fixture,
    'import type { FastifyInstance, InjectOptions, LightMyRequestResponse as InjectResponse } from "fastify";\n' +
      "type HostCallback = " +
      hostType +
      ";\n" +
      "declare const hostCallback: HostCallback;\n" +
      callbackTypes
        .map(
          (type, index) => "const callback" + index + ": " + type + " = hostCallback;\nvoid callback" + index + ";\n",
        )
        .join(""),
  );
  const program = ts.createProgram([fixture], {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    paths: { fastify: [fastifyDeclaration] },
    typeRoots: [join(host, "packages/server/node_modules/@types")],
  });
  return ts.getPreEmitDiagnostics(program);
};
// ponytail: this proves the actual exported host callback and four source signatures;
// the exact build-graph gate separately checks whole activate/selfCheck contracts.
const broken = types.map(() => '(options: InjectOptions | string) => ReturnType<FastifyInstance["inject"]>');
const red = compile(broken);
assert.equal(
  red.length,
  4,
  ts.formatDiagnosticsWithColorAndContext(red, {
    getCurrentDirectory: () => root,
    getCanonicalFileName: (file) => file,
    getNewLine: () => "\n",
  }),
);
assert(
  red.every((diagnostic) => diagnostic.code === 2322),
  "Original overload failure must reproduce",
);
const green = compile(types);
assert.equal(
  green.length,
  0,
  ts.formatDiagnosticsWithColorAndContext(green, {
    getCurrentDirectory: () => root,
    getCanonicalFileName: (file) => file,
    getNewLine: () => "\n",
  }),
);
console.log("PASS: original four TS2322 overload mismatches reproduced; actual callback signatures assign strictly.");
