// Logging batch B1 v1.0 (2026-09-23): capability package activation, prompt-context
// contributors and the long-term memory runtime log structured, non-repeating lines.
// Uses a temporary data directory; no provider, no live server.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-logging-b0-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = `${process.env.DATA_DIR}/storage`; // never the live store named in .env
process.env.LOG_DIR = join(dataDir, "logs");
process.env.LOG_LEVEL = "fatal";

const { logger } = await import("../../packages/server/src/lib/logger.js");
type Line = { level: string; fields: Record<string, unknown>; msg: unknown };
const lines: Line[] = [];
for (const level of ["debug", "info", "warn", "error"] as const) {
  const original = logger[level].bind(logger);
  (logger as unknown as Record<string, unknown>)[level] = (first: unknown, ...rest: unknown[]) => {
    if (first && typeof first === "object" && !(first instanceof Error)) {
      lines.push({ level, fields: first as Record<string, unknown>, msg: rest[0] });
    }
    return Reflect.apply(original, logger, [first, ...rest]);
  };
}
const byEvent = (event: string) => lines.filter((line) => line.fields.event === event);

try {
  // 1. The persisted "[errorId]" suffix is parsed back out for /api/health.
  const { persistedErrorId, capabilityPackageManager } =
    await import("../../packages/server/src/services/capability-packages/package-manager.service.js");
  const id = "0fce3158-58ce-4562-9e63-0741d3d6bf16";
  assert.equal(persistedErrorId(`Cannot find module [${id}]`), id);
  assert.equal(persistedErrorId("Cannot find module"), null);
  assert.equal(persistedErrorId(null), null);

  // 2. Rollback says why it did nothing instead of returning a bare null.
  const rollback = await capabilityPackageManager.rollbackRuntime("not-installed");
  assert.equal(rollback.restored, null);
  assert.equal(rollback.reason, "no-previous-version");
  assert.deepEqual(await capabilityPackageManager.runtimePackageSkips(), []);

  // 3. A failing prompt-context contributor logs once per window, then recovers once.
  const { collectCapabilityPromptContext, registerCapabilityPromptContext, withDeadline } =
    await import("../../packages/server/src/services/capability-packages/capability-prompt-context.service.js");
  // withDeadline unrefs its timer; hold a ref so the process waits for it in this bare script.
  const keepAlive = setTimeout(() => undefined, 1_000);
  const timeout = await withDeadline(new Promise(() => undefined), "b0 deadline", 5).catch((error: unknown) => error);
  clearTimeout(keepAlive);
  assert.equal((timeout as Error).name, "TimeoutError");
  let fail = true;
  const release = registerCapabilityPromptContext("b0-pkg", () => {
    if (fail) throw new Error("contributor broke");
    return "fine";
  });
  const request = { chatId: "chat-b0", chatMeta: {}, mode: "roleplay" };
  await collectCapabilityPromptContext(request);
  await collectCapabilityPromptContext(request);
  const contributeLines = byEvent("package.contribute");
  assert.equal(contributeLines.length, 1, "a repeating contributor failure is written once per window");
  assert.equal(contributeLines[0]!.level, "warn");
  assert.equal(contributeLines[0]!.fields.packageId, "b0-pkg");
  assert.equal(contributeLines[0]!.fields.chatId, "chat-b0");
  assert.equal(contributeLines[0]!.fields.outcome, "failed");
  assert.equal(contributeLines[0]!.fields.timedOut, false);
  assert.equal(typeof contributeLines[0]!.fields.elapsedMs, "number");
  assert.equal(typeof contributeLines[0]!.fields.packageStatus, "string");
  fail = false;
  const ok = await collectCapabilityPromptContext(request);
  assert.deepEqual(ok.blocks, ["fine"]);
  const recovered = byEvent("package.contribute").filter((line) => line.fields.state === "recovered");
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]!.fields.suppressedCount, 1);
  release();

  // 4. Long-term memory: a missing runtime warns once, recovers once, and a recall logs its size, never its text.
  const { recallLongTermMemory, withLongTermMemoryRuntimeTimeout } =
    await import("../../packages/server/src/services/generation/long-term-memory-runtime.js");
  const { registerCapabilityService } =
    await import("../../packages/server/src/services/capability-packages/capability-service-registry.service.js");
  const recallInput = {
    chatId: "chat-b0",
    chatMode: "roleplay" as never,
    characterIds: [],
    messages: [],
    debugMode: false,
  };
  assert.equal(await recallLongTermMemory(recallInput), null);
  assert.equal(await recallLongTermMemory(recallInput), null);
  assert.equal(byEvent("package.service.missing").length, 1);
  assert.equal(byEvent("package.service.missing")[0]!.fields.serviceKey, "long-term-memory:runtime");
  const RECALLED = "PLANTED RECALL TEXT that must not be logged";
  const unregister = registerCapabilityService("long-term-memory:runtime", {
    recall: async () => ({ text: RECALLED }),
    recordPromptAccepted: async () => undefined,
  });
  const recall = await recallLongTermMemory(recallInput);
  assert.equal(recall?.text, RECALLED);
  assert.equal(
    byEvent("package.service.missing").filter((line) => line.fields.state === "recovered").length,
    1,
    "the service appearing closes the repeat key",
  );
  const recallLine = byEvent("ltm.recall").at(-1)!;
  assert.equal(recallLine.fields.outcome, "ok");
  assert.equal(recallLine.fields.recalledChars, RECALLED.length);
  assert.ok(!JSON.stringify(lines).includes(RECALLED), "recalled text never reaches a log line");
  unregister();
  const timedOut = await withLongTermMemoryRuntimeTimeout(5, () => new Promise(() => undefined)).catch(
    (error: unknown) => error,
  );
  assert.equal((timedOut as Error).name, "TimeoutError");

  // 5. Activation uses the shared vocabulary and keeps the early-boot check ahead of rollback.
  const runtimeSource = readFileSync(
    new URL(
      "../../packages/server/src/services/capability-packages/capability-module-runtime.service.ts",
      import.meta.url,
    ),
    "utf8",
  );
  for (const needle of [
    'event: "package.activate.summary"',
    'event: "package.rollback"',
    'event: "package.state"',
    '"ME_PACKAGE_PERSISTED_ERROR"',
    '"ME_EARLY_BOOT"',
    'startup.record("packages"',
    "logger.child({ packageId, packageVersion })",
    '"x-request-id": `pkg-${operationId}`',
    "[${failure.errorId}]",
  ]) {
    assert.ok(runtimeSource.includes(needle), `capability runtime contains ${needle}`);
  }
  assert.ok(
    runtimeSource.indexOf("if (isHostLifecycleActivationError(error))") <
      runtimeSource.indexOf("await capabilityPackageManager.rollbackRuntime(installed.id)"),
  );

  console.log("logging-b0 regression passed");
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
