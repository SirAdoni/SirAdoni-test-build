import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// A background task that calls app.inject() while startup is still registering routes used to boot Fastify early.
// Every later capability package then failed with "Root plugin has already booted" and the next addHook threw and
// killed the server (live crash 2026-09-23). The gate holds such calls until registration has finished.
process.env.LOG_LEVEL = "silent";
process.env.LOG_FILE_LEVEL = "silent";
const { default: Fastify } = await import("../../packages/server/node_modules/fastify/fastify.js");
const { holdInjectUntilRegistered } = await import("../../packages/server/src/lib/fastify-inject-gate.js");

const app = Fastify();
const release = holdInjectUntilRegistered(app, 60_000);
app.get("/early", async () => ({ ok: "early" }));

// A background call fires before registration is finished.
const earlyCall = app.inject({ method: "GET", url: "/late" });
await new Promise((resolve) => setTimeout(resolve, 20));

// Registration continues after the early call: this used to throw "already listening/booted".
app.get("/late", async () => ({ ok: "late" }));
app.addHook("onRequest", async () => undefined);
await app.register(async (child) => {
  child.get("/plugin", async () => ({ ok: "plugin" }));
});

release();
const late = await earlyCall;
assert.equal(late.statusCode, 200, "the held request runs after registration and reaches a route added later");
assert.deepEqual(late.json(), { ok: "late" });
assert.equal((await app.inject({ method: "GET", url: "/plugin" })).statusCode, 200, "calls after release run directly");

// Callback style is held too.
const app2 = Fastify();
const release2 = holdInjectUntilRegistered(app2, 60_000);
const callbackResult = new Promise<number>((resolve, reject) =>
  app2.inject({ method: "GET", url: "/cb" }, (error, response) =>
    error ? reject(error) : resolve(response!.statusCode),
  ),
);
app2.get("/cb", async () => "ok");
release2();
assert.equal(await callbackResult, 200);
await app.close();
await app2.close();

// buildApp installs the gate right after creating the instance and releases it only at the very end.
const appSource = readFileSync(new URL("../../packages/server/src/app.ts", import.meta.url), "utf8");
const install = appSource.indexOf("holdInjectUntilRegistered(app)");
const runtimeStart = appSource.indexOf("capabilityModuleRuntime.start(app)");
const continuityStart = appSource.indexOf("gameContinuity.start()");
const releaseAt = appSource.indexOf("releaseInjectGate();");
const returnAt = appSource.lastIndexOf("return app;");
assert.ok(
  install > 0 && install < continuityStart && install < runtimeStart,
  "gate is installed before background work and packages start",
);
assert.ok(
  releaseAt > runtimeStart && releaseAt < returnAt,
  "gate is released after package activation, just before buildApp returns",
);

console.log("startup-inject-gate regression passed");

// A host lifecycle failure must not roll a package back or mark it "error" (that disabled three packages for good).
const { isHostLifecycleActivationError } =
  await import("../../packages/server/src/services/capability-packages/capability-module-runtime.service.js");
const booted = Object.assign(new Error("Root plugin has already booted"), { code: "AVV_ERR_ROOT_PLG_BOOTED" });
const listening = Object.assign(new Error("Fastify instance is already listening. Cannot add route!"), {
  code: "FST_ERR_INSTANCE_ALREADY_LISTENING",
});
assert.equal(isHostLifecycleActivationError(booted), true);
assert.equal(isHostLifecycleActivationError(listening), true);
assert.equal(isHostLifecycleActivationError(new Error("Cannot find module './server.mjs'")), false);
const runtimeSource = readFileSync(
  new URL(
    "../../packages/server/src/services/capability-packages/capability-module-runtime.service.ts",
    import.meta.url,
  ),
  "utf8",
);
assert.ok(
  runtimeSource.indexOf("if (isHostLifecycleActivationError(error))") <
    runtimeSource.indexOf("await capabilityPackageManager.rollbackRuntime(installed.id)"),
  "host lifecycle errors return before rollback and before the error status is persisted",
);
console.log("capability host-lifecycle error handling passed");
