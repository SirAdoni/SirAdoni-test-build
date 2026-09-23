import { parentPort, workerData } from "node:worker_threads";
import { getQuickJS, shouldInterruptAfterDeadline } from "quickjs-emscripten";

type ScriptWorkerInput = {
  scriptBody: string;
  argsJson: string;
  contextJson: string;
  timeoutMs: number;
};

const input = workerData as ScriptWorkerInput;

try {
  const quickJs = await getQuickJS();
  const source = [
    `"use strict";`,
    `const args = JSON.parse(${JSON.stringify(input.argsJson)});`,
    `const context = JSON.parse(${JSON.stringify(input.contextJson)});`,
    `const console = Object.freeze({ log() {} });`,
    `JSON.stringify((function() {`,
    input.scriptBody,
    `}).call(undefined));`,
  ].join("\n");
  const serialized = quickJs.evalCode(source, {
    memoryLimitBytes: 32 * 1024 * 1024,
    maxStackSizeBytes: 2 * 1024 * 1024,
    shouldInterrupt: shouldInterruptAfterDeadline(Date.now() + input.timeoutMs),
  });
  const value = typeof serialized === "string" ? JSON.parse(serialized) : { result: "OK" };
  parentPort?.postMessage({ ok: true, value });
} catch (error) {
  parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
}
