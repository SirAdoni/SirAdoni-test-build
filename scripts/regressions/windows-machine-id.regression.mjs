import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import ts from "typescript";

const source = fs.readFileSync("packages/server/src/db/file-backed-store.ts", "utf8");
const ast = ts.createSourceFile("file-backed-store.ts", source, ts.ScriptTarget.Latest, true);
const declaration = ast.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === "readStableMachineId",
);
assert.ok(declaration, "Exercise the actual production identity probe");
const code = ts.transpileModule(declaration.getText(ast), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
function probe(outcomes, platform = "win32") {
  const calls = [];
  const result = vm.runInNewContext(code + "; readStableMachineId();", {
    process: { platform, env: { SystemRoot: "C:/Windows" } },
    join: path.join,
    execFileSync(executable, args, options) {
      calls.push({ executable, args, options });
      const outcome = outcomes.shift();
      assert.notEqual(outcome, undefined, "Probe exceeded its bounded attempts");
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    readFileSync() {
      return "synthetic-linux-id";
    },
  });
  return { result, calls };
}
const timeout = () => Object.assign(new Error("synthetic timeout"), { code: "ETIMEDOUT" });
const valid = "MachineGuid    REG_SZ    synthetic-machine-id\r\n";
let run = probe([valid]);
assert.equal(run.result, "synthetic-machine-id");
assert.equal(run.calls.length, 1);
assert.equal(run.calls[0].executable, path.join("C:/Windows", "System32", "reg.exe"));
assert.deepEqual(Array.from(run.calls[0].args), [
  "query",
  "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
  "/v",
  "MachineGuid",
]);
run = probe([timeout(), valid]);
assert.equal(run.result, "synthetic-machine-id");
assert.deepEqual(
  run.calls.map((c) => c.options.timeout),
  [1000, 5000],
);
assert.equal(run.calls[0].executable, run.calls[1].executable);
assert.deepEqual(Array.from(run.calls[0].args), Array.from(run.calls[1].args));
assert.equal(run.calls[1].options.windowsHide, true);
assert.equal(run.calls[1].options.maxBuffer, 64 * 1024);
run = probe([timeout(), timeout()]);
assert.equal(run.result, null);
assert.equal(run.calls.length, 2);
for (const failure of ["unparseable registry output", Object.assign(new Error("denied"), { code: "EACCES" })]) {
  run = probe([failure]);
  assert.equal(run.result, null);
  assert.equal(run.calls.length, 1);
}
run = probe([timeout(), "unparseable registry output"]);
assert.equal(run.result, null);
assert.equal(run.calls.length, 2);
assert.equal(probe(['"IOPlatformUUID" = "synthetic-mac-id"'], "darwin").result, "synthetic-mac-id");
assert.equal(probe([], "linux").result, "synthetic-linux-id");
console.log(
  "Windows machine identity: bounded timeout retry, unchanged query, permanent failure fail-closed, non-Windows behavior PASS",
);
