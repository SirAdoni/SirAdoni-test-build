// Runtime diagnostics endpoint: GET /api/admin/runtime-diagnostics returns one
// read-only snapshot of what /api/health does not already serve (memory peaks,
// storage residency, capability package runtime state, worker gauges) built
// from the logging pass helpers, stays privileged, leaks no stored secrets, and
// degrades one failing section instead of the whole reply.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-health-endpoint-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
process.env.LOG_LEVEL = "silent";
process.env.DISABLE_REQUEST_LOGGING = "true";
process.env.AUTO_CREATE_DEFAULT_CONNECTION = "false";
delete process.env.ADMIN_SECRET;
delete process.env.BASIC_AUTH_USER;
delete process.env.BASIC_AUTH_PASS;

const SECRET = "sk-regression-diagnostics-secret-0000";

try {
  const diagnostics = await import("../../packages/server/src/lib/runtime-diagnostics.js");

  // 1. Package state mapping, including the real boot shape (readiness left "pending").
  {
    const { derivePackageRuntimeState } = diagnostics;
    const base = { status: "active", readiness: "pending", hasServer: true, live: false, activationFailed: false };
    assert.equal(derivePackageRuntimeState({ ...base, activationFailed: true }), "failed", "boot failure");
    assert.equal(
      derivePackageRuntimeState({ ...base, activationFailed: true, activationErrorCode: "ME_EARLY_BOOT" }),
      "skipped",
      "an early-boot skip matches the package.activate outcome",
    );
    assert.equal(derivePackageRuntimeState(base), "pending", "not live and no failure yet: still activating");
    assert.equal(derivePackageRuntimeState({ ...base, readiness: "registered" }), "pending", "part-way through");
    assert.equal(derivePackageRuntimeState({ ...base, live: true, readiness: "ready" }), "active");
    assert.equal(derivePackageRuntimeState({ ...base, hasServer: false, live: null }), "active", "client-only");
    assert.equal(derivePackageRuntimeState({ ...base, status: "restart-required" }), "restart-required");
    assert.equal(derivePackageRuntimeState({ ...base, status: "error" }), "failed");
  }

  // 2. Worker section: the registered worker gauges plus continuity breaker state.
  {
    const { registerWorkerGauge } = await import("../../packages/server/src/lib/worker-gauges.js");
    const unregister = registerWorkerGauge("regressionProbe", () => ({ pending: 5, active: 1 }));
    const pausedUntil = Date.now() + 60_000;
    const workers = diagnostics.collectWorkerDiagnostics({
      continuity: {
        health: () => ({ pausedUntil, pauseCode: "CONTINUITY_PROVIDER_UNRESPONSIVE", transientFailures: 3 }),
        queueStats: () => ({ pending: 4, active: 1, parked: 2 }),
      },
    });
    unregister();
    assert.deepEqual(workers.gauges.regressionProbe, { pending: 5, active: 1 }, "gauges are reused, not recomputed");
    // pending, active and pausedUntil are in the continuity gauge already; only the rest is added.
    assert.deepEqual(workers.gameContinuity, {
      parked: 2,
      pauseCode: "CONTINUITY_PROVIDER_UNRESPONSIVE",
      transientFailures: 3,
    });
    const without = diagnostics.collectWorkerDiagnostics({});
    assert.equal(without.gameContinuity, null);
    assert.equal("regressionProbe" in without.gauges, false);
  }

  const { buildApp } = await import("../../packages/server/src/app.js");
  const { capabilityPackageManager } =
    await import("../../packages/server/src/services/capability-packages/package-manager.service.js");
  const { capabilityModuleRuntime } =
    await import("../../packages/server/src/services/capability-packages/capability-module-runtime.service.js");
  const app = await buildApp();
  try {
    await app.ready();

    // Store a secret the snapshot must never echo.
    const created = await app.inject({
      method: "POST",
      url: "/api/connections",
      payload: { name: "Regression connection", provider: "openai", model: "gpt-test", apiKey: SECRET },
    });
    assert.ok(created.statusCode < 300, `connection create failed: ${created.statusCode} ${created.body}`);

    // 4. Loopback admin read returns every section.
    const response = await app.inject({ method: "GET", url: "/api/admin/runtime-diagnostics" });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.ok(!response.body.includes(SECRET), "stored secrets must never appear in diagnostics");
    const body = response.json();
    assert.ok(body.process.memoryPeaks.peakRssMiB > 0, "peaks come from runtime-memory");
    assert.ok(body.process.memoryPeaks.peakHeapUsedMiB > 0);
    assert.equal(typeof body.process.uptimeSeconds, "number");
    assert.equal(body.storage.open, true);
    assert.ok(body.storage.residentRows >= 1, "row counts reflect writes");
    assert.ok(Array.isArray(body.storage.dirtyTables));
    assert.equal("tables" in body.storage, false, "per-table counts stay in the storage gauge");
    assert.ok(body.workers.gauges.storage, "the storage worker gauge is sampled");
    assert.ok(body.workers.gauges.continuity, "the continuity worker gauge is sampled");
    assert.equal(typeof body.workers.gauges.continuity.pending, "number");
    assert.equal(typeof body.workers.gameContinuity.parked, "number", "continuity queue detail beyond the gauge");
    for (const key of ["pending", "active", "pausedUntil"]) {
      assert.equal(key in body.workers.gameContinuity, false, `${key} stays in gauges.continuity only`);
    }
    assert.ok(body.capabilityPackages.counts && Array.isArray(body.capabilityPackages.packages));
    // /api/health already serves these; the snapshot does not repeat them.
    const publicHealth = (await app.inject({ method: "GET", url: "/api/health" })).json();
    assert.ok(
      publicHealth.startup && publicHealth.memory && "buildIntegrity" in publicHealth,
      "public health carries them",
    );
    for (const key of ["startup", "build", "buildIntegrity", "memory", "version"]) {
      assert.equal(key in body, false, `${key} is served by /api/health`);
    }
    assert.equal("memory" in body.process, false, "the memory snapshot is served by /api/health");

    // 5. Capability package state separates "registered as active" from "runtime actually live",
    // driven through the real activation failure recording in CapabilityModuleRuntime.
    const manager = capabilityPackageManager as any;
    const runtime = capabilityModuleRuntime as any;
    const saved = {
      installed: manager.installed,
      markRuntimeReadiness: manager.markRuntimeReadiness,
      markRuntimeStatus: manager.markRuntimeStatus,
      runtimeBlockReason: manager.runtimeBlockReason,
    };
    const fixture = (id: string, overrides: Record<string, unknown>) => ({
      id,
      version: "1.0.0",
      manifest: { entrypoints: { server: "server.mjs" } },
      installedAt: new Date().toISOString(),
      status: "active",
      error: null,
      readiness: "pending",
      readinessError: null,
      legacy: false,
      ...overrides,
    });
    try {
      const persisted: string[] = [];
      manager.markRuntimeReadiness = async (id: string, readiness: string) => {
        persisted.push(`${id}:${readiness}`);
      };
      manager.markRuntimeStatus = async (id: string, status: string) => {
        persisted.push(`${id}:status:${status}`);
      };
      manager.runtimeBlockReason = (installed: { id: string }) =>
        installed.id === "pkg-skipped-at-boot"
          ? "Fastify instance is already listening. Cannot call register!"
          : `blocked for regression apiKey=${SECRET}`;
      const early = await runtime.activateOne(app, { installed: fixture("pkg-skipped-at-boot", {}) }, false, false);
      assert.equal(early.outcome, "skipped", "host-lifecycle failure keeps the package for the next boot");
      const broken = await runtime.activateOne(app, { installed: fixture("pkg-broken", {}) }, false, false);
      assert.equal(broken.outcome, "failed");
      const recorded = capabilityModuleRuntime.runtimeState().activationErrors;
      assert.equal(recorded["pkg-skipped-at-boot"]?.errorCode, "ME_EARLY_BOOT");
      assert.equal(recorded["pkg-broken"]?.errorId, broken.errorId, "the failure record points at the logged error");
      assert.ok(!persisted.includes("pkg-skipped-at-boot:status:error"), "an early-boot failure is not persisted");
      assert.ok(persisted.includes("pkg-broken:status:error"));

      manager.installed = async () => [
        fixture("pkg-skipped-at-boot", {}),
        fixture("pkg-broken", { status: "error", error: `activate failed apiKey=${SECRET}`, readiness: "error" }),
        fixture("pkg-activating", { readiness: "registered" }),
        fixture("pkg-client-only", { manifest: { entrypoints: { client: "client.js" } }, readiness: "ready" }),
        fixture("pkg-waiting", { status: "restart-required" }),
      ];
      const packages = (await app.inject({ method: "GET", url: "/api/admin/runtime-diagnostics" })).json()
        .capabilityPackages;
      const byId = Object.fromEntries(packages.packages.map((item: { id: string }) => [item.id, item]));
      assert.equal(
        byId["pkg-skipped-at-boot"].state,
        "skipped",
        "registry says active, the runtime never started, and package.activate logged it as skipped",
      );
      assert.equal(byId["pkg-skipped-at-boot"].live, false);
      assert.match(byId["pkg-skipped-at-boot"].error, /already listening/);
      assert.equal(byId["pkg-skipped-at-boot"].lastActivationFailure.errorCode, "ME_EARLY_BOOT");
      assert.equal(byId["pkg-broken"].state, "failed");
      assert.ok(!JSON.stringify(packages).includes(SECRET), "package errors are sanitized");
      assert.equal(byId["pkg-activating"].state, "pending", "mid-activation is pending, not failed");
      assert.equal(byId["pkg-client-only"].state, "active");
      assert.equal(byId["pkg-client-only"].live, null);
      assert.equal(byId["pkg-waiting"].state, "restart-required");
      assert.deepEqual(packages.counts, { active: 1, failed: 1, skipped: 1, "restart-required": 1, pending: 1 });

      // 6. One failing source degrades its own section only.
      manager.installed = async () => {
        throw new Error("registry unreadable");
      };
      const degraded = await app.inject({ method: "GET", url: "/api/admin/runtime-diagnostics" });
      assert.equal(degraded.statusCode, 200);
      assert.deepEqual(degraded.json().capabilityPackages, { error: "registry unreadable" });
      assert.equal(degraded.json().storage.open, true);
    } finally {
      Object.assign(manager, saved);
    }

    // 7. Privileged like its neighbours. A remote caller that passes Basic Auth
    // (so the global non-loopback hook lets it through) but has no admin secret
    // reaches an ungated admin read, and is refused by requirePrivilegedAccess here.
    process.env.BASIC_AUTH_USER = "regression-user";
    process.env.BASIC_AUTH_PASS = "regression-pass-0123456789";
    try {
      const headers = {
        authorization: `Basic ${Buffer.from("regression-user:regression-pass-0123456789").toString("base64")}`,
      };
      const remote = { remoteAddress: "203.0.113.9", headers };
      const neighbour = await app.inject({ method: "GET", url: "/api/admin/request-timeouts", ...remote });
      assert.equal(neighbour.statusCode, 200, `Basic Auth must pass the global hook: ${neighbour.body}`);
      const gated = await app.inject({ method: "GET", url: "/api/admin/runtime-diagnostics", ...remote });
      assert.equal(gated.statusCode, 403, `requirePrivilegedAccess must refuse: ${gated.statusCode} ${gated.body}`);
      assert.ok(!gated.body.includes("rssMiB"));
    } finally {
      delete process.env.BASIC_AUTH_USER;
      delete process.env.BASIC_AUTH_PASS;
    }

    // 8. The existing public health check is unchanged.
    const health = await app.inject({ method: "GET", url: "/api/health" });
    assert.equal(health.statusCode, 200);
    assert.equal(health.json().status, "ok");
  } finally {
    await app.close();
  }
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

process.stdout.write("Robustness health endpoint regression passed.\n");
process.exit(0);
