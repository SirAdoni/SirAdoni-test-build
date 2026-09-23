// Logging batch 13 v1.0 (2026-09-23): update apply steps, .env reload lines,
// the startup.config line and the TLS load error.
// Runs against a temporary log directory and .env; no git, no pnpm, no live server.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "marinara-logging-b13-"));
const logDir = join(tempDir, "logs");
process.env.LOG_DIR = logDir;
process.env.LOG_FILE_LEVEL = "debug";
process.env.LOG_LEVEL = "fatal";
process.env.MARINARA_ENV_FILE = join(tempDir, ".env");
process.env.MARINARA_ENV_WATCH = "0";

type Line = Record<string, any>;

function mainLines(): Line[] {
  return readdirSync(logDir)
    .filter((name) => /^marinara-.*\.log/.test(name))
    .flatMap((name) => readFileSync(join(logDir, name), "utf8").split("\n"))
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Line);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 120));
const root = join(import.meta.dirname, "../../packages/server/src");

try {
  const { maskValue, logDiff } = await import("../../packages/server/src/config/env-watcher.js");
  const { logStorageDiagnostics, loadTlsOptions } = await import("../../packages/server/src/config/runtime-config.js");

  // (1) Values appear only for the allowlist; secret keys hide even the length.
  assert.equal(maskValue("PORT", "7000"), "7000");
  assert.equal(maskValue("LOG_LEVEL", "debug"), "debug");
  assert.equal(maskValue("ADMIN_SECRET", "hunter2"), "<set>");
  assert.equal(maskValue("SOME_API_KEY", "abc"), "<set>");
  assert.equal(maskValue("DATA_DIR", "/private/path"), "<set, length=13>");
  assert.equal(maskValue("PORT", undefined), "<unset>");
  assert.equal(maskValue("PORT", ""), "<empty>");

  // (2) One config.reload line, warn when a restart is needed, no secret values.
  process.env.ADMIN_SECRET = "b13-secret-value";
  process.env.PORT = "7123";
  logDiff({ added: ["ADMIN_SECRET"], updated: ["PORT"], removed: ["OLD_KEY"] } as any, "/tmp/b13.env");
  await settle();
  const reload = mainLines().filter((line) => line.event === "config.reload");
  assert.equal(reload.length, 1, "one config.reload line per change");
  assert.equal(reload[0]!.level, 40, "PORT needs a restart, so the line is a warn");
  assert.deepEqual(reload[0]!.restartRequired, ["PORT"]);
  // The file sink sanitizes a second time, so a secret key may also read [REDACTED].
  assert.match(String(reload[0]!.added?.[0]), /^ADMIN_SECRET=(<set>|\[REDACTED\])$/);
  assert.deepEqual(reload[0]!.updated, ["PORT=7123"]);
  assert.deepEqual(reload[0]!.removed, ["OLD_KEY"]);
  assert.equal(reload[0]!.envPath, "/tmp/b13.env");
  assert.match(reload[0]!.msg, /\.env changed \(3 keys\)/);
  assert.ok(!JSON.stringify(mainLines()).includes("b13-secret-value"), "secret values never reach the log");
  delete process.env.ADMIN_SECRET;
  delete process.env.PORT;

  // (3) logStorageDiagnostics writes one startup.config line.
  const captured: unknown[][] = [];
  logStorageDiagnostics({ info: (...args: unknown[]) => captured.push(args) });
  assert.equal(captured.length, 1);
  const [configFields, configMsg] = captured[0] as [Record<string, unknown>, string];
  assert.equal(configFields.event, "startup.config");
  assert.equal(configMsg, "[startup] Configuration resolved");
  for (const key of [
    "dataDir",
    "fileStorageDir",
    "envPath",
    "envFileExists",
    "logDir",
    "logFileLevel",
    "consoleLevel",
    "eagerStorage",
    "lite",
    "tls",
    "nodeEnv",
  ]) {
    assert.ok(key in configFields, `startup.config carries ${key}`);
  }
  assert.equal(configFields.tls, false);

  // (4) A bad TLS path throws TlsConfigError with the fs error as cause.
  process.env.SSL_CERT = join(tempDir, "missing-cert.pem");
  process.env.SSL_KEY = join(tempDir, "missing-key.pem");
  let tlsError: any;
  try {
    loadTlsOptions();
  } catch (error) {
    tlsError = error;
  }
  delete process.env.SSL_CERT;
  delete process.env.SSL_KEY;
  assert.ok(tlsError, "loadTlsOptions throws for missing files");
  assert.equal(tlsError.name, "TlsConfigError");
  assert.equal(tlsError.cause?.code, "ENOENT");

  // (5) The update route logs each step and reports its failure once.
  const updates = readFileSync(join(root, "routes/updates.routes.ts"), "utf8").replace(/\r\n/g, "\n");
  for (const step of ["fetch", "format-check", "stash", "checkout", "install", "build", "verify"]) {
    assert.ok(updates.includes(`logUpdateStep("${step}"`), `update step ${step} is logged`);
  }
  assert.ok(updates.includes('"update.step"') && updates.includes('"update.build.verify"'));
  assert.ok(updates.includes("ME_UPDATE_BUILD_STALE"), "a stale rebuild fails the apply");
  assert.match(
    updates,
    /reportDiagnosticError\(err, \{ operation: "update\.apply", stage: currentStep \}/,
    "the apply failure is reported once with the running step",
  );
  assert.match(updates, /errorId: reference\.errorId,\s*code: reference\.code,/, "the 500 body carries the ids");
  assert.match(
    updates,
    /logger\.info\("\[Update\] Shutting down after update\.\.\."\);\s*noteSessionExitKind\("restart"\);/,
    "the shutdown line is written before close starts",
  );
  assert.match(updates, /new Error\(parts\.join\(" "\), \{ cause: err \}\)/, "pnpm failures keep their cause");

  console.log("logging-b13 regression passed");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
