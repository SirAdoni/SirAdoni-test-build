import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const checkerPath = join(repositoryRoot, "scripts/check-port-available.mjs");

function listen(server) {
  return new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
}

function close(server) {
  return new Promise((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
}

function runChecker(port) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [checkerPath], {
      windowsHide: true,
      cwd: repositoryRoot,
      env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), SSL_CERT: "", SSL_KEY: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (status) => resolveRun({ status, stdout, stderr }));
  });
}

function runCheckerWithInheritedOutput(port) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [checkerPath], {
      windowsHide: true,
      cwd: repositoryRoot,
      env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), SSL_CERT: "", SSL_KEY: "" },
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.once("error", reject);
    child.once("close", resolveRun);
  });
}

const healthyServer = createServer((request, response) => {
  if (request.url === "/api/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", version: "2.4.4", build: "v2.4.4 regression" }));
    return;
  }
  response.writeHead(404).end();
});
await listen(healthyServer);
const healthyAddress = healthyServer.address();
assert.ok(healthyAddress && typeof healthyAddress === "object");
const healthyResult = await runChecker(healthyAddress.port);
assert.equal(healthyResult.status, 2, healthyResult.stderr);
assert.match(healthyResult.stdout, /Marinara Engine v2\.4\.4 regression is already running/u);
assert.equal(
  await runCheckerWithInheritedOutput(healthyAddress.port),
  2,
  "the existing-server probe must preserve exit code 2 while its fetch handles close",
);
await close(healthyServer);

let transientHealthRequests = 0;
const transientServer = createServer((request, response) => {
  if (request.url !== "/api/health") {
    response.writeHead(404).end();
    return;
  }
  transientHealthRequests += 1;
  if (transientHealthRequests === 1) return;
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ status: "ok", version: "2.4.4", build: "v2.4.4 delayed regression" }));
});
await listen(transientServer);
const transientAddress = transientServer.address();
assert.ok(transientAddress && typeof transientAddress === "object");
const transientResult = await runChecker(transientAddress.port);
assert.equal(transientResult.status, 2, transientResult.stderr);
assert.match(transientResult.stdout, /Marinara Engine v2\.4\.4 delayed regression is already running/u);
assert.equal(transientHealthRequests, 2, "a timed-out health check must get one bounded retry");
await close(transientServer);

const hangingSockets = new Set();
const hangingServer = createServer(() => {});
hangingServer.on("connection", (socket) => {
  hangingSockets.add(socket);
  socket.once("close", () => hangingSockets.delete(socket));
});
await listen(hangingServer);
const hangingAddress = hangingServer.address();
assert.ok(hangingAddress && typeof hangingAddress === "object");
const hangingResult = await runChecker(hangingAddress.port);
assert.equal(hangingResult.status, 1);
assert.match(hangingResult.stderr, /may be a stalled Marinara Engine or another local service/u);
assert.match(hangingResult.stderr, /Close or restart it, or start Marinara on another port/u);
for (const socket of hangingSockets) socket.destroy();
await close(hangingServer);

const unrelatedServer = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ status: "ok" }));
});
await listen(unrelatedServer);
const unrelatedAddress = unrelatedServer.address();
assert.ok(unrelatedAddress && typeof unrelatedAddress === "object");
const unrelatedResult = await runChecker(unrelatedAddress.port);
assert.equal(unrelatedResult.status, 1);
assert.match(unrelatedResult.stderr, /Port \d+ is already in use/u);
await close(unrelatedServer);

const freeResult = await runChecker(unrelatedAddress.port);
assert.equal(freeResult.status, 0, freeResult.stderr);

for (const launcherPath of ["start.bat", "start.sh"]) {
  const source = readFileSync(join(repositoryRoot, launcherPath), "utf8");
  const firstPortCheck = source.indexOf("check_launch_port");
  const updateCheck = source.indexOf("Checking for updates");
  assert.ok(
    firstPortCheck >= 0 && firstPortCheck < updateCheck,
    `${launcherPath} must reuse the server before updates`,
  );
  assert.match(source, /Reopening the running Marinara Engine instance/u);
}

console.log("Existing-server launcher regressions passed.");
