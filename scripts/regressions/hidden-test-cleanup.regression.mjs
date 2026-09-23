import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../../e2e/hide-windows-cleanup.cjs", import.meta.url), "utf8");
for (const platform of ["win32", "linux"]) {
  const calls = [];
  let synced = false;
  const childProcess = {
    spawn: (...args) => {
      calls.push(args);
      return { pid: 123 };
    },
    spawnSync: (...args) => {
      calls.push(args);
      return { status: 7 };
    },
  };
  runInNewContext(source, {
    process: { platform },
    require: (name) => {
      if (name === "node:child_process") return childProcess;
      if (name === "node:module")
        return {
          syncBuiltinESMExports: () => {
            synced = true;
          },
        };
      throw new Error("Unexpected module: " + name);
    },
  });
  assert.equal(childProcess.spawnSync("taskkill /pid 123 /T /F", { shell: true }).status, 7);
  childProcess.spawnSync("taskkill.exe", ["/pid", "123"], { stdio: "ignore" });
  childProcess.spawnSync("intentional-visible", [], { windowsHide: false });
  const hidden = platform === "win32" ? true : undefined;
  assert.equal(calls[0][1].windowsHide, hidden);
  assert.equal(calls[0][1].shell, true);
  assert.equal(calls[1][2].windowsHide, hidden);
  assert.equal(calls[1][2].stdio, "ignore");
  assert.equal(calls[2][2].windowsHide, false);
  const options = { shell: true, env: { TEST: "preserved" }, stdio: "pipe" };
  assert.equal(childProcess.spawn("node server.mjs", [], options).pid, 123);
  assert.equal(calls[3][2].windowsHide, hidden);
  assert.equal(calls[3][2].env, options.env);
  assert.equal(options.windowsHide, undefined, "Do not mutate caller options");
  childProcess.spawn("helper");
  assert.equal(calls[4][1]?.windowsHide, hidden);
  assert.equal(synced, platform === "win32");
}
console.info("Hidden test cleanup regression passed");
