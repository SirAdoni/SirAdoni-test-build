// Logging batch 12 v1.0 (2026-09-23): sidecars. Downloads log sidecar.download.file
// with host only (never the URL path), classify failures as ME_DOWNLOAD_HTTP / _SIZE /
// _SHA and rethrow with cause; retry() logs sidecar.download.retry before each sleep.
// Source checks cover the process, runtime, route and utility-slot lines. Local
// loopback HTTP server on a random port and a temporary log directory only.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const logDir = mkdtempSync(join(tmpdir(), "marinara-logging-b12-"));
const workDir = mkdtempSync(join(tmpdir(), "marinara-logging-b12-dl-"));
process.env.LOG_DIR = logDir;
process.env.LOG_FILE_LEVEL = "debug";
process.env.LOG_LEVEL = "fatal";

const root = join(import.meta.dirname, "../..");
const src = (path: string) => readFileSync(join(root, "packages/server/src", path), "utf8");

type Line = Record<string, any>;
function mainLines(): Line[] {
  return readdirSync(logDir)
    .filter((name) => /^marinara-.*\.log/.test(name))
    .flatMap((name) => readFileSync(join(logDir, name), "utf8").split("\n"))
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Line);
}

const BODY = Buffer.from("sidecar-bytes-".repeat(64));
const BODY_SHA = createHash("sha256").update(BODY).digest("hex");
const SECRET_PATH = "/signed/SECRETPATHTOKEN/model.gguf";

const server = createServer((req, res) => {
  if (req.url?.startsWith("/missing")) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not here");
    return;
  }
  res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(BODY.length) });
  res.end(BODY);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;
assert.notEqual(port, 7860);
const base = `http://127.0.0.1:${port}`;

try {
  const { logger } = await import("../../packages/server/src/lib/logger.js");
  const { downloadFileWithProgress, retry } =
    await import("../../packages/server/src/services/sidecar/sidecar-download.js");

  // 1. Success: running then ok, with bytes, elapsedMs and shaVerified; host only.
  const okPath = join(workDir, "ok.bin");
  await downloadFileWithProgress({
    url: `${base}${SECRET_PATH}`,
    destPath: okPath,
    expectedBytes: BODY.length,
    expectedSha256: BODY_SHA,
    progress: { phase: "model", label: "ok-file" },
  });
  assert.ok(existsSync(okPath));

  // 2. SHA mismatch: ME_DOWNLOAD_SHA, message kept, cause attached.
  const shaError = await downloadFileWithProgress({
    url: `${base}/file.bin`,
    destPath: join(workDir, "sha.bin"),
    expectedSha256: "0".repeat(64),
    progress: { phase: "model", label: "sha-file" },
  }).catch((error: unknown) => error as Error & { errorCode?: string });
  assert.ok(shaError instanceof Error);
  assert.equal(shaError.errorCode, "ME_DOWNLOAD_SHA");
  assert.match(shaError.message, /SHA-256 mismatch/);
  assert.ok(shaError.cause instanceof Error);

  // 3. Size mismatch: ME_DOWNLOAD_SIZE.
  const sizeError = await downloadFileWithProgress({
    url: `${base}/file.bin`,
    destPath: join(workDir, "size.bin"),
    expectedBytes: BODY.length + 5,
    progress: { phase: "model", label: "size-file" },
  }).catch((error: unknown) => error as Error & { errorCode?: string });
  assert.equal((sizeError as any).errorCode, "ME_DOWNLOAD_SIZE");

  // 4. HTTP failure through retry(): one retry line, then ME_DOWNLOAD_HTTP.
  const httpError = await retry(
    () =>
      downloadFileWithProgress({
        url: `${base}/missing`,
        destPath: join(workDir, "missing.bin"),
        progress: { phase: "runtime", label: "http-file" },
      }),
    { retries: 2, baseDelayMs: 5, label: "http-file" },
  ).catch((error: unknown) => error as Error & { errorCode?: string });
  assert.equal((httpError as any).errorCode, "ME_DOWNLOAD_HTTP");

  logger.flush?.();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const lines = mainLines();
  const fileLines = lines.filter((line) => line.event === "sidecar.download.file");

  const okRunning = fileLines.find((line) => line.label === "ok-file" && line.state === "running");
  assert.ok(okRunning, "running line for the successful download");
  assert.equal(okRunning.host, `127.0.0.1:${port}`);
  assert.equal(okRunning.shaExpected, true);
  const okDone = fileLines.find((line) => line.label === "ok-file" && line.outcome === "ok");
  assert.ok(okDone, "ok line for the successful download");
  assert.equal(okDone.bytes, BODY.length);
  assert.equal(okDone.shaVerified, true);
  assert.equal(typeof okDone.elapsedMs, "number");

  const shaFailed = fileLines.find((line) => line.label === "sha-file" && line.outcome === "failed");
  assert.equal(shaFailed?.errorCode, "ME_DOWNLOAD_SHA");
  assert.equal(shaFailed?.level, 40);
  assert.equal(typeof shaFailed?.downloadedBytes, "number");
  const sizeFailed = fileLines.find((line) => line.label === "size-file" && line.outcome === "failed");
  assert.equal(sizeFailed?.errorCode, "ME_DOWNLOAD_SIZE");

  const retries = lines.filter((line) => line.event === "sidecar.download.retry" && line.label === "http-file");
  assert.equal(retries.length, 1);
  assert.equal(retries[0]!.attempt, 1);
  assert.equal(retries[0]!.maxAttempts, 2);
  assert.equal(retries[0]!.errorCode, "ME_DOWNLOAD_HTTP");
  assert.equal(typeof retries[0]!.delayMs, "number");

  const raw = readdirSync(logDir)
    .filter((name) => /^marinara-.*\.log/.test(name))
    .map((name) => readFileSync(join(logDir, name), "utf8"))
    .join("\n");
  assert.ok(!raw.includes("SECRETPATHTOKEN"), "download URL paths never reach the log");

  // 5. Source checks for the parts that need a real child process or route.
  const processSrc = src("services/sidecar/sidecar-process.service.ts");
  for (const needle of [
    '"sidecar.spawn"',
    '"sidecar.ready"',
    '"sidecar.exit"',
    '"sidecar.crashloop"',
    'event: "sidecar.start"',
    'stage: "runtime-fallback"',
    'registerWorkerGauge("sidecar"',
    ".prev",
    "stderrTail",
  ]) {
    assert.ok(processSrc.includes(needle), `sidecar-process has ${needle}`);
  }
  assert.ok(!/\.catch\(\(\) => null\)/.test(processSrc), "no silent runtime-fallback catch");
  assert.ok(!processSrc.includes('writeFileSync(sidecarRuntimeService.getLogPath(), "", "utf-8");\n    this.starting'));

  const runtimeSrc = src("services/sidecar/sidecar-runtime.service.ts");
  assert.ok(runtimeSrc.includes('stage: "capabilities"'));
  assert.ok(runtimeSrc.includes("describeChildFailure"));
  assert.ok(!runtimeSrc.includes(".catch(() => undefined)"));

  const mlxSrc = src("services/sidecar/mlx-runtime.service.ts");
  assert.ok(mlxSrc.includes("describeChildFailure"));
  assert.ok(mlxSrc.includes('throw new Error("Install aborted", { cause: error })'));
  assert.ok(
    src("services/sidecar/sidecar-model.service.ts").includes('new Error("Download cancelled", { cause: error })'),
  );

  const routesSrc = src("routes/sidecar.routes.ts");
  assert.ok(routesSrc.includes('"sidecar.sync:status"'));
  assert.equal((routesSrc.match(/event: "sidecar\.download"/g) ?? []).length, 2);
  assert.equal((routesSrc.match(/errorId: ref\.errorId/g) ?? []).length, 2);

  const utilitySrc = src("services/utility-sidecar/utility-sidecar.service.ts");
  assert.ok(utilitySrc.includes('child.stdout?.on("data"'), "utility stdout is drained");
  assert.ok(utilitySrc.includes('"utility_sidecar.exit"'));
  assert.ok(utilitySrc.includes('event: "utility_sidecar.start"'));
  assert.ok(src("services/utility-sidecar/utility-sidecar.provider.ts").includes('event: "utility_sidecar.fallback"'));

  console.log("logging-b12 regression passed");
} finally {
  server.close();
  rmSync(workDir, { recursive: true, force: true });
  rmSync(logDir, { recursive: true, force: true });
}
