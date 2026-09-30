import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Boot steps are timed and a failure names the step it came from.
const { startup } = await import("../../packages/server/src/lib/startup-timeline.js");
const { logger } = await import("../../packages/server/src/lib/logger.js");

assert.match(String(logger.bindings().bootId), /^[0-9a-f]{8}$/u, "each process start has a short boot id");

assert.equal(await startup.phase("sample.ok", () => 42), 42, "a phase returns its step's value");
const failure = new Error("seed exploded");
await assert.rejects(
  startup.phase("sample.outer", () => startup.phase("sample.inner", () => Promise.reject(failure))),
  (error) => error === failure,
  "a failing phase rethrows the original error",
);
assert.equal(startup.stageOf(failure), "sample.inner", "the innermost phase names the failure");
const recorded = startup.phases.map((phase) => `${phase.stage}:${phase.outcome}`);
assert.deepEqual(recorded, ["sample.ok:ok", "sample.inner:failed", "sample.outer:failed"]);

// Nested phases both report their wall time, and the summary ranks those elapsed durations.
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
await startup.phase("nested.outer", async () => {
  await startup.phase("nested.inner", () => wait(120));
});
const inner = startup.phases.find((phase) => phase.stage === "nested.inner")!;
const outer = startup.phases.find((phase) => phase.stage === "nested.outer")!;
assert.ok(inner.elapsedMs >= 100, "the inner step reports its elapsed time");
assert.ok(outer.elapsedMs >= inner.elapsedMs, "the outer phase includes nested wall time");

const summary = startup.summary();
assert.equal(summary.phases.count, 5);
assert.deepEqual(
  summary.phases.failed.map((phase) => phase.stage + ":" + phase.outcome),
  ["sample.inner:failed", "sample.outer:failed"],
);
const expectedSlowest = [...startup.phases].sort((a, b) => b.elapsedMs - a.elapsedMs).slice(0, 8);
assert.ok(summary.phases.slowest.length <= 8, "the summary bounds its slowest phase list");
assert.deepEqual(
  summary.phases.slowest.map((phase) => phase.stage),
  expectedSlowest.map((phase) => phase.stage),
  "the summary ranks phases by elapsed time",
);
// index.ts wires the timeline and emits one structured ready event after listening.
const index = readFileSync(new URL("../../packages/server/src/index.ts", import.meta.url), "utf8");
assert.match(index, /startup\.phase\("app\.build"/u);
assert.match(index, /startup\.phase\("http\.listen"/u);
assert.match(index, /event: "startup\.ready"/u);
assert.match(index, /Marinara Engine ready on %s in %d ms/u);
assert.match(index, /startup\.stageOf\(err\)/u, "a bootstrap failure names its step");
console.info("Logging startup timeline regression passed");
